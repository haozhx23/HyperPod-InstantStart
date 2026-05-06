const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getCurrentAccountId } = require('./awsHelpers');

/**
 * HyperPod Inference Operator Manager
 *
 * 通过 EKS add-on 管理 SageMaker HyperPod Inference Operator，与 SageMaker console
 * 的安装方式完全对齐（addon name: amazon-sagemaker-hyperpod-inference）。
 *
 * 安装流程（闭环创建）：
 *   1. 前置依赖 addon precheck（缺失则自动补装）
 *   2. 创建 IAM Roles（Execution / ALB / KEDA / JumpStart Gated）
 *   3. 创建 TLS 证书 S3 bucket（命名 hyperpod-tls-*）
 *   4. 给 public subnets 打 kubernetes.io/role/elb=1 tag
 *   5. 创建 S3 VPC Gateway endpoint（如不存在）
 *   6. aws eks create-addon amazon-sagemaker-hyperpod-inference
 *   7. 轮询直到 ACTIVE
 *   8. 保存 metadata（方便卸载闭环）
 *
 * 卸载流程（闭环删除）：
 *   1. aws eks delete-addon amazon-sagemaker-hyperpod-inference + 等待消失
 *   2. 删除 4 个 IAM Role + Policy
 *   3. 清空并删除 TLS S3 bucket
 *   4. 清理 metadata
 *   （VPC endpoint / subnet tag 不删，可能被其他服务共用）
 */
class InferenceOperatorManager {
  // EKS addon 核心常量
  static ADDON_NAME = 'amazon-sagemaker-hyperpod-inference';
  static NAMESPACE = 'hyperpod-inference-system';

  // 前置依赖 addon 列表（console Quick Install 会检查这几个）
  static DEPENDENCY_ADDONS = [
    { name: 'aws-mountpoint-s3-csi-driver', minVersion: 'v1.14.1-eksbuild.1', requiresSaRole: true },
    { name: 'aws-fsx-csi-driver', minVersion: 'v1.6.0-eksbuild.1', requiresSaRole: true },
    { name: 'metrics-server', minVersion: 'v0.7.2-eksbuild.4', requiresSaRole: false },
    { name: 'cert-manager', minVersion: 'v1.18.2-eksbuild.2', requiresSaRole: false },
  ];

  // 托管 policy（与 console 对齐）
  static MANAGED_INFERENCE_ACCESS = 'arn:aws:iam::aws:policy/AmazonSageMakerHyperPodInferenceAccess';
  static MANAGED_GATED_MODEL_ACCESS = 'arn:aws:iam::aws:policy/AmazonSageMakerHyperPodGatedModelAccess';
  static MANAGED_FSX_FULL_ACCESS = 'arn:aws:iam::aws:policy/AmazonFSxFullAccess';

  // ALB controller iam_policy 文档 URL（官方文档一致）
  static ALB_IAM_POLICY_URL =
    'https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.13.0/docs/install/iam_policy.json';

  // 轮询参数
  static ADDON_POLL_INTERVAL_MS = 15000; // 15s
  static ADDON_POLL_TIMEOUT_MS = 20 * 60 * 1000; // 20min

  constructor(clusterManager) {
    this.clusterManager = clusterManager;
  }

  // ============ IAM 资源命名规则（项目自有，方便调试和闭环清理） ============
  _roleNames(clusterTag) {
    return {
      execution: `SageMakerHyperPodInference-${clusterTag}`,
      alb: `HyperPodInferenceALB-${clusterTag}`,
      keda: `HyperPodInferenceKEDA-${clusterTag}`,
      gated: `HyperPodInferenceGated-${clusterTag}`,
    };
  }

  _policyNames(clusterTag) {
    return {
      // Execution role 直接挂托管 policy，无需自有 policy
      alb: `HyperPodInferenceALB-${clusterTag}-Policy`,
      keda: `HyperPodInferenceKEDA-${clusterTag}-Policy`,
      // Gated role 也直接挂托管 policy
    };
  }

  // ================================================================
  // 公开接口：checkStatus / install / uninstall / getAmpWorkspace
  // ================================================================

  /**
   * 查询 Inference Operator 状态（查 EKS addon）
   * 返回结构与旧版保持兼容：{ installed, iamRoles, namespace, helmRelease }
   */
  async checkStatus() {
    const activeClusterName = this.clusterManager.getActiveCluster();
    if (!activeClusterName) {
      return { installed: false, iamRoles: {}, namespace: InferenceOperatorManager.NAMESPACE, helmRelease: null };
    }

    try {
      const { eksClusterName, region } = await this._getClusterInfo(activeClusterName);
      if (!eksClusterName) {
        return { installed: false, iamRoles: {}, namespace: InferenceOperatorManager.NAMESPACE, helmRelease: null };
      }

      const addonStatus = await this._describeAddon(eksClusterName, region);
      const installed = addonStatus === 'ACTIVE';

      // 读 IAM role ARN（只读，不创建）
      const iamRoles = await this._readIamRoles(activeClusterName);

      return {
        installed,
        addonStatus,
        iamRoles,
        namespace: InferenceOperatorManager.NAMESPACE,
        helmRelease: null, // 已弃用 helm，始终返回 null
      };
    } catch (error) {
      console.error('Error checking inference operator status:', error.message);
      return { installed: false, iamRoles: {}, namespace: InferenceOperatorManager.NAMESPACE, helmRelease: null };
    }
  }

