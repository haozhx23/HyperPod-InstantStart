/**
 * Cluster available instance-types aggregation route.
 *
 * Extracted from index.js (Phase 3 wave N). Public route (ships); it contains an
 * inner release-sentinel-wrapped branch (one withheld instance-type source) that is
 * stripped in builds where that feature is withheld — leaving a valid if-without-else.
 * Zero injection: uses AWSHelpers (../utils) + execSync only.
 */

const express = require('express');
const router = express.Router();

router.get('/cluster/cluster-available-instance', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    const { getEffectiveRegion } = require('../utils/regionResolver');

    console.log('Fetching cluster available instance types...');

    // 初始化结果数据结构
    const result = {
      success: true,
      data: {
        hyperpod: [],
        eksNodeGroup: [],
        karpenter: [],
        karpenterHyperPod: []  // 新增：Karpenter HyperPod 实例类型
      }
    };

    // 获取区域(运维路径:优先活跃集群 region,主机兜底)
    const region = getEffectiveRegion();

    // 1. 获取 HyperPod 实例类型
    try {
      const nodesJson = execSync('kubectl get nodes -o json', { encoding: 'utf8', timeout: 10000 });
      const nodesData = JSON.parse(nodesJson);

      // 过滤HyperPod节点并统计实例类型
      const hyperPodNodes = nodesData.items.filter(node =>
        node.metadata.labels['sagemaker.amazonaws.com/compute-type'] === 'hyperpod'
      );

      const hyperPodTypeMap = new Map();
      hyperPodNodes.forEach(node => {
        const instanceType = node.metadata.labels['node.kubernetes.io/instance-type'];
        const instanceGroup = node.metadata.labels['sagemaker.amazonaws.com/instance-group-name'];

        if (instanceType && instanceType.startsWith('ml.')) {
          const key = `${instanceType}-${instanceGroup}`;
          if (!hyperPodTypeMap.has(key)) {
            hyperPodTypeMap.set(key, {
              type: instanceType,
              group: instanceGroup,
              count: 0
            });
          }
          hyperPodTypeMap.get(key).count++;
        }
      });

      result.data.hyperpod = Array.from(hyperPodTypeMap.values());
      console.log(`Found ${result.data.hyperpod.length} HyperPod instance types`);
    } catch (error) {
      console.warn('Error fetching HyperPod instance types:', error.message);
    }

    // 2. 获取 EKS NodeGroup 实例类型
    try {
      const nodesJson = execSync('kubectl get nodes -o json', { encoding: 'utf8', timeout: 10000 });
      const nodesData = JSON.parse(nodesJson);

      // 过滤EKS NodeGroup节点
      const eksNodes = nodesData.items.filter(node =>
        node.metadata.labels['alpha.eksctl.io/nodegroup-name'] &&
        !node.metadata.labels['sagemaker.amazonaws.com/compute-type']
      );

      const eksTypeMap = new Map();
      eksNodes.forEach(node => {
        const instanceType = node.metadata.labels['node.kubernetes.io/instance-type'];
        const nodeGroup = node.metadata.labels['alpha.eksctl.io/nodegroup-name'];

        if (instanceType && !instanceType.startsWith('ml.')) {
          const key = `${instanceType}-${nodeGroup}`;
          if (!eksTypeMap.has(key)) {
            eksTypeMap.set(key, {
              type: instanceType,
              nodeGroup: nodeGroup,
              count: 0
            });
          }
          eksTypeMap.get(key).count++;
        }
      });

      result.data.eksNodeGroup = Array.from(eksTypeMap.values());
      console.log(`Found ${result.data.eksNodeGroup.length} EKS NodeGroup instance types`);
    } catch (error) {
      console.warn('Error fetching EKS NodeGroup instance types:', error.message);
    }

    // 3. 获取 Karpenter NodePool 实例类型（分离 EC2 和 HyperPod）
    try {
      const nodePoolsJson = execSync('kubectl get nodepool -o json', { encoding: 'utf8', timeout: 10000 });
      const nodePoolsData = JSON.parse(nodePoolsJson);

      nodePoolsData.items.forEach(nodePool => {
        const nodePoolName = nodePool.metadata.name;
        const nodeClassRef = nodePool.spec?.template?.spec?.nodeClassRef;
        
        // 检查是否是 HyperpodNodeClass
        if (nodeClassRef?.kind === 'HyperpodNodeClass') {
          // 从 HyperpodNodeClass 获取实例类型
          try {
            const nodeClassName = nodeClassRef.name;
            const nodeClassJson = execSync(`kubectl get hyperpodnodeclass ${nodeClassName} -o json`, { encoding: 'utf8', timeout: 5000 });
            const nodeClassData = JSON.parse(nodeClassJson);
            
            // 从 status.instanceGroups 获取实例类型
            const statusInstanceGroups = nodeClassData.status?.instanceGroups || [];
            statusInstanceGroups.forEach(ig => {
              const instanceTypes = ig.instanceTypes || [];
              instanceTypes.forEach(instanceType => {
                result.data.karpenterHyperPod.push({
                  type: instanceType,
                  nodePool: nodePoolName,
                  available: true
                });
              });
            });
          } catch (ncError) {
            console.warn(`Failed to get HyperpodNodeClass for NodePool ${nodePoolName}:`, ncError.message);
          }
        }
      });

      console.log(`Found ${result.data.karpenter.length} Karpenter EC2 instance types`);
      console.log(`Found ${result.data.karpenterHyperPod.length} Karpenter HyperPod instance types`);
    } catch (error) {
      // Karpenter 未安装时静默处理，不输出错误日志
    }

    // 只打印摘要，不打印完整 JSON
    console.log('Cluster available instance types fetched:', {
      hyperpod: result.data?.hyperpod?.length || 0,
      eksNodeGroup: result.data?.eksNodeGroup?.length || 0,
      karpenter: result.data?.karpenter?.length || 0,
      karpenterHyperPod: result.data?.karpenterHyperPod?.length || 0
    });
    res.json(result);

  } catch (error) {
    console.error('Error fetching cluster available instance types:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = { router };
