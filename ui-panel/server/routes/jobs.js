/**
 * k8s-jobs routes.
 *
 * Extracted from index.js (Phase 3, wave 4). This module only reads and
 * deletes Kubernetes jobs. It uses dependency injection for executeKubectl,
 * which is provided by the host via initialize().
 */

const express = require('express');
const router = express.Router();

// Module-level injected dependencies
let executeKubectl = null;

function initialize(deps) {
  executeKubectl = deps.executeKubectl;
}

// 获取 Kubernetes Jobs（kubectl get jobs）
router.get('/k8s-jobs', async (req, res) => {
  try {
    const output = await executeKubectl('get jobs -o json');
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
    res.json({ success: true, jobs });
  } catch (error) {
    console.error('Error fetching k8s jobs:', error);
    res.json({ success: true, jobs: [] });
  }
});

// 删除 Kubernetes Job
router.delete('/k8s-jobs/:jobName', async (req, res) => {
  try {
    const { jobName } = req.params;
    await executeKubectl(`delete job ${jobName}`);
    res.json({ success: true, message: `Job ${jobName} deleted` });
  } catch (error) {
    console.error('Error deleting k8s job:', error);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

module.exports = { router, initialize };
