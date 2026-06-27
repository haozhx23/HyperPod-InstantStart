/**
 * routes/config.js
 * -----------------------------------------------------------
 * Read-only configuration endpoints, extracted verbatim from
 * index.js (Phase 3 route-extraction pilot).
 *
 * All routes here are pure reads (config files on disk / AWS
 * instance-type lookups) with NO dependency on index.js global
 * state (no broadcast / wss / clusterManager / executeKubectl /
 * timers), so this module needs no initialize(deps) — it just
 * exports a router, mounted at `/api/config` by index.js.
 *
 * NOTE: __dirname here is ui-panel/server/routes, one level
 * deeper than the original index.js. Config-file paths use
 * `../../config/…` (was `../config/…`) and the awsHelpers require
 * is `../utils/…` (was `./utils/…`).
 * -----------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// 获取实例类型配置选项（从 config/instance-type-options.json 读取）
router.get('/instance-type-options', (req, res) => {
  try {
    const configPath = path.join(__dirname, '../../config/instance-type-options.json');
    const types = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json({ success: true, instanceTypes: types });
  } catch (error) {
    console.error('Error reading instance-type-options.json:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取支持 EFA-only 网络接口的机型白名单（从 config/efa-only-instance-types.json 读取）
// 用于 UI 判断"加节点组"时是否显示 efa-only 开关。判定标准：EFA-supported 且多网卡。
router.get('/efa-only-instance-types', (req, res) => {
  try {
    const configPath = path.join(__dirname, '../../config/efa-only-instance-types.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json({ success: true, instanceTypes: cfg.instanceTypes || [] });
  } catch (error) {
    console.error('Error reading efa-only-instance-types.json:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/instance-info', async (req, res) => {
  const { instanceType } = req.query;
  if (!instanceType) {
    return res.json({ success: false, error: 'instanceType query param required' });
  }
  try {
    const { getInstanceTypeInfo } = require('../utils/awsHelpers');
    const info = await getInstanceTypeInfo(instanceType);
    res.json({ success: true, ...info });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

router.get('/instance-efa', async (req, res) => {
  const { instanceType } = req.query;
  if (!instanceType) {
    return res.json({ success: false, error: 'instanceType query param required' });
  }
  try {
    const { getInstanceEfaCount } = require('../utils/awsHelpers');
    const count = await getInstanceEfaCount(instanceType);
    res.json({ success: true, efaCount: count });
  } catch (error) {
    res.json({ success: true, efaCount: 0 });
  }
});

// 获取 UI 组件配置（控制各模块 tab/组件 显示/隐藏）
router.get('/app-status', (req, res) => {
  try {
    const configPath = path.join(__dirname, '../../config/ui-component-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json({ success: true, config });
  } catch (error) {
    console.error('Error reading ui-component-config.json:', error.message);
    // 返回默认配置（全部开启）
    res.json({ success: true, config: { 'app-status': {}, 'training-recipes': {}, 'cluster-management': {} } });
  }
});

module.exports = { router };
