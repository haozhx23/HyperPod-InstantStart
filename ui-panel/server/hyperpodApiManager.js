/**
 * HyperPod API Manager
 *
 * 管理 HyperPod 集群的所有 API，包括：
 * - 集群生命周期（创建、删除、状态查询）
 * - Instance Group 管理（扩缩容、添加、删除）
 * - 节点操作（重启、替换）
 * - 软件更新和高级特性
 *
 * 扩展点：
 * - shouldUseThreadsPerCore2(): 可被覆盖以支持不同的实例类型判断逻辑
 */

const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const { execSync, execAsync } = require('./utils/exec');

// 依赖模块
const ClusterManager = require('./clusterManager');
const CloudFormationManager = require('./utils/cloudFormationManager');
const HyperPodDependencyManager = require('./utils/hyperPodDependencyManager');
const MetadataUtils = require('./utils/metadataUtils');
const SubnetManager = require('./utils/subnetManager');
const NetworkManager = require('./utils/networkManager');
const {
  cleanInstanceGroupForUpdate,
  isEfaOnlySupportedInstanceType
} = require('./utils/instanceGroupUtils');

// 常量
const MANAGED_CLUSTERS_DIR = path.join(__dirname, '../managed_clusters_info');
const CREATING_HYPERPOD_CLUSTERS_FILE = path.join(MANAGED_CLUSTERS_DIR, 'creating-hyperpod-clusters.json');

// 模块级变量
let broadcastFn = null;
let clusterManager = null;

/**
 * 初始化模块
 * @param {Function} broadcast - WebSocket 广播函数
 * @param {ClusterManager} cm - 集群管理器实例
 */
function initialize(broadcast, cm) {
  broadcastFn = broadcast;
  clusterManager = cm || new ClusterManager();
}

/**
 * 广播消息
 */
function broadcast(data) {
  if (broadcastFn) {
    broadcastFn(data);
  }
}

// ============================================================
// 扩展点：实例类型相关逻辑
// ============================================================

/**
 * 判断是否需要 ThreadsPerCore=2
 * 扩展点：Neuron 项目可以覆盖此函数
 *
 * @param {string} instanceType - 实例类型
 * @param {string} trainingPlanArn - Training Plan ARN
 * @returns {boolean}
 */
function shouldUseThreadsPerCore2(instanceType, trainingPlanArn) {
  if (trainingPlanArn) return true;
  if (!instanceType) return false;
  const type = instanceType.toLowerCase();
  // HyperPod GPU 实例需要 ThreadsPerCore=2
  return type.startsWith('ml.p4') || type.startsWith('ml.p5') || type.startsWith('ml.p6');
}

// ============================================================
// 辅助函数：创建状态管理
// ============================================================

/**
 * 获取正在创建的 HyperPod 集群
 */
function getCreatingHyperPodClusters() {
  try {
    if (fs.existsSync(CREATING_HYPERPOD_CLUSTERS_FILE)) {
      return JSON.parse(fs.readFileSync(CREATING_HYPERPOD_CLUSTERS_FILE, 'utf8'));
    }
    return {};
  } catch (error) {
    console.error('Error reading creating HyperPod clusters file:', error);
    return {};
  }
}

/**
 * 更新创建中的 HyperPod 状态
 */
function updateCreatingHyperPodStatus(clusterTag, statusUpdate) {
  try {
    const creatingClusters = getCreatingHyperPodClusters();

    if (statusUpdate === 'COMPLETED') {
      delete creatingClusters[clusterTag];
    } else {
      creatingClusters[clusterTag] = {
        ...creatingClusters[clusterTag],
        ...statusUpdate,
        lastUpdated: new Date().toISOString()
      };
    }

    fs.writeFileSync(CREATING_HYPERPOD_CLUSTERS_FILE, JSON.stringify(creatingClusters, null, 2));
  } catch (error) {
    console.error('Error updating creating HyperPod clusters status:', error);
  }
}

/**
 * 注册已完成的 HyperPod 集群
 */
