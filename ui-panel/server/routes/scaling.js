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
const { collectInvalid, collectPresent, rejectInvalid } = require('../utils/validateInput');

/**
 * 统一扩缩容配置的字段校验（S1 边界）。
 *
 * `KedaManager.generateUnifiedScalingYaml()` 是**字符串替换式**的 YAML 生成
 * （`utils/kedaManager.js:167` 起的一串 `template.replace(...)`），所以带换行的值能改写
 * ScaledObject 的结构。另外 `serviceName` 还会进落盘路径
 * `keda-scaling-${config.serviceName}-${timestamp}.yaml`（同文件 `:236`），随后被
 * `kubectl apply -f` 引用——它同时是路径注入面。
 *
 * `KedaManager.validateUnifiedConfig()` 只查字段是否存在（同文件 `:285`），挡不住这些。
 * 注意端口/间隔用 'int'，但**阈值必须用 'num'**：前端是 `<InputNumber step={0.1}>`，
 * 小数是合法输入，用 int 会把 2.5 拒掉。
 */
function unifiedScalingProblems(config = {}) {
  return collectPresent([
    ['serviceName', config.serviceName, 'token', { maxLength: 200 }],
    ['deploymentName', config.deploymentName, 'token', { maxLength: 253 }],
    ['routerMetricPort', config.routerMetricPort, 'int', { max: 65535 }],
    ['minReplica', config.minReplica, 'int', { max: 10000 }],
    ['maxReplica', config.maxReplica, 'int', { max: 10000 }],
    ['kedaPollInterval', config.kedaPollInterval, 'int', { max: 86400 }],
    ['kedaCoolDownPeriod', config.kedaCoolDownPeriod, 'int', { max: 86400 }],
    ['scrapeInterval', config.scrapeInterval, 'int', { max: 86400 }],
    ['qpsWindow', config.qpsWindow, 'token', { maxLength: 16 }],
    ['kedaTrig1ValueThreshold', config.kedaTrig1ValueThreshold, 'num', { max: 1e9 }],
    ['kedaTrig1ActThreshold', config.kedaTrig1ActThreshold, 'num', { max: 1e9 }],
    ['kedaTrig2ValueThreshold', config.kedaTrig2ValueThreshold, 'num', { max: 1e9 }],
    ['kedaTrig2ActThreshold', config.kedaTrig2ActThreshold, 'num', { max: 1e9 }],
    ['enabledTriggers', config.enabledTriggers, 'tokens', { maxLength: 32 }],
  ]);
}

// 模块级注入依赖
let broadcast = null;

function initialize(deps) {
  broadcast = deps.broadcast;
}

// 下面两个端点（/keda/preview 与 /deploy-keda-scaling）是**未实现的桩**：一个直接返回
// 501，另一个返回硬编码的失败对象，请求体不会流向任何命令、路径或 YAML。所以它们不在
// S1 的设防范围内——不是漏了，是没有注入面。要实现它们时必须同时加校验。

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

    const problems = unifiedScalingProblems(config);
    if (problems.length > 0) return rejectInvalid(res, problems, 'POST /keda/unified/preview');

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

    const problems = unifiedScalingProblems(config);
    if (problems.length > 0) return rejectInvalid(res, problems, 'POST /deploy-keda-scaling-unified');

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
