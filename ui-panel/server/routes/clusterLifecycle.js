/**
 * clusterLifecycle.js
 *
 * 从 index.js 抽离（Phase 3 波6）。
 * 多集群列表/切换 + 集群导入/创建/配置/日志/状态查询。
 * 全部委托 multiClusterAPIs / multiClusterStatus 两个自建实例，零注入。
 */

const express = require('express');
const router = express.Router();

const MultiClusterAPIs = require('../multiClusterApis');
const MultiClusterStatus = require('../multiClusterStatus');

const multiClusterAPIs = new MultiClusterAPIs();
const multiClusterStatus = new MultiClusterStatus();

// 多集群管理API
router.get('/multi-cluster/list', (req, res) => multiClusterAPIs.handleGetClusters(req, res));
router.post('/multi-cluster/switch', (req, res) => multiClusterAPIs.handleSwitchCluster(req, res));
router.post('/multi-cluster/switch-kubectl', (req, res) => multiClusterAPIs.handleSwitchKubectlConfig(req, res));

// 集群导入API
router.post('/cluster/import', (req, res) => multiClusterAPIs.handleImportCluster(req, res));
router.post('/cluster/test-connection', (req, res) => multiClusterAPIs.handleTestConnection(req, res));
router.post('/cluster/:clusterTag/redetect-state', (req, res) => multiClusterAPIs.handleRedetectClusterState(req, res));

// 重写现有的集群API以支持多集群
router.post('/cluster/save-config', (req, res) => multiClusterAPIs.handleSaveConfig(req, res));
router.post('/cluster/launch', (req, res) => multiClusterAPIs.handleLaunch(req, res));
router.post('/cluster/configure', (req, res) => multiClusterAPIs.handleConfigure(req, res));
router.get('/cluster/logs/:step', (req, res) => multiClusterAPIs.handleGetLogs(req, res));
router.get('/cluster/logs-history', (req, res) => multiClusterAPIs.handleGetLogsHistory(req, res));
router.post('/cluster/clear-status-cache', (req, res) => multiClusterAPIs.handleClearStatusCache(req, res));

// 重写状态检查API以支持多集群
router.get('/cluster/step1-status', (req, res) => multiClusterStatus.handleStep1Status(req, res));
router.get('/cluster/step2-status', (req, res) => multiClusterStatus.handleStep2Status(req, res));
router.get('/cluster/cloudformation-status', (req, res) => multiClusterStatus.handleCloudFormationStatus(req, res));

module.exports = { router };
