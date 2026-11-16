/**
 * k8s-jobs routes.
 *
 * Extracted from index.js (Phase 3, wave 4). This module only reads and
 * deletes Kubernetes jobs. It uses dependency injection for executeKubectl,
 * which is provided by the host via initialize().
 */

const express = require('express');
const router = express.Router();
const { collectInvalid, rejectInvalid } = require('../utils/validateInput');
const { runKubectl } = require('../utils/kubectl');
const { resolveClusterTarget } = require('../utils/kubectlContext');

// Module-level injected dependencies
let executeKubectl = null;
let queryKubectl = runKubectl;
let resolveTarget = resolveClusterTarget;

function initialize(deps) {
  executeKubectl = deps.executeKubectl;
  queryKubectl = deps.queryKubectl || runKubectl;
  resolveTarget = deps.resolveTarget || resolveClusterTarget;
}

function queryProblems(req) {
  const problems = [];
  for (const field of ['namespace', 'clusterTag']) {
    if (req.query[field] !== undefined) {
      problems.push(...collectInvalid([[field, req.query[field], 'token', {
        maxLength: field === 'namespace' ? 63 : 100
      }]]));
    }
  }
  return problems;
}

// 获取 Kubernetes Jobs（kubectl get jobs）
router.get('/k8s-jobs', async (req, res) => {
  try {
    const problems = queryProblems(req);
    if (req.query.allNamespaces !== undefined &&
        !['true', 'false'].includes(req.query.allNamespaces)) {
      problems.push('allNamespaces must be true or false');
    }
    if (req.query.namespace && req.query.allNamespaces === 'true') {
      problems.push('namespace cannot be combined with allNamespaces=true');
    }
    if (problems.length) return rejectInvalid(res, problems, req.path);
    const target = resolveTarget(req.query.clusterTag);
    const scope = req.query.allNamespaces === 'true'
      ? ['-A']
      : ['-n', req.query.namespace || 'default'];
    const output = await queryKubectl(['get', 'jobs', ...scope, '-o', 'json'], {
      context: target.context,
      timeout: 30000
    });
    const data = JSON.parse(output);
    const jobs = (data.items || []).map(job => ({
      name: job.metadata?.name,
      namespace: job.metadata?.namespace || 'default',
      completions: job.spec?.completions || 1,
      succeeded: job.status?.succeeded || 0,
      failed: job.status?.failed || 0,
      active: job.status?.active || 0,
      startTime: job.status?.startTime,
      completionTime: job.status?.completionTime,
      creationTimestamp: job.metadata?.creationTimestamp,
      conditions: job.status?.conditions || []
    }));
    res.json({ success: true, clusterTag: target.clusterTag, jobs });
  } catch (error) {
    console.error('Error fetching k8s jobs:', error);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

router.get('/k8s-jobs/:jobName', async (req, res) => {
  try {
    const problems = [
      ...queryProblems(req),
      ...collectInvalid([['jobName', req.params.jobName, 'token', { maxLength: 63 }]])
    ];
    if (problems.length) return rejectInvalid(res, problems, req.path);
    const target = resolveTarget(req.query.clusterTag);
    const output = await queryKubectl([
      'get', 'job', req.params.jobName,
      '-n', req.query.namespace || 'default', '-o', 'json'
    ], { context: target.context, timeout: 30000 });
    res.json({ success: true, clusterTag: target.clusterTag, job: JSON.parse(output) });
  } catch (error) {
    console.error('Error fetching k8s job:', error);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

// 删除 Kubernetes Job
router.delete('/k8s-jobs/:jobName', async (req, res) => {
  try {
    const { jobName } = req.params;

    const problems = collectInvalid([['jobName', jobName, 'token', { maxLength: 63 }]]);
    if (problems.length > 0) return rejectInvalid(res, problems, req.path);

    await executeKubectl(['delete', 'job', jobName]);
    res.json({ success: true, message: `Job ${jobName} deleted` });
  } catch (error) {
    console.error('Error deleting k8s job:', error);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

module.exports = { router, initialize };
