/**
 * MLflow API Manager
 * 处理 MLflow 配置、连接测试、同步和训练历史相关的 API
 */

const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { collectInvalid, rejectInvalid } = require('./utils/validateInput');

// 依赖注入
let broadcast = null;

/**
 * 初始化模块依赖
 * @param {Object} deps - 依赖对象
 * @param {Function} deps.broadcast - WebSocket 广播函数
 */
function initialize(deps) {
  broadcast = deps.broadcast;
}

// MLflow 配置文件路径
const CONFIG_FILE = path.join(__dirname, '../config/mlflow-metric-config.json');

// 确保配置目录存在
const configDir = path.dirname(CONFIG_FILE);
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// 默认 MLflow 配置
const DEFAULT_MLFLOW_CONFIG = {
  tracking_uri: '',
  experiment_id: '',
  sync_configs: {}
};

/**
 * 读取 MLflow 配置
 * @returns {Object} MLflow 配置对象
 */
function readMlflowConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(configData);
    }
  } catch (error) {
    console.error('Error reading MLflow config:', error);
  }
  return DEFAULT_MLFLOW_CONFIG;
}

/**
 * 保存 MLflow 配置
 * @param {Object} config - 配置对象
 * @returns {boolean} 是否保存成功
 */
function saveMlflowConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving MLflow config:', error);
    return false;
  }
}

// ==================== API 路由 ====================

/**
 * GET /api/mlflow-metric-config
 * 获取 MLflow 配置
 */
