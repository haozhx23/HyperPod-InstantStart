const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs = require('fs');
const path = require('path');
const InferenceOperatorManager = require('./inferenceOperatorManager');
const EnvInjector = require('./envInjector');
const { cleanInstanceGroupForUpdate } = require('./instanceGroupUtils');
const HyperPodKarpenterInstaller = require('./hyperpodKarpenterInstaller');
const dependencyConfig = require('./dependencyConfigLoader');

/**
 * HyperPod Managed Features Manager
 * 管理 HyperPod 集群的高级功能配置
 */
class ManagedFeaturesManager {
  static TIERED_STORAGE_SA_NAME = 'tiered-storage-sa';
  static TIERED_STORAGE_SA_NAMESPACE = 'default';

  constructor(clusterManager) {
    this.clusterManager = clusterManager;
    this.inferenceOpManager = new InferenceOperatorManager(clusterManager);
  }

  /**
   * 获取当前集群的高级功能配置（从 AWS API 实时读取）
   */
  async getAdvancedFeatures() {
    const activeClusterName = this.clusterManager.getActiveCluster();

    if (!activeClusterName) {
      throw new Error('No active cluster found');
    }

    // 获取集群基本信息
    const { region, hyperPodCluster } = await this._getClusterInfo(activeClusterName);

    // 读取 cluster_info（一次性读取，避免每个子方法重复读取）
    const clusterInfo = JSON.parse(fs.readFileSync(
      path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
    ));
    const eksClusterName = clusterInfo.eksCluster?.name;

    // 通用状态检查（不依赖 HyperPod）
    const generalChecks = [
      this.inferenceOpManager.checkStatus(),
      this._getCertManagerStatusFast(eksClusterName, region),
      this._getTrainingOperatorStatusFast(eksClusterName, region),
      this._getFsxCsiDriverStatusFast(eksClusterName, region),
      this._getKuberayOperatorStatusFast(eksClusterName, region),
      eksClusterName ? this._getTieredStorageIRSAStatus(eksClusterName, region) : Promise.resolve({ installed: false, status: 'NOT_FOUND' })
    ];

    // HyperPod 专属：describe-cluster（非 HyperPod 集群跳过）
    if (hyperPodCluster) {
      generalChecks.unshift(
        execAsync(`aws sagemaker describe-cluster --cluster-name ${hyperPodCluster.ClusterName} --region ${region} --output json`)
      );
    } else {
      generalChecks.unshift(Promise.resolve(null));
    }

    const [
      describeResult,
      inferenceOpStatus,
      certManagerStatus,
      trainingOpStatus,
      fsxCsiDriverStatus,
      kuberayOperatorStatus,
      tieredStorageIRSA
    ] = await Promise.all(generalChecks);

    const clusterData = describeResult ? JSON.parse(describeResult.stdout) : null;

    const advancedFeatures = {
      tieredStorage: clusterData
        ? { ...this._parseTieredStorageConfig(clusterData.TieredStorageConfig), irsa: tieredStorageIRSA }
        : { enabled: false, configMode: 'default', irsa: tieredStorageIRSA },
      inferenceOperator: {
        enabled: inferenceOpStatus.installed,
        iamRoles: inferenceOpStatus.iamRoles
      },
      trainingOperator: {
        enabled: trainingOpStatus.installed,
        status: trainingOpStatus.status
      },
      certManager: {
        enabled: certManagerStatus.installed,
        status: certManagerStatus.status
      },
      fsxCsiDriver: {
        enabled: fsxCsiDriverStatus.installed,
        status: fsxCsiDriverStatus.status
      },
      kuberayOperator: {
        enabled: kuberayOperatorStatus.installed,
        status: kuberayOperatorStatus.status
      },
      karpenter: clusterData
        ? this._parseKarpenterConfig(clusterData.AutoScaling, clusterInfo.hyperpodKarpenter)
        : { enabled: false }
    };

    return {
      advancedFeatures,
      hasHyperPod: !!hyperPodCluster,
      clusterName: hyperPodCluster?.ClusterName || eksClusterName,
      region
    };
  }

  /**
   * 获取 cert-manager 状态（快速版，接受预解析参数）
   */
  async _getCertManagerStatusFast(eksClusterName, region) {
    try {
      if (!eksClusterName) return { installed: false, status: 'NOT_FOUND' };
      // 1. 检查 EKS addon
      const cmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name cert-manager --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
      const { stdout } = await execAsync(cmd);
      const status = stdout.trim();
      if (status !== 'NOT_FOUND') return { installed: status === 'ACTIVE', status };
      // 2. Fallback: kubectl 检测（覆盖 Helm/HyperPod Space 等非 addon 安装方式）
      const { stdout: pods } = await execAsync('kubectl get pods -n cert-manager --field-selector=status.phase=Running --no-headers 2>/dev/null || echo ""');
      if (pods.trim() && pods.includes('cert-manager')) {
        return { installed: true, status: 'ACTIVE (non-addon)' };
      }
      return { installed: false, status: 'NOT_FOUND' };
    } catch (error) {
      return { installed: false, status: 'NOT_FOUND' };
    }
  }