async function registerCompletedHyperPod(clusterTag) {
  try {
    console.log(`HyperPod cluster ${clusterTag} creation completed`);

    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

    if (!fs.existsSync(clusterInfoPath)) {
      throw new Error(`Cluster info not found: ${clusterInfoPath}`);
    }

    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
    const region = clusterInfo.region;

    // 获取 HyperPod CloudFormation Stack 输出
    const hyperPodConfigPath = path.join(metadataDir, 'hyperpod-config.json');
    if (!fs.existsSync(hyperPodConfigPath)) {
      throw new Error(`HyperPod config not found: ${hyperPodConfigPath}`);
    }

    const hyperPodConfig = JSON.parse(fs.readFileSync(hyperPodConfigPath, 'utf8'));
    const stackName = hyperPodConfig.hyperPodCluster?.stackName || hyperPodConfig.stackName;
    
    const stackOutputs = await CloudFormationManager.getStackOutputs(stackName, region);
    
    // 从 CloudFormation 输出获取 HyperPod 集群信息
    const hyperPodClusterName = stackOutputs.HyperPodClusterName;
    const hyperPodClusterArn = stackOutputs.HyperPodClusterArn;
    
    if (!hyperPodClusterName) {
      throw new Error('HyperPodClusterName not found in CloudFormation outputs');
    }

    // 更新 cluster_info.json
    clusterInfo.cloudFormation = clusterInfo.cloudFormation || {};
    clusterInfo.cloudFormation.outputs = clusterInfo.cloudFormation.outputs || {};
    
    if (stackOutputs.S3BucketName) {
      clusterInfo.cloudFormation.outputs.OutputS3BucketName = stackOutputs.S3BucketName;
      clusterInfo.eksCluster = clusterInfo.eksCluster || {};
      clusterInfo.eksCluster.s3BucketName = stackOutputs.S3BucketName;
    }
    if (stackOutputs.SageMakerIAMRoleArn) {
      clusterInfo.cloudFormation.outputs.OutputSageMakerIAMRoleArn = stackOutputs.SageMakerIAMRoleArn;
      clusterInfo.eksCluster = clusterInfo.eksCluster || {};
      clusterInfo.eksCluster.sageMakerRoleArn = stackOutputs.SageMakerIAMRoleArn;
    }
    if (stackOutputs.SageMakerIAMRoleName) {
      clusterInfo.cloudFormation.outputs.OutputSageMakerIAMRoleName = stackOutputs.SageMakerIAMRoleName;
    }

    // 获取 HyperPod 集群详细信息
    const hpCmd = `aws sagemaker describe-cluster --cluster-name ${hyperPodClusterName} --region ${region} --output json`;
    const hpResult = await execAsync(hpCmd);
    const hpData = JSON.parse(hpResult.stdout);
    hpData.source = 'ui-created';

    clusterInfo.hyperPodCluster = hpData;
    clusterInfo.lastModified = new Date().toISOString();

    fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
    console.log(`Updated cluster metadata with HyperPod info for ${clusterTag}`);
    
    // 更新 cluster_envs（添加 HyperPod 变量）
    const EnvInjector = require('./utils/envInjector');
    EnvInjector.updateClusterEnvFile(clusterTag);
    console.log(`Updated cluster_envs with HyperPod variables for ${clusterTag}`);

    // 配置 HyperPod 依赖（此时 cluster_envs 已包含所需变量）
    await HyperPodDependencyManager.configureHyperPodDependencies(clusterTag, clusterManager);

  } catch (error) {
    console.error('Error registering completed HyperPod:', error);
    throw error;
  }
}

// ============================================================
// API 路由
// ============================================================

/**
 * 创建 HyperPod 集群
 * POST /api/cluster/create-hyperpod
 */
