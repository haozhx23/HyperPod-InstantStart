/**
 * Training Goodput 路由（GET /api/training-jobs/:jobName/goodput）。
 *
 * 只读：数值都由 HyperPod Observability 的 Training Metrics Agent 算好。运行中和刚结束的
 * 任务读 agent 的实时 /metrics；窗口已滑过任务开头的已完成任务从 AMP 读历史结果。
 * 取哪份数据见 utils/trainingGoodput.js 的 resolveJobGoodput()。依赖通过 initialize() 注入，
 * 便于测试。
 */

const express = require('express');
const router = express.Router();
const { collectInvalid, collectPresent, rejectInvalid } = require('../utils/validateInput');
const { runKubectl } = require('../utils/kubectl');
const { resolveClusterTarget } = require('../utils/kubectlContext');
const { ampClient } = require('../utils/ampQuery');
const {
  METRICS_SOURCE,
  COLLECTOR_CONFIG,
  fetchTrainingMetrics,
  fetchHptoJob,
  describeHptoJob,
  fetchHistorySource,
  loadWholeJobFromHistory,
  resolveJobGoodput,
} = require('../utils/trainingGoodput');

// 已完成任务的历史结果不会再变，按 (context, 任务 uid) 缓存；只缓存成功结果，
// 失败或「暂无」下次重查。条目上限防止长期运行时无界增长。
const HISTORY_CACHE_LIMIT = 500;

let queryKubectl = runKubectl;
let resolveTarget = resolveClusterTarget;
let queryAmp = ampClient.query;
let now = () => Date.now();
const historyCache = new Map();
const historyInFlight = new Map();

function initialize(deps = {}) {
  queryKubectl = deps.queryKubectl || runKubectl;
  resolveTarget = deps.resolveTarget || resolveClusterTarget;
  queryAmp = deps.queryAmp || ampClient.query;
  now = deps.now || (() => Date.now());
  historyCache.clear();
  historyInFlight.clear();
}

/** 给失败加上「哪一步」的前缀，保留 kubectl 的 stderr。 */
function step(label, promise) {
  return promise.catch(error => {
    throw Object.assign(new Error(`${label}: ${(error.stderr || '').trim() || error.message}`), { cause: error });
  });
}

function rememberHistory(key, value) {
  if (historyCache.size >= HISTORY_CACHE_LIMIT) historyCache.delete(historyCache.keys().next().value);
  historyCache.set(key, value);
}

function loadHistoryCached({ job, context }) {
  const key = JSON.stringify([context, job.uid || `${job.namespace}/${job.name}@${job.createdAtMs}`]);
  if (historyCache.has(key)) return Promise.resolve(historyCache.get(key));
  if (historyInFlight.has(key)) return historyInFlight.get(key);

  const promise = loadWholeJobFromHistory({
    job,
    loadHistorySource: () => step(
      `Cannot read ${COLLECTOR_CONFIG.namespace}/${COLLECTOR_CONFIG.configMap}`,
      fetchHistorySource({ queryKubectl, context })
    ),
    queryAmp: params => step('Goodput history query (Amazon Managed Service for Prometheus) failed', queryAmp(params)),
  }).then(result => {
    if (result.status === 'ok') rememberHistory(key, result);
    return result;
  }).finally(() => historyInFlight.delete(key));
  historyInFlight.set(key, promise);
  return promise;
}

router.get('/training-jobs/:jobName/goodput', async (req, res) => {
  const problems = [
    ...collectInvalid([['jobName', req.params.jobName, 'token']]),
    ...collectPresent([
      ['clusterTag', req.query.clusterTag, 'token', { maxLength: 100 }],
      ['namespace', req.query.namespace, 'token', { maxLength: 63 }],
    ]),
  ];
  if (problems.length) return rejectInvalid(res, problems, req.path);

  let target;
  try {
    target = resolveTarget(req.query.clusterTag);
  } catch (error) {
    return res.status(409).json({ success: false, error: error.message });
  }

  const { jobName } = req.params;
  const { context } = target;
  try {
    const [resource, metrics] = await Promise.all([
      step(`Cannot read HyperPodPyTorchJob ${jobName}`,
        fetchHptoJob({ queryKubectl, context, jobName, namespace: req.query.namespace })),
      step(`Training Metrics Agent (${METRICS_SOURCE.namespace}/${METRICS_SOURCE.service}) unavailable`,
        fetchTrainingMetrics({ queryKubectl, context })),
    ]);
    if (!metrics.installed) {
      return res.json({
        success: true,
        clusterTag: target.clusterTag,
        status: 'not_installed',
        jobName,
        source: METRICS_SOURCE,
      });
    }
    if (!resource) {
      return res.status(404).json({ success: false, error: `HyperPodPyTorchJob ${jobName} not found` });
    }

    const job = describeHptoJob(resource);
    const result = await resolveJobGoodput({
      job,
      samples: metrics.samples,
      now: now(),
      loadHistory: () => loadHistoryCached({ job, context }),
    });
    res.json({
      success: true,
      clusterTag: target.clusterTag,
      fetchedAt: new Date(now()).toISOString(),
      ...result,
    });
  } catch (error) {
    console.error(`Error reading goodput for ${jobName}:`, error.message);
    res.status(503).json({ success: false, error: error.message });
  }
});

module.exports = { router, initialize };
