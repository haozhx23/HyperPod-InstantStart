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
const { collectInvalid, collectPresent, rejectInvalid } = require('../utils/validateInput');

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

    // `kubectl get nodepool ${name} -o json` + `kubectl delete nodepool ${name}`
    // （`hyperpodKarpenterManager.js:102`/`:109`）
    const problems = collectInvalid([['name', name]]);
    if (problems.length > 0) {
      return rejectInvalid(res, problems, 'DELETE /cluster/hyperpod-karpenter/nodepool/:name');
    }

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

    // `kubectl delete hyperpodnodeclass ${name}`（`hyperpodKarpenterManager.js:144`）
    const problems = collectInvalid([['name', name]]);
    if (problems.length > 0) {
      return rejectInvalid(res, problems, 'DELETE /cluster/hyperpod-karpenter/nodeclass/:name');
    }

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

    // clusterTag 进 IAM 角色名与策略名（`hyperpodKarpenterInstaller.js:50`/`:78`）并被写进 metadata；
    // hyperPodClusterName 进 `aws sagemaker update-cluster --cluster-name "${...}"`（同文件 `:157`）
    // ——双引号挡不住 `$( )` 与反引号。
    const problems = collectInvalid([
      ['clusterTag', clusterTag, 'token', { maxLength: 100 }],
      ['hyperPodClusterName', hyperPodClusterName, 'token', { maxLength: 100 }],
    ]);
    if (problems.length > 0) {
      return rejectInvalid(res, problems, 'POST /cluster/hyperpod-karpenter/install');
    }

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

    // 每个元素都进拼接式 YAML 的列表项，YAML 再进 `kubectl apply -f - <<EOF`
    // （`hyperpodKarpenterManager.js:171`/`:174`）；第一个元素还会成为 nodeclass/nodepool 名。
    // 用 'tokens' 逐元素校验：报错要能指出是哪一个。
    const problems = collectInvalid([['instanceGroups', instanceGroups, 'tokens', { maxLength: 100 }]]);
    if (problems.length > 0) {
      return rejectInvalid(res, problems, 'POST /cluster/hyperpod-karpenter/create-resource');
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
    const problems = collectInvalid([['instanceGroupName', req.params.instanceGroupName, 'token', { maxLength: 100 }]]);
    if (problems.length > 0) {
      return rejectInvalid(res, problems, 'GET /cluster/hyperpod-karpenter/nodeclaims/:instanceGroupName');
    }

    const nodeClaims = await HyperPodKarpenterManager.getNodeClaimsByInstanceGroup(req.params.instanceGroupName);
    res.json({ success: true, data: nodeClaims });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 删除 NodeClaim
router.delete('/cluster/hyperpod-karpenter/nodeclaim/:name', async (req, res) => {
  try {
    // `kubectl delete nodeclaim ${name}`（`hyperpodKarpenterManager.js:260`）
    const problems = collectInvalid([['name', req.params.name]]);
    if (problems.length > 0) {
      return rejectInvalid(res, problems, 'DELETE /cluster/hyperpod-karpenter/nodeclaim/:name');
    }

    const result = await HyperPodKarpenterManager.deleteNodeClaim(req.params.name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = { router, initialize };
