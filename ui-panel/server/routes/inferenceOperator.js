/**
 * HyperPod Inference Operator routes (feature: inference-operator).
 *
 * Extracted from index.js (Phase 3 wave N — sentinel-aware). public:true in both
 * manifests today (ships); listed in manifest paths + index.js require/mount
 * wrapped in an inference-operator release sentinel for clean future withholding.
 * Self-requires the operator managers (../utils/…); inject clusterManager.
 */

const express = require('express');
const router = express.Router();
const { promisify } = require('util');
const execAsync = promisify(require('child_process').exec);

let clusterManager = null;

function initialize(deps) {
  clusterManager = deps.clusterManager;
}

// 获取 AMP Workspace URL
router.get('/cluster/amp-workspace', async (req, res) => {
  try {
    const InferenceOperatorManager = require('../utils/inferenceOperatorManager');
    const inferenceOpManager = new InferenceOperatorManager(clusterManager);
    const result = await inferenceOpManager.getAmpWorkspace();
    res.json(result);
  } catch (error) {
    console.error('Error fetching AMP workspace:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取 HyperPod Inference Operator 部署列表
router.get('/inference-operator/deployments', async (req, res) => {
  try {
    const { stdout } = await execAsync(
      `kubectl get deployments -A -l deploying-service=hyperpod-inference -o json`
    );
    const result = JSON.parse(stdout);

    const deployments = result.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      replicas: item.spec.replicas,
      availableReplicas: item.status.availableReplicas || 0,
      creationTimestamp: item.metadata.creationTimestamp
    }));

    res.json({ success: true, deployments });
  } catch (error) {
    console.error('Error fetching inference operator deployments:', error);
    res.status(500).json({ success: false, error: error.message, deployments: [] });
  }
});

// Get available metrics for Inference Operator deployment
router.get('/inference-operator/deployment/:name/metrics', async (req, res) => {
  try {
    const { name } = req.params;
    const InferenceOperatorMetricsManager = require('../utils/inferenceOperatorMetricsManager');
    const result = await InferenceOperatorMetricsManager.getDeploymentMetrics(name);
    res.json(result);
  } catch (error) {
    console.error('Error fetching deployment metrics:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      businessMetrics: [],
      vllmMetrics: []
    });
  }
});

module.exports = { router, initialize };
