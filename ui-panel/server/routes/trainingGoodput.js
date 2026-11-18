/**
 * Training Goodput 路由（GET /api/training-jobs/:jobName/goodput）。
 *
 * 只读：数值来自 HyperPod Observability add-on 的 Training Metrics Agent，组合方式见
 * utils/trainingGoodput.js。依赖通过 initialize() 注入，便于测试。
 */

const express = require('express');
const router = express.Router();
const { collectInvalid, collectPresent, rejectInvalid } = require('../utils/validateInput');
const { runKubectl } = require('../utils/kubectl');
const { resolveClusterTarget } = require('../utils/kubectlContext');
const { fetchTrainingMetrics, summarizeJobGoodput, METRICS_SOURCE } = require('../utils/trainingGoodput');

let queryKubectl = runKubectl;
let resolveTarget = resolveClusterTarget;

function initialize(deps = {}) {
  queryKubectl = deps.queryKubectl || runKubectl;
  resolveTarget = deps.resolveTarget || resolveClusterTarget;
}

router.get('/training-jobs/:jobName/goodput', async (req, res) => {
  const problems = [
    ...collectInvalid([['jobName', req.params.jobName, 'token']]),
    ...collectPresent([['clusterTag', req.query.clusterTag, 'token', { maxLength: 100 }]]),
  ];
  if (problems.length) return rejectInvalid(res, problems, req.path);

  let target;
  try {
    target = resolveTarget(req.query.clusterTag);
  } catch (error) {
    return res.status(409).json({ success: false, error: error.message });
  }

  try {
    const metrics = await fetchTrainingMetrics({ queryKubectl, context: target.context });
    if (!metrics.installed) {
      return res.json({
        success: true,
        clusterTag: target.clusterTag,
        status: 'not_installed',
        jobName: req.params.jobName,
        source: METRICS_SOURCE,
      });
    }
    res.json({
      success: true,
      clusterTag: target.clusterTag,
      fetchedAt: new Date().toISOString(),
      ...summarizeJobGoodput(metrics.samples, req.params.jobName),
    });
  } catch (error) {
    console.error(`Error reading training metrics for ${req.params.jobName}:`, error.message);
    res.status(503).json({
      success: false,
      error: `Training Metrics Agent (${METRICS_SOURCE.namespace}/${METRICS_SOURCE.service}) unavailable: ${error.stderr || error.message}`,
    });
  }
});

module.exports = { router, initialize };