  /**
   * 安装 Inference Operator（完整闭环）
   */
  async install() {
    const activeClusterName = this.clusterManager.getActiveCluster();
    if (!activeClusterName) {
      throw new Error('No active cluster found');
    }

    const info = await this._getClusterInfo(activeClusterName);
    const { region, eksClusterName, accountId, oidcId, vpcId } = info;

    console.log('[InferenceOperator] Starting installation...');
    const steps = [];

    // Step 0: 幂等检查 - 如果 addon 已 ACTIVE，跳过
    const currentStatus = await this._describeAddon(eksClusterName, region);
    if (currentStatus === 'ACTIVE') {
      console.log('[InferenceOperator] Addon already ACTIVE, skipping install');
      return {
        success: true,
        message: 'Inference Operator addon is already installed and ACTIVE',
        skipped: true,
        iamRoles: await this._readIamRoles(activeClusterName),
      };
    }
    if (currentStatus === 'CREATING') {
      console.log('[InferenceOperator] Addon is CREATING, waiting to ACTIVE...');
      await this._waitAddonActive(eksClusterName, region);
      return { success: true, message: 'Inference Operator addon reached ACTIVE', iamRoles: await this._readIamRoles(activeClusterName) };
    }
    // 如果是 CREATE_FAILED / DEGRADED，先删除再重装
    if (currentStatus === 'CREATE_FAILED' || currentStatus === 'DEGRADED') {
      console.log(`[InferenceOperator] Addon in ${currentStatus} state, deleting before reinstall...`);
      await this._deleteAddon(eksClusterName, region);
      await this._waitAddonDeleted(eksClusterName, region);
    }

    // Step 1: 前置依赖 addon precheck + 自动补装
    console.log('[InferenceOperator] Step 1: Checking dependency addons...');
    const depResult = await this._ensureDependencyAddons(eksClusterName, region, accountId);
    steps.push({ step: 'dependencies', ...depResult });

    // Step 2: 创建 IAM Roles
    console.log('[InferenceOperator] Step 2: Creating IAM roles...');
    const roles = await this._createAllIamRoles(activeClusterName, accountId, region, oidcId);
    steps.push({ step: 'iam', roles });

    // Step 3: 创建 TLS S3 bucket
    console.log('[InferenceOperator] Step 3: Creating TLS S3 bucket...');
    const tlsBucket = await this._createTlsBucket(activeClusterName, accountId, region);
    steps.push({ step: 'tlsBucket', bucket: tlsBucket });

    // Step 4: 给子网打 ELB tag
    console.log('[InferenceOperator] Step 4: Tagging public subnets for ALB...');
    await this._tagSubnetsForAlb(vpcId, region);
    steps.push({ step: 'subnetTags', status: 'done' });

    // Step 5: 创建 S3 VPC Gateway endpoint（幂等）
    console.log('[InferenceOperator] Step 5: Ensuring S3 VPC endpoint...');
    const s3VpceResult = await this._ensureS3VpcEndpoint(vpcId, region);
    steps.push({ step: 's3VpcEndpoint', ...s3VpceResult });

    // Step 6: 获取 HyperPod Cluster ARN
    const hyperPodClusterArn = await this._getHyperPodClusterArn(activeClusterName);

    // Step 7: 创建 addon
    console.log('[InferenceOperator] Step 7: Creating EKS addon...');
    const addonConfig = {
      executionRoleArn: roles.executionArn,
      tlsCertificateS3Bucket: tlsBucket,
      hyperpodClusterArn: hyperPodClusterArn,
      jumpstartGatedModelDownloadRoleArn: roles.gatedArn,
      alb: {
        serviceAccount: { create: true, roleArn: roles.albArn },
      },
      keda: {
        auth: { aws: { irsa: { roleArn: roles.kedaArn } } },
      },
    };
    await this._createAddon(eksClusterName, region, addonConfig);
    steps.push({ step: 'createAddon', status: 'CREATING' });

    // Step 8: 轮询到 ACTIVE
    console.log('[InferenceOperator] Step 8: Waiting for addon to reach ACTIVE...');
    await this._waitAddonActive(eksClusterName, region);
    steps.push({ step: 'waitActive', status: 'ACTIVE' });

    // Step 9: 保存 metadata
    await this._saveMetadata(activeClusterName, { tlsBucket, roles, addonConfig });

    console.log('[InferenceOperator] Installation complete');
    return {
      success: true,
      message: 'Inference Operator installed successfully via EKS add-on',
      iamRoles: {
        inferenceRole: roles.executionArn,
        kedaRole: roles.kedaArn,
        albRole: roles.albArn,
        gatedRole: roles.gatedArn,
      },
      tlsBucket,
      steps,
    };
  }