router.post('/create-hyperpod', async (req, res) => {
  try {
    const { userConfig } = req.body;

    // 获取当前活跃集群信息
    const activeCluster = clusterManager.getActiveCluster();
    console.log('Active cluster:', activeCluster);
    if (!activeCluster) {
      return res.status(400).json({ success: false, error: 'No active cluster selected' });
    }

    // 🛡️ 防重复创建：检查是否已有 HyperPod 集群
    const existingClusterInfo = MetadataUtils.getClusterInfo(activeCluster);
    if (existingClusterInfo?.hyperPodCluster) {
      const hpStatus = existingClusterInfo.hyperPodCluster.ClusterStatus;
      const hpName = existingClusterInfo.hyperPodCluster.ClusterName;
      console.warn(`HyperPod cluster already exists: ${hpName} (${hpStatus})`);
      return res.status(400).json({
        success: false,
        error: `HyperPod cluster '${hpName}' already exists (status: ${hpStatus}). Delete it first before creating a new one.`
      });
    }

    // ⭐ 创建 HyperPod 前，先更新 cluster_envs（读取用户可能设置的 S3/Role）
    const EnvInjector = require('./utils/envInjector');
    try {
      EnvInjector.updateClusterEnvFile(activeCluster);
      console.log(`✅ Updated cluster_envs before HyperPod creation for ${activeCluster}`);
    } catch (error) {
      console.warn(`Failed to update cluster_envs: ${error.message}`);
    }

    // 检查 kubectl 连通性
    try {
      console.log('Testing kubectl connectivity...');
      const kubectlResult = execSync('kubectl cluster-info', { encoding: 'utf8', timeout: 15000 });
      console.log('kubectl cluster-info result:', kubectlResult);
    } catch (error) {
      console.error('kubectl connectivity test failed:', error.message);
      return res.status(400).json({
        success: false,
        error: `EKS cluster not accessible via kubectl: ${error.message}`
      });
    }

    // 获取 EKS 集群信息
    const eksClusterInfo = MetadataUtils.getEKSClusterInfo(activeCluster);
    const region = MetadataUtils.getClusterRegion(activeCluster);
    const clusterInfo = MetadataUtils.getClusterInfo(activeCluster);

    if (!eksClusterInfo || !region) {
      return res.status(400).json({
        success: false,
        error: 'EKS cluster information not found in metadata'
      });
    }

    console.log('EKS cluster info from metadata:', eksClusterInfo);

    // 构建 EKS 基础设施信息（S3/Role 由 HyperPod CF Stack 自动创建，无需传入）
    const eksInfrastructureInfo = {
      VPC_ID: eksClusterInfo.vpcId,
      SECURITY_GROUP_ID: eksClusterInfo.securityGroupId,
      EKS_CLUSTER_NAME: eksClusterInfo.name,
    };

    // 生成 HyperPod 配置
    const initInstanceGroupTag = userConfig.initInstanceGroupTag;
    const hyperPodStackName = `hypd-cfn-${activeCluster}`;
    const eksClusterTag = activeCluster;
    const hyperPodClusterName = `hp-cluster-${eksClusterTag}`;

    // availabilityZone 必填
    if (!userConfig.availabilityZone) {
      return res.status(400).json({ success: false, error: 'availabilityZone is required for creating HyperPod cluster' });
    }

    // 获取可用区 ID
    const azCommand = `aws ec2 describe-availability-zones --region ${region} --query "AvailabilityZones[?ZoneName=='${userConfig.availabilityZone}'].ZoneId" --output text`;
    const azResult = execSync(azCommand, { encoding: 'utf8' });
    const availabilityZoneId = azResult.trim();

    // 确保目标 AZ 有 Public Subnet
    // 注释掉自动创建，避免 CIDR 冲突问题
    // console.log(`\n🔍 Ensuring public subnet exists in ${userConfig.availabilityZone}...`);
    // try {
    //   const publicSubnetResult = await SubnetManager.ensurePublicSubnet({
    //     vpcId: eksInfrastructureInfo.VPC_ID,
    //     availabilityZone: userConfig.availabilityZone,
    //     clusterTag: activeCluster,
    //     region: region
    //   });

    //   console.log(`✅ Public subnet ready: ${publicSubnetResult.subnetId} (${publicSubnetResult.subnetName})`);
    //   if (publicSubnetResult.created) {
    //     console.log(`   Created new subnet with CIDR: ${publicSubnetResult.cidrBlock}`);
    //   }
    // } catch (subnetError) {
    //   console.error('❌ Failed to ensure public subnet:', subnetError);
    //   return res.status(500).json({
    //     success: false,
    //     error: `Failed to ensure public subnet in ${userConfig.availabilityZone}: ${subnetError.message}`
    //   });
    // }

    // 验证必需的基础设施信息
    if (!eksInfrastructureInfo.VPC_ID || !eksInfrastructureInfo.SECURITY_GROUP_ID) {
      return res.status(400).json({
        success: false,
        error: 'Missing required EKS infrastructure information (VPC or Security Group)'
      });
    }

    // 确保 compute subnet 存在（统一链路：与 addInstanceGroup 共用 ensureComputeSubnet）
    // 优先级：用户指定 > 自动查找/创建
    let computeSubnetId;
    if (userConfig.computeSubnetId) {
      computeSubnetId = userConfig.computeSubnetId;
      console.log(`Using user-specified compute subnet: ${computeSubnetId}`);
    } else {
      const subnetResult = await NetworkManager.ensureComputeSubnet(
        eksInfrastructureInfo.VPC_ID, userConfig.availabilityZone, region, eksInfrastructureInfo.EKS_CLUSTER_NAME
      );
      computeSubnetId = subnetResult.subnetId;
      console.log(`Using compute subnet: ${computeSubnetId} (created: ${subnetResult.created})`);
    }

    // 记录创建状态
    updateCreatingHyperPodStatus(activeCluster, {
      type: 'hyperpod',
      status: 'IN_PROGRESS',
      phase: 'CREATING_STACK',
      stackName: hyperPodStackName,
      region: region,
      createdAt: new Date().toISOString()
    });

    // 构建 HyperPod 配置（subnet 已由 ensureComputeSubnet 创建，CF 跳过 subnet 创建）
    const hyperPodConfig = {
      ResourceNamePrefix: eksClusterTag,
      AvailabilityZoneId: availabilityZoneId,
      ExistingPrivateSubnetId: computeSubnetId,
      HyperPodClusterName: hyperPodClusterName,
      NodeRecovery: 'None',
      UseContinuousNodeProvisioningMode: 'true',
      CreateAcceleratedInstanceGroup: 'true',
      AcceleratedInstanceGroupName: `${initInstanceGroupTag}-ig`,
      AcceleratedInstanceType: userConfig.AcceleratedInstanceType,
      AcceleratedInstanceCount: userConfig.AcceleratedInstanceCount,
      AcceleratedEBSVolumeSize: userConfig.AcceleratedEBSVolumeSize,
      AcceleratedTrainingPlanArn: userConfig.AcceleratedTrainingPlanArn || '',
      AcceleratedThreadsPerCore: shouldUseThreadsPerCore2(userConfig.AcceleratedInstanceType, userConfig.AcceleratedTrainingPlanArn) ? 2 : 1,
      EnableInstanceStressCheck: 'false',
      EnableInstanceConnectivityCheck: 'false'
    };

    const stackResult = await CloudFormationManager.createHyperPodStack(
      hyperPodStackName,
      region,
      eksInfrastructureInfo,
      hyperPodConfig
    );

    // CF stack 已提交，更新 phase 让 auto-poller 开始跟踪
    updateCreatingHyperPodStatus(activeCluster, {
      phase: 'WAITING_FOR_STACK',
      stackId: stackResult.stackId
    });

    // 保存配置到 metadata
    await clusterManager.saveHyperPodConfig(activeCluster, {
      stackName: hyperPodStackName,
      stackId: stackResult.stackId,
      region: region,
      hyperPodClusterName: hyperPodClusterName,  // ← 添加集群名称
      userConfig: userConfig,
      infrastructureInfo: eksInfrastructureInfo,
      createdAt: new Date().toISOString()
    });

    // 发送 WebSocket 通知
    broadcast({
      type: 'hyperpod_creation_started',
      status: 'success',
      message: `HyperPod cluster creation started: ${hyperPodStackName}`,
      clusterTag: activeCluster,
      stackName: hyperPodStackName
    });

    res.json({
      success: true,
      stackName: hyperPodStackName,
      stackId: stackResult.stackId,
      message: 'HyperPod cluster creation started'
    });

  } catch (error) {
    console.error('Error creating HyperPod cluster:', error);

    const activeCluster = clusterManager.getActiveCluster();
    if (activeCluster) {
      updateCreatingHyperPodStatus(activeCluster, {
        status: 'FAILED',
        phase: 'FAILED',
        error: error.message,
        failedAt: new Date().toISOString()
      });
    }

    broadcast({
      type: 'hyperpod_creation_failed',
      status: 'error',
      message: `HyperPod creation failed: ${error.message}`
    });

    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 删除 HyperPod 集群
 * DELETE /api/cluster/:clusterTag/hyperpod
 */
router.delete('/:clusterTag/hyperpod', async (req, res) => {
  try {
    const { clusterTag } = req.params;

    // 读取 HyperPod 配置获取 stackId
    const hyperPodConfigPath = path.join(MANAGED_CLUSTERS_DIR, clusterTag, 'metadata/hyperpod-config.json');

    if (!fs.existsSync(hyperPodConfigPath)) {
      return res.status(404).json({ success: false, error: 'HyperPod configuration not found' });
    }

    const hyperPodConfig = JSON.parse(fs.readFileSync(hyperPodConfigPath, 'utf8'));
    const stackName = hyperPodConfig.hyperPodCluster.stackName;
    const region = hyperPodConfig.hyperPodCluster.region;

    // 记录删除状态
    updateCreatingHyperPodStatus(clusterTag, {
      type: 'hyperpod',
      status: 'DELETING',
      phase: 'DELETING_STACK',
      stackName: stackName,
      region: region,
      deletedAt: new Date().toISOString()
    });

    // 使用 AWS CLI 删除 CloudFormation Stack
    const deleteCommand = `aws cloudformation delete-stack --stack-name ${stackName} --region ${region}`;
    execSync(deleteCommand, { encoding: 'utf8', timeout: 30000 });

    // WebSocket 广播删除开始
    broadcast({
      type: 'hyperpod_deletion_started',
      clusterTag,
      stackName,
      message: 'HyperPod cluster deletion started'
    });

    res.json({ success: true, message: 'HyperPod deletion started' });
  } catch (error) {
    console.error('Error deleting HyperPod cluster:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 扩缩容 HyperPod Instance Group
 * PUT /api/cluster/hyperpod/instances/:name/scale
 */
router.put('/hyperpod/instances/:name/scale', async (req, res) => {
  try {
    const { name } = req.params;
    const { targetCount } = req.body;

    const activeClusterName = clusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    // 从 cluster_info.json 获取集群信息
    const clusterInfo = await clusterManager.getClusterInfo(activeClusterName);
    if (!clusterInfo) {
      return res.status(400).json({ error: 'Cluster info not found' });
    }

    if (!clusterInfo.hyperPodCluster) {
      return res.status(400).json({ error: 'No HyperPod cluster found for this EKS cluster' });
    }

    const region = clusterInfo.region;
    const hpClusterName = clusterInfo.hyperPodCluster.ClusterName;

    // 动态获取当前实例组的完整配置
    const getCmd = `aws sagemaker describe-cluster --cluster-name ${hpClusterName} --region ${region}`;
    const getResult = await execAsync(getCmd);
    const clusterData = JSON.parse(getResult.stdout);

    // 找到要更新的实例组
    const instanceGroup = clusterData.InstanceGroups.find(ig => ig.InstanceGroupName === name);
    if (!instanceGroup) {
      throw new Error(`Instance group ${name} not found`);
    }

    // 清理运行时字段，只保留 update-cluster 允许的字段
    const updateInstanceGroup = cleanInstanceGroupForUpdate(instanceGroup);
    updateInstanceGroup.InstanceCount = targetCount;

    const cmd = `aws sagemaker update-cluster --cluster-name ${hpClusterName} --instance-groups '${JSON.stringify(updateInstanceGroup)}' --region ${region}`;

    console.log('Executing HyperPod scaling command:', cmd);
    console.log('Update instance group object:', JSON.stringify(updateInstanceGroup, null, 2));

    await execAsync(cmd);

    // WebSocket 通知
    broadcast({
      type: 'nodegroup_updated',
      status: 'success',
      message: `HyperPod instance group ${name} scaling updated successfully`
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating HyperPod instance group:', error);
    broadcast({
      type: 'nodegroup_updated',
      status: 'error',
      message: `Failed to update HyperPod instance group: ${error.message}`
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 添加 Instance Group
 * POST /api/cluster/hyperpod/add-instance-group
 */
router.post('/hyperpod/add-instance-group', async (req, res) => {
  let tempConfigPath;

  try {
    const { userConfig } = req.body;
    const activeClusterName = clusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    // 从 cluster_info.json 获取集群信息
    const clusterInfo = await clusterManager.getClusterInfo(activeClusterName);

    if (!clusterInfo) {
      return res.status(400).json({ error: 'Cluster metadata not found' });
    }

    if (!clusterInfo.hyperPodCluster) {
      return res.status(400).json({ error: 'No HyperPod cluster found' });
    }

    if (userConfig.efaOnly && !isEfaOnlySupportedInstanceType(userConfig.instanceType)) {
      return res.status(400).json({
        error: `EFA-only network interface is not supported for ${userConfig.instanceType}. Disable EFA-only and try again.`
      });
    }

    const region = clusterInfo.region;
    const hyperPodCluster = clusterInfo.hyperPodCluster;

    // 获取现有集群的详细信息
    const describeCmd = `aws sagemaker describe-cluster --cluster-name ${hyperPodCluster.ClusterName} --region ${region} --output json`;
    const describeResult = await execAsync(describeCmd);
    const clusterData = JSON.parse(describeResult.stdout);

    // 构建新的实例组配置
    const newInstanceGroup = {
      InstanceCount: userConfig.instanceCount,
      InstanceGroupName: userConfig.instanceGroupName,
      InstanceType: userConfig.instanceType,
      LifeCycleConfig: clusterData.InstanceGroups[0]?.LifeCycleConfig,
      ExecutionRole: clusterData.InstanceGroups[0]?.ExecutionRole,
      ThreadsPerCore: shouldUseThreadsPerCore2(userConfig.instanceType, userConfig.trainingPlanArn) ? 2 : 1,
      InstanceStorageConfigs: [
        {
          EbsVolumeConfig: {
            VolumeSizeInGB: userConfig.volumeSize,
            RootVolume: false
          }
        }
      ]
    };

    // 如果是 Spot 实例
    if (userConfig.isSpot) {
      newInstanceGroup.CapacityRequirements = { Spot: {} };
    }

    // availabilityZone 必填
    if (!userConfig.availabilityZone) {
      return res.status(400).json({ error: 'availabilityZone is required for adding instance group' });
    }

    // Compute Subnet 选择优先级：用户指定 > 自动检测已存在 > 自动创建
    {
      const vpcId = clusterData.VpcConfig?.Subnets?.[0] ?
        (() => {
          const subnetCmd = `aws ec2 describe-subnets --region ${region} --subnet-ids ${clusterData.VpcConfig.Subnets[0]} --query "Subnets[0].VpcId" --output text`;
          return execSync(subnetCmd, { encoding: 'utf8' }).trim();
        })() : clusterInfo.cloudFormation?.outputs?.OutputVpcId;

      const securityGroupId = clusterData.VpcConfig?.SecurityGroupIds?.[0] ||
                             clusterInfo.eksCluster?.securityGroupId;

      let computeSubnetId;

      if (userConfig.subnetId) {
        // 用户明确指定已有 subnet（优先级最高，可复用之前新建的 subnet）
        computeSubnetId = userConfig.subnetId;
        console.log(`Using user-specified compute subnet: ${computeSubnetId}`);
      } else {
        // newSubnet 开关：true 则新建独立 subnet（与 IG 生命周期解耦），否则用按 AZ 共享 subnet
        const eksClusterName = clusterInfo.cloudFormation?.outputs?.OutputEKSClusterName || activeClusterName;
        const newSubnet = !!userConfig.newSubnet;
        const result = await NetworkManager.ensureComputeSubnet(
          vpcId, userConfig.availabilityZone, region, eksClusterName, newSubnet
        );
        computeSubnetId = result.subnetId;
        console.log(`Using ${newSubnet ? 'new' : 'shared'} compute subnet: ${computeSubnetId} (created: ${result.created})`);
      }

      newInstanceGroup.OverrideVpcConfig = {
        SecurityGroupIds: [securityGroupId],
        Subnets: [computeSubnetId]
      };
    }

    // 如果有 TrainingPlanArn
    if (userConfig.trainingPlanArn) {
      newInstanceGroup.TrainingPlanArn = userConfig.trainingPlanArn;
    }

    // EFA-only 配置用于新建节点；支持范围已在请求入口按共享白名单校验。
    if (userConfig.efaOnly) {
      newInstanceGroup.NetworkInterface = { InterfaceType: 'efa-only' };
    }

    // UpdateCluster.InstanceGroups 是局部 upsert，只提交本次新增的 IG。
    // 重发无关 IG 会扩大变更面，并可能因遗漏旧组字段而造成意外更新。
    const instanceGroupConfig = {
      ClusterName: hyperPodCluster.ClusterName,
      InstanceGroups: [newInstanceGroup]
    };

    console.log('Generated instance group config:', JSON.stringify(instanceGroupConfig, null, 2));

    // 创建临时配置文件
    tempConfigPath = path.join('/tmp', `instance-group-config-${Date.now()}.json`);
    fs.writeFileSync(tempConfigPath, JSON.stringify(instanceGroupConfig, null, 2));

    // 调用 AWS CLI 添加实例组
    const addCmd = `aws sagemaker update-cluster --cli-input-json file://${tempConfigPath} --region ${region}`;
    const addResult = await execAsync(addCmd);

    console.log('Instance group addition result:', addResult.stdout);

    res.json({
      success: true,
      message: 'Instance group addition initiated successfully',
      config: instanceGroupConfig
    });

  } catch (error) {
    console.error('Error adding instance group:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (tempConfigPath && fs.existsSync(tempConfigPath)) {
      try {
        fs.unlinkSync(tempConfigPath);
      } catch (cleanupError) {
        console.warn(`Failed to clean up temporary instance group config ${tempConfigPath}:`, cleanupError.message);
      }
    }
  }
});

/**
 * 删除 Instance Group
 * POST /api/cluster/hyperpod/delete-instance-group
 */
router.post('/hyperpod/delete-instance-group', async (req, res) => {
  try {
    const { instanceGroupName } = req.body;
    const activeClusterName = clusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    if (!instanceGroupName) {
      return res.status(400).json({ error: 'Instance group name is required' });
    }

    // 从 cluster_info.json 获取集群信息
    const clusterInfo = await clusterManager.getClusterInfo(activeClusterName);

    if (!clusterInfo) {
      return res.status(400).json({ error: 'Cluster metadata not found' });
    }

    if (!clusterInfo.hyperPodCluster) {
      return res.status(400).json({ error: 'No HyperPod cluster found' });
    }

    const region = clusterInfo.region;
    const hyperPodCluster = clusterInfo.hyperPodCluster;

    console.log(`Deleting instance group "${instanceGroupName}" from cluster "${hyperPodCluster.ClusterName}"`);

    // 注：compute subnet 已与实例组生命周期解耦，删除 IG 不再触碰 subnet。
    // 启用了 new subnet 的用户需自行维护这些 subnet。

    // 调用 AWS CLI 删除实例组
    const deleteCmd = `aws sagemaker update-cluster --cluster-name ${hyperPodCluster.ClusterName} --instance-groups-to-delete ${instanceGroupName} --region ${region}`;
    const deleteResult = await execAsync(deleteCmd);

    console.log('Instance group deletion result:', deleteResult.stdout);

    res.json({
      success: true,
      message: `Instance group "${instanceGroupName}" deletion initiated successfully`
    });

  } catch (error) {
    console.error('Error deleting instance group:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 更新软件
 * POST /api/cluster/hyperpod/update-software
 */
router.post('/hyperpod/update-software', async (req, res) => {
  try {
    const { clusterArn } = req.body;

    const activeClusterName = clusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    // 从 cluster_info.json 获取集群信息
    const clusterInfo = await clusterManager.getClusterInfo(activeClusterName);

    if (!clusterInfo) {
      return res.status(400).json({ error: 'Cluster configuration not found' });
    }

    const region = clusterInfo.region;

    // 使用 AWS CLI 更新软件
    const updateCmd = `aws sagemaker update-cluster-software --cluster-name "${clusterArn}" --region ${region}`;
    const result = await execAsync(updateCmd);

    console.log('Update software result:', result.stdout);

    broadcast({
      type: 'hyperpod_software_update',
      status: 'success',
      message: 'HyperPod software update initiated'
    });

    res.json({ success: true, message: 'Software update initiated' });
  } catch (error) {
    console.error('Error updating HyperPod software:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取高级特性配置
 * GET /api/cluster/hyperpod/advanced-features
 */
router.get('/hyperpod/advanced-features', async (req, res) => {
  try {
    const ManagedFeaturesManager = require('./utils/managedFeaturesManager');
    const manager = new ManagedFeaturesManager(clusterManager);
    const result = await manager.getAdvancedFeatures();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error getting advanced features:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 设置高级特性配置
 * POST /api/cluster/hyperpod/advanced-features
 */
router.post('/hyperpod/advanced-features', async (req, res) => {
  try {
    const ManagedFeaturesManager = require('./utils/managedFeaturesManager');
    const manager = new ManagedFeaturesManager(clusterManager);
    const result = await manager.updateAdvancedFeatures(req.body);
    res.json(result);
  } catch (error) {
    console.error('Error setting advanced features:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取 HyperPod 创建状态
 * GET /api/cluster/hyperpod-creation-status/:clusterTag
 */
router.get('/hyperpod-creation-status/:clusterTag', async (req, res) => {
  try {
    const { clusterTag } = req.params;
    const creatingClusters = getCreatingHyperPodClusters();
    const status = creatingClusters[clusterTag];

    if (!status) {
      return res.json({ success: true, status: null });
    }

    // 正在创建 CF Stack 时跳过查询（create-stack API 可能尚未完成）
    if (status.phase === 'CREATING_STACK') {
      return res.json({ success: true, status });
    }

    // 检查 CloudFormation 状态
    if (status.stackName && status.region) {
      try {
        const checkCmd = `aws cloudformation describe-stacks --stack-name ${status.stackName} --region ${status.region} --query 'Stacks[0].StackStatus' --output text`;
        const stackStatus = execSync(checkCmd, { encoding: 'utf8', timeout: 10000 }).trim();

        if (stackStatus === 'CREATE_COMPLETE') {
          status.cfStatus = 'CREATE_COMPLETE';
          return res.json({ success: true, status: { ...status, cfStatus: 'CREATE_COMPLETE' } });
        } else if (stackStatus.includes('FAILED') || stackStatus.includes('ROLLBACK') || stackStatus.includes('DELETE')) {
          console.log(`Auto-cleaning failed HyperPod creation: ${clusterTag}, status: ${stackStatus}`);
          updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');

          broadcast({
            type: 'hyperpod_creation_failed',
            status: 'error',
            message: `HyperPod creation failed and cleaned up: ${stackStatus}`,
            clusterTag: clusterTag
          });

          return res.json({ success: true, status: null });
        }

        status.cfStatus = stackStatus;
      } catch (error) {
        if (error.message.includes('does not exist')) {
          console.log(`Auto-cleaning non-existent HyperPod stack: ${clusterTag}`);
          updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
          return res.json({ success: true, status: null });
        }
        console.error(`Error checking CloudFormation status: ${error.message}`);
      }
    }

    res.json({ success: true, status });
  } catch (error) {
    console.error('Error getting HyperPod creation status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取正在创建的 HyperPod 集群列表（只读查询）
 * GET /api/cluster/creating-hyperpod-clusters
 * 
 * 注意：此 API 只返回当前状态，不触发任何写入/注册流程
 * 状态变更由定时检查链路 (index.js) 统一处理
 */
router.get('/creating-hyperpod-clusters', async (req, res) => {
  try {
    const creatingClusters = getCreatingHyperPodClusters();
    res.json({ success: true, data: creatingClusters });
  } catch (error) {
    console.error('Error getting creating HyperPod clusters:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取 HyperPod 依赖状态
 * GET /api/cluster/:clusterTag/hyperpod/dependencies/status
 */
router.get('/:clusterTag/hyperpod/dependencies/status', async (req, res) => {
  try {
    const { clusterTag } = req.params;
    const status = await HyperPodDependencyManager.getDependenciesStatus(clusterTag, clusterManager);
    res.json({ success: true, status });
  } catch (error) {
    console.error('Error getting HyperPod dependencies status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 重启 HyperPod 节点
 * POST /api/cluster/hyperpod/node/reboot
 */
router.post('/hyperpod/node/reboot', async (req, res) => {
  try {
    const { nodeId } = req.body;

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        message: 'Node ID is required'
      });
    }

    console.log(`Rebooting HyperPod node: ${nodeId}`);

    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({
        success: false,
        message: 'No active cluster selected'
      });
    }

    const clusterInfo = await clusterManager.getClusterInfo(activeCluster);
    if (!clusterInfo || !clusterInfo.hyperPodCluster) {
      return res.status(400).json({
        success: false,
        message: 'No HyperPod cluster found'
      });
    }

    // 从节点名提取 instance ID (hyperpod-i-xxx -> i-xxx)
    const instanceId = nodeId.replace(/^hyperpod-/, '');
    const hpClusterName = clusterInfo.hyperPodCluster.ClusterName;
    const region = clusterInfo.region;

    // 使用 SageMaker API 触发 reboot
    const cmd = `aws sagemaker batch-reboot-cluster-nodes --cluster-name ${hpClusterName} --node-ids ${instanceId} --region ${region}`;

    const result = execSync(cmd, { encoding: 'utf8' });
    console.log('Reboot API result:', result);

    const apiResult = JSON.parse(result);
    
    // 检查是否有失败的节点
    if (apiResult.Failed && apiResult.Failed.length > 0) {
      const failedNode = apiResult.Failed[0];
      return res.status(400).json({
        success: false,
        message: failedNode.Message || 'Reboot failed',
        errorCode: failedNode.ErrorCode,
        apiResponse: apiResult
      });
    }

    broadcast({
      type: 'hyperpod_node_reboot',
      status: 'success',
      nodeId: nodeId,
      message: `Node ${nodeId} reboot initiated`
    });

    res.json({
      success: true,
      message: 'Node reboot initiated successfully',
      nodeId: nodeId,
      apiResponse: apiResult
    });
  } catch (error) {
    console.error('HyperPod node reboot error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * 替换 HyperPod 节点
 * POST /api/cluster/hyperpod/node/replace
 */
router.post('/hyperpod/node/replace', async (req, res) => {
  try {
    const { nodeId } = req.body;

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        message: 'Node ID is required'
      });
    }

    console.log(`Replacing HyperPod node: ${nodeId}`);

    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({
        success: false,
        message: 'No active cluster selected'
      });
    }

    const clusterInfo = await clusterManager.getClusterInfo(activeCluster);
    if (!clusterInfo || !clusterInfo.hyperPodCluster) {
      return res.status(400).json({
        success: false,
        message: 'No HyperPod cluster found'
      });
    }

    // 从节点名提取 instance ID (hyperpod-i-xxx -> i-xxx)
    const instanceId = nodeId.replace(/^hyperpod-/, '');
    const hpClusterName = clusterInfo.hyperPodCluster.ClusterName;
    const region = clusterInfo.region;

    // 使用 SageMaker API 触发 replace
    const cmd = `aws sagemaker batch-replace-cluster-nodes --cluster-name ${hpClusterName} --node-ids ${instanceId} --region ${region}`;

    const result = execSync(cmd, { encoding: 'utf8' });
    console.log('Replace API result:', result);

    const apiResult = JSON.parse(result);
    
    // 检查是否有失败的节点
    if (apiResult.Failed && apiResult.Failed.length > 0) {
      const failedNode = apiResult.Failed[0];
      return res.status(400).json({
        success: false,
        message: failedNode.Message || 'Replace failed',
        errorCode: failedNode.ErrorCode,
        apiResponse: apiResult
      });
    }

    broadcast({
      type: 'hyperpod_node_replace',
      status: 'success',
      nodeId: nodeId,
      message: `Node ${nodeId} replacement initiated`
    });

    res.json({
      success: true,
      message: 'Node replacement initiated successfully',
      nodeId: nodeId,
      apiResponse: apiResult
    });
  } catch (error) {
    console.error('HyperPod node replace error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * 删除 HyperPod 节点
 * POST /api/cluster/hyperpod/node/delete
 */
router.post('/hyperpod/node/delete', async (req, res) => {
  try {
    const { nodeId } = req.body;

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        message: 'Node ID is required'
      });
    }

    console.log(`Deleting HyperPod node: ${nodeId}`);

    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({
        success: false,
        message: 'No active cluster selected'
      });
    }

    const clusterInfo = await clusterManager.getClusterInfo(activeCluster);
    if (!clusterInfo || !clusterInfo.hyperPodCluster) {
      return res.status(400).json({
        success: false,
        message: 'No HyperPod cluster found'
      });
    }

    // 从节点名提取 instance ID (hyperpod-i-xxx -> i-xxx)
    const instanceId = nodeId.replace(/^hyperpod-/, '');
    const hpClusterName = clusterInfo.hyperPodCluster.ClusterName;
    const region = clusterInfo.region;

    // 使用 SageMaker API 删除节点
    const cmd = `aws sagemaker batch-delete-cluster-nodes --cluster-name ${hpClusterName} --node-ids ${instanceId} --region ${region}`;

    const result = execSync(cmd, { encoding: 'utf8' });
    console.log('Delete API result:', result);

    const apiResult = JSON.parse(result);
    
    // 检查是否有失败的节点
    if (apiResult.Failed && apiResult.Failed.length > 0) {
      const failedNode = apiResult.Failed[0];
      return res.status(400).json({
        success: false,
        message: failedNode.Message || 'Delete failed',
        errorCode: failedNode.ErrorCode,
        apiResponse: apiResult
      });
    }

    broadcast({
      type: 'hyperpod_node_delete',
      status: 'success',
      nodeId: nodeId,
      message: `Node ${nodeId} deletion initiated`
    });

    res.json({
      success: true,
      message: 'Node deletion initiated successfully',
      nodeId: nodeId,
      apiResponse: apiResult
    });
  } catch (error) {
    console.error('HyperPod node delete error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ============================================================
// 导出
// ============================================================

module.exports = {
  router,
  initialize,

  // 导出辅助函数供其他模块使用
  getCreatingHyperPodClusters,
  updateCreatingHyperPodStatus,
  registerCompletedHyperPod,

  // 导出扩展点函数
  shouldUseThreadsPerCore2
};
