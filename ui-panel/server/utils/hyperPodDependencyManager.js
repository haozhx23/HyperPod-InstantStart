const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class HyperPodDependencyManager {

  /**
   * 执行非阻塞命令
   */
  static async executeNonBlocking(command, options = {}) {
    return new Promise((resolve, reject) => {
      const logFile = '/app/tmp/hypd-dependency.log';
      const timestamp = new Date().toISOString();
      const logHeader = `\n=== ${timestamp} ===\nExecuting: ${command.substring(0, 100)}...\n`;

      try {
        fs.appendFileSync(logFile, logHeader);
      } catch (err) {
        console.error('Failed to write log header:', err);
      }

      const child = spawn('bash', ['-c', `${command} >> ${logFile} 2>&1`], {
        stdio: 'pipe',
        ...options
      });

      child.on('close', (code) => {
        const logFooter = `\n--- Command completed with exit code: ${code} ---\n`;
        try {
          fs.appendFileSync(logFile, logFooter);
        } catch (err) {
          console.error('Failed to write log footer:', err);
        }

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command failed with exit code ${code}`));
        }
      });

      child.on('error', (error) => {
        const errorLog = `\n!!! Command execution error: ${error.message} !!!\n`;
        try {
          fs.appendFileSync(logFile, errorLog);
        } catch (err) {
          console.error('Failed to write error log:', err);
        }
        reject(error);
      });
    });
  }

  /**
   * HyperPod集群创建完成后的完整依赖配置流程
   */
  static async configureHyperPodDependencies(clusterTag, clusterManager) {
    try {
      console.log(`Configuring HyperPod dependencies for cluster: ${clusterTag}`);

      const clusterDir = clusterManager.getClusterDir(clusterTag);
      const configDir = path.join(clusterDir, 'config');

      if (!fs.existsSync(configDir)) {
        throw new Error(`Cluster config directory not found: ${configDir}`);
      }

      // 配置 HyperPod Pod Identity 权限
      await this.configureHyperPodPodIdentity(configDir);

      console.log(`Successfully configured HyperPod dependencies for cluster: ${clusterTag}`);
      return { success: true };

    } catch (error) {
      console.error(`Error configuring HyperPod dependencies for cluster ${clusterTag}:`, error);
      throw error;
    }
  }

  /**
   * 等待HyperPod集群就绪
   */
  static async waitForHyperPodReady(configDir) {
    console.log('Waiting for HyperPod cluster to be ready...');

    const waitCmd = `cd ${configDir} && bash -c 'source cluster_envs &&

    echo "Checking HyperPod cluster status..."

    MAX_ATTEMPTS=30
    ATTEMPT=0

    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
      STATUS=$(aws sagemaker describe-cluster --cluster-name $HP_CLUSTER_NAME --region $AWS_REGION --query "ClusterStatus" --output text 2>/dev/null || echo "NOT_FOUND")

      if [ "$STATUS" = "InService" ]; then
        echo "✅ HyperPod cluster is ready (InService)"
        break
      elif [ "$STATUS" = "Failed" ]; then
        echo "❌ ERROR: HyperPod cluster creation failed"
        exit 1
      else
        echo "HyperPod cluster status: $STATUS, waiting... (attempt $((ATTEMPT+1))/$MAX_ATTEMPTS)"
        sleep 30
        ATTEMPT=$((ATTEMPT+1))
      fi
    done

    if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
      echo "⚠️ WARNING: Timeout waiting for HyperPod cluster to be ready"
      exit 1
    fi
    '`;

    await this.executeNonBlocking(waitCmd);
  }

  /**
   * 安装HyperPod专用依赖（简化版）
   * [2026-04-08] cert-manager 从 configure dependency 阶段移除，整合到这里一起安装
   */
  static async installHyperPodDependencies(configDir) {
    console.log('Installing HyperPod-specific dependencies...');

    // Phase 0: 初始等待 - 等待节点就绪和基础 addon pods 启动
    console.log('Waiting 180 seconds for cluster nodes and base addons to initialize...');
    await this.executeNonBlocking(`echo "Initial wait: 180 seconds for nodes and pods to initialize..." && sleep 180 && echo "Initial wait completed"`);

    // Phase 1: 清理失败的安装
    const cleanupResult = await this.cleanupFailedInstallations(configDir);
    if (cleanupResult.alreadyInstalled) {
      console.log('Training Operator addon is already installed, skipping...');
      return;
    }

    // Phase 2: 安装 cert-manager（如果尚未安装）并等待就绪
    // --- 旧逻辑：仅等待 cert-manager 就绪（假设已在 configure dependency 阶段安装） ---
    // await this.waitForCertManagerReady(configDir);
    await this.installAndWaitForCertManager(configDir);

    // Phase 3: 安装 Training Operator addon（带重试）
    await this.installTrainingOperatorAddon(configDir);

    // Phase 4: 验证安装
    await this.verifyTrainingOperatorInstallation(configDir);

    console.log('=== All HyperPod dependencies installed successfully ===');
  }

  /**
   * 清理失败的安装
   */
  static async cleanupFailedInstallations(configDir) {
    console.log('Checking and cleaning up previous installations...');

    const commands = `cd ${configDir} && bash -c 'source cluster_envs &&

    echo "=========================================="
    echo "Checking Training Operator addon status"
    echo "=========================================="

    CURRENT_STATUS=\$(aws eks describe-addon \\
        --cluster-name \$EKS_CLUSTER_NAME \\
        --addon-name amazon-sagemaker-hyperpod-training-operator \\
        --region \$AWS_REGION \\
        --query "addon.status" \\
        --output text 2>/dev/null || echo "NOT_FOUND")

    echo "Current status: \$CURRENT_STATUS"

    if [ "\$CURRENT_STATUS" = "ACTIVE" ]; then
        echo "✅ Training Operator addon is already ACTIVE"
        exit 100
    fi

    if [ "\$CURRENT_STATUS" = "CREATE_FAILED" ] || [ "\$CURRENT_STATUS" = "DEGRADED" ]; then
        echo "Cleaning up failed addon..."
        aws eks delete-addon \\
            --cluster-name \$EKS_CLUSTER_NAME \\
            --addon-name amazon-sagemaker-hyperpod-training-operator \\
            --region \$AWS_REGION 2>&1 || true

        echo "Waiting for deletion..."
        for i in {1..24}; do
            STATUS=\$(aws eks describe-addon \\
                --cluster-name \$EKS_CLUSTER_NAME \\
                --addon-name amazon-sagemaker-hyperpod-training-operator \\
                --region \$AWS_REGION \\
                --query "addon.status" \\
                --output text 2>/dev/null || echo "DELETED")
            if [ "\$STATUS" = "DELETED" ]; then
                echo "✅ Addon deleted"
                break
            fi
            echo "Waiting... (\$i/24)"
            sleep 5
        done
        sleep 10
    fi

    echo "Ready for installation"
    '`;

    try {
      await this.executeNonBlocking(commands);
    } catch (error) {
      if (error.message && error.message.includes('exit code 100')) {
        return { alreadyInstalled: true };
      }
      throw error;
    }
    return { alreadyInstalled: false };
  }

  /**
   * 安装 cert-manager 并等待就绪
   * [2026-04-08] 从 clusterDependencyManager.installCertManager 整合而来，
   * 合并了安装和等待逻辑（原 waitForCertManagerReady 的等待部分）
   */
  static async installAndWaitForCertManager(configDir) {
    console.log('Installing cert-manager and waiting for it to be ready...');

    const commands = `cd ${configDir} && bash -c 'source cluster_envs &&

    echo "=========================================="
    echo "Step 1: Install cert-manager addon"
    echo "=========================================="

    CERT_STATUS=\$(aws eks describe-addon \\
        --cluster-name \$EKS_CLUSTER_NAME \\
        --addon-name cert-manager \\
        --region \$AWS_REGION \\
        --query "addon.status" \\
        --output text 2>/dev/null || echo "NOT_FOUND")

    if [ "\$CERT_STATUS" = "ACTIVE" ]; then
        echo "✅ cert-manager is already ACTIVE, skipping installation"
    else
        if [ "\$CERT_STATUS" = "NOT_FOUND" ]; then
            echo "Creating cert-manager addon..."
            aws eks create-addon \\
                --cluster-name \$EKS_CLUSTER_NAME \\
                --addon-name cert-manager \\
                --region \$AWS_REGION \\
                --configuration-values '"'"'{"replicaCount":1,"cainjector":{"replicaCount":1},"webhook":{"replicaCount":1}}'"'"' \\
                --resolve-conflicts OVERWRITE 2>&1 || echo "cert-manager addon creation failed, may already exist"
        fi

        echo "Waiting for cert-manager addon to become ACTIVE..."
        for i in {1..30}; do
            STATUS=\$(aws eks describe-addon \\
                --cluster-name \$EKS_CLUSTER_NAME \\
                --addon-name cert-manager \\
                --region \$AWS_REGION \\
                --query "addon.status" \\
                --output text 2>/dev/null || echo "UNKNOWN")

            if [ "\$STATUS" = "ACTIVE" ]; then
                echo "✅ cert-manager addon is ACTIVE"
                break
            fi
            echo "cert-manager status: \$STATUS (\$i/30)"
            sleep 10
        done
    fi

    echo ""
    echo "=========================================="
    echo "Step 2: Wait for cert-manager deployments"
    echo "=========================================="

    kubectl wait --for=condition=available deployment/cert-manager -n cert-manager --timeout=300s || true
    kubectl wait --for=condition=available deployment/cert-manager-webhook -n cert-manager --timeout=300s || true
    kubectl wait --for=condition=available deployment/cert-manager-cainjector -n cert-manager --timeout=300s || true

    echo ""
    echo "=========================================="
    echo "Step 3: Verify webhook endpoints exist"
    echo "=========================================="

    for i in {1..30}; do
        ENDPOINTS=\$(kubectl get endpoints cert-manager-webhook -n cert-manager -o jsonpath="{.subsets[*].addresses[*].ip}" 2>/dev/null || echo "")
        if [ -n "\$ENDPOINTS" ]; then
            echo "✅ cert-manager webhook endpoints: \$ENDPOINTS"
            break
        fi
        echo "Waiting for endpoints... (\$i/30)"
        sleep 5
    done

    echo ""
    echo "=========================================="
    echo "Step 4: Stabilization wait (300s)"
    echo "=========================================="
    echo "Waiting 300 seconds for cert-manager webhook to be fully accessible..."
    sleep 300

    echo "✅ cert-manager installation and readiness check completed"
    '`;

    await this.executeNonBlocking(commands);
  }

  /**
   * 等待 cert-manager 就绪（简化版）
   * 只检查 addon 状态和 deployment 就绪，不做 webhook 连接测试
   * [2026-04-08] 旧方法，保留供参考。新流程使用 installAndWaitForCertManager
   */
  static async waitForCertManagerReady(configDir) {
    console.log('Waiting for cert-manager to be ready...');

    const commands = `cd ${configDir} && bash -c 'source cluster_envs &&

    echo "=========================================="
    echo "Step 1: Check cert-manager addon status"
    echo "=========================================="

    for i in {1..30}; do
        STATUS=\$(aws eks describe-addon \\
            --cluster-name \$EKS_CLUSTER_NAME \\
            --addon-name cert-manager \\
            --region \$AWS_REGION \\
            --query "addon.status" \\
            --output text 2>/dev/null || echo "UNKNOWN")

        if [ "\$STATUS" = "ACTIVE" ]; then
            echo "✅ cert-manager addon is ACTIVE"
            break
        fi
        echo "cert-manager status: \$STATUS (\$i/30)"
        sleep 10
    done

    echo ""
    echo "=========================================="
    echo "Step 2: Wait for cert-manager deployments"
    echo "=========================================="

    kubectl wait --for=condition=available deployment/cert-manager -n cert-manager --timeout=300s || true
    kubectl wait --for=condition=available deployment/cert-manager-webhook -n cert-manager --timeout=300s || true
    kubectl wait --for=condition=available deployment/cert-manager-cainjector -n cert-manager --timeout=300s || true

    echo ""
    echo "=========================================="
    echo "Step 3: Verify webhook endpoints exist"
    echo "=========================================="

    for i in {1..30}; do
        ENDPOINTS=\$(kubectl get endpoints cert-manager-webhook -n cert-manager -o jsonpath="{.subsets[*].addresses[*].ip}" 2>/dev/null || echo "")
        if [ -n "\$ENDPOINTS" ]; then
            echo "✅ cert-manager webhook endpoints: \$ENDPOINTS"
            break
        fi
        echo "Waiting for endpoints... (\$i/30)"
        sleep 5
    done

    echo ""
    echo "=========================================="
    echo "Step 4: Stabilization wait (300s)"
    echo "=========================================="
    echo "Waiting 300 seconds for cert-manager webhook to be fully accessible..."
    sleep 300

    echo "✅ cert-manager is ready"
    '`;

    await this.executeNonBlocking(commands);
  }

  /**
   * 等待 cert-manager 完全就绪（增强版 - 别名）
   */
  static async waitForCertManagerFullyReady(configDir) {
    return this.waitForCertManagerReady(configDir);
  }

  /**
   * 安装 Training Operator addon（带重试）
   */
  static async installTrainingOperatorAddon(configDir) {
    console.log('Installing HyperPod Training Operator addon...');

    const commands = `cd ${configDir} && bash -c 'source cluster_envs &&

    echo "=========================================="
    echo "Installing Training Operator Addon"
    echo "=========================================="

    MAX_RETRIES=3
    RETRY_DELAY=120

    for ATTEMPT in 1 2 3; do
        echo ""
        echo ">>> Attempt \$ATTEMPT/\$MAX_RETRIES <<<"

        # Check current status
        STATUS=\$(aws eks describe-addon \\
            --cluster-name \$EKS_CLUSTER_NAME \\
            --addon-name amazon-sagemaker-hyperpod-training-operator \\
            --region \$AWS_REGION \\
            --query "addon.status" \\
            --output text 2>/dev/null || echo "NOT_FOUND")

        echo "Current status: \$STATUS"

        if [ "\$STATUS" = "ACTIVE" ]; then
            echo "✅ Training Operator addon is ACTIVE!"
            exit 0
        fi

        # Delete if failed
        if [ "\$STATUS" = "CREATE_FAILED" ] || [ "\$STATUS" = "DEGRADED" ]; then
            echo "Deleting failed addon..."
            aws eks delete-addon \\
                --cluster-name \$EKS_CLUSTER_NAME \\
                --addon-name amazon-sagemaker-hyperpod-training-operator \\
                --region \$AWS_REGION 2>&1 || true
            echo "Waiting 60s for deletion..."
            sleep 60
            STATUS="NOT_FOUND"
        fi

        # Create addon if not found
        if [ "\$STATUS" = "NOT_FOUND" ]; then
            echo "Creating addon..."
            aws eks create-addon \\
                --cluster-name \$EKS_CLUSTER_NAME \\
                --addon-name amazon-sagemaker-hyperpod-training-operator \\
                --region \$AWS_REGION \\
                --resolve-conflicts OVERWRITE 2>&1 || true
        fi

        # Wait for ACTIVE or failure
        echo "Waiting for addon to become ACTIVE..."
        for i in {1..60}; do
            STATUS=\$(aws eks describe-addon \\
                --cluster-name \$EKS_CLUSTER_NAME \\
                --addon-name amazon-sagemaker-hyperpod-training-operator \\
                --region \$AWS_REGION \\
                --query "addon.status" \\
                --output text 2>/dev/null || echo "UNKNOWN")

            if [ "\$STATUS" = "ACTIVE" ]; then
                echo "✅ Training Operator addon is now ACTIVE!"
                exit 0
            elif [ "\$STATUS" = "CREATE_FAILED" ]; then
                echo "❌ Addon creation failed"
                aws eks describe-addon \\
                    --cluster-name \$EKS_CLUSTER_NAME \\
                    --addon-name amazon-sagemaker-hyperpod-training-operator \\
                    --region \$AWS_REGION \\
                    --query "addon.health.issues" 2>/dev/null || true
                break
            fi

            echo "Status: \$STATUS (\$i/60)"
            sleep 10
        done

        if [ \$ATTEMPT -lt \$MAX_RETRIES ]; then
            echo "Waiting \$RETRY_DELAY seconds before retry..."
            sleep \$RETRY_DELAY
        fi
    done

    echo "❌ Failed to install Training Operator addon after \$MAX_RETRIES attempts"
    exit 1
    '`;

    await this.executeNonBlocking(commands);
  }

  /**
   * 安装 Training Operator addon（带重试 - 别名）
   */
  static async installTrainingOperatorAddonWithRetry(configDir) {
    return this.installTrainingOperatorAddon(configDir);
  }

  /**
   * 验证 Training Operator 安装
   */
  static async verifyTrainingOperatorInstallation(configDir) {
    console.log('Verifying Training Operator installation...');

    const commands = `cd ${configDir} && bash -c 'source cluster_envs &&

    echo "=========================================="
    echo "Verifying Installation"
    echo "=========================================="

    STATUS=\$(aws eks describe-addon \\
        --cluster-name \$EKS_CLUSTER_NAME \\
        --addon-name amazon-sagemaker-hyperpod-training-operator \\
        --region \$AWS_REGION \\
        --query "addon.status" \\
        --output text 2>/dev/null || echo "NOT_FOUND")

    echo "Addon status: \$STATUS"

    echo ""
    echo "Checking pods..."
    kubectl get pods -n aws-hyperpod -o wide 2>/dev/null || echo "No pods found yet"

    echo ""
    echo "Verification completed"
    '`;

    await this.executeNonBlocking(commands);
  }

  /**
   * 检查HyperPod依赖配置状态
   */
  static async checkHyperPodDependencyStatus(configDir) {
    try {
      const checkCmd = `cd ${configDir} && bash -c 'source cluster_envs &&
        aws eks describe-addon --cluster-name $EKS_CLUSTER_NAME --addon-name amazon-sagemaker-hyperpod-training-operator --region $AWS_REGION --query "addon.status" --output text 2>/dev/null || echo "NOT_INSTALLED"
      '`;

      const result = execSync(checkCmd, { encoding: 'utf8' }).trim();

      return {
        success: true,
        status: result,
        isConfigured: result === 'ACTIVE'
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        isConfigured: false
      };
    }
  }

  /**
   * 清理HyperPod依赖配置
   */
  static async cleanupHyperPodDependencies(configDir) {
    try {
      console.log('Cleaning up HyperPod dependencies...');

      const cleanupCmd = `cd ${configDir} && bash -c 'source cluster_envs &&
      source cluster_envs &&
        aws eks delete-addon --cluster-name $EKS_CLUSTER_NAME --addon-name amazon-sagemaker-hyperpod-training-operator --region $AWS_REGION || true
        aws eks delete-pod-identity-association --cluster-name $EKS_CLUSTER_NAME --association-arn $(aws eks list-pod-identity-associations --cluster-name $EKS_CLUSTER_NAME --region $AWS_REGION --query "associations[?serviceAccount==\`hp-training-operator-controller-manager\`].associationArn" --output text) --region $AWS_REGION || true
        echo "HyperPod dependencies cleanup completed"
      '`;

      execSync(cleanupCmd, { stdio: 'inherit' });

      return { success: true };

    } catch (error) {
      console.error('Error cleaning up HyperPod dependencies:', error);
      throw error;
    }
  }

  /**
   * 配置 HyperPod Pod Identity 权限
   */
  static async configureHyperPodPodIdentity(clusterConfigDir) {
    console.log('Configuring HyperPod Pod Identity permissions...');

    const commands = `cd ${clusterConfigDir} && bash -c 'source cluster_envs &&

    EXECUTION_ROLE=\${EXECUTION_ROLE:-\$SAGEMAKER_ROLE_ARN}
    if [ -z "\$EXECUTION_ROLE" ]; then
        echo "No EXECUTION_ROLE found, skipping Pod Identity configuration"
        exit 0
    fi

    EXEC_ROLE_NAME=\${EXECUTION_ROLE##*/}
    echo "Using execution role: \$EXEC_ROLE_NAME"

    echo "Adding SageMaker DescribeClusterNode policy..."
    aws iam put-role-policy \\
        --role-name \$EXEC_ROLE_NAME \\
        --policy-name SageMakerDescribeClusterNode \\
        --policy-document '"'"'{
          "Version": "2012-10-17",
          "Statement": [{
            "Effect": "Allow",
            "Action": ["sagemaker:DescribeClusterNode"],
            "Resource": "*"
          }]
        }'"'"'

    echo "Updating assume role policy for EKS Pod Identity..."
    aws iam update-assume-role-policy \\
        --role-name \$EXEC_ROLE_NAME \\
        --policy-document '"'"'{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"Service": "sagemaker.amazonaws.com"},
                "Action": "sts:AssumeRole"
            },
            {
                "Sid": "AllowEksAuthToAssumeRoleForPodIdentity",
                "Effect": "Allow",
                "Principal": {"Service": "pods.eks.amazonaws.com"},
                "Action": ["sts:AssumeRole", "sts:TagSession"]
            }
        ]
    }'"'"'

    echo "Creating Pod Identity Association..."
    aws eks create-pod-identity-association \\
        --cluster-name \$EKS_CLUSTER_NAME \\
        --role-arn \$EXECUTION_ROLE \\
        --namespace aws-hyperpod \\
        --service-account hp-training-operator-controller-manager \\
        --region \$AWS_REGION 2>&1 || echo "Pod Identity Association may already exist"

    echo "✅ Pod Identity configuration completed"
    '`;

    await this.executeNonBlocking(commands);
  }

  /**
   * 等待 AWS Load Balancer Controller webhook 就绪
   */
  static async waitForLoadBalancerWebhook(configDir) {
    console.log('Waiting for AWS Load Balancer Controller webhook...');

    const commands = `cd ${configDir} && bash -c 'source cluster_envs &&
    kubectl wait --for=condition=available deployment/aws-load-balancer-controller -n kube-system --timeout=300s || true
    for i in {1..30}; do
        ENDPOINTS=\$(kubectl get endpoints aws-load-balancer-webhook-service -n kube-system -o jsonpath="{.subsets[*].addresses[*].ip}" 2>/dev/null)
        if [ -n "\$ENDPOINTS" ]; then
            echo "Webhook endpoints ready: \$ENDPOINTS"
            break
        fi
        echo "Waiting... (\$i/30)"
        sleep 5
    done
    echo "LBC webhook check completed"
    '`;

    await this.executeNonBlocking(commands);
  }
}

module.exports = HyperPodDependencyManager;
