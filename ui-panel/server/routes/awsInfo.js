/**
 * routes/awsInfo.js
 * -----------------------------------------------------------
 * Read-only AWS / cluster query endpoints, extracted verbatim
 * from index.js (Phase 3 route-extraction, wave 2).
 *
 * Dependency model:
 *   - AWSHelpers / NetworkManager / AWSInstanceTypeManager are
 *     stateless utility modules — required directly here. Node's
 *     module cache means these are the SAME singletons index.js
 *     uses, so no state divergence.
 *   - clusterManager is the `new ClusterManager()` instance owned
 *     by index.js; it MUST be injected via initialize({ clusterManager })
 *     so this module shares that one instance (not a fresh copy).
 *
 * Mounted at `/api` by index.js (paths below are /aws/... and
 * /cluster/availability-zones). __dirname is ui-panel/server/routes,
 * so util requires use `../utils/…` (was `./utils/…` in index.js).
 * -----------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const AWSHelpers = require('../utils/awsHelpers');
const NetworkManager = require('../utils/networkManager');
const AWSInstanceTypeManager = require('../utils/awsInstanceTypeManager');
const { getEffectiveRegion } = require('../utils/regionResolver');

// Injected: the shared ClusterManager singleton owned by index.js.
let clusterManager = null;

function initialize(deps) {
  clusterManager = deps.clusterManager;
}

// 获取当前AWS配置的region
router.get('/aws/current-region', async (req, res) => {
  try {
    const region = AWSHelpers.getCurrentRegion();
    res.json({
      success: true,
      region
    });
  } catch (error) {
    console.error('Failed to get current AWS region:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取"活跃集群的 region"(运维路径主来源;无活跃集群时回退主机 region)
// 与 /aws/current-region 的区别:current-region 永远是本机 region(创建默认值),
// active-region 优先返回当前活跃集群的 region,便于跨 region 运维。
router.get('/aws/active-region', async (req, res) => {
  try {
    const region = getEffectiveRegion();
    res.json({
      success: true,
      region
    });
  } catch (error) {
    console.error('Failed to get active cluster region:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取可用区列表API
router.get('/cluster/availability-zones', async (req, res) => {
  const { region } = req.query;
  const result = await NetworkManager.getAvailabilityZones(region);

  if (result.success) {
    res.json(result);
  } else {
    res.status(result.error === 'Region parameter required' ? 400 : 500)
      .json({ success: false, error: result.error });
  }
});

// 🎨 AWS Instance Types API for Advanced Scaling (Cache-based, no fallbacks)
router.get('/aws/instance-types', async (req, res) => {
  try {
    const activeClusterName = clusterManager.getActiveCluster();

    const result = AWSInstanceTypeManager.getCachedInstanceTypes(activeClusterName);

    if (result.success) {
      return res.json({ success: true, ...result.data });
    } else {
      const statusCode = result.needsRefresh ? 200 : 500;
      return res.status(statusCode).json(result);
    }
  } catch (error) {
    console.error('Error accessing instance types cache:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🎨 AWS Instance Types Refresh API (Manual cache update)
router.post('/aws/instance-types/refresh', async (req, res) => {
  try {
    const activeClusterName = clusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({
        success: false,
        error: 'No active cluster configured. Please select a cluster first.'
      });
    }

    const { families } = req.body;
    const result = await AWSInstanceTypeManager.refreshInstanceTypes(activeClusterName, families);

    if (result.success) {
      res.json({ success: true, ...result.data });
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Error refreshing instance types:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🎨 Subnet-aware Instance Types API (基于子网的实例类型获取)
router.post('/aws/instance-types/by-subnet', async (req, res) => {
  try {
    const { subnetId } = req.body;

    const activeClusterName = clusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({
        success: false,
        error: 'No active cluster configured. Please select a cluster first.'
      });
    }

    const result = await AWSInstanceTypeManager.getInstanceTypesBySubnet(activeClusterName, subnetId);

    if (result.success) {
      res.json({ success: true, ...result.data });
    } else {
      const statusCode = result.error?.includes('not found') ? 404 : 400;
      res.status(statusCode).json(result);
    }
  } catch (error) {
    console.error('Error fetching instance types by subnet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = { router, initialize };