  /**
   * 卸载 Inference Operator（完整闭环）
   */
  async uninstall() {
    const activeClusterName = this.clusterManager.getActiveCluster();
    if (!activeClusterName) {
      throw new Error('No active cluster found');
    }

    const { region, eksClusterName, accountId } = await this._getClusterInfo(activeClusterName);
    console.log('[InferenceOperator] Starting uninstall...');
    const steps = [];

    // Step 1: 删除 addon + 等待消失
    console.log('[InferenceOperator] Step 1: Deleting EKS addon...');
    try {
      const status = await this._describeAddon(eksClusterName, region);
      if (status !== 'NOT_FOUND') {
        await this._deleteAddon(eksClusterName, region);
        await this._waitAddonDeleted(eksClusterName, region);
      }
      steps.push({ step: 'deleteAddon', status: 'deleted' });
    } catch (e) {
      console.warn('[InferenceOperator] deleteAddon warning:', e.message);
      steps.push({ step: 'deleteAddon', status: 'warning', error: e.message });
    }

    // Step 2: 清理 IAM Roles + Policies
    console.log('[InferenceOperator] Step 2: Cleaning IAM resources...');
    const iamResult = await this._deleteAllIamRoles(activeClusterName, accountId);
    steps.push({ step: 'iam', ...iamResult });

    // Step 3: 清理 TLS bucket
    console.log('[InferenceOperator] Step 3: Deleting TLS S3 bucket...');
    const bucketResult = await this._deleteTlsBucket(activeClusterName, region);
    steps.push({ step: 'tlsBucket', ...bucketResult });

    // Step 4: 清理 metadata
    console.log('[InferenceOperator] Step 4: Cleaning metadata...');
    await this._cleanMetadata(activeClusterName);
    steps.push({ step: 'metadata', status: 'cleaned' });

    console.log('[InferenceOperator] Uninstall complete');
    return {
      success: true,
      message: 'Inference Operator uninstalled successfully',
      steps,
    };
  }

  // ================================================================
  // 集群信息 & IAM 状态读取
  // ================================================================

