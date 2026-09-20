/**
 * Managed Inference scaling (ScaledObject) routes (feature: managed-inference).
 *
 * Extracted from index.js (Phase 3 wave N — sentinel-aware). public:true in std,
 * public:false in .ec2. The managedScalingManager backing file is already a
 * withheld path; this file is added to the same feature paths so it is deleted
 * wherever managed-inference is withheld, and index.js require/mount are wrapped
 * in a managed-inference release sentinel. Self-requires the manager; inject broadcast.
 */

const express = require('express');
const router = express.Router();
const ManagedScalingManager = require('../utils/managedScalingManager');
const { collectInvalid, rejectInvalid } = require('../utils/validateInput');

let broadcast = null;

function initialize(deps) {
  broadcast = deps.broadcast;
}

// 这两个 POST 端点**故意不做 token 校验**：`generateScaledObjectYAML()` 把配置装进一个
// JS 对象再交给 `YAML.stringify()`（`managedScalingManager.js:76`），序列化器自己负责转义，
// 数值走 `parseInt`，落盘路径只含时间戳。这里不存在拼接式 YAML 或 shell 插值。
// 给 promQuery 套名字白名单反而会把合法的 PromQL 拒掉——同 `download-model-enhanced` 的教训。

// Managed Inference Scaling - Preview ScaledObject YAML
router.post('/keda/preview-scaledobject', async (req, res) => {
  try {
    const config = req.body;
    const result = await ManagedScalingManager.previewScaledObject(config);
    res.json(result);
  } catch (error) {
    console.error('Error generating ScaledObject preview:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Managed Inference Scaling - Deploy ScaledObject
router.post('/keda/deploy-scaledobject', async (req, res) => {
  try {
    const config = req.body;
    const result = await ManagedScalingManager.deployScaledObject(config);
    res.json(result);
  } catch (error) {
    console.error('Error deploying ScaledObject:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 删除 ScaledObject
router.delete('/keda/scaledobject/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { namespace = 'default' } = req.query;

    // `kubectl delete scaledobject ${name} -n ${namespace}`（`managedScalingManager.js:134`）
    const problems = collectInvalid([
      ['name', name, 'token', { maxLength: 253 }],
      ['namespace', namespace, 'token', { maxLength: 63 }],
    ]);
    if (problems.length > 0) return rejectInvalid(res, problems, 'DELETE /keda/scaledobject/:name');

    const result = await ManagedScalingManager.deleteScaledObject(name, namespace);

    if (result.success) {
      broadcast({
        type: 'keda_scaledobject_deleted',
        status: 'success',
        message: result.message,
        scaledObjectName: name,
        namespace: namespace,
        timestamp: new Date().toISOString()
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Error deleting ScaledObject:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = { router, initialize };
