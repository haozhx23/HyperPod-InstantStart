/**
 * Pod describe 路由
 *
 * 从 index.js 抽离(Phase 3 波9)。
 * 提供 Pod describe(kubectl describe pod)接口。
 * 含 K8s 名称安全校验,依赖注入 executeKubectl。
 */

const express = require('express');
const router = express.Router();

// name/namespace 仅允许 [a-zA-Z0-9.\-_]，拒绝任何 shell 元字符。
const SAFE_K8S_NAME = /^[a-zA-Z0-9][a-zA-Z0-9.\-_]*$/;

let executeKubectl = null;

function initialize(deps) {
  executeKubectl = deps.executeKubectl;
}

router.get('/pods/:namespace/:name/describe', async (req, res) => {
  const { namespace, name } = req.params;
  if (!SAFE_K8S_NAME.test(namespace) || !SAFE_K8S_NAME.test(name)) {
    return res.status(400).json({ success: false, error: 'Invalid namespace or pod name' });
  }
  try {
    const output = await executeKubectl(`describe pod ${name} -n ${namespace}`, 20000);
    res.json({ success: true, output });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err?.message || (typeof err === 'string' ? err : 'kubectl describe failed'),
    });
  }
});

module.exports = { router, initialize };
