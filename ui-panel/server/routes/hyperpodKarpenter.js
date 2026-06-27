/**
 * HyperPod Karpenter routes (feature: hyperpod-karpenter).
 *
 * Extracted from index.js (Phase 3 wave N — sentinel-aware). This is a distinct
 * Karpenter variant (its own feature/module/routes). public:true in both
 * manifests today (ships); listed in manifest paths + index.js require/mount wrapped
 * in a hyperpod-karpenter release sentinel so it can be withheld cleanly if ever flipped.
 * Self-requires HyperPodKarpenterManager + HyperPodKarpenterInstaller; inject clusterManager.
 */

const express = require('express');
const router = express.Router();
const HyperPodKarpenterManager = require('../utils/hyperpodKarpenterManager');
const HyperPodKarpenterInstaller = require('../utils/hyperpodKarpenterInstaller');

let clusterManager = null;

function initialize(deps) {
  clusterManager = deps.clusterManager;
}

// ==========================================
// HyperPod Karpenter Management APIs
// ==========================================

// 获取 HyperPod Karpenter 资源
router.get('/cluster/hyperpod-karpenter/resources', async (req, res) => {
  try {
    const resources = await HyperPodKarpenterManager.getHyperPodKarpenterResources();

    res.json({
      success: true,
      data: resources
    });
  } catch (error) {
    console.error('Error getting HyperPod Karpenter resources:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: {
        nodeClasses: [],
        nodePools: []
      }
    });
  }
});

// 删除 HyperPod Karpenter NodePool
router.delete('/cluster/hyperpod-karpenter/nodepool/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await HyperPodKarpenterManager.deleteNodePool(name);

    res.json(result);
  } catch (error) {
    console.error('Error deleting HyperPod Karpenter NodePool:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 删除 HyperpodNodeClass
router.delete('/cluster/hyperpod-karpenter/nodeclass/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await HyperPodKarpenterManager.deleteNodeClass(name);

    res.json(result);
  } catch (error) {
    console.error('Error deleting HyperpodNodeClass:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// 安装 HyperPod Karpenter
router.post('/cluster/hyperpod-karpenter/install', async (req, res) => {
  try {
    const { clusterTag, hyperPodClusterName } = req.body;

    console.log(`Installing HyperPod Karpenter for cluster: ${clusterTag}, HyperPod: ${hyperPodClusterName}`);

    const result = await HyperPodKarpenterInstaller.installHyperPodKarpenter(clusterTag, hyperPodClusterName);

    res.json(result);
  } catch (error) {
    console.error('Error installing HyperPod Karpenter:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取 HyperPod Karpenter 安装状态
router.get('/cluster/hyperpod-karpenter/status', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    const status = await HyperPodKarpenterInstaller.getInstallationStatus(activeCluster);

    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('Error getting HyperPod Karpenter status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: { installed: false }
    });
  }
});

// 创建 HyperPod Karpenter 资源
router.post('/cluster/hyperpod-karpenter/create-resource', async (req, res) => {
  try {
    const { instanceGroups } = req.body;

    if (!instanceGroups || instanceGroups.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Instance groups are required'
      });
    }

    const result = await HyperPodKarpenterManager.createHyperPodKarpenterResource(instanceGroups);

    res.json(result);
  } catch (error) {
    console.error('Error creating HyperPod Karpenter resource:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取指定 instance group 的 NodeClaim 列表
router.get('/cluster/hyperpod-karpenter/nodeclaims/:instanceGroupName', async (req, res) => {
  try {
    const nodeClaims = await HyperPodKarpenterManager.getNodeClaimsByInstanceGroup(req.params.instanceGroupName);
    res.json({ success: true, data: nodeClaims });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 删除 NodeClaim
router.delete('/cluster/hyperpod-karpenter/nodeclaim/:name', async (req, res) => {
  try {
    const result = await HyperPodKarpenterManager.deleteNodeClaim(req.params.name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = { router, initialize };
