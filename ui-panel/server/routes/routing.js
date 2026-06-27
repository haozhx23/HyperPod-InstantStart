/**
 * SGLang Router 路由模块
 *
 * 从 index.js 抽离（Phase 3 波4）。
 * 提供 SGLang Router 的列表、服务列表、删除（单个/全部）功能。
 * 依赖 RoutingManager（自 require）+ 注入的 broadcast。
 */

const express = require('express');
const router = express.Router();
const RoutingManager = require('../utils/routingManager');

// 模块级注入依赖
let broadcast = null;

function initialize(deps) {
  broadcast = deps.broadcast;
}

// 获取Router部署列表
router.get('/routers', async (req, res) => {
  try {
    console.log('Getting Router deployments list');
    const routers = await RoutingManager.getRouterDeployments();
    res.json({
      success: true,
      routers: routers,
      count: routers.length
    });
  } catch (error) {
    console.error('Error getting Router deployments:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to get Router deployments'
    });
  }
});

// 获取Router Services列表（用于KEDA配置）
router.get('/router-services', async (req, res) => {
  try {
    console.log('Getting Router services list');
    const services = await RoutingManager.getRouterServices();
    res.json({
      success: true,
      services: services,
      count: services.length
    });
  } catch (error) {
    console.error('Error getting Router services:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to get Router services'
    });
  }
});

// 删除指定Router部署
router.delete('/routers/:deploymentName', async (req, res) => {
  try {
    const { deploymentName } = req.params;
    console.log(`Deleting Router deployment: ${deploymentName}`);
    if (!deploymentName) {
      return res.status(400).json({
        success: false,
        error: 'Deployment name is required'
      });
    }
    const result = await RoutingManager.deleteRouter(deploymentName);
    if (result.success) {
      broadcast({
        type: 'sglang_router_deletion',
        status: 'success',
        message: result.message,
        deploymentName: deploymentName,
        deletedCount: result.totalDeleted,
        timestamp: new Date().toISOString()
      });
      res.json({
        success: true,
        message: result.message,
        processedInstances: result.processedInstances,
        totalDeleted: result.totalDeleted,
        results: result.results
      });
    } else {
      broadcast({
        type: 'sglang_router_deletion',
        status: 'error',
        message: result.message,
        deploymentName: deploymentName,
        error: result.error,
        timestamp: new Date().toISOString()
      });
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error deleting Router deployment:', error);
    broadcast({
      type: 'sglang_router_deletion',
      status: 'error',
      message: 'Failed to delete Router deployment',
      error: error.message,
      timestamp: new Date().toISOString()
    });
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to delete Router deployment'
    });
  }
});

// 删除所有Router部署（管理员功能）
router.delete('/routers', async (req, res) => {
  try {
    console.log('Deleting all Router deployments');
    const result = await RoutingManager.deleteAllRouters();
    if (result.success) {
      broadcast({
        type: 'sglang_router_deletion_all',
        status: 'success',
        message: result.message,
        timestamp: new Date().toISOString()
      });
      res.json(result);
    } else {
      broadcast({
        type: 'sglang_router_deletion_all',
        status: 'error',
        message: result.message,
        error: result.error,
        timestamp: new Date().toISOString()
      });
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error deleting all Router deployments:', error);
    broadcast({
      type: 'sglang_router_deletion_all',
      status: 'error',
      message: 'Failed to delete all Router deployments',
      error: error.message,
      timestamp: new Date().toISOString()
    });
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to delete all Router deployments'
    });
  }
});

// 部署 Advanced Scaling 配置（SGLang Router 部署，Phase 3 波9 并入）
router.post('/deploy-advanced-scaling', async (req, res) => {
  try {
    const config = req.body;
    console.log('Deploying SGLang Router with config:', config);

    // 验证配置
    const validation = RoutingManager.validateConfig(config.sglangRouter);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid configuration',
        errors: validation.errors
      });
    }

    // 使用 RoutingManager 部署
    const result = await RoutingManager.applyRouterConfiguration(config.sglangRouter);

    if (result.success) {
      // 广播成功消息
      broadcast({
        type: 'sglang_router_deployment',
        status: 'success',
        message: result.message,
        yamlPath: result.yamlPath,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        message: result.message,
        yamlPath: result.yamlPath,
        generatedYaml: result.generatedYaml,
        kubectlOutput: result.kubectlOutput
      });
    } else {
      broadcast({
        type: 'sglang_router_deployment',
        status: 'error',
        message: result.message,
        timestamp: new Date().toISOString()
      });

      res.status(500).json({
        success: false,
        error: result.error,
        message: result.message
      });
    }

  } catch (error) {
    console.error('Error deploying SGLang Router:', error);

    broadcast({
      type: 'sglang_router_deployment',
      status: 'error',
      message: `SGLang Router deployment failed: ${error.message}`,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = { router, initialize };
