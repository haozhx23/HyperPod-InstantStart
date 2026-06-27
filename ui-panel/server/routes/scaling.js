/**
 * KEDA 自动扩缩容路由
 *
 * 从 index.js 抽离(Phase 3 波8)。
 * 提供 KEDA 自动扩缩容相关接口: preview / deploy / unified / status。
 * 依赖 KedaManager(本模块自 require)以及注入的 broadcast。
 */

const express = require('express');
const router = express.Router();
const KedaManager = require('../utils/kedaManager');

// 模块级注入依赖
let broadcast = null;

function initialize(deps) {
  broadcast = deps.broadcast;
}

// 预览 KEDA YAML 配置 - TODO: 需要实现缺失的方法
router.post('/keda/preview', async (req, res) => {
  try {
    const config = req.body;

    // 验证配置
    const validation = KedaManager.validateConfig(config);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid configuration',
        errors: validation.errors
      });
    }

    // TODO: KedaManager.generateFullKedaYaml 方法不存在，需要实现或使用替代方案
    res.status(501).json({
      success: false,
      error: 'Method KedaManager.generateFullKedaYaml is not implemented',
      message: 'This API endpoint needs the missing generateFullKedaYaml method'
    });
  } catch (error) {
    console.error('Error generating KEDA preview:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 部署 KEDA 配置
router.post('/deploy-keda-scaling', async (req, res) => {
  try {
    const config = req.body;
    console.log('Deploying KEDA scaling with config:', config);

    // 验证配置
    const validation = KedaManager.validateConfig(config);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid configuration',
        errors: validation.errors
      });
    }

    // TODO: KedaManager.applyKedaConfiguration 方法不存在，需要实现或使用替代方案
    // 暂时返回错误，提示需要实现缺失的方法
    const result = {
      success: false,
      error: 'Method KedaManager.applyKedaConfiguration is not implemented',
      message: 'This API endpoint needs the missing applyKedaConfiguration method'
    };

    if (result.success) {
      // 广播成功消息
      broadcast({
        type: 'keda_deployment',
        status: 'success',
        message: 'KEDA scaling configuration deployed successfully',
        yamlPath: result.yamlPath,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        message: result.message,
        yamlPath: result.yamlPath,
        generatedYaml: result.generatedYaml
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error,
        message: result.message
      });
    }
  } catch (error) {
    console.error('Error deploying KEDA scaling:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 统一扩缩容 - 预览 YAML
router.post('/keda/unified/preview', async (req, res) => {
  try {
    const config = req.body;
    console.log('Generating unified KEDA preview for service:', config.serviceName);

    const result = await KedaManager.previewUnifiedScalingYaml(config);

    if (result.success) {
      res.json({
        success: true,
        yaml: result.yaml,
        config: result.config
      });
    } else {
      console.log('Preview validation failed:', result.errors);
      res.status(400).json({
        success: false,
        error: result.error,
        errors: result.errors
      });
    }
  } catch (error) {
    console.error('Error generating unified KEDA preview:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 统一扩缩容 - 部署配置
router.post('/deploy-keda-scaling-unified', async (req, res) => {
  try {
    const config = req.body;
    console.log('Deploying unified KEDA scaling with config:', config);

    const result = await KedaManager.applyUnifiedScalingConfiguration(config);

    if (result.success) {
      // 广播成功消息
      broadcast({
        type: 'keda_unified_deployment',
        status: 'success',
        message: 'Unified KEDA scaling configuration deployed successfully',
        serviceName: config.serviceName,
        deploymentName: config.deploymentName,
        enabledTriggers: config.enabledTriggers,
        yamlPath: result.yamlPath,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        message: result.message,
        yamlPath: result.yamlPath,
        generatedYaml: result.generatedYaml
      });
    } else {
      // 广播错误消息
      broadcast({
        type: 'keda_unified_deployment',
        status: 'error',
        message: result.message,
        error: result.error,
        timestamp: new Date().toISOString()
      });

      res.status(500).json({
        success: false,
        error: result.error,
        message: result.message,
        errors: result.errors
      });
    }
  } catch (error) {
    console.error('Error deploying unified KEDA scaling:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取 KEDA 状态
router.get('/keda/status', async (req, res) => {
  try {
    const status = await KedaManager.getKedaStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting KEDA status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      kedaInstalled: false
    });
  }
});

module.exports = { router, initialize };
