const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const dependencyConfig = require('./dependencyConfigLoader');

class ClusterDependencyManager {
  
  /**
   * 执行非阻塞命令
   */
  static async executeNonBlocking(command, options = {}) {
    return new Promise((resolve, reject) => {
      // 添加日志头部
      const logFile = '/app/tmp/cluster-dependency.log';
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
   * 配置kubectl和OIDC provider
   */
  static async configureKubectlAndOIDC(clusterConfigDir) {
    console.log('Configuring kubectl and OIDC...');
    
    const kubectlCmd = `cd ${clusterConfigDir} && bash -c 'source cluster_envs && 
echo "=== Configuring kubectl for cluster: $EKS_CLUSTER_NAME ===" &&
aws eks update-kubeconfig --name $EKS_CLUSTER_NAME --region $AWS_REGION &&
echo "=== Associating IAM OIDC provider ===" &&
eksctl utils associate-iam-oidc-provider --region $AWS_REGION --cluster $EKS_CLUSTER_NAME --approve &&
echo "=== kubectl and OIDC configuration completed ==="'`;
    
    await this.executeNonBlocking(kubectlCmd);
  }

  /**
   * 安装Helm依赖
   */
  static async installHelmDependencies(clusterConfigDir) {
    console.log('Installing helm dependencies...');
    
    // 分步执行，便于调试和错误处理
    await this.setupHelmRepos(clusterConfigDir);
    await this.cloneHyperPodCLI(clusterConfigDir);
    await this.createNamespaces(clusterConfigDir);
    await this.installHyperPodChart(clusterConfigDir);
  }

  /**
   * 设置Helm仓库
   */
  static async setupHelmRepos(clusterConfigDir) {
    console.log('Setting up helm repositories...');
    
    const repoCmd = `cd ${clusterConfigDir} && 
echo "=== Setting up Helm repositories ===" &&
helm repo add eks https://aws.github.io/eks-charts --debug &&
helm repo add nvidia https://nvidia.github.io/k8s-device-plugin --debug &&
echo "=== Updating Helm repositories ===" &&
helm repo update --debug &&
echo "=== Helm repositories setup completed ==="`;
    
    await this.executeNonBlocking(repoCmd);
  }

  /**
   * 克隆HyperPod CLI仓库（支持通过配置锁定 tag 版本）
   */
  static async cloneHyperPodCLI(clusterConfigDir) {
    console.log('Cloning SageMaker HyperPod CLI repository...');

    const cliVersion = dependencyConfig.load().hyperpodHelmChart.cliVersion;
    const branchFlag = cliVersion ? `--branch ${cliVersion} --depth 1` : '';

    const cloneCmd = `cd ${clusterConfigDir} &&
if [ ! -d "./sagemaker-hyperpod-cli" ]; then
  echo "Cloning SageMaker HyperPod CLI repository (version: ${cliVersion || 'latest main'})..."
  git clone ${branchFlag} https://github.com/aws/sagemaker-hyperpod-cli.git
else
  echo "SageMaker HyperPod CLI repository already exists, skipping clone..."
fi`;

    await this.executeNonBlocking(cloneCmd);
  }

  /**
   * 创建必要的命名空间
   * 同时打上 Helm 接管的 label/annotation，避免后续 `helm install hyperpod-dependencies`
   * 因为 namespace 已存在但缺少 ownership metadata 而报 "cannot be imported" 错误。
   */
  static async createNamespaces(clusterConfigDir) {
    console.log('Creating namespaces...');
    const namespaceCmd = `cd ${clusterConfigDir} && bash -c 'source cluster_envs &&
kubectl create namespace aws-hyperpod --dry-run=client -o yaml | kubectl apply -f - &&
kubectl create namespace kubeflow --dry-run=client -o yaml | kubectl apply -f - &&
for ns in aws-hyperpod kubeflow; do
  kubectl label namespace "$ns" app.kubernetes.io/managed-by=Helm --overwrite
  kubectl annotate namespace "$ns" meta.helm.sh/release-name=hyperpod-dependencies meta.helm.sh/release-namespace=kube-system --overwrite
done'`;

    await this.executeNonBlocking(namespaceCmd);
  }

  /**
   * 安装HyperPod Helm Chart
   * 只服务 HyperPod 节点（chart 默认 affinity 就是 ml.* 白名单）。
   */
  static async installHyperPodChart(clusterConfigDir) {
    console.log('Installing HyperPod helm chart...');

    const { efaDevicePluginImageTag } = dependencyConfig.load().hyperpodHelmChart;

    // 与 chart 默认值一致地声明开关；字段必须精确匹配 Chart.yaml 里的 condition key。
    const values = {
      'cert-manager': { enabled: false },
      'neuron-device-plugin': { devicePlugin: { enabled: false } },
      'nvidia-device-plugin': { devicePlugin: { enabled: true } },
      'aws-efa-k8s-device-plugin': {
        devicePlugin: { enabled: true },
        ...(efaDevicePluginImageTag && { image: { tag: efaDevicePluginImageTag } }),
      },
      'health-monitoring-agent': { enabled: true },
      'hyperpod-patching': { enabled: true },
      mlflow: { enabled: false },
      'mpi-operator': { enabled: false },
      trainingOperators: { enabled: false },
      inferenceOperators: { enabled: false },
      'deep-health-check': { enabled: false },
      'job-auto-restart': { enabled: false },
      storage: { enabled: false },
      'cluster-role-and-bindings': { enabled: false },
      'namespaced-role-and-bindings': { enabled: false },
      'team-role-and-bindings': { enabled: false },
      'gpu-operator': { enabled: false },
    };

    const valuesPath = path.join(clusterConfigDir, 'hyperpod-values-override.yaml');
    fs.writeFileSync(valuesPath, yaml.stringify(values));
    console.log(`Wrote helm overrides to ${valuesPath}`);

    const installCmd = `cd ${clusterConfigDir} && bash -c 'source cluster_envs &&
echo "=== Building HyperPod Helm Chart dependencies ===" &&
helm dependency build sagemaker-hyperpod-cli/helm_chart/HyperPodHelmChart --debug &&
echo "=== Installing HyperPod Helm Chart ===" &&
echo "Cluster: \$EKS_CLUSTER_NAME" &&
echo "Region: \$AWS_REGION" &&
echo "--- values override ---" && cat hyperpod-values-override.yaml && echo "--- end ---" &&
helm upgrade --install hyperpod-dependencies ./sagemaker-hyperpod-cli/helm_chart/HyperPodHelmChart --kube-context arn:aws:eks:\$AWS_REGION:\$(aws sts get-caller-identity --query Account --output text):cluster/\$EKS_CLUSTER_NAME --namespace kube-system -f hyperpod-values-override.yaml --atomic --timeout=10m &&
echo "=== HyperPod Helm Chart installation completed ==="'`;

    await this.executeNonBlocking(installCmd);
  }


  static async installGeneralDependencies(clusterConfigDir) {
    console.log('Installing EKS general dependencies...');
    
    const commands = `cd ${clusterConfigDir} && bash -c 'source cluster_envs && 
    
    # 安装S3 CSI驱动程序
    echo "=== Installing S3 CSI Driver ==="
    
    # 获取账户ID
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    ROLE_NAME=SM_HP_S3_CSI_ROLE_$EKS_CLUSTER_NAME
    
    # 创建IAM服务账户和角色
    echo "Creating IAM service account for S3 CSI driver..."
    eksctl create iamserviceaccount \\
        --name s3-csi-driver-sa \\
        --namespace kube-system \\
        --override-existing-serviceaccounts \\
        --cluster $EKS_CLUSTER_NAME \\
        --attach-policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess \\
        --role-name $ROLE_NAME \\
        --approve \\
        --role-only || echo "S3 CSI service account already exists"
    
    # 获取角色ARN
    ROLE_ARN=$(aws iam get-role --role-name $ROLE_NAME --query "Role.Arn" --output text)
    
    # 安装S3 CSI驱动程序addon
    echo "Installing S3 CSI driver addon..."
    eksctl create addon \\
        --name aws-mountpoint-s3-csi-driver \\
        --cluster $EKS_CLUSTER_NAME \\
        --service-account-role-arn $ROLE_ARN \\
        --force || echo "S3 CSI driver addon already exists"
    
    echo "S3 CSI Driver installation completed"
        
    echo "EKS general dependencies installation completed"
    '`;
    
    await this.executeNonBlocking(commands);
  }

  /**
   * 安装 FSx Dependencies
   */
  static async installFSxDependencies(clusterConfigDir) {
    console.log('Installing FSx dependencies...');
    
    const commands = `cd ${clusterConfigDir} && bash -c 'source cluster_envs && 
    
    echo "=== Installing FSx CSI Driver ==="
    
    # 获取账户ID
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    ROLE_NAME=SM_HP_FSX_CSI_ROLE_$EKS_CLUSTER_NAME
    
    # 创建IAM服务账户和角色
    echo "Creating IAM service account for FSx CSI driver..."
    eksctl create iamserviceaccount \\
        --name fsx-csi-controller-sa \\
        --namespace kube-system \\
        --override-existing-serviceaccounts \\
        --cluster $EKS_CLUSTER_NAME \\
        --attach-policy-arn arn:aws:iam::aws:policy/AmazonFSxFullAccess \\
        --role-name $ROLE_NAME \\
        --region $AWS_REGION \\
        --approve \\
        --role-only || echo "FSx CSI service account already exists"
    
    # 获取角色ARN
    ROLE_ARN=$(aws iam get-role --role-name $ROLE_NAME --query "Role.Arn" --output text)
    
    # 安装 FSx CSI Driver addon
    echo "Installing FSx CSI driver addon..."
    eksctl create addon \\
        --name aws-fsx-csi-driver \\
        --cluster $EKS_CLUSTER_NAME \\
        --service-account-role-arn $ROLE_ARN \\
        --region $AWS_REGION \\
        --force || echo "FSx CSI driver addon already exists"
    
    echo "FSx CSI Driver installation completed"
    '`;

    await this.executeNonBlocking(commands);
  }


  static async installnlbDependencies(clusterConfigDir) {
    console.log('Installing NLB dependencies...');
    
    const commands = `cd ${clusterConfigDir} && bash -c 'source cluster_envs && 
    
    # 动态获取 ACCOUNT_ID 和 VPC_ID
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    VPC_ID=$(aws eks describe-cluster --name $EKS_CLUSTER_NAME --region $AWS_REGION --query "cluster.resourcesVpcConfig.vpcId" --output text)
    
    # 下载ALB IAM策略
    curl -o /tmp/alb-iam-policy.json https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.13.0/docs/install/iam_policy.json

    # 检查并处理IAM策略
    echo "Checking IAM policy status..."
    POLICY_ARN="arn:aws:iam::\$ACCOUNT_ID:policy/AWSLoadBalancerControllerIAMPolicy"
    
    if aws iam get-policy --policy-arn "\$POLICY_ARN" >/dev/null 2>&1; then
        echo "Policy already exists, skipping creation"
    else
        echo "Creating IAM policy..."
        aws iam create-policy \\
            --policy-name AWSLoadBalancerControllerIAMPolicy \\
            --policy-document file:///tmp/alb-iam-policy.json || echo "Policy creation failed"
    fi

    # 删除现有的AWS Load Balancer Controller（如果存在）
    echo "Removing existing AWS Load Balancer Controller..."
    helm uninstall aws-load-balancer-controller -n kube-system >> /app/tmp/dependency-install.log 2>&1 || echo "No existing controller found"
    
    # 等待清理完成
    echo "Waiting for cleanup to complete..."
    sleep 10
    
    # 等待webhook service完全清理
    while kubectl get service aws-load-balancer-webhook-service -n kube-system >/dev/null 2>&1; do
        echo "Waiting for webhook service to be removed..."
        sleep 5
    done

    # 创建IAM服务账户（先删除再创建确保干净状态）
    echo "Ensuring clean ServiceAccount state..."
    eksctl delete iamserviceaccount --cluster=\$EKS_CLUSTER_NAME --namespace=kube-system --name=aws-load-balancer-controller >> /app/tmp/dependency-install.log 2>&1 || echo "ServiceAccount not found, proceeding..."
    
    # 使用短的角色名称避免64字符限制
    ROLE_NAME="ALB-\$EKS_CLUSTER_NAME"
    
    echo "Creating ServiceAccount for AWS Load Balancer Controller..."
    eksctl create iamserviceaccount \\
      --cluster=\$EKS_CLUSTER_NAME \\
      --namespace=kube-system \\
      --name=aws-load-balancer-controller \\
      --role-name=\$ROLE_NAME \\
      --attach-policy-arn=arn:aws:iam::\$ACCOUNT_ID:policy/AWSLoadBalancerControllerIAMPolicy \\
      --region=\$AWS_REGION \\
      --override-existing-serviceaccounts \\
      --approve
    
    # 验证ServiceAccount创建成功
    if ! kubectl get serviceaccount aws-load-balancer-controller -n kube-system >/dev/null 2>&1; then
        echo "❌ Failed to create ServiceAccount"
        exit 1
    fi
    echo "✅ ServiceAccount created successfully"

    # 获取公有子网并添加ELB标签
    echo "Tagging public subnets for ELB..."
    PUBLIC_SUBNETS=\$(aws ec2 describe-subnets \\
        --filters "Name=vpc-id,Values=\${VPC_ID}" "Name=map-public-ip-on-launch,Values=true" \\
        --query "Subnets[*].SubnetId" \\
        --output text)
    
    for SUBNET_ID in \$PUBLIC_SUBNETS; do
        echo "Tagging public subnet: \$SUBNET_ID"
        aws ec2 create-tags --resources \$SUBNET_ID --tags Key=kubernetes.io/role/elb,Value=1 >> /app/tmp/dependency-install.log 2>&1 || echo "Failed to tag \$SUBNET_ID"
    done

    # 安装AWS Load Balancer Controller
    echo "Installing AWS Load Balancer Controller..."
    helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \\
      -n kube-system \\
      --set clusterName=\$EKS_CLUSTER_NAME \\
      --set serviceAccount.create=false \\
      --set serviceAccount.name=aws-load-balancer-controller \\
      --set vpcId=\$VPC_ID \\
      --set region=\$AWS_REGION \\
      --timeout=300s

    # 验证Controller安装状态（不等待Pod就绪）
    echo "Checking AWS Load Balancer Controller installation..."
    helm list -n kube-system | grep aws-load-balancer-controller || echo "Controller not found in helm list"

    # 最终状态检查
    echo "Final status check..."
    if kubectl get deployment aws-load-balancer-controller -n kube-system >/dev/null 2>&1; then
        echo "✅ AWS Load Balancer Controller deployment exists"
    else
        echo "⚠️  AWS Load Balancer Controller deployment not found"
    fi
    
    if kubectl get serviceaccount aws-load-balancer-controller -n kube-system >/dev/null 2>&1; then
        echo "✅ ServiceAccount exists"
    else
        echo "⚠️  ServiceAccount not found"
    fi

    echo "NLB dependencies installation completed"
    '`;
    
    await this.executeNonBlocking(commands);
  }

    // # 确保ServiceAccount有正确的IAM角色注解
    // kubectl annotate serviceaccount aws-load-balancer-controller -n kube-system \\
    //   eks.amazonaws.com/role-arn=arn:aws:iam::\$ACCOUNT_ID:role/eksctl-\$EKS_CLUSTER_NAME-addon-iamserviceaccount-kube-system-aws-load-balancer-controller \\
    //   --overwrite || echo "Failed to annotate service account"

  /**
   * 安装 cert-manager EKS addon（必须在 AWS LB Controller 之前）
   */
  static async installCertManager(clusterConfigDir) {
    console.log('Installing cert-manager addon...');
    
    const commands = `cd ${clusterConfigDir} && bash -c 'source cluster_envs && 

    echo "Creating cert-manager addon..."
    aws eks create-addon \\
        --cluster-name \$EKS_CLUSTER_NAME \\
        --addon-name cert-manager \\
        --region \$AWS_REGION \\
        --configuration-values '"'"'{"replicaCount":1,"cainjector":{"replicaCount":1},"webhook":{"replicaCount":1}}'"'"' \\
        --resolve-conflicts OVERWRITE >> /app/tmp/dependency-install.log 2>&1 || echo "cert-manager addon already exists"

    # kubectl scale deployment cert-manager cert-manager-cainjector cert-manager-webhook -n cert-manager --replicas=1

    echo "Waiting for cert-manager to be ready..."
    MAX_WAIT=20
    WAIT_COUNT=0
    
    while [ \$WAIT_COUNT -lt \$MAX_WAIT ]; do
        CERT_STATUS=\$(aws eks describe-addon \\
            --cluster-name \$EKS_CLUSTER_NAME \\
            --addon-name cert-manager \\
            --region \$AWS_REGION \\
            --query "addon.status" \\
            --output text 2>/dev/null || echo "UNKNOWN")
        
        if [ "\$CERT_STATUS" = "ACTIVE" ]; then
            echo "✅ cert-manager is ready (ACTIVE)"
            break
        elif [ "\$CERT_STATUS" = "CREATE_FAILED" ] || [ "\$CERT_STATUS" = "DEGRADED" ]; then
            echo "⚠️  cert-manager status: \$CERT_STATUS, but continuing..."
            break
        else
            echo "cert-manager status: \$CERT_STATUS, waiting... (\$((WAIT_COUNT+1))/\$MAX_WAIT)"
            sleep 15
            WAIT_COUNT=\$((WAIT_COUNT+1))
        fi
    done

    echo "cert-manager installation completed"
    '`;
    
    await this.executeNonBlocking(commands);
  }


  /**
   * 安装 EKS Pod Identity Agent（所有集群都需要）
   */
  static async installEKSPodIdentity(clusterConfigDir) {
    console.log('Installing EKS Pod Identity Agent...');
    
    const commands = `cd ${clusterConfigDir} && bash -c 'source cluster_envs && 

    # 创建EKS Pod Identity Agent addon
    echo "Creating EKS Pod Identity Agent addon..."
    aws eks create-addon \\
        --cluster-name \$EKS_CLUSTER_NAME \\
        --addon-name eks-pod-identity-agent \\
        --region \$AWS_REGION \\
        --resolve-conflicts OVERWRITE >> /app/tmp/dependency-install.log 2>&1 || echo "Pod Identity Agent addon already exists"

    echo "EKS Pod Identity Agent installation completed"
    '`;
    
    await this.executeNonBlocking(commands);
  }



  /**
   * 导入集群的依赖配置流程
   */
  static async configureImportedClusterDependencies(clusterTag, clusterManager) {
    try {
      console.log(`Configuring imported cluster dependencies for: ${clusterTag}`);
      
      const clusterDir = clusterManager.getClusterDir(clusterTag);
      const configDir = path.join(clusterDir, 'config');
      
      if (!fs.existsSync(configDir)) {
        throw new Error(`Cluster config directory not found: ${configDir}`);
      }
      
      // 步骤 1: 配置 kubectl 和 OIDC
      await this.configureKubectlAndOIDC(configDir);

      // 步骤 2: 安装 S3 CSI Driver
      await this.installGeneralDependencies(configDir);


      console.log(`Successfully configured imported cluster dependencies for: ${clusterTag}`);
      return { success: true };
      
    } catch (error) {
      console.error(`Error configuring imported cluster dependencies for ${clusterTag}:`, error);
      throw error;
    }
  }

  /**
   * EKS集群基础依赖配置流程（不包含HyperPod专用依赖）
   * 路由方法：根据集群类型选择配置流程
   */
  static async configureClusterDependencies(clusterTag, clusterManager) {
    try {
      // 获取集群类型
      const MetadataUtils = require('./metadataUtils');
      const clusterType = MetadataUtils.getClusterType(clusterTag);
      
      // 检查是否是导入的 raw EKS 集群（需要完整的 HyperPod 依赖）
      const clusterDir = clusterManager.getClusterDir(clusterTag);
      const importMetadataPath = path.join(clusterDir, 'metadata', 'import_metadata.json');
      let isRawEKS = false;
      
      if (clusterType === 'imported' && fs.existsSync(importMetadataPath)) {
        const importMetadata = JSON.parse(fs.readFileSync(importMetadataPath, 'utf8'));
        // 如果是导入的 EKS 集群（不是已有 HyperPod 的集群），标记为 raw EKS
        isRawEKS = importMetadata.importType === 'eks' || !importMetadata.hasHyperPod;
      }
      
      if (clusterType === 'imported' && !isRawEKS) {
        // 导入的已有 HyperPod 的集群使用简化流程
        return await this.configureImportedClusterDependencies(clusterTag, clusterManager);
      } else {
        // 创建的集群或导入的 raw EKS 集群使用完整流程（包含 HyperPod Helm Chart）
        console.log(`Using full dependency configuration for ${clusterType === 'imported' ? 'imported raw EKS' : 'created'} cluster: ${clusterTag}`);
        return await this.configureCreatedClusterDependencies(clusterTag, clusterManager);
      }
      
    } catch (error) {
      console.error(`Error configuring cluster dependencies for ${clusterTag}:`, error);
      throw error;
    }
  }

  /**
   * 创建集群的依赖配置流程（完整版）
   */
  static async configureCreatedClusterDependencies(clusterTag, clusterManager) {
    try {
      console.log(`Configuring created cluster dependencies for: ${clusterTag}`);
      
      // 获取集群配置目录
      const clusterDir = clusterManager.getClusterDir(clusterTag);
      const configDir = path.join(clusterDir, 'config');
      
      // 验证配置目录存在
      if (!fs.existsSync(configDir)) {
        throw new Error(`Cluster config directory not found: ${configDir}`);
      }
      
      await this.configureKubectlAndOIDC(configDir);

      const depConfig = dependencyConfig.load();


      // 安装 HyperPod Helm Chart（可通过配置关闭，适用于纯 EKS Node Group 场景）
      if (depConfig.hyperpodHelmChart.enabled) {
        await this.installHelmDependencies(configDir);
      } else {
        console.log('HyperPod Helm Chart is disabled in config, skipping');
      }


      // [2026-04-08] cert-manager 已整合到 training operator 一起管理（安装/卸载）
      // 不再在 configure dependency 阶段安装，改由 managedFeaturesManager 和 hyperPodDependencyManager 负责
      // await this.installCertManager(configDir);

      // 安装 EKS Pod Identity Agent（所有集群都需要）
      await this.installEKSPodIdentity(configDir);

      // await this.installnlbDependencies(configDir);
      
      await this.installGeneralDependencies(configDir);

      console.log(`Successfully configured created cluster dependencies for: ${clusterTag}`);
      return { success: true };
      
    } catch (error) {
      console.error(`Error configuring created cluster dependencies for ${clusterTag}:`, error);
      throw error;
    }
  }

  /**
   * 检查依赖配置状态
   */
  static async checkDependencyStatus(clusterConfigDir) {
    try {
      // 检查helm chart是否安装
      const helmCheckCmd = `cd ${clusterConfigDir} && bash -c 'source cluster_envs && helm list -n kube-system | grep hyperpod-dependencies'`;
      let hasHelmChart = false;
      
      try {
        execSync(helmCheckCmd, { stdio: 'pipe' });
        hasHelmChart = true;
      } catch (error) {
        hasHelmChart = false;
      }
      
      return {
        hasHelmChart,
        isConfigured: hasHelmChart
      };
      
    } catch (error) {
      console.error('Error checking dependency status:', error);
      return {
        hasHelmChart: false,
        isConfigured: false,
        error: error.message
      };
    }
  }

  /**
   * 清理依赖配置（用于重新配置或错误恢复）
   */
  static async cleanupDependencies(clusterConfigDir) {
    try {
      console.log('Cleaning up cluster dependencies...');
      
      // 卸载helm chart
      const uninstallCmd = `cd ${clusterConfigDir} && bash -c 'source cluster_envs && 
helm uninstall hyperpod-dependencies -n kube-system || true'`;
      
      execSync(uninstallCmd, { stdio: 'inherit' });
      
      // 删除克隆的仓库
      const repoPath = path.join(clusterConfigDir, 'sagemaker-hyperpod-cli');
      if (fs.existsSync(repoPath)) {
        execSync(`rm -rf ${repoPath}`, { stdio: 'inherit' });
      }
      
      console.log('Successfully cleaned up dependencies');
      return { success: true };
      
    } catch (error) {
      console.error('Error cleaning up dependencies:', error);
      throw error;
    }
  }

  /**
   * 获取VPC中的NAT Gateway ID
   * @param {string} vpcId - VPC ID
   * @param {string} region - AWS区域
   * @returns {Promise<string>} NAT Gateway ID
   */
  static async getNatGatewayId(vpcId, region) {
    try {
      const command = `aws ec2 describe-nat-gateways --region ${region} --filter "Name=vpc-id,Values=${vpcId}" "Name=state,Values=available" --query 'NatGateways[0].NatGatewayId' --output text`;
      const result = execSync(command, { encoding: 'utf8' }).trim();
      
      if (result === 'None' || !result) {
        console.warn(`No available NAT Gateway found in VPC ${vpcId}`);
        return 'nat-placeholder';
      }
      
      return result;
    } catch (error) {
      console.error('Error getting NAT Gateway:', error);
      return 'nat-placeholder';
    }
  }
}

module.exports = ClusterDependencyManager;