  async _getClusterInfo(activeClusterName) {
    const metadataDir = this.clusterManager.getClusterMetadataDir(activeClusterName);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    if (!fs.existsSync(clusterInfoPath)) {
      throw new Error('Cluster metadata not found');
    }
    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));

    const region = clusterInfo.region;
    const eksClusterName = clusterInfo.eksCluster?.name;
    if (!region) throw new Error('AWS region not found in metadata');
    if (!eksClusterName) throw new Error('EKS cluster name not found in metadata');

    const accountId = getCurrentAccountId();

    // OIDC ID
    const { stdout: oidcIssuer } = await execAsync(
      `aws eks describe-cluster --name ${eksClusterName} --region ${region} --query 'cluster.identity.oidc.issuer' --output text`
    );
    const oidcId = oidcIssuer.trim().split('/').pop();

    // VPC ID
    const vpcId = clusterInfo.eksCluster?.vpcId ||
      (await execAsync(`aws eks describe-cluster --name ${eksClusterName} --region ${region} --query 'cluster.resourcesVpcConfig.vpcId' --output text`)).stdout.trim();

    return {
      clusterInfo,
      metadataDir,
      region,
      eksClusterName,
      accountId,
      oidcId,
      vpcId,
    };
  }

  async _readIamRoles(clusterTag) {
    const names = this._roleNames(clusterTag);
    const out = {};
    for (const [key, name] of Object.entries(names)) {
      try {
        const { stdout } = await execAsync(`aws iam get-role --role-name ${name} --query 'Role.Arn' --output text 2>/dev/null`);
        const arn = stdout.trim();
        if (arn) out[key] = arn;
      } catch {
        // role 不存在
      }
    }
    // 保持 legacy 字段命名，前端/下游可能用到
    return {
      inferenceRole: out.execution || null,
      kedaRole: out.keda || null,
      albRole: out.alb || null,
      gatedRole: out.gated || null,
    };
  }

  async _getHyperPodClusterArn(clusterTag) {
    const metadataDir = this.clusterManager.getClusterMetadataDir(clusterTag);
    const clusterInfo = JSON.parse(fs.readFileSync(path.join(metadataDir, 'cluster_info.json'), 'utf8'));
    return clusterInfo.hyperPodCluster?.ClusterArn || '';
  }

  // ================================================================
  // EKS Addon 核心操作
  // ================================================================

  async _describeAddon(eksClusterName, region) {
    try {
      const { stdout } = await execAsync(
        `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${InferenceOperatorManager.ADDON_NAME} --region ${region} --query "addon.status" --output text 2>/dev/null`
      );
      const s = stdout.trim();
      return s || 'NOT_FOUND';
    } catch {
      return 'NOT_FOUND';
    }
  }

  async _createAddon(eksClusterName, region, config) {
    // 将 config 写临时文件（configuration-values 太长 CLI 会难处理）
    const tmpPath = `/tmp/inference-addon-config-${Date.now()}.json`;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    try {
      await execAsync(
        `aws eks create-addon --cluster-name ${eksClusterName} --addon-name ${InferenceOperatorManager.ADDON_NAME} --configuration-values file://${tmpPath} --region ${region} --resolve-conflicts OVERWRITE`
      );
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  }

  async _deleteAddon(eksClusterName, region) {
    await execAsync(
      `aws eks delete-addon --cluster-name ${eksClusterName} --addon-name ${InferenceOperatorManager.ADDON_NAME} --region ${region} 2>/dev/null || true`
    );
  }

  async _waitAddonActive(eksClusterName, region) {
    const start = Date.now();
    while (Date.now() - start < InferenceOperatorManager.ADDON_POLL_TIMEOUT_MS) {
      const status = await this._describeAddon(eksClusterName, region);
      console.log(`[InferenceOperator] Addon status: ${status}`);
      if (status === 'ACTIVE') return;
      if (status === 'CREATE_FAILED' || status === 'DEGRADED') {
        // 获取 health issues 提供更多信息
        try {
          const { stdout } = await execAsync(
            `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${InferenceOperatorManager.ADDON_NAME} --region ${region} --query "addon.health.issues" --output json`
          );
          throw new Error(`Addon failed with status ${status}. Health issues: ${stdout.trim()}`);
        } catch (inner) {
          throw new Error(`Addon failed with status ${status}: ${inner.message}`);
        }
      }
      await new Promise((r) => setTimeout(r, InferenceOperatorManager.ADDON_POLL_INTERVAL_MS));
    }
    throw new Error(`Timed out waiting for addon to reach ACTIVE (20min)`);
  }

  async _waitAddonDeleted(eksClusterName, region) {
    const start = Date.now();
    while (Date.now() - start < InferenceOperatorManager.ADDON_POLL_TIMEOUT_MS) {
      const status = await this._describeAddon(eksClusterName, region);
      if (status === 'NOT_FOUND') return;
      console.log(`[InferenceOperator] Waiting for addon to be deleted (status: ${status})...`);
      await new Promise((r) => setTimeout(r, InferenceOperatorManager.ADDON_POLL_INTERVAL_MS));
    }
    throw new Error('Timed out waiting for addon to be deleted');
  }

  // ================================================================
  // 前置依赖 addon 检查 + 自动补装
  // ================================================================

  async _ensureDependencyAddons(eksClusterName, region, accountId) {
    const results = [];
    for (const dep of InferenceOperatorManager.DEPENDENCY_ADDONS) {
      const status = await this._describeDependencyAddonStatus(eksClusterName, region, dep.name);
      if (status === 'ACTIVE') {
        console.log(`[InferenceOperator][dep] ${dep.name}: ACTIVE`);
        results.push({ name: dep.name, action: 'skip', status });
        continue;
      }
      if (status === 'CREATING') {
        console.log(`[InferenceOperator][dep] ${dep.name}: CREATING, waiting...`);
        await this._waitDependencyAddonActive(eksClusterName, region, dep.name);
        results.push({ name: dep.name, action: 'wait', status: 'ACTIVE' });
        continue;
      }
      if (status === 'CREATE_FAILED' || status === 'DEGRADED') {
        console.log(`[InferenceOperator][dep] ${dep.name}: ${status}, recreating...`);
        await execAsync(
          `aws eks delete-addon --cluster-name ${eksClusterName} --addon-name ${dep.name} --region ${region} 2>/dev/null || true`
        );
        await this._waitDependencyAddonDeleted(eksClusterName, region, dep.name);
      }
      // 安装
      console.log(`[InferenceOperator][dep] ${dep.name}: installing...`);
      await this._installDependencyAddon(eksClusterName, region, accountId, dep);
      await this._waitDependencyAddonActive(eksClusterName, region, dep.name);
      results.push({ name: dep.name, action: 'installed', status: 'ACTIVE' });
    }
    return { success: true, results };
  }

  async _describeDependencyAddonStatus(eksClusterName, region, addonName) {
    try {
      const { stdout } = await execAsync(
        `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --query "addon.status" --output text 2>/dev/null`
      );
      return stdout.trim() || 'NOT_FOUND';
    } catch {
      return 'NOT_FOUND';
    }
  }

  async _waitDependencyAddonActive(eksClusterName, region, addonName) {
    const start = Date.now();
    while (Date.now() - start < InferenceOperatorManager.ADDON_POLL_TIMEOUT_MS) {
      const status = await this._describeDependencyAddonStatus(eksClusterName, region, addonName);
      if (status === 'ACTIVE') return;
      if (status === 'CREATE_FAILED' || status === 'DEGRADED') {
        throw new Error(`Dependency addon ${addonName} failed: ${status}`);
      }
      await new Promise((r) => setTimeout(r, InferenceOperatorManager.ADDON_POLL_INTERVAL_MS));
    }
    throw new Error(`Timed out waiting for dependency addon ${addonName} to reach ACTIVE`);
  }

  async _waitDependencyAddonDeleted(eksClusterName, region, addonName) {
    const start = Date.now();
    while (Date.now() - start < InferenceOperatorManager.ADDON_POLL_TIMEOUT_MS) {
      const status = await this._describeDependencyAddonStatus(eksClusterName, region, addonName);
      if (status === 'NOT_FOUND') return;
      await new Promise((r) => setTimeout(r, InferenceOperatorManager.ADDON_POLL_INTERVAL_MS));
    }
    throw new Error(`Timed out waiting for ${addonName} deletion`);
  }

  async _installDependencyAddon(eksClusterName, region, accountId, dep) {
    // metrics-server / cert-manager 不需要 SA role
    if (!dep.requiresSaRole) {
      await execAsync(
        `aws eks create-addon --cluster-name ${eksClusterName} --addon-name ${dep.name} --region ${region} --resolve-conflicts OVERWRITE`
      );
      return;
    }

    // aws-fsx-csi-driver / aws-mountpoint-s3-csi-driver 需要 SA role
    // 复用项目 `SM_HP_FSX_CSI_ROLE_<eks>` / `SM_HP_S3_CSI_ROLE_<eks>` 命名（管理级 managedFeaturesManager 已有模式）
    if (dep.name === 'aws-fsx-csi-driver') {
      const roleName = `SM_HP_FSX_CSI_ROLE_${eksClusterName}`;
      // eksctl 创建 IAM service account（只创建 role）
      await execAsync(
        `eksctl create iamserviceaccount --name fsx-csi-controller-sa --namespace kube-system --override-existing-serviceaccounts --cluster ${eksClusterName} --attach-policy-arn ${InferenceOperatorManager.MANAGED_FSX_FULL_ACCESS} --role-name ${roleName} --region ${region} --approve --role-only 2>/dev/null || true`
      );
      const { stdout: roleArn } = await execAsync(`aws iam get-role --role-name ${roleName} --query "Role.Arn" --output text`);
      await execAsync(
        `aws eks create-addon --addon-name ${dep.name} --cluster-name ${eksClusterName} --service-account-role-arn ${roleArn.trim()} --region ${region} --resolve-conflicts OVERWRITE`
      );
      return;
    }

    if (dep.name === 'aws-mountpoint-s3-csi-driver') {
      const roleName = `SM_HP_S3_CSI_ROLE_${eksClusterName}`;
      const policyName = `S3MountpointAccessPolicy-${eksClusterName}`;
      // 创建宽松 S3 权限 policy（集群级，允许挂任意 bucket）
      const policyDoc = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['s3:ListBucket', 's3:GetObject', 's3:PutObject', 's3:AbortMultipartUpload', 's3:DeleteObject'],
            Resource: ['*'],
          },
        ],
      });
      await execAsync(
        `aws iam create-policy --policy-name ${policyName} --policy-document '${policyDoc}' 2>/dev/null || true`
      );
      const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;
      await execAsync(
        `eksctl create iamserviceaccount --name s3-csi-driver-sa --namespace kube-system --override-existing-serviceaccounts --cluster ${eksClusterName} --attach-policy-arn ${policyArn} --role-name ${roleName} --region ${region} --approve --role-only 2>/dev/null || true`
      );
      const { stdout: roleArn } = await execAsync(`aws iam get-role --role-name ${roleName} --query "Role.Arn" --output text`);
      await execAsync(
        `aws eks create-addon --addon-name ${dep.name} --cluster-name ${eksClusterName} --service-account-role-arn ${roleArn.trim()} --region ${region} --resolve-conflicts OVERWRITE`
      );
      return;
    }

    throw new Error(`Unknown dependency addon: ${dep.name}`);
  }

  // ================================================================
  // IAM Roles 创建/删除
  // ================================================================

  async _createAllIamRoles(clusterTag, accountId, region, oidcId) {
    const executionArn = await this._createExecutionRole(clusterTag, accountId, region, oidcId);
    const albArn = await this._createAlbRole(clusterTag, accountId, region, oidcId);
    const kedaArn = await this._createKedaRole(clusterTag, accountId, region, oidcId);
    const gatedArn = await this._createGatedRole(clusterTag, accountId, region, oidcId);
    return { executionArn, albArn, kedaArn, gatedArn };
  }

  async _createExecutionRole(clusterTag, accountId, region, oidcId) {
    const roleName = this._roleNames(clusterTag).execution;

    // 已存在则直接返回
    try {
      const { stdout } = await execAsync(`aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text 2>/dev/null`);
      if (stdout.trim()) {
        console.log(`[InferenceOperator][iam] Execution role already exists: ${roleName}`);
        return stdout.trim();
      }
    } catch {}

    const trustPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'sagemaker.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
        {
          Effect: 'Allow',
          Principal: { Federated: `arn:aws:iam::${accountId}:oidc-provider/oidc.eks.${region}.amazonaws.com/id/${oidcId}` },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringLike: {
              [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:aud`]: 'sts.amazonaws.com',
              [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:sub`]: `system:serviceaccount:${InferenceOperatorManager.NAMESPACE}:hyperpod-inference-controller-manager`,
            },
          },
        },
      ],
    };

    const trustPath = `/tmp/inf-exec-trust-${Date.now()}.json`;
    fs.writeFileSync(trustPath, JSON.stringify(trustPolicy));
    try {
      await execAsync(`aws iam create-role --role-name ${roleName} --assume-role-policy-document file://${trustPath}`);
      await execAsync(`aws iam attach-role-policy --role-name ${roleName} --policy-arn ${InferenceOperatorManager.MANAGED_INFERENCE_ACCESS}`);
      const { stdout } = await execAsync(`aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text`);
      console.log(`[InferenceOperator][iam] Created execution role: ${roleName}`);
      return stdout.trim();
    } finally {
      fs.unlinkSync(trustPath);
    }
  }

  async _createAlbRole(clusterTag, accountId, region, oidcId) {
    const roleName = this._roleNames(clusterTag).alb;
    const policyName = this._policyNames(clusterTag).alb;
    const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;

    // 幂等
    try {
      const { stdout } = await execAsync(`aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text 2>/dev/null`);
      if (stdout.trim()) {
        console.log(`[InferenceOperator][iam] ALB role already exists: ${roleName}`);
        return stdout.trim();
      }
    } catch {}

    const trustPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Federated: `arn:aws:iam::${accountId}:oidc-provider/oidc.eks.${region}.amazonaws.com/id/${oidcId}` },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:sub`]: `system:serviceaccount:${InferenceOperatorManager.NAMESPACE}:aws-load-balancer-controller`,
              [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:aud`]: 'sts.amazonaws.com',
            },
          },
        },
      ],
    };

    // 下载官方 ALB controller iam_policy.json
    const policyFilePath = `/tmp/alb-iam-policy-${Date.now()}.json`;
    await execAsync(`curl -fsSL -o ${policyFilePath} ${InferenceOperatorManager.ALB_IAM_POLICY_URL}`);

    const trustPath = `/tmp/inf-alb-trust-${Date.now()}.json`;
    fs.writeFileSync(trustPath, JSON.stringify(trustPolicy));

    try {
      // 创建 policy（幂等）
      await execAsync(`aws iam create-policy --policy-name ${policyName} --policy-document file://${policyFilePath} 2>/dev/null || true`);
      // 创建 role
      await execAsync(`aws iam create-role --role-name ${roleName} --assume-role-policy-document file://${trustPath}`);
      await execAsync(`aws iam attach-role-policy --role-name ${roleName} --policy-arn ${policyArn}`);
      const { stdout } = await execAsync(`aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text`);
      console.log(`[InferenceOperator][iam] Created ALB role: ${roleName}`);
      return stdout.trim();
    } finally {
      if (fs.existsSync(policyFilePath)) fs.unlinkSync(policyFilePath);
      if (fs.existsSync(trustPath)) fs.unlinkSync(trustPath);
    }
  }

  async _createKedaRole(clusterTag, accountId, region, oidcId) {
    const roleName = this._roleNames(clusterTag).keda;
    const policyName = this._policyNames(clusterTag).keda;
    const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;

    try {
      const { stdout } = await execAsync(`aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text 2>/dev/null`);
      if (stdout.trim()) {
        console.log(`[InferenceOperator][iam] KEDA role already exists: ${roleName}`);
        return stdout.trim();
      }
    } catch {}

    const trustPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Federated: `arn:aws:iam::${accountId}:oidc-provider/oidc.eks.${region}.amazonaws.com/id/${oidcId}` },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:sub`]: `system:serviceaccount:${InferenceOperatorManager.NAMESPACE}:keda-operator`,
              [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:aud`]: 'sts.amazonaws.com',
            },
          },
        },
      ],
    };

    const permissionPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['cloudwatch:GetMetricData', 'cloudwatch:GetMetricStatistics', 'cloudwatch:ListMetrics'],
          Resource: '*',
        },
        {
          Effect: 'Allow',
          Action: ['aps:QueryMetrics', 'aps:GetLabels', 'aps:GetSeries', 'aps:GetMetricMetadata'],
          Resource: '*',
        },
      ],
    };

    const trustPath = `/tmp/inf-keda-trust-${Date.now()}.json`;
    const policyPath = `/tmp/inf-keda-policy-${Date.now()}.json`;
    fs.writeFileSync(trustPath, JSON.stringify(trustPolicy));
    fs.writeFileSync(policyPath, JSON.stringify(permissionPolicy));

    try {
      await execAsync(`aws iam create-policy --policy-name ${policyName} --policy-document file://${policyPath} 2>/dev/null || true`);
      await execAsync(`aws iam create-role --role-name ${roleName} --assume-role-policy-document file://${trustPath}`);
      await execAsync(`aws iam attach-role-policy --role-name ${roleName} --policy-arn ${policyArn}`);
      const { stdout } = await execAsync(`aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text`);
      console.log(`[InferenceOperator][iam] Created KEDA role: ${roleName}`);
      return stdout.trim();
    } finally {
      if (fs.existsSync(trustPath)) fs.unlinkSync(trustPath);
      if (fs.existsSync(policyPath)) fs.unlinkSync(policyPath);
    }
  }

  async _createGatedRole(clusterTag, accountId, region, oidcId) {
    const roleName = this._roleNames(clusterTag).gated;

    try {
      const { stdout } = await execAsync(`aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text 2>/dev/null`);
      if (stdout.trim()) {
        console.log(`[InferenceOperator][iam] Gated role already exists: ${roleName}`);
        return stdout.trim();
      }
    } catch {}

    const trustPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Federated: `arn:aws:iam::${accountId}:oidc-provider/oidc.eks.${region}.amazonaws.com/id/${oidcId}` },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringLike: {
              [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:sub`]: 'system:serviceaccount:*:hyperpod-inference-service-account*',
              [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:aud`]: 'sts.amazonaws.com',
            },
          },
        },
        {
          Effect: 'Allow',
          Principal: { Service: 'sagemaker.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    };

    const trustPath = `/tmp/inf-gated-trust-${Date.now()}.json`;
    fs.writeFileSync(trustPath, JSON.stringify(trustPolicy));
    try {
      await execAsync(`aws iam create-role --role-name ${roleName} --assume-role-policy-document file://${trustPath}`);
      await execAsync(`aws iam attach-role-policy --role-name ${roleName} --policy-arn ${InferenceOperatorManager.MANAGED_GATED_MODEL_ACCESS}`);
      const { stdout } = await execAsync(`aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text`);
      console.log(`[InferenceOperator][iam] Created gated role: ${roleName}`);
      return stdout.trim();
    } finally {
      fs.unlinkSync(trustPath);
    }
  }

  async _deleteAllIamRoles(clusterTag, accountId) {
    const names = this._roleNames(clusterTag);
    const policyNames = this._policyNames(clusterTag);
    const deleted = [];

    // Execution Role (只挂托管 policy，直接 detach + delete)
    await this._detachManagedAndDeleteRole(names.execution, [InferenceOperatorManager.MANAGED_INFERENCE_ACCESS], [], deleted);

    // ALB Role（挂自有 policy）
    await this._detachManagedAndDeleteRole(
      names.alb,
      [],
      [`arn:aws:iam::${accountId}:policy/${policyNames.alb}`],
      deleted
    );

    // KEDA Role（挂自有 policy）
    await this._detachManagedAndDeleteRole(
      names.keda,
      [],
      [`arn:aws:iam::${accountId}:policy/${policyNames.keda}`],
      deleted
    );

    // Gated Role（只挂托管 policy）
    await this._detachManagedAndDeleteRole(
      names.gated,
      [InferenceOperatorManager.MANAGED_GATED_MODEL_ACCESS],
      [],
      deleted
    );

    return { success: true, deleted };
  }

  /**
   * Detach 指定 policies（托管 + 自有） → delete role → delete 自有 policies
   */
  async _detachManagedAndDeleteRole(roleName, managedPolicyArns, ownPolicyArns, deletedLog) {
    // 检查 role 是否存在
    let exists = false;
    try {
      await execAsync(`aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text 2>/dev/null`);
      exists = true;
    } catch {
      deletedLog.push({ role: roleName, status: 'not_found' });
      return;
    }
    if (!exists) return;

    // Detach 所有 policy
    for (const arn of [...managedPolicyArns, ...ownPolicyArns]) {
      await execAsync(`aws iam detach-role-policy --role-name ${roleName} --policy-arn ${arn} 2>/dev/null || true`);
    }
    // 兜底：detach 所有 attached policy（防遗漏）
    try {
      const { stdout } = await execAsync(`aws iam list-attached-role-policies --role-name ${roleName} --query 'AttachedPolicies[].PolicyArn' --output json`);
      const attached = JSON.parse(stdout.trim() || '[]');
      for (const arn of attached) {
        await execAsync(`aws iam detach-role-policy --role-name ${roleName} --policy-arn ${arn} 2>/dev/null || true`);
      }
    } catch {}
    // 兜底：删除所有 inline policy
    try {
      const { stdout } = await execAsync(`aws iam list-role-policies --role-name ${roleName} --query 'PolicyNames' --output json`);
      const inlines = JSON.parse(stdout.trim() || '[]');
      for (const name of inlines) {
        await execAsync(`aws iam delete-role-policy --role-name ${roleName} --policy-name ${name} 2>/dev/null || true`);
      }
    } catch {}

    // Delete role
    await execAsync(`aws iam delete-role --role-name ${roleName} 2>/dev/null || true`);
    deletedLog.push({ role: roleName, status: 'deleted' });
    console.log(`[InferenceOperator][iam] Deleted role: ${roleName}`);

    // Delete own policies
    for (const arn of ownPolicyArns) {
      await execAsync(`aws iam delete-policy --policy-arn ${arn} 2>/dev/null || true`);
      deletedLog.push({ policy: arn, status: 'deleted' });
    }
  }

  // ================================================================
  // TLS S3 Bucket 创建 / 删除
  // ================================================================

  async _createTlsBucket(clusterTag, accountId, region) {
    // 先查 metadata 是否已记录
    const existing = this._readMetadataField(clusterTag, 'tlsBucket');
    if (existing) {
      // 验证 bucket 是否真的存在
      const exists = await this._bucketExists(existing, region);
      if (exists) {
        console.log(`[InferenceOperator][bucket] Reusing existing TLS bucket: ${existing}`);
        return existing;
      }
      console.log(`[InferenceOperator][bucket] Metadata has ${existing} but bucket is gone, recreating`);
    }

    // 生成新 bucket 名（必须 hyperpod-tls-* 前缀，符合托管 policy 的 resource 约束）
    const rand = crypto.randomBytes(3).toString('hex'); // 6 hex chars
    const bucket = `hyperpod-tls-${accountId}-${clusterTag}-${rand}`.toLowerCase();

    // 创建 bucket（区域处理：us-east-1 不能指定 LocationConstraint）
    if (region === 'us-east-1') {
      await execAsync(`aws s3api create-bucket --bucket ${bucket} --region ${region}`);
    } else {
      await execAsync(`aws s3api create-bucket --bucket ${bucket} --region ${region} --create-bucket-configuration LocationConstraint=${region}`);
    }
    // 启用 encryption
    await execAsync(
      `aws s3api put-bucket-encryption --bucket ${bucket} --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'`
    );
    // Block public access
    await execAsync(
      `aws s3api put-public-access-block --bucket ${bucket} --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"`
    );
    console.log(`[InferenceOperator][bucket] Created TLS bucket: ${bucket}`);
    return bucket;
  }

  async _bucketExists(bucket, region) {
    try {
      await execAsync(`aws s3api head-bucket --bucket ${bucket} --region ${region} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  async _deleteTlsBucket(clusterTag, region) {
    const bucket = this._readMetadataField(clusterTag, 'tlsBucket');
    if (!bucket) {
      return { status: 'no_bucket_in_metadata' };
    }
    const exists = await this._bucketExists(bucket, region);
    if (!exists) {
      return { status: 'bucket_not_found', bucket };
    }
    try {
      // 删除所有对象 + 版本
      await execAsync(`aws s3 rm s3://${bucket} --recursive --region ${region} 2>/dev/null || true`);
      // 清理所有版本（非版本化桶此命令仍可执行）
      await execAsync(
        `aws s3api delete-objects --bucket ${bucket} --region ${region} --delete "$(aws s3api list-object-versions --bucket ${bucket} --region ${region} --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null)" 2>/dev/null || true`
      );
      await execAsync(
        `aws s3api delete-objects --bucket ${bucket} --region ${region} --delete "$(aws s3api list-object-versions --bucket ${bucket} --region ${region} --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null)" 2>/dev/null || true`
      );
      // 删除 bucket
      await execAsync(`aws s3api delete-bucket --bucket ${bucket} --region ${region}`);
      console.log(`[InferenceOperator][bucket] Deleted TLS bucket: ${bucket}`);
      return { status: 'deleted', bucket };
    } catch (e) {
      console.warn(`[InferenceOperator][bucket] Failed to delete ${bucket}: ${e.message}`);
      return { status: 'error', bucket, error: e.message };
    }
  }

  // ================================================================
  // 子网 ELB tag / S3 VPC Endpoint
  // ================================================================

  async _tagSubnetsForAlb(vpcId, region) {
    // 查 public subnet（map-public-ip-on-launch=true）
    const { stdout } = await execAsync(
      `aws ec2 describe-subnets --region ${region} --filters "Name=vpc-id,Values=${vpcId}" "Name=map-public-ip-on-launch,Values=true" --query 'Subnets[*].SubnetId' --output text`
    );
    const subnets = stdout.trim().split(/\s+/).filter(Boolean);
    if (subnets.length === 0) {
      console.log('[InferenceOperator][subnet] No public subnets found, skipping ELB tag');
      return;
    }
    for (const subnet of subnets) {
      await execAsync(
        `aws ec2 create-tags --resources ${subnet} --tags Key=kubernetes.io/role/elb,Value=1 --region ${region}`
      );
    }
    console.log(`[InferenceOperator][subnet] Tagged ${subnets.length} public subnets with kubernetes.io/role/elb=1`);
  }

  async _ensureS3VpcEndpoint(vpcId, region) {
    const { stdout: existingStd } = await execAsync(
      `aws ec2 describe-vpc-endpoints --region ${region} --filters "Name=vpc-id,Values=${vpcId}" "Name=service-name,Values=com.amazonaws.${region}.s3" --query 'VpcEndpoints[0].VpcEndpointId' --output text`
    );
    const existing = existingStd.trim();
    if (existing && existing !== 'None') {
      return { status: 'exists', vpceId: existing };
    }
    // 创建
    const { stdout: rtStd } = await execAsync(
      `aws ec2 describe-route-tables --region ${region} --filters "Name=vpc-id,Values=${vpcId}" --query 'RouteTables[].Associations[].RouteTableId' --output text`
    );
    const rtIds = [...new Set(rtStd.trim().split(/\s+/).filter(Boolean))];
    if (rtIds.length === 0) {
      console.warn('[InferenceOperator][vpce] No route tables found, skipping S3 endpoint');
      return { status: 'no_route_tables' };
    }
    const { stdout: createStd } = await execAsync(
      `aws ec2 create-vpc-endpoint --region ${region} --vpc-id ${vpcId} --vpc-endpoint-type Gateway --service-name com.amazonaws.${region}.s3 --route-table-ids ${rtIds.join(' ')} --query 'VpcEndpoint.VpcEndpointId' --output text`
    );
    console.log(`[InferenceOperator][vpce] Created S3 VPC endpoint: ${createStd.trim()}`);
    return { status: 'created', vpceId: createStd.trim() };
  }

  // ================================================================
  // Metadata 读写
  // ================================================================

  async _saveMetadata(clusterTag, { tlsBucket, roles, addonConfig }) {
    const metadataDir = this.clusterManager.getClusterMetadataDir(clusterTag);
    const p = path.join(metadataDir, 'cluster_info.json');
    const info = JSON.parse(fs.readFileSync(p, 'utf8'));
    info.inferenceOperator = {
      installed: true,
      installationDate: new Date().toISOString(),
      installMethod: 'eks-addon',
      addonName: InferenceOperatorManager.ADDON_NAME,
      namespace: InferenceOperatorManager.NAMESPACE,
      tlsBucket,
      iamRoles: {
        executionRole: roles.executionArn,
        albRole: roles.albArn,
        kedaRole: roles.kedaArn,
        gatedRole: roles.gatedArn,
      },
    };
    fs.writeFileSync(p, JSON.stringify(info, null, 2));
  }

  async _cleanMetadata(clusterTag) {
    try {
      const metadataDir = this.clusterManager.getClusterMetadataDir(clusterTag);
      const p = path.join(metadataDir, 'cluster_info.json');
      if (!fs.existsSync(p)) return;
      const info = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (info.inferenceOperator) {
        delete info.inferenceOperator;
        fs.writeFileSync(p, JSON.stringify(info, null, 2));
      }
    } catch (e) {
      console.warn(`[InferenceOperator][metadata] clean failed: ${e.message}`);
    }
  }

  _readMetadataField(clusterTag, field) {
    try {
      const metadataDir = this.clusterManager.getClusterMetadataDir(clusterTag);
      const p = path.join(metadataDir, 'cluster_info.json');
      if (!fs.existsSync(p)) return null;
      const info = JSON.parse(fs.readFileSync(p, 'utf8'));
      return info.inferenceOperator?.[field] || null;
    } catch {
      return null;
    }
  }

  // ================================================================
  // 保留接口：AMP Workspace 查询（被 /api/cluster/amp-workspace 调用）
  // ================================================================

  async getAmpWorkspace() {
    try {
      // 检查 hyperpod-observability namespace 是否存在
      try {
        await execAsync(`kubectl get namespace hyperpod-observability 2>/dev/null`);
      } catch {
        return { success: false, message: 'HyperPod Observability not installed' };
      }

      const { stdout } = await execAsync(
        `kubectl get observabilityconfig -n hyperpod-observability -o jsonpath='{.items[0].spec.amp.remoteWriteUrl}' 2>/dev/null`
      );
      const remoteWriteUrl = stdout.trim();
      if (!remoteWriteUrl) {
        return { success: false, message: 'AMP workspace not configured' };
      }
      const workspaceUrl = remoteWriteUrl.replace('/api/v1/remote_write', '');
      return { success: true, workspaceUrl, remoteWriteUrl };
    } catch (error) {
      console.error('Error fetching AMP workspace:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = InferenceOperatorManager;
