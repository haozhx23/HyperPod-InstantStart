/**
 * clusterLifecycle.js
 *
 * 从 index.js 抽离（Phase 3 波6）。
 * 多集群列表/切换 + 集群导入/创建/配置/日志/状态查询。
 * 全部委托 multiClusterAPIs / multiClusterStatus 两个自建实例，零注入。
 *
 * 每个委托都过 `asyncHandler`（E8）：被委托的 handler 本身是 async，返回的 Promise
 * 在 express 4 里不被框架接管，拒绝会变成进程级 unhandledRejection 并关掉整个面板。
 * 这些 handler 目前各自都有内部 try（`multiClusterApis.js` 里 9 个，另 3 个直接返回 410），
 * 所以这里是纵深防御——但那层保护是逐方法维护的，路由层不应依赖它。
 */

const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../utils/asyncRoute');

const MultiClusterAPIs = require('../multiClusterApis');
const MultiClusterStatus = require('../multiClusterStatus');

const multiClusterAPIs = new MultiClusterAPIs();
const multiClusterStatus = new MultiClusterStatus();

// 多集群管理API
router.get('/multi-cluster/list', asyncHandler((req, res) => multiClusterAPIs.handleGetClusters(req, res)));
router.post('/multi-cluster/switch', asyncHandler((req, res) => multiClusterAPIs.handleSwitchCluster(req, res)));
router.post('/multi-cluster/switch-kubectl', asyncHandler((req, res) => multiClusterAPIs.handleSwitchKubectlConfig(req, res)));

// 集群导入API
router.post('/cluster/import', asyncHandler((req, res) => multiClusterAPIs.handleImportCluster(req, res)));
router.post('/cluster/test-connection', asyncHandler((req, res) => multiClusterAPIs.handleTestConnection(req, res)));
router.post('/cluster/:clusterTag/redetect-state', asyncHandler((req, res) => multiClusterAPIs.handleRedetectClusterState(req, res)));

// 重写现有的集群API以支持多集群
router.post('/cluster/save-config', asyncHandler((req, res) => multiClusterAPIs.handleSaveConfig(req, res)));
router.post('/cluster/launch', asyncHandler((req, res) => multiClusterAPIs.handleLaunch(req, res)));
router.post('/cluster/configure', asyncHandler((req, res) => multiClusterAPIs.handleConfigure(req, res)));
router.get('/cluster/logs/:step', asyncHandler((req, res) => multiClusterAPIs.handleGetLogs(req, res)));
router.get('/cluster/logs-history', asyncHandler((req, res) => multiClusterAPIs.handleGetLogsHistory(req, res)));
router.post('/cluster/clear-status-cache', asyncHandler((req, res) => multiClusterAPIs.handleClearStatusCache(req, res)));

// 重写状态检查API以支持多集群
router.get('/cluster/step1-status', asyncHandler((req, res) => multiClusterStatus.handleStep1Status(req, res)));
router.get('/cluster/step2-status', asyncHandler((req, res) => multiClusterStatus.handleStep2Status(req, res)));
router.get('/cluster/cloudformation-status', asyncHandler((req, res) => multiClusterStatus.handleCloudFormationStatus(req, res)));

module.exports = { router };