  /**
   * 获取 Training Operator 状态（快速版，接受预解析参数）
   */
  async _getTrainingOperatorStatusFast(eksClusterName, region) {
    try {
      if (!eksClusterName) return { installed: false, status: 'NOT_FOUND' };
      const cmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name amazon-sagemaker-hyperpod-training-operator --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
      const { stdout } = await execAsync(cmd);
      const status = stdout.trim();
      return { installed: status === 'ACTIVE', status };
    } catch (error) {
      return { installed: false, status: 'NOT_FOUND' };
    }
  }

  /**
   * 获取 Training Operator 状态（兼容旧调用）
   */
  async _getTrainingOperatorStatus() {
    try {
      const activeClusterName = this.clusterManager.getActiveCluster();
      const { region } = await this._getClusterInfo(activeClusterName);
      const clusterInfo = JSON.parse(fs.readFileSync(
        path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
      ));
      const eksClusterName = clusterInfo.eksCluster?.name;
      return this._getTrainingOperatorStatusFast(eksClusterName, region);
    } catch (error) {
      return { installed: false, status: 'NOT_FOUND' };
    }
  }

  /**
   * 通用：轮询等待指定 EKS addon 到达 ACTIVE 状态
   *
   * 用于被依赖的 addon（如 cert-manager）安装后、依赖它的组件（如 Training Operator）
   * 开始安装前的同步点。默认 15 秒间隔、10 分钟超时。
   *
   * @param {string} eksClusterName
   * @param {string} region
   * @param {string} addonName - EKS addon 名称
   * @param {object} [options]
   * @param {number} [options.intervalMs=15000]
   * @param {number} [options.timeoutMs=600000]
   * @throws 当状态变为 CREATE_FAILED / DEGRADED 或超时
   */
  async _waitAddonActive(eksClusterName, region, addonName, options = {}) {
    const intervalMs = options.intervalMs || 15000;
    const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { stdout } = await execAsync(
        `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`
      );
      const status = stdout.trim();
      if (status === 'ACTIVE') return;
      if (status === 'CREATE_FAILED' || status === 'DEGRADED') {
        throw new Error(`Addon ${addonName} failed to reach ACTIVE: ${status}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Timed out waiting for addon ${addonName} to reach ACTIVE (${timeoutMs / 1000}s)`);
  }

  /**
   * 更新高级功能配置
   */
  async updateAdvancedFeatures(updates) {
    const results = {
      tieredStorage: null,
      inferenceOperator: null,
      trainingOperator: null,
      certManager: null,
      fsxCsiDriver: null,
      kuberayOperator: null,
      karpenter: null
    };

    // 1. 更新 Tiered Storage (如果有变化)
    if (updates.tieredStorage !== undefined) {
      results.tieredStorage = await this._updateTieredStorage(updates.tieredStorage);
    }

    // 2. 更新 Inference Operator (如果有变化)
    if (updates.inferenceOperator !== undefined) {
      results.inferenceOperator = await this._updateInferenceOperator(updates.inferenceOperator);
    }

    // 3. 更新 Training Operator (如果有变化)
    if (updates.trainingOperator !== undefined) {
      results.trainingOperator = await this._updateTrainingOperator(updates.trainingOperator);
    }

    // 4. 更新 cert-manager (如果有变化)
    if (updates.certManager !== undefined) {
      results.certManager = await this._updateCertManager(updates.certManager);
    }


    // 6. 更新 FSx CSI Driver (如果有变化)
    if (updates.fsxCsiDriver !== undefined) {
      results.fsxCsiDriver = await this._updateFsxCsiDriver(updates.fsxCsiDriver);
    }

    // 7. 更新 KubeRay Operator (如果有变化)
    if (updates.kuberayOperator !== undefined) {
      results.kuberayOperator = await this._updateKuberayOperator(updates.kuberayOperator);
    }

    // 8. 更新 HyperPod Karpenter (如果有变化)
    if (updates.karpenter !== undefined) {
      results.karpenter = await this._updateKarpenter(updates.karpenter);
    }

    return {
      success: true,
      message: 'Advanced features updated successfully',
      results
    };
  }

  /**
   * 更新 Tiered Storage
   */
  async _updateTieredStorage(tieredStorage) {
    const activeClusterName = this.clusterManager.getActiveCluster();
    const { region, hyperPodCluster, configDir } = await this._getClusterInfo(activeClusterName);

    if (!hyperPodCluster) {
      return { success: false, message: 'HyperPod cluster required for Tiered Storage' };
    }

    // 获取现有集群详细信息
    const describeCmd = `aws sagemaker describe-cluster --cluster-name ${hyperPodCluster.ClusterName} --region ${region} --output json`;
    const describeResult = await execAsync(describeCmd);
    const clusterData = JSON.parse(describeResult.stdout);

    // 检查是否有变化
    const currentConfig = this._parseTieredStorageConfig(clusterData.TieredStorageConfig);
    const hasChange = 
      currentConfig.enabled !== tieredStorage.enabled ||
      (tieredStorage.enabled && 
       currentConfig.configMode !== tieredStorage.configMode) ||
      (tieredStorage.configMode === 'custom' && 
       currentConfig.percentage !== tieredStorage.percentage);

    // 读取 cluster_info 用于 IRSA 操作
    const clusterInfo = JSON.parse(fs.readFileSync(
      path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
    ));
    const eksClusterName = clusterInfo.eksCluster?.name;

    const results = { tieredStorageUpdate: null, irsa: null };

    // 更新 Tiered Storage 配置（如果有变化）
    if (hasChange) {
      const updateConfig = {
        ClusterName: hyperPodCluster.ClusterName,
        InstanceGroups: clusterData.InstanceGroups.map(cleanInstanceGroupForUpdate),
        TieredStorageConfig: this._buildTieredStorageConfig(tieredStorage)
      };

      console.log('Updating Tiered Storage:', JSON.stringify(updateConfig.TieredStorageConfig, null, 2));

      const tempConfigPath = path.join(configDir, 'temp-tiered-storage-config.json');
      fs.writeFileSync(tempConfigPath, JSON.stringify(updateConfig, null, 2));

      try {
        const updateCmd = `aws sagemaker update-cluster --cli-input-json file://${tempConfigPath} --region ${region}`;
        const updateResult = await execAsync(updateCmd);
        results.tieredStorageUpdate = { success: true, result: JSON.parse(updateResult.stdout) };
      } finally {
        if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
      }
    } else {
      results.tieredStorageUpdate = { success: true, message: 'No changes detected', skipped: true };
    }

    // 同步 IRSA：启用时安装，禁用时卸载
    if (eksClusterName) {
      try {
        const irsaStatus = await this._getTieredStorageIRSAStatus(eksClusterName, region);
        if (tieredStorage.enabled && !irsaStatus.installed) {
          results.irsa = await this._installTieredStorageIRSA(eksClusterName, region, clusterInfo);
        } else if (!tieredStorage.enabled && irsaStatus.installed) {
          results.irsa = await this._uninstallTieredStorageIRSA(eksClusterName, region, clusterInfo);
        }
      } catch (irsaError) {
        console.error('IRSA operation failed:', irsaError.message);
        results.irsa = { success: false, error: irsaError.message };
      }
    }

    return { success: true, ...results };
  }

  /**
   * 更新 Inference Operator
   */
  async _updateInferenceOperator(inferenceOperator) {
    if (inferenceOperator.enabled) {
      // 安装
      return await this.inferenceOpManager.install();
    } else {
      // 卸载
      return await this.inferenceOpManager.uninstall();
    }
  }

  /**
   * 获取集群基本信息（内部方法）
   */
  async _getClusterInfo(activeClusterName) {
    // 读取 metadata
    const metadataDir = this.clusterManager.getClusterMetadataDir(activeClusterName);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    
    if (!fs.existsSync(clusterInfoPath)) {
      throw new Error('Cluster metadata not found');
    }

    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
    
    return {
      region: clusterInfo.region,
      hyperPodCluster: clusterInfo.hyperPodCluster || null,
      configDir: this.clusterManager.getClusterConfigDir(activeClusterName),
      metadataDir
    };
  }

  /**
   * 获取 Tiered Storage IRSA 状态（检查 IAM Role + K8s ServiceAccount）
   */
  async _getTieredStorageIRSAStatus(eksClusterName, region) {
    const saName = ManagedFeaturesManager.TIERED_STORAGE_SA_NAME;
    const namespace = ManagedFeaturesManager.TIERED_STORAGE_SA_NAMESPACE;
    try {
      const { stdout } = await execAsync(
        `kubectl get sa ${saName} -n ${namespace} -o jsonpath='{.metadata.annotations.eks\\.amazonaws\\.com/role-arn}' 2>/dev/null || echo ""`
      );
      const roleArn = stdout.trim().replace(/^'|'$/g, '');
      if (!roleArn) return { installed: false, status: 'NOT_FOUND' };

      // Verify the IAM role exists
      const roleName = roleArn.split('/').pop();
      const { stdout: roleStatus } = await execAsync(
        `aws iam get-role --role-name ${roleName} --query "Role.RoleName" --output text 2>/dev/null || echo "NOT_FOUND"`
      );
      const installed = roleStatus.trim() !== 'NOT_FOUND';
      return { installed, status: installed ? 'ACTIVE' : 'NOT_FOUND', saName, roleArn: installed ? roleArn : null, roleName: installed ? roleName : null };
    } catch {
      return { installed: false, status: 'NOT_FOUND', saName };
    }
  }

  /**
   * 安装 Tiered Storage IRSA（IAM Policy + Role + K8s ServiceAccount）
   */
  async _installTieredStorageIRSA(eksClusterName, region, clusterInfo) {
    const saName = ManagedFeaturesManager.TIERED_STORAGE_SA_NAME;
    const namespace = ManagedFeaturesManager.TIERED_STORAGE_SA_NAMESPACE;
    const accountId = EnvInjector.extractAccountIdFromArn(clusterInfo.eksCluster?.arn);
    if (!accountId) throw new Error('Cannot extract account ID from EKS ARN');

    // Get OIDC ID
    const { stdout: oidcIssuer } = await execAsync(
      `aws eks describe-cluster --name ${eksClusterName} --region ${region} --query 'cluster.identity.oidc.issuer' --output text`
    );
    const oidcId = oidcIssuer.trim().replace('https://', '');

    const roleName = `SM_HP_TieredCkpt_Role_${eksClusterName}`;
    const policyName = `SM_HP_TieredCkpt_S3Policy_${eksClusterName}`;

    // 1. Create IAM Policy (S3 full access + CloudWatch logs)
    const policyDoc = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:*'], Resource: '*' },
        { Effect: 'Allow', Action: ['logs:CreateLogGroup','logs:CreateLogStream','logs:PutLogEvents'], Resource: '*' }
      ]
    });
    const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;
    await execAsync(`aws iam create-policy --policy-name "${policyName}" --policy-document '${policyDoc}' 2>/dev/null || true`);

    // 2. Create IAM Role with OIDC trust
    const trustDoc = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { Federated: `arn:aws:iam::${accountId}:oidc-provider/${oidcId}` },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: { StringEquals: { [`${oidcId}:sub`]: `system:serviceaccount:${namespace}:${saName}`, [`${oidcId}:aud`]: 'sts.amazonaws.com' } }
      }]
    });
    await execAsync(`aws iam create-role --role-name "${roleName}" --assume-role-policy-document '${trustDoc}' 2>/dev/null || true`);
    await execAsync(`aws iam attach-role-policy --role-name "${roleName}" --policy-arn "${policyArn}"`);

    // 3. Create K8s ServiceAccount
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    await execAsync(`kubectl create sa ${saName} -n ${namespace} 2>/dev/null || true`);
    await execAsync(`kubectl annotate sa ${saName} -n ${namespace} "eks.amazonaws.com/role-arn=${roleArn}" --overwrite`);

    return { success: true, message: 'Tiered Storage IRSA installed', roleArn, roleName };
  }

  /**
   * 卸载 Tiered Storage IRSA（删除 K8s SA + IAM Role + Policy）
   */
  async _uninstallTieredStorageIRSA(eksClusterName, region, clusterInfo) {
    const saName = ManagedFeaturesManager.TIERED_STORAGE_SA_NAME;
    const namespace = ManagedFeaturesManager.TIERED_STORAGE_SA_NAMESPACE;
    const accountId = EnvInjector.extractAccountIdFromArn(clusterInfo.eksCluster?.arn);
    const roleName = `SM_HP_TieredCkpt_Role_${eksClusterName}`;
    const policyName = `SM_HP_TieredCkpt_S3Policy_${eksClusterName}`;
    const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;

    // 1. Delete K8s ServiceAccount
    await execAsync(`kubectl delete sa ${saName} -n ${namespace} 2>/dev/null || true`);

    // 2. Detach policy and delete role
    await execAsync(`aws iam detach-role-policy --role-name "${roleName}" --policy-arn "${policyArn}" 2>/dev/null || true`);
    await execAsync(`aws iam delete-role --role-name "${roleName}" 2>/dev/null || true`);

    // 3. Delete policy
    await execAsync(`aws iam delete-policy --policy-arn "${policyArn}" 2>/dev/null || true`);

    return { success: true, message: 'Tiered Storage IRSA uninstalled' };
  }

  /**
   * 解析 TieredStorageConfig
   */
  _parseTieredStorageConfig(config) {
    if (!config) {
      return {
        enabled: false,
        configMode: 'default',
        percentage: null
      };
    }

    return {
      enabled: config.Mode === 'Enable',
      configMode: config.InstanceMemoryAllocationPercentage ? 'custom' : 'default',
      percentage: config.InstanceMemoryAllocationPercentage || null
    };
  }

  /**
   * 构建 TieredStorageConfig
   */
  _buildTieredStorageConfig(tieredStorage) {
    if (!tieredStorage.enabled) {
      return { Mode: 'Disable' };
    }

    const config = { Mode: 'Enable' };

    if (tieredStorage.configMode === 'custom' && tieredStorage.percentage) {
      config.InstanceMemoryAllocationPercentage = tieredStorage.percentage;
    }

    return config;
  }

  /**
   * 解析 Karpenter AutoScaling 配置
   */
  _parseKarpenterConfig(autoScaling, localMeta) {
    const defaults = {
      consolidationPolicy: 'WhenEmptyOrUnderutilized',
      consolidateAfter: '0s',
      budgetNodes: '90%'
    };
    return {
      enabled: autoScaling?.Mode === 'Enable',
      status: autoScaling?.Status || null,
      roleName: localMeta?.roleName || null,
      disruption: localMeta?.disruption || defaults
    };
  }

  /**
   * 更新 HyperPod Karpenter（启用/禁用）
   */
  async _updateKarpenter(karpenter) {
    const activeClusterName = this.clusterManager.getActiveCluster();
    const { region, hyperPodCluster } = await this._getClusterInfo(activeClusterName);

    if (!hyperPodCluster) {
      return { success: false, message: 'HyperPod cluster required for Karpenter' };
    }

    // 获取当前状态
    const { stdout } = await execAsync(`aws sagemaker describe-cluster --cluster-name ${hyperPodCluster.ClusterName} --region ${region} --output json`);
    const clusterData = JSON.parse(stdout);
    const currentEnabled = clusterData.AutoScaling?.Mode === 'Enable';

    // 无变化 → 仅保存 disruption 配置
    if (karpenter.enabled === currentEnabled) {
      if (karpenter.enabled && karpenter.disruption) {
        await this._saveKarpenterDisruption(activeClusterName, karpenter.disruption);
      }
      return { success: true, message: 'No changes detected', skipped: true };
    }

    if (karpenter.enabled) {
      return await this._enableKarpenter(activeClusterName, hyperPodCluster, region, karpenter);
    } else {
      return await this._disableKarpenter(activeClusterName, hyperPodCluster, region);
    }
  }

  /**
   * 启用 HyperPod Karpenter
   */
  async _enableKarpenter(clusterTag, hyperPodCluster, region, karpenter) {
    // 复用 installer 的安装逻辑（创建 IAM Role + Policy + update-cluster）
    const result = await HyperPodKarpenterInstaller.installHyperPodKarpenter(clusterTag, hyperPodCluster.ClusterName);

    // 保存 disruption 默认配置
    if (karpenter.disruption) {
      await this._saveKarpenterDisruption(clusterTag, karpenter.disruption);
    }

    return { success: true, action: 'enabled', ...result };
  }

  /**
   * 禁用 HyperPod Karpenter
   */
  async _disableKarpenter(clusterTag, hyperPodCluster, region) {
    const results = { cleanup: null, disable: null, iamCleanup: null };

    // 1. 清理 K8s 资源（NodePool → NodeClass）
    try {
      await execAsync('kubectl delete nodepool --all --ignore-not-found 2>/dev/null || true');
      await execAsync('kubectl delete hyperpodnodeclass --all --ignore-not-found 2>/dev/null || true');
      results.cleanup = { success: true };
      console.log('Karpenter K8s resources cleaned up');
    } catch (error) {
      console.warn('K8s cleanup warning:', error.message);
      results.cleanup = { success: false, error: error.message };
    }

    // 2. Disable autoscaling
    try {
      await execAsync(`aws sagemaker update-cluster --cluster-name "${hyperPodCluster.ClusterName}" --auto-scaling Mode=Disable --region ${region}`);
      results.disable = { success: true };
      console.log('Karpenter autoscaling disabled');
    } catch (error) {
      console.error('Failed to disable autoscaling:', error.message);
      throw new Error(`Failed to disable Karpenter: ${error.message}`);
    }

    // 3. 清理 IAM（role + policy）
    const meta = await HyperPodKarpenterInstaller.getInstallationStatus(clusterTag);
    if (meta.roleName) {
      try {
        const roleName = meta.roleName;
        const policyName = `SageMakerHyperPodKarpenterPolicy-${clusterTag}`;
        const { getCurrentAccountId } = require('./awsHelpers');
        const accountId = getCurrentAccountId();
        const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;

        // detach + delete policy, then delete role
        await execAsync(`aws iam detach-role-policy --role-name "${roleName}" --policy-arn "${policyArn}" 2>/dev/null || true`);
        await execAsync(`aws iam delete-policy --policy-arn "${policyArn}" 2>/dev/null || true`);
        // 也清理旧的 inline policy（兼容旧安装）
        await execAsync(`aws iam delete-role-policy --role-name "${roleName}" --policy-name "${roleName}-Karpenter-Policy" 2>/dev/null || true`);
        await execAsync(`aws iam delete-role --role-name "${roleName}" 2>/dev/null || true`);
        results.iamCleanup = { success: true };
        console.log(`IAM resources cleaned up: ${roleName}`);
      } catch (error) {
        console.warn('IAM cleanup warning:', error.message);
        results.iamCleanup = { success: false, error: error.message };
      }
    }

    // 4. 更新 metadata
    await HyperPodKarpenterInstaller.updateMetadata(clusterTag, { installed: false });

    return { success: true, action: 'disabled', ...results };
  }

  /**
   * 保存 Karpenter disruption 配置到 metadata
   */
  async _saveKarpenterDisruption(clusterTag, disruption) {
    const metadataFile = path.join(this.clusterManager.getClusterDir(clusterTag), 'metadata', 'cluster_info.json');
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
      metadata.hyperpodKarpenter = metadata.hyperpodKarpenter || {};
      metadata.hyperpodKarpenter.disruption = disruption;
      metadata.lastModified = new Date().toISOString();
      fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
    } catch (error) {
      console.error('Failed to save Karpenter disruption config:', error.message);
    }
  }

  /**
   * 更新 Training Operator
   */
  async _updateTrainingOperator(trainingOperator) {
    const activeClusterName = this.clusterManager.getActiveCluster();
    const { region, configDir } = await this._getClusterInfo(activeClusterName);
    const clusterInfo = JSON.parse(fs.readFileSync(
      path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
    ));
    const eksClusterName = clusterInfo.eksCluster?.name;
    if (!eksClusterName) throw new Error('EKS cluster not found');

    const currentStatus = await this._getTrainingOperatorStatus();

    if (trainingOperator.enabled && !currentStatus.installed) {
      // 安装 Training Operator
      return await this._installTrainingOperator(eksClusterName, region, configDir);
    } else if (!trainingOperator.enabled && currentStatus.installed) {
      // 卸载 Training Operator
      return await this._uninstallTrainingOperator(eksClusterName, region);
    }

    return { success: true, message: 'No changes needed' };
  }

  /**
   * 安装 Training Operator（需要 cert-manager 已就绪）
   */
  async _installTrainingOperator(eksClusterName, region, configDir) {
    // 检查 cert-manager 是否 ACTIVE；缺失则自动补装（对齐 Inference Operator 行为，也对齐 SageMaker Console Quick Install）
    const certStatus = await this._getCertManagerStatusFast(eksClusterName, region);
    if (!certStatus.installed) {
      console.log('[TrainingOperator] cert-manager not installed, auto-installing as dependency...');
      await this._installCertManager(eksClusterName, region);
      await this._waitAddonActive(eksClusterName, region, 'cert-manager');
      console.log('[TrainingOperator] cert-manager is now ACTIVE, continuing training operator install');
    }

    // 安装 Training Operator
    const addonName = 'amazon-sagemaker-hyperpod-training-operator';
    const statusCmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
    const { stdout: status } = await execAsync(statusCmd);
    const currentStatus = status.trim();

    if (currentStatus === 'ACTIVE') {
      return { success: true, message: 'Training Operator is already installed' };
    }
    if (currentStatus === 'CREATING') {
      return { success: true, message: 'Training Operator is being installed', status: 'CREATING' };
    }

    if (currentStatus === 'CREATE_FAILED' || currentStatus === 'DEGRADED') {
      await execAsync(`aws eks delete-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} 2>/dev/null || true`);
      await new Promise(r => setTimeout(r, 30000));
    }

    await execAsync(`aws eks create-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --resolve-conflicts OVERWRITE`);
    return { success: true, message: 'Training Operator installation initiated', status: 'CREATING' };
  }

  /**
   * 更新 cert-manager（独立 add-on）
   */
  async _updateCertManager(certManager) {
    const activeClusterName = this.clusterManager.getActiveCluster();
    const { region } = await this._getClusterInfo(activeClusterName);
    const clusterInfo = JSON.parse(fs.readFileSync(
      path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
    ));
    const eksClusterName = clusterInfo.eksCluster?.name;
    if (!eksClusterName) throw new Error('EKS cluster not found');

    const currentStatus = await this._getCertManagerStatusFast(eksClusterName, region);

    if (certManager.enabled && !currentStatus.installed) {
      return await this._installCertManager(eksClusterName, region);
    } else if (!certManager.enabled && currentStatus.installed) {
      return await this._uninstallCertManager(eksClusterName, region);
    }
    return { success: true, message: 'No changes needed' };
  }

  async _installCertManager(eksClusterName, region) {
    const addonName = 'cert-manager';
    const statusCmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
    const { stdout: status } = await execAsync(statusCmd);
    const currentStatus = status.trim();

    if (currentStatus === 'ACTIVE') {
      return { success: true, message: 'cert-manager is already installed' };
    }
    if (currentStatus === 'CREATING') {
      return { success: true, message: 'cert-manager is being installed', status: 'CREATING' };
    }
    if (currentStatus === 'CREATE_FAILED' || currentStatus === 'DEGRADED') {
      await execAsync(`aws eks delete-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} 2>/dev/null || true`);
      await new Promise(r => setTimeout(r, 15000));
    }

    await execAsync(`aws eks create-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --configuration-values '{"replicaCount":1,"cainjector":{"replicaCount":1},"webhook":{"replicaCount":1}}' --resolve-conflicts OVERWRITE`);
    return { success: true, message: 'cert-manager installation initiated', status: 'CREATING' };
  }

  async _uninstallCertManager(eksClusterName, region) {
    const addonName = 'cert-manager';
    const statusCmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
    const { stdout: status } = await execAsync(statusCmd);

    if (status.trim() !== 'NOT_FOUND') {
      await execAsync(`aws eks delete-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region}`);
    }
    return { success: true, message: 'cert-manager uninstalled successfully' };
  }

  /**
   * 卸载 Training Operator
   */
  async _uninstallTrainingOperator(eksClusterName, region) {
    const addonName = 'amazon-sagemaker-hyperpod-training-operator';
    const statusCmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
    const { stdout: status } = await execAsync(statusCmd);

    if (status.trim() !== 'NOT_FOUND') {
      await execAsync(`aws eks delete-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region}`);
    }

    return { success: true, message: 'Training Operator uninstalled successfully' };
  }


  /**
   * 获取 FSx CSI Driver 状态（快速版）
   */
  async _getFsxCsiDriverStatusFast(eksClusterName, region) {
    try {
      if (!eksClusterName) return { installed: false, status: 'NOT_FOUND' };
      const cmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name aws-fsx-csi-driver --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
      const { stdout } = await execAsync(cmd);
      const status = stdout.trim();
      return { installed: status === 'ACTIVE', status };
    } catch (error) {
      return { installed: false, status: 'NOT_FOUND' };
    }
  }

  /**
   * 获取 FSx CSI Driver 状态（兼容旧调用）
   */
  async _getFsxCsiDriverStatus() {
    try {
      const activeClusterName = this.clusterManager.getActiveCluster();
      const { region } = await this._getClusterInfo(activeClusterName);
      const clusterInfo = JSON.parse(fs.readFileSync(
        path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
      ));
      const eksClusterName = clusterInfo.eksCluster?.name;
      return this._getFsxCsiDriverStatusFast(eksClusterName, region);
    } catch (error) {
      return { installed: false, status: 'NOT_FOUND' };
    }
  }

  /**
   * 更新 FSx CSI Driver
   */
  async _updateFsxCsiDriver(fsxCsiDriver) {
    const activeClusterName = this.clusterManager.getActiveCluster();
    const { region, configDir } = await this._getClusterInfo(activeClusterName);
    const clusterInfo = JSON.parse(fs.readFileSync(
      path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
    ));
    const eksClusterName = clusterInfo.eksCluster?.name;
    if (!eksClusterName) throw new Error('EKS cluster not found');

    const currentStatus = await this._getFsxCsiDriverStatus();

    if (fsxCsiDriver.enabled && !currentStatus.installed) {
      return await this._installFsxCsiDriver(eksClusterName, region, configDir);
    } else if (!fsxCsiDriver.enabled && currentStatus.installed) {
      return await this._uninstallFsxCsiDriver(eksClusterName, region);
    }

    return { success: true, message: 'No changes needed' };
  }

  /**
   * 安装 FSx CSI Driver（创建 IAM Role + EKS Addon）
   */
  async _installFsxCsiDriver(eksClusterName, region, configDir) {
    const addonName = 'aws-fsx-csi-driver';
    const statusCmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
    const { stdout: status } = await execAsync(statusCmd);
    const currentStatus = status.trim();

    if (currentStatus === 'ACTIVE') {
      return { success: true, message: 'FSx CSI Driver is already installed' };
    }
    if (currentStatus === 'CREATING') {
      return { success: true, message: 'FSx CSI Driver is being installed', status: 'CREATING' };
    }

    if (currentStatus === 'CREATE_FAILED' || currentStatus === 'DEGRADED') {
      await execAsync(`aws eks delete-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} 2>/dev/null || true`);
      await new Promise(r => setTimeout(r, 30000));
    }

    // 创建 IAM Role
    const roleName = `SM_HP_FSX_CSI_ROLE_${eksClusterName}`;
    await execAsync(`eksctl create iamserviceaccount --name fsx-csi-controller-sa --namespace kube-system --override-existing-serviceaccounts --cluster ${eksClusterName} --attach-policy-arn arn:aws:iam::aws:policy/AmazonFSxFullAccess --role-name ${roleName} --region ${region} --approve --role-only 2>/dev/null || true`);

    const { stdout: roleArn } = await execAsync(`aws iam get-role --role-name ${roleName} --query "Role.Arn" --output text`);

    await execAsync(`aws eks create-addon --addon-name ${addonName} --cluster-name ${eksClusterName} --service-account-role-arn ${roleArn.trim()} --region ${region} --resolve-conflicts OVERWRITE`);
    return { success: true, message: 'FSx CSI Driver installation initiated', status: 'CREATING' };
  }

  /**
   * 卸载 FSx CSI Driver
   */
  async _uninstallFsxCsiDriver(eksClusterName, region) {
    const addonName = 'aws-fsx-csi-driver';
    const statusCmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
    const { stdout: status } = await execAsync(statusCmd);

    if (status.trim() === 'NOT_FOUND') {
      return { success: true, message: 'FSx CSI Driver is not installed' };
    }

    await execAsync(`aws eks delete-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region}`);

    // 清理 eksctl 创建的 IAM service account 及其 CloudFormation stack
    const roleName = `SM_HP_FSX_CSI_ROLE_${eksClusterName}`;
    await execAsync(`eksctl delete iamserviceaccount --name fsx-csi-controller-sa --namespace kube-system --cluster ${eksClusterName} --region ${region} 2>/dev/null || true`);

    return { success: true, message: 'FSx CSI Driver uninstalled successfully' };
  }

  /**
   * 获取 KubeRay Operator 状态（快速版）
   * kuberay 不是 EKS addon，走 helm + kubectl 双路检测。
   */
  async _getKuberayOperatorStatusFast(eksClusterName, region) {
    try {
      if (!eksClusterName) return { installed: false, status: 'NOT_FOUND' };
      // 1. 优先查 helm release
      const { stdout: helmJson } = await execAsync(
        `helm list -n kuberay-operator --output json 2>/dev/null || echo "[]"`
      );
      const releases = JSON.parse(helmJson.trim() || '[]');
      const release = releases.find(r => r.name === 'kuberay-operator');
      if (release) {
        return {
          installed: release.status === 'deployed',
          status: release.status === 'deployed' ? 'ACTIVE' : release.status
        };
      }
      // 2. Fallback: kubectl 检测（覆盖非 helm 的历史安装）
      const { stdout: dep } = await execAsync(
        `kubectl get deployment -n kuberay-operator kuberay-operator --no-headers 2>/dev/null || echo ""`
      );
      if (dep.trim() && dep.includes('kuberay-operator')) {
        return { installed: true, status: 'ACTIVE (non-helm)' };
      }
      return { installed: false, status: 'NOT_FOUND' };
    } catch (error) {
      return { installed: false, status: 'NOT_FOUND' };
    }
  }

  /**
   * 更新 KubeRay Operator
   */
  async _updateKuberayOperator(kuberay) {
    const activeClusterName = this.clusterManager.getActiveCluster();
    const { region } = await this._getClusterInfo(activeClusterName);
    const clusterInfo = JSON.parse(fs.readFileSync(
      path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
    ));
    const eksClusterName = clusterInfo.eksCluster?.name;
    if (!eksClusterName) throw new Error('EKS cluster not found');

    const currentStatus = await this._getKuberayOperatorStatusFast(eksClusterName, region);

    if (kuberay.enabled && !currentStatus.installed) {
      return await this._installKuberayOperator(eksClusterName, region);
    } else if (!kuberay.enabled && currentStatus.installed) {
      return await this._uninstallKuberayOperator(eksClusterName, region);
    }
    return { success: true, message: 'No changes needed' };
  }

  /**
   * 安装 KubeRay Operator (helm chart)
   * 版本从 config/cluster-dependencies-config.json 读。
   */
  async _installKuberayOperator(eksClusterName, region) {
    const chartVersion = dependencyConfig.requireVersion(
      dependencyConfig.load().kuberayOperatorChartVersion,
      'kuberayOperatorChartVersion'
    );
    const cmd = [
      `helm repo add kuberay https://ray-project.github.io/kuberay-helm/ 2>/dev/null || true`,
      `helm repo update kuberay`,
      `kubectl create namespace kuberay-operator --dry-run=client -o yaml | kubectl apply -f -`,
      `helm upgrade --install kuberay-operator kuberay/kuberay-operator --namespace kuberay-operator --version ${chartVersion} --timeout=10m`
    ].join(' && ');
    await execAsync(cmd);
    return { success: true, message: `KubeRay Operator installed (chart ${chartVersion})`, status: 'ACTIVE' };
  }

  /**
   * 卸载 KubeRay Operator
   * 只 uninstall release，不删 namespace（留给用户的 RayCluster CR 一席之地）。
   */
  async _uninstallKuberayOperator(eksClusterName, region) {
    await execAsync(`helm uninstall kuberay-operator -n kuberay-operator 2>/dev/null || true`);
    return { success: true, message: 'KubeRay Operator uninstalled successfully' };
  }

}

module.exports = ManagedFeaturesManager;
