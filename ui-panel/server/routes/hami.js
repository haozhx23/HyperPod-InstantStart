/**
 * HAMi GPU 虚拟化路由
 *
 * 从 index.js 抽离（Phase 3 波5）。
 * 提供 HAMi 的全局 install/uninstall/status 以及节点级 enable/disable。
 * 依赖 HAMiManager（本文件自 require）+ 注入的 clusterManager。
 */

const express = require('express');
const router = express.Router();
const HAMiManager = require('../utils/hamiManager');
const { collectInvalid, collectPresent, rejectInvalid } = require('../utils/validateInput');

let clusterManager = null;

function initialize(deps) {
  clusterManager = deps.clusterManager;
}

// 全局安装/配置 HAMi（幂等操作）
router.post('/cluster/hami/install', async (req, res) => {
  try {
    const { splitCount, nodePolicy, gpuPolicy } = req.body;

    // 三个值都拼进同一条 helm 命令（`hamiManager.js:74` 的 `--set ...=${splitCount}` 等）。
    // 三者都有默认值，所以只校验出现了的，不改必填契约。
    const problems = collectPresent([
      ['splitCount', splitCount, 'int', { max: 100 }],
      ['nodePolicy', nodePolicy, 'token', { maxLength: 32 }],
      ['gpuPolicy', gpuPolicy, 'token', { maxLength: 32 }],
    ]);
    if (problems.length > 0) return rejectInvalid(res, problems, 'POST /cluster/hami/install');

    const activeCluster = clusterManager.getActiveCluster();

    console.log(`Installing/Configuring HAMi for cluster: ${activeCluster}`);

    const result = await HAMiManager.installHAMi({
      splitCount,
      nodePolicy,
      gpuPolicy
    });

    // 保存配置到 metadata
    HAMiManager.saveConfig(activeCluster, {
      splitCount,
      nodePolicy,
      gpuPolicy
    }, clusterManager);

    res.json(result);
  } catch (error) {
    console.error('HAMi installation error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 卸载 HAMi
router.delete('/cluster/hami/uninstall', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    console.log(`Uninstalling HAMi for cluster: ${activeCluster}`);

    const result = await HAMiManager.uninstallHAMi();

    // 清除 metadata
    HAMiManager.clearConfig(activeCluster, clusterManager);

    res.json(result);
  } catch (error) {
    console.error('HAMi uninstallation error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 检查 HAMi 状态
router.get('/cluster/hami/status', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    const status = await HAMiManager.checkStatus(activeCluster, clusterManager);
    res.json(status);
  } catch (error) {
    console.error('HAMi status check error:', error);
    res.status(500).json({
      installed: false,
      error: error.message
    });
  }
});

// 启用节点（打标签）
router.post('/cluster/hami/node/enable', async (req, res) => {
  try {
    const { nodeName } = req.body;

    if (!nodeName) {
      return res.status(400).json({
        success: false,
        message: 'Node name is required'
      });
    }

    // `kubectl label nodes ${nodeName} gpu=on`（`hamiManager.js:129`）
    const problems = collectInvalid([['nodeName', nodeName]]);
    if (problems.length > 0) return rejectInvalid(res, problems, 'POST /cluster/hami/node/enable');

    console.log(`Enabling HAMi for node: ${nodeName}`);
    const result = await HAMiManager.enableNode(nodeName);

    res.json(result);
  } catch (error) {
    console.error('HAMi node enable error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 禁用节点（删除标签 + 清理 pods）
router.post('/cluster/hami/node/disable', async (req, res) => {
  try {
    const { nodeName } = req.body;

    if (!nodeName) {
      return res.status(400).json({
        success: false,
        message: 'Node name is required'
      });
    }

    // `kubectl label nodes ${nodeName} gpu-` 与 `--field-selector spec.nodeName=${nodeName}`
    // （`hamiManager.js:159`/`:169`）
    const problems = collectInvalid([['nodeName', nodeName]]);
    if (problems.length > 0) return rejectInvalid(res, problems, 'POST /cluster/hami/node/disable');

    console.log(`Disabling HAMi for node: ${nodeName}`);
    const result = await HAMiManager.disableNode(nodeName);

    res.json(result);
  } catch (error) {
    console.error('HAMi node disable error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = { router, initialize };
