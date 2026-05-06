/**
 * NodeGroup API Manager
 *
 * EKS 节点组管理 API 模块，从 index.js 提取
 *
 * 包含的 API:
 * - GET /nodegroups - 获取节点组列表（EKS + HyperPod）
 * - PUT /nodegroups/:name/scale - 缩放 EKS 节点组
 * - DELETE /nodegroup/:nodeGroupName - 删除 EKS 节点组
 * - POST /create-nodegroup - 创建 EKS 节点组
 * - GET /:clusterTag/nodegroup/:nodeGroupName/dependencies/status - 检查依赖状态
 *
 * 扩展点（供 Neuron 项目覆盖）:
 * - getNodeGroups(): 可被覆盖以支持不同的实例类型检测逻辑
 */

const express = require('express');
const router = express.Router();
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs = require('fs');
const path = require('path');

// 模块依赖 - 将在 initialize 中注入
let broadcast = null;
let clusterManager = null;
let CloudFormationManager = null;

/**
 * 初始化模块
 * @param {Function} broadcastFn - WebSocket 广播函数
 * @param {Object} clusterMgr - ClusterManager 实例
 */
function initialize(broadcastFn, clusterMgr) {
  broadcast = broadcastFn;
  clusterManager = clusterMgr;
  CloudFormationManager = require('./utils/cloudFormationManager');
  console.log('NodeGroup API Manager initialized');
}

// ==================== 节点组列表 API ====================

/**
 * GET /nodegroups
 * 获取当前集群的所有节点组（EKS + HyperPod）
 */
router.get('/nodegroups', async (req, res) => {
  try {
    const ClusterManager = require('./clusterManager');
    const localClusterManager = new ClusterManager();
    const activeClusterName = localClusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    // 从 cluster_info.json 获取集群信息
    const clusterInfo = await localClusterManager.getClusterInfo(activeClusterName);

    if (!clusterInfo) {
      return res.status(400).json({ error: 'Cluster configuration not found' });
    }

    const clusterName = clusterInfo.eksCluster?.name || activeClusterName;
    const region = clusterInfo.region;

    // 获取EKS节点组
    const eksCmd = `aws eks list-nodegroups --cluster-name ${clusterName} --region ${region} --output json`;
    const eksResult = await execAsync(eksCmd);
    const eksData = JSON.parse(eksResult.stdout);


    // 获取HyperPod实例组 - 优先使用userCreated，然后使用detected
    const hyperPodGroups = [];

    try {
      // 从metadata中获取HyperPod集群信息
      const metadataDir = localClusterManager.getClusterMetadataDir(activeClusterName);
      const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

      if (fs.existsSync(clusterInfoPath)) {
        const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));

        // 使用新的hyperPodCluster结构，动态获取最新状态
        if (clusterInfo.hyperPodCluster) {
          const hpClusterName = clusterInfo.hyperPodCluster.ClusterName;
          console.log(`Found HyperPod cluster: ${hpClusterName}, fetching latest status...`);

          try {
            // 使用AWS Helper动态获取最新的HyperPod集群状态
            const AWSHelpers = require('./utils/awsHelpers');
            const hpData = await AWSHelpers.describeHyperPodCluster(hpClusterName, region);

            // Collect all subnet IDs to batch-resolve AZs (include cluster-level VpcConfig as fallback)
            const clusterSubnets = hpData.VpcConfig?.Subnets || [];
            const allSubnetIds = [...new Set([
              ...clusterSubnets,
              ...(hpData.InstanceGroups || [])
                .flatMap(ig => ig.OverrideVpcConfig?.Subnets || [])
            ])];
            const subnetAZMap = await AWSHelpers.getSubnetAZs(allSubnetIds, region);

            for (const instanceGroup of hpData.InstanceGroups || []) {
              // 判断 Capacity Type: Spot > Training Plan > On-Demand
              let capacityType = 'on-demand';
              if (instanceGroup.CapacityRequirements?.Spot) {
                capacityType = 'spot';
              } else if (instanceGroup.TrainingPlanArn) {
                capacityType = 'training-plan';
              }

              // Resolve AZ from subnet: instance-level OverrideVpcConfig first, fallback to cluster-level VpcConfig
              const subnets = instanceGroup.OverrideVpcConfig?.Subnets || clusterSubnets;
              const availabilityZone = subnets.length > 0 ? subnetAZMap[subnets[0]] || '' : '';

              hyperPodGroups.push({
                clusterName: hpData.ClusterName,
                clusterArn: hpData.ClusterArn,
                clusterStatus: hpData.ClusterStatus, // 添加集群级别状态
                name: instanceGroup.InstanceGroupName,
                status: instanceGroup.Status,
                instanceType: instanceGroup.InstanceType,
                availabilityZone,
                capacityType: capacityType, // 添加容量类型
                currentCount: instanceGroup.CurrentCount,
                targetCount: instanceGroup.TargetCount,
                executionRole: instanceGroup.ExecutionRole
              });
            }
          } catch (hpError) {
            console.warn(`Failed to get latest HyperPod cluster status for ${hpClusterName}:`, hpError.message);
          }
        } else {
          console.log('No HyperPod cluster found in metadata');
        }
      } else {
        console.log('No cluster metadata found, no HyperPod clusters available');
      }

    } catch (hpError) {
      console.log('Error reading HyperPod cluster metadata:', hpError.message);
    }

    console.log(`Returning ${hyperPodGroups.length} HyperPod instance groups`);

    res.json({
      hyperPodInstanceGroups: hyperPodGroups
    });
  } catch (error) {
    console.error('Error fetching node groups:', error);
    res.status(500).json({ error: error.message });
  }
});


// ==================== 模块导出 ====================

module.exports = {
  router,
  initialize
};
