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

let broadcast = null;

function initialize(deps) {
  broadcast = deps.broadcast;
}

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