router.get('/mlflow-metric-config', (req, res) => {
  try {
    const config = readMlflowConfig();
    res.json({
      success: true,
      config: config
    });
  } catch (error) {
    console.error('Error fetching MLflow config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/mlflow-metric-config
 * 保存 MLflow 配置
 */
router.post('/mlflow-metric-config', (req, res) => {
  try {
    const { tracking_uri } = req.body;

    if (!tracking_uri) {
      return res.status(400).json({
        success: false,
        error: 'tracking_uri is required'
      });
    }

    // 这个值会落进 `config/mlflow-metric-config.json`，之后由
    // `GET /training-history` 取出来作为 argv 传给 Python 脚本（本文件 `:527`）——
    // 属于二阶输入：存的时候看着无害，用的时候才兑现。argv 形式本身不过 shell，
    // 但首字符是 `-` 的值会被脚本的 argparse 当成 flag，所以这里一并卡住。
    const problems = collectInvalid([['tracking_uri', tracking_uri, 'uri']]);
    if (problems.length > 0) return rejectInvalid(res, problems, 'POST /mlflow-metric-config');

    const config = { tracking_uri };

    if (saveMlflowConfig(config)) {
      console.log('MLflow config saved:', config);
      res.json({
        success: true,
        config: config
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to save configuration'
      });
    }
  } catch (error) {
    console.error('Error saving MLflow config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/mlflow-metric-config/test
 * 测试 MLflow 连接
 */
router.post('/mlflow-metric-config/test', async (req, res) => {
  try {
    const { tracking_uri } = req.body;

    if (!tracking_uri) {
      return res.status(400).json({
        success: false,
        error: 'tracking_uri is required'
      });
    }

    // 这一处是**生成代码注入**，不是 shell 注入：tracking_uri 被插进下面那段 Python 的
    // 字符串字面量（`tracking_uri = "${tracking_uri}"`），脚本落盘后由
    // `spawn('python3', [tempScriptPath])` 执行。闭合双引号即可执行任意 Python，
    // 例如 `http://x" ; import os; os.system("id") #`。
    // 'uri' 这一类同时拒引号、反斜杠、$、反引号和换行，并要求 scheme 是 http(s)。
    const problems = collectInvalid([['tracking_uri', tracking_uri, 'uri']]);
    if (problems.length > 0) return rejectInvalid(res, problems, 'POST /mlflow-metric-config/test');

    console.log(`Testing MLflow connection to: ${tracking_uri}`);

    // 创建测试脚本
    const testScript = `#!/usr/bin/env python3
import mlflow
import sys
import json

try:
    tracking_uri = "${tracking_uri}"
    mlflow.set_tracking_uri(tracking_uri)

    # 尝试获取实验列表来测试连接
    experiments = mlflow.search_experiments()

    result = {
        "success": True,
        "experiments_count": len(experiments),
        "message": f"Successfully connected to MLflow. Found {len(experiments)} experiments."
    }

    print(json.dumps(result))
    sys.exit(0)

except Exception as e:
    result = {
        "success": False,
        "error": str(e)
    }
    print(json.dumps(result))
    sys.exit(1)
`;

    const tempScriptPath = path.join(__dirname, '../temp/test_mlflow_connection.py');

    // 确保 temp 目录存在
    const tempDir = path.dirname(tempScriptPath);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    fs.writeFileSync(tempScriptPath, testScript);

    const pythonPath = 'python3';
    const pythonProcess = spawn(pythonPath, [tempScriptPath], {
      cwd: __dirname,
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pythonProcess.on('close', (code) => {
      // 清理临时文件
      try {
        fs.unlinkSync(tempScriptPath);
      } catch (e) {
        console.warn('Failed to cleanup temp file:', e);
      }

      if (stderr) {
        console.log('Python test script stderr:', stderr);
      }

      try {
        const result = JSON.parse(stdout);
        if (result.success) {
          res.json(result);
        } else {
          res.status(400).json(result);
        }
      } catch (parseError) {
        console.error('Failed to parse test result:', parseError);
        console.error('Raw output:', stdout);
        res.status(500).json({
          success: false,
          error: 'Failed to test MLflow connection',
          details: stdout || stderr
        });
      }
    });

    pythonProcess.on('error', (error) => {
      console.error('Failed to start Python test script:', error);
      res.status(500).json({
        success: false,
        error: `Failed to start test script: ${error.message}`
      });
    });

  } catch (error) {
    console.error('MLflow connection test error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/mlflow-sync
 * MLflow 跨账户同步
 */
router.post('/mlflow-sync', async (req, res) => {
  try {
    const { sync_config, experiment_name, experiment_id } = req.body;

    // 支持两种参数格式以保持兼容性
    const experimentIdentifier = experiment_name || experiment_id;

    // 验证必需字段
    if (!sync_config || !experimentIdentifier) {
      return res.status(400).json({
        success: false,
        error: 'sync_config and experiment_name (or experiment_id) are required'
      });
    }

    // 验证 JSON 配置
    let configObj;
    try {
      configObj = JSON.parse(sync_config);
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: 'Invalid JSON format in sync_config'
      });
    }

    // 验证必需的配置字段
    const requiredFields = ['contributor_name', 'source_mlflow_arn', 'shared_account_id', 'shared_aws_region', 'cross_account_role_arn', 'shared_mlflow_arn'];
    const missingFields = requiredFields.filter(field => !configObj[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required fields in sync_config: ${missingFields.join(', ')}`
      });
    }

    // 验证 source 和 destination ARN 不能相同
    if (configObj.source_mlflow_arn === configObj.shared_mlflow_arn) {
      return res.status(400).json({
        success: false,
        error: 'Source MLflow ARN and Shared MLflow ARN cannot be the same. Please ensure you are syncing to a different MLflow server.'
      });
    }

    // 添加时间戳
    configObj.setup_date = new Date().toISOString();

    console.log(`Starting MLflow sync for experiment ${experimentIdentifier}...`);

    // 1. 保存配置到 mlflow-metric-config.json
    const currentConfig = readMlflowConfig();
    const updatedConfig = {
      ...currentConfig,
      experiment_name: experimentIdentifier,
      sync_configs: {
        ...configObj,
        last_sync: new Date().toISOString()
      }
    };

    if (!saveMlflowConfig(updatedConfig)) {
      return res.status(500).json({
        success: false,
        error: 'Failed to save sync configuration'
      });
    }

    // 2. 创建临时配置文件供 Python 脚本使用
    const tempConfigPath = path.join(__dirname, '../temp/sync-config-temp.json');

    // 确保 temp 目录存在
    const tempDir = path.dirname(tempConfigPath);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    fs.writeFileSync(tempConfigPath, JSON.stringify(configObj, null, 2));

    // 3. 调用 Python 同步脚本
    const pythonPath = 'python3';
    const syncScriptPath = path.join(__dirname, '../mlflow/cross_account_sync.py');

    const pythonProcess = spawn(pythonPath, [
      syncScriptPath,
      '--config-file', tempConfigPath,
      '--experiment-name', experimentIdentifier
    ], {
      cwd: '/tmp',  // 避免 MLflow 在 server/ 目录创建 mlruns/
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pythonProcess.on('close', (code) => {
      // 清理临时配置文件
      try {
        fs.unlinkSync(tempConfigPath);
      } catch (e) {
        console.warn('Failed to cleanup temp config file:', e);
      }

      if (code === 0) {
        console.log('MLflow sync completed successfully');
        console.log('Sync output:', stdout);

        res.json({
          success: true,
          message: 'Successfully synced experiment to shared MLflow server',
          output: stdout,
          experiment_id: experimentIdentifier,
          contributor: configObj.contributor_name
        });
      } else {
        console.error('MLflow sync failed with code:', code);
        console.error('Sync stderr:', stderr);
        console.error('Sync stdout:', stdout);

        res.status(500).json({
          success: false,
          error: 'MLflow sync failed',
          details: stderr || stdout,
          exit_code: code
        });
      }
    });

    pythonProcess.on('error', (error) => {
      console.error('Failed to start MLflow sync script:', error);

      // 清理临时配置文件
      try {
        fs.unlinkSync(tempConfigPath);
      } catch (e) {
        console.warn('Failed to cleanup temp config file:', e);
      }

      res.status(500).json({
        success: false,
        error: `Failed to start sync script: ${error.message}`
      });
    });

  } catch (error) {
    console.error('MLflow sync API error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/configure-mlflow-auth
 * 配置 MLflow 认证
 */
router.post('/configure-mlflow-auth', async (req, res) => {
  try {
    const MLflowTrackingServerManager = require('./utils/mlflowTrackingServerManager');
    const mlflowManager = new MLflowTrackingServerManager();

    // 配置 MLflow 认证
    const result = await mlflowManager.configureAuthentication();

    // 广播配置成功消息
    if (broadcast) {
      broadcast({
        type: 'mlflow_auth_configured',
        status: 'success',
        message: result.message
      });
    }

    res.json({
      success: true,
      message: result.message
    });

  } catch (error) {
    console.error('Error configuring MLflow authentication:', error);

    // 广播配置失败消息
    if (broadcast) {
      broadcast({
        type: 'mlflow_auth_configured',
        status: 'error',
        message: `Failed to configure MLflow authentication: ${error.message}`
      });
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/create-mlflow-tracking-server
 * 创建 MLflow Tracking Server
 */
router.post('/create-mlflow-tracking-server', async (req, res) => {
  try {
    const { mlflowServerName, trackingServerSize = 'Small' } = req.body;

    const MLflowTrackingServerManager = require('./utils/mlflowTrackingServerManager');
    const mlflowManager = new MLflowTrackingServerManager();

    // 验证输入参数
    mlflowManager.validateServerName(mlflowServerName);
    mlflowManager.validateServerSize(trackingServerSize);

    // 创建 tracking server
    const result = await mlflowManager.createTrackingServer(mlflowServerName, trackingServerSize);

    // 广播创建成功消息
    if (broadcast) {
      broadcast({
        type: 'mlflow_tracking_server_created',
        status: 'success',
        message: result.message,
        serverName: mlflowServerName
      });
    }

    res.json(result);

  } catch (error) {
    console.error('Error creating MLflow tracking server:', error);

    // 广播创建失败消息
    if (broadcast) {
      broadcast({
        type: 'mlflow_tracking_server_created',
        status: 'error',
        message: error.message
      });
    }

    res.json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/training-history
 * 获取训练历史数据（从 MLflow）
 */
router.get('/training-history', async (req, res) => {
  try {
    console.log('Fetching training history from MLflow...');

    // 读取当前 MLflow 配置
    const mlflowConfig = readMlflowConfig();
    console.log('Using MLflow URI:', mlflowConfig.tracking_uri);

    // 使用系统 Python 执行脚本，传递配置参数
    const pythonPath = 'python3';
    const scriptPath = path.join(__dirname, '../mlflow/get_training_history.py');

    const pythonProcess = spawn(pythonPath, [scriptPath, mlflowConfig.tracking_uri], {
      cwd: '/tmp',  // 避免 MLflow 在 server/ 目录创建 mlruns/
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    let responseHandled = false;

    pythonProcess.on('close', (code) => {
      if (responseHandled) return;

      if (stderr) {
        console.log('Python script stderr:', stderr);
      }

      if (code !== 0) {
        console.error(`Python script exited with code ${code}`);
        responseHandled = true;
        return res.status(500).json({
          success: false,
          error: `Failed to fetch training history: exit code ${code}`,
          stderr: stderr
        });
      }

      try {
        const result = JSON.parse(stdout);
        console.log(`Training history fetched: ${result.total} records`);
        responseHandled = true;
        res.json(result);
      } catch (parseError) {
        console.error('Failed to parse Python script output:', parseError);
        console.error('Raw output:', stdout);
        responseHandled = true;
        res.status(500).json({
          success: false,
          error: 'Failed to parse training history data',
          raw_output: stdout
        });
      }
    });

    pythonProcess.on('error', (error) => {
      if (responseHandled) return;

      console.error('Failed to start Python script:', error);
      responseHandled = true;
      res.status(500).json({
        success: false,
        error: `Failed to start Python script: ${error.message}`
      });
    });

  } catch (error) {
    console.error('Training history fetch error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/cluster/mlflow-info
 * 获取活跃集群的 MLflow 信息
 */
router.get('/cluster/mlflow-info', (req, res) => {
  try {
    // 使用多集群管理器获取活跃集群的 MLflow 信息
    const ClusterManager = require('./clusterManager');
    const clusterManager = new ClusterManager();
    const activeCluster = clusterManager.getActiveCluster();

    if (!activeCluster) {
      return res.json({
        success: false,
        error: 'No active cluster found'
      });
    }

    // 从活跃集群的配置目录读取 MLflow 信息
    const configDir = clusterManager.getClusterConfigDir(activeCluster);
    const mlflowInfoPath = path.join(configDir, 'mlflow-server-info.json');

    if (fs.existsSync(mlflowInfoPath)) {
      const fileContent = fs.readFileSync(mlflowInfoPath, 'utf8').trim();

      // 检查文件是否为空
      if (!fileContent) {
        return res.json({
          success: true,
          data: {
            status: 'not_found',
            error: 'MLflow server info file is empty',
            clusterTag: activeCluster
          }
        });
      }

      let mlflowInfo;
      try {
        mlflowInfo = JSON.parse(fileContent);
      } catch (parseError) {
        return res.json({
          success: true,
          data: {
            status: 'error',
            error: 'Invalid JSON in MLflow server info file',
            clusterTag: activeCluster
          }
        });
      }

      // 检查解析后的对象是否为空或无效
      if (!mlflowInfo || Object.keys(mlflowInfo).length === 0) {
        return res.json({
          success: true,
          data: {
            status: 'not_found',
            error: 'MLflow server info is empty',
            clusterTag: activeCluster
          }
        });
      }

      // 返回前端期望的数据结构
      res.json({
        success: true,
        data: {
          status: 'found',
          trackingServerArn: mlflowInfo.TrackingServerArn,
          trackingServerName: mlflowInfo.TrackingServerName,
          trackingServerUrl: mlflowInfo.TrackingServerUrl,
          trackingServerStatus: mlflowInfo.TrackingServerStatus,
          isActive: mlflowInfo.IsActive,
          mlflowVersion: mlflowInfo.MlflowVersion,
          artifactStoreUri: mlflowInfo.ArtifactStoreUri,
          trackingServerSize: mlflowInfo.TrackingServerSize,
          roleArn: mlflowInfo.RoleArn,
          creationTime: mlflowInfo.CreationTime,
          clusterTag: activeCluster,
          rawData: mlflowInfo // 保留原始数据以备调试
        }
      });
    } else {
      res.json({
        success: true,
        data: {
          status: 'not_found',
          error: `MLflow server info not found for cluster: ${activeCluster}`,
          clusterTag: activeCluster
        }
      });
    }
  } catch (error) {
    console.error('Error reading MLflow server info:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
});

// ==================== 导出 ====================

module.exports = {
  router,
  initialize,
  readMlflowConfig,
  saveMlflowConfig
};
