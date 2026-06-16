const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const { exec, spawn, execSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs = require('fs-extra');
const YAML = require('yaml');
const path = require('path');

// 加载 user.env 配置文件
require('dotenv').config({ path: path.join(__dirname, '../client/user.env') });

// 引入工具模块
const HyperPodDependencyManager = require('./utils/hyperPodDependencyManager');
const AWSHelpers = require('./utils/awsHelpers');
const MetadataUtils = require('./utils/metadataUtils');
const EKSServiceHelper = require('./utils/eksServiceHelper');
const NetworkManager = require('./utils/networkManager');
const AWSInstanceTypeManager = require('./utils/awsInstanceTypeManager');
const {
  generateNLBAnnotations,
  parseInferenceCommand,
  makeHttpRequest,
  generateDeploymentTag,
  generateHybridNodeSelectorTerms,
  generateResourcesSection
} = require('./utils/inferenceUtils');

// 引入集群状态V2模块
const { 
  handleClusterStatusV2, 
  handleClearCache, 
  handleCacheStatus 
} = require('./clusterStatusV2');

// 引入应用状态V2模块
const {
  handlePodsV2,
  handleServicesV2,
  handleAppStatusV2,
  handleClearAppCache,
  handleAppCacheStatus
} = require('./appStatusV2');

// 引入 HyperPod API 管理模块
const hyperpodApiManager = require('./hyperpodApiManager');

// 引入 NodeGroup API 管理模块
const nodeGroupApiManager = require('./nodeGroupApiManager');

// 引入日志流管理模块
const logStreamManager = require('./logStreamManager');

// 引入 MLflow API 管理模块
const mlflowApiManager = require('./mlflowApiManager');

// 引入 EKS Creation 管理模块
const eksCreationManager = require('./eksCreationManager');


// 引入 Training Job 管理模块
const trainingJobManager = require('./trainingJobManager');

// 引入 Deployment 管理模块
const deploymentManager = require('./deploymentManager');

const http = require('http');
const { authMiddleware, verifyHandler, isAuthActive, getAuthConfig } = require('./utils/authMiddleware');
const app = express();
// Unified single-port design: HTTP (static + /api) and WebSocket (/ws) share one TCP port.
// Production (client/build exists) uses PORT; dev (no build) uses API_PORT so CRA dev server on PORT can proxy to it.
const clientBuildPath = path.join(__dirname, '../client/build');
const IS_PRODUCTION = fs.existsSync(clientBuildPath);
const authConfig = getAuthConfig();
const PORT = IS_PRODUCTION
  ? (process.env.PORT || authConfig.port || 3099)
  : (process.env.API_PORT || 3001);

app.use(cors());
app.use(express.json());

// Auth middleware (imported earlier for port config)
app.post('/api/auth/verify', verifyHandler);
app.use('/api', authMiddleware);

// Production mode: serve React static build
if (IS_PRODUCTION) {
  console.log('📦 Production mode: serving React build from', clientBuildPath);
  app.use(express.static(clientBuildPath));
}

// Unified HTTP server; WebSocket attaches to it at path /ws (same origin, same port).
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// 日志存储配置 - 简化路径结构
const LOGS_BASE_DIR = path.join(__dirname, '..', 'logs');

// 确保日志目录存在 - 简化版本，直接使用任务名
function ensureLogDirectory(jobName, podName) {
  const jobLogDir = path.join(LOGS_BASE_DIR, jobName);
  if (!fs.existsSync(jobLogDir)) {
    fs.mkdirSync(jobLogDir, { recursive: true });
  }
  return path.join(jobLogDir, `${podName}.log`);
}

// 优化错误消息的函数
function optimizeErrorMessage(errorMessage) {
  if (!errorMessage) return 'Unknown error';
  
  // 如果是获取hyperpodpytorchjob但资源类型不存在，这是正常情况
  if (errorMessage.includes(`doesn't have a resource type "hyperpodpytorchjob"`)) {
    return 'No HyperPod training jobs found (HyperPod operator may not be installed)';
  }
  // 如果是获取rayjob但资源类型不存在
  if (errorMessage.includes(`doesn't have a resource type "rayjob"`)) {
    return 'No RayJobs found (Ray operator may not be installed)';
  }
  // 如果是资源不存在，使用更友好的消息
  if (errorMessage.includes('not found') || errorMessage.includes('NotFound')) {
    return 'Resource not found - this may be normal if no resources have been created yet';
  }
  // 如果是连接问题
  if (errorMessage.includes('connection refused') || errorMessage.includes('unable to connect')) {
    return 'Unable to connect to Kubernetes cluster. Please check if the cluster is accessible.';
  }
  
  return errorMessage;
}

// 执行kubectl命令的辅助函数 - 简化版错误优化
function executeKubectl(command, timeout = 30000) { // 默认30秒超时
  return new Promise((resolve, reject) => {
    console.log(`Executing kubectl command: kubectl ${command}`);
    
    // maxBuffer 默认 1 MiB，大集群 `get pods -A -o json` 可能 4-10 MiB，必须显式拉大
    const child = exec(`kubectl ${command}`, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // 检查是否是"资源类型不存在"的预期错误（CRD 未安装）
        const isResourceTypeNotFound = stderr?.includes(`doesn't have a resource type`) || 
                                        error.message?.includes(`doesn't have a resource type`);
        
        if (isResourceTypeNotFound) {
          // 静默处理：只打印简洁的提示，不打印堆栈
          console.error(stderr?.trim() || error.message);
        } else {
          // 其他错误：打印完整信息用于调试
          console.error(`kubectl command failed: kubectl ${command}`);
          console.error(`Error details:`, error);
          console.error(`Stderr:`, stderr);
        }
        
        if (error.code === 'ETIMEDOUT') {
          console.error(`kubectl command timed out after ${timeout}ms: ${command}`);
          reject(new Error(`Command timed out after ${timeout/1000} seconds. The cluster may be slow to respond.`));
        } else {
          const errorMessage = error.message || stderr || 'Unknown kubectl error';
          
          // 资源类型不存在：静默 reject，不打印额外日志
          if (isResourceTypeNotFound) {
            reject(new Error(errorMessage));
            return;
          }
          
          // 针对特定情况优化错误消息
          let optimizedMessage = errorMessage;
          
          // 如果是资源不存在，使用更友好的消息
          if (errorMessage.includes('not found') || errorMessage.includes('NotFound')) {
            optimizedMessage = 'Resource not found - this may be normal if no resources have been created yet';
          }
          // 如果是连接问题
          else if (errorMessage.includes('connection refused') || errorMessage.includes('unable to connect')) {
            optimizedMessage = 'Unable to connect to Kubernetes cluster. Please check if the cluster is accessible.';
          }
          
          console.error(`Optimized error message: ${optimizedMessage}`);
          reject(new Error(optimizedMessage));
        }
      } else {
        // 优化日志输出：JSON 响应只打印摘要
        if (command.includes('-o json') && stdout.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(stdout);
            const itemCount = parsed.items?.length ?? (parsed.metadata?.name ? 1 : 0);
            const kind = parsed.kind || 'Resource';
            console.log(`kubectl succeeded: kubectl ${command} → ${kind} (${itemCount} items)`);
          } catch {
            // 解析失败时打印截断的输出
            console.log(`kubectl succeeded: kubectl ${command}`);
            console.log(`Output (truncated): ${stdout.substring(0, 200)}...`);
          }
        } else {
          // 非 JSON 命令打印完整输出（通常较短）
          console.log(`kubectl succeeded: kubectl ${command}`);
          if (stdout.trim()) {
            console.log(`Output: ${stdout.trim().substring(0, 500)}${stdout.length > 500 ? '...' : ''}`);
          }
        }
        resolve(stdout);
      }
    });
    
    // 额外的超时保护
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      console.error(`Force killing kubectl command after ${timeout}ms: ${command}`);
    }, timeout);
    
    child.on('exit', () => {
      clearTimeout(timeoutId);
    });
  });
}

// shouldUseThreadsPerCore2 函数已迁移至 hyperpodApiManager.js
// generateModelTag 函数已迁移至 s3StorageManager.js
// generateNLBAnnotations, parseInferenceCommand, makeHttpRequest 函数已迁移至 utils/inferenceUtils.js

// 获取Pending GPU统计
app.get('/api/pending-gpus', async (req, res) => {
  try {
    const pendingPodsOutput = await executeKubectl('get pods --field-selector status.phase=Pending -o json');
    const pendingPodsData = JSON.parse(pendingPodsOutput);
    
    let pendingGPUs = 0;
    if (pendingPodsData.items && Array.isArray(pendingPodsData.items)) {
      pendingGPUs = pendingPodsData.items.reduce((sum, pod) => {
        if (pod.spec?.containers) {
          return sum + pod.spec.containers.reduce((containerSum, container) => {
            const gpuRequest = container.resources?.requests?.['nvidia.com/gpu'];
            return containerSum + (parseInt(gpuRequest) || 0);
          }, 0);
        }
        return sum;
      }, 0);
    }
    
    res.json({ pendingGPUs });
  } catch (error) {
    console.error('Error fetching pending GPUs:', error);
    res.status(500).json({ error: error.message, pendingGPUs: 0 });
  }
});

// 获取集群节点GPU使用情况 - V2优化版本
app.get('/api/cluster-status', handleClusterStatusV2);

// 集群状态缓存管理API
app.post('/api/cluster-status/clear-cache', handleClearCache);
app.get('/api/cluster-status/cache-status', handleCacheStatus);

// 统一日志流管理 - 避免冲突
const unifiedLogStreams = new Map(); // 统一管理所有日志流

// 启动统一日志流（支持自动收集和WebSocket流式传输）
function startUnifiedLogStream(jobName, podName, options = {}) {
  const { ws = null, autoCollection = false, namespace = null } = options;
  // streamKey 包含 namespace，避免跨 ns 同名 pod 冲突（例如 kube-system 和 default 里都可能有 dns pod）
  const streamKey = namespace ? `${jobName}-${namespace}-${podName}` : `${jobName}-${podName}`;
  
  // 如果已经有该pod的日志流，添加WebSocket连接但不重启进程
  if (unifiedLogStreams.has(streamKey)) {
    const existing = unifiedLogStreams.get(streamKey);
    if (ws && !existing.webSockets.has(ws)) {
      existing.webSockets.add(ws);
      console.log(`Added WebSocket to existing log stream for ${streamKey}`);
      
      // 发送连接成功消息
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'log_stream_started',
          jobName: jobName,
          podName: podName,
          timestamp: new Date().toISOString()
        }));
      }
    }
    return;
  }
  
  console.log(`🚀 Starting unified log stream for pod: ${podName} in job: ${jobName} (auto: ${autoCollection})`);
  
  // 创建日志文件路径
  const logFilePath = ensureLogDirectory(jobName, podName);
  const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  
  // 启动kubectl logs命令（带 namespace，如果没提供则走 kubectl 当前上下文默认 ns）
  const kubectlArgs = namespace
    ? ['logs', '-n', namespace, '-f', podName]
    : ['logs', '-f', podName];
  const logProcess = spawn('kubectl', kubectlArgs, {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  // 创建WebSocket集合
  const webSockets = new Set();
  if (ws) {
    webSockets.add(ws);
  }
  
  // 存储统一的日志流信息
  unifiedLogStreams.set(streamKey, {
    process: logProcess,
    logStream: logStream,
    webSockets: webSockets,
    jobName: jobName,
    podName: podName,
    autoCollection: autoCollection,
    startTime: new Date().toISOString()
  });
  
  // 处理标准输出
  logProcess.stdout.on('data', (data) => {
    const logLine = data.toString();
    const timestamp = new Date().toISOString();
    
    // 写入文件（带时间戳）
    logStream.write(`[${timestamp}] ${logLine}`);
    
    // 发送到所有连接的WebSocket
    webSockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'log_data',
          jobName: jobName,
          podName: podName,
          data: logLine,
          timestamp: timestamp
        }));
      }
    });
  });
  
  // 处理错误输出
  logProcess.stderr.on('data', (data) => {
    const errorLine = data.toString();
    const timestamp = new Date().toISOString();
    
    // 写入文件
    logStream.write(`[${timestamp}] ERROR: ${errorLine}`);
    
    // 发送错误到WebSocket
    webSockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'log_error',
          jobName: jobName,
          podName: podName,
          error: errorLine,
          timestamp: timestamp
        }));
      }
    });
  });
  
  // 处理进程退出
  logProcess.on('close', (code) => {
    console.log(`Unified log stream for ${podName} exited with code ${code}`);
    logStream.end();
    
    // 通知所有WebSocket连接
    webSockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'log_stream_closed',
          jobName: jobName,
          podName: podName,
          timestamp: new Date().toISOString()
        }));
      }
    });
    
    unifiedLogStreams.delete(streamKey);
  });
  
  // 处理进程错误
  logProcess.on('error', (error) => {
    console.error(`Unified log stream error for ${podName}:`, error);
    logStream.end();
    
    // 通知所有WebSocket连接
    webSockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'log_stream_error',
          jobName: jobName,
          podName: podName,
          error: error.message,
          timestamp: new Date().toISOString()
        }));
      }
    });
    
    unifiedLogStreams.delete(streamKey);
  });
  
  // 发送启动成功消息
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'log_stream_started',
      jobName: jobName,
      podName: podName,
      timestamp: new Date().toISOString()
    }));
  }
}

// 从统一日志流中移除WebSocket连接
function removeWebSocketFromLogStream(ws, jobName, podName, namespace) {
  const streamKey = namespace ? `${jobName}-${namespace}-${podName}` : `${jobName}-${podName}`;
  const stream = unifiedLogStreams.get(streamKey);
  
  if (stream) {
    stream.webSockets.delete(ws);
    console.log(`Removed WebSocket from log stream ${streamKey}, remaining: ${stream.webSockets.size}`);
    
    // 如果没有WebSocket连接且不是自动收集，停止日志流
    if (stream.webSockets.size === 0 && !stream.autoCollection) {
      console.log(`No more WebSocket connections for ${streamKey}, stopping log stream`);
      stream.process.kill();
      stream.logStream.end();
      unifiedLogStreams.delete(streamKey);
    }
  }
}

// 为训练任务自动开始日志收集
async function startAutoLogCollectionForJob(jobName) {
  try {
    console.log(`🔍 Starting auto log collection for training job: ${jobName}`);
    
    // 获取该训练任务的所有pods（-A 以支持跨 namespace 训练作业）
    const output = await executeKubectl('get pods -A -o json');
    const result = JSON.parse(output);
    
    const jobPods = result.items.filter(pod => {
      const labels = pod.metadata.labels || {};
      const ownerReferences = pod.metadata.ownerReferences || [];
      
      return labels['training-job-name'] === jobName || 
             labels['app'] === jobName ||
             ownerReferences.some(ref => ref.name === jobName) ||
             pod.metadata.name.includes(jobName);
    });
    
    // 为每个运行中的pod开始自动日志收集
    jobPods.forEach(pod => {
      if (pod.status.phase === 'Running' || pod.status.phase === 'Pending') {
        startUnifiedLogStream(jobName, pod.metadata.name, { autoCollection: true });
      }
    });
    
    console.log(`✅ Started auto log collection for ${jobPods.length} pods in job ${jobName}`);
  } catch (error) {
    console.error(`❌ Failed to start auto log collection for job ${jobName}:`, error);
  }
}

// 修改原有的startLogStream函数，使用统一管理
function startLogStream(ws, jobName, podName, namespace) {
  startUnifiedLogStream(jobName, podName, { ws: ws, namespace });
}

// 修改原有的stopLogStream函数
function stopLogStream(ws, jobName, podName, namespace) {
  removeWebSocketFromLogStream(ws, jobName, podName, namespace);
  
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'log_stream_stopped',
      jobName: jobName,
      podName: podName,
      timestamp: new Date().toISOString()
    }));
  }
}

// 应用状态V2 API - 优化版本
app.get('/api/v2/pods', handlePodsV2);
app.get('/api/v2/services', handleServicesV2);
app.get('/api/v2/app-status', handleAppStatusV2);
app.post('/api/v2/app-status/clear-cache', handleClearAppCache);
app.get('/api/v2/app-status/cache-status', handleAppCacheStatus);

// V1 API - 已废弃，使用 V2 API 替代 (2025-11-25)
// app.get('/api/pods', async (req, res) => {
//   try {
//     console.log('Fetching pods...');
//     const output = await executeKubectl('get pods -o json');
//     const pods = JSON.parse(output);
//     console.log('Pods fetched:', pods.items.length, 'pods');
//     res.json(pods.items);
//   } catch (error) {
//     console.error('Pods fetch error:', error);
//     res.status(500).json({ error: error.message });
//   }
// });

// V1 API - 已废弃，使用 V2 API 替代 (2025-11-25)
// app.get('/api/services', async (req, res) => {
//   try {
//     console.log('Fetching services...');
//     const output = await executeKubectl('get services -o json');
//     const services = JSON.parse(output);
//     console.log('Services fetched:', services.items.length, 'services');
//     res.json(services.items);
//   } catch (error) {
//     console.error('Services fetch error:', error);
//     res.status(500).json({ error: error.message });
//   }
// });

// 代理HTTP请求到模型服务
app.post('/api/proxy-request', async (req, res) => {
  try {
    const { url, payload, method = 'POST' } = req.body;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing url'
      });
    }
    
    // GET请求不需要payload
    if (method.toUpperCase() !== 'GET' && payload === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing payload for non-GET request'
      });
    }
    
    console.log(`Proxy ${method} → ${url}`);

    const result = await makeHttpRequest(url, payload, method);

    console.log(`Proxy ${method} ← ${result.success ? 'OK' : 'FAIL'}`);
    res.json(result);
    
  } catch (error) {
    console.error('Proxy request error:', error);
    res.json({
      success: false,
      error: error.error || error.message || 'Request failed'
    });
  }
});

// 新增：代理HTTP请求到模型服务（Port-Forward模式）
app.post('/api/proxy-request-portforward', async (req, res) => {
  const portForwardManager = require('./portForwardManager');
  let requestId = null;
  
  try {
    const { url, payload, method = 'POST', portForward } = req.body;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing url'
      });
    }
    
    if (!portForward || !portForward.enabled) {
      return res.status(400).json({
        success: false,
        error: 'Port-forward configuration required'
      });
    }
    
    const { serviceName, namespace, servicePort, localPort } = portForward;
    
    console.log(`[Port-Forward Mode] Starting for ${serviceName}...`);
    
    // 启动 port-forward
    const pfResult = await portForwardManager.startTemporary(
      serviceName,
      namespace,
      servicePort,
      localPort
    );
    
    requestId = pfResult.requestId;
    console.log(`[Port-Forward] Started: ${requestId}`);
    
    // 等待 port-forward 完全就绪
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log(`Proxy ${method} → ${url}`);

    const result = await makeHttpRequest(url, payload, method);

    console.log(`Proxy ${method} ← ${result.success ? 'OK' : 'FAIL'}`);
    res.json(result);
    
  } catch (error) {
    console.error('Proxy request error:', error);
    res.json({
      success: false,
      error: error.error || error.message || 'Request failed'
    });
  } finally {
    // 请求完成后立即关闭 port-forward
    if (requestId) {
      portForwardManager.stop(requestId);
      console.log(`[Port-Forward] Stopped: ${requestId}`);
    }
  }
});

// ========== Deploy API 已拆分并迁移至 deploymentManager.js ==========
// POST /api/deploy/container - Container 部署 (vLLM/SGLang/Custom)
// POST /api/deploy/managed-inference - Managed Inference 部署 (Inference Operator)

// 部署绑定Service
// /api/deploy-service 已迁移至 deploymentManager.js

// ========== Training APIs 已迁移至 trainingJobManager.js ==========
// 包括: launch-*-training, *-config/save|load, training-jobs, hyperpod-jobs, rayjobs 等

// /api/inference-endpoints (GET, DELETE) 已迁移至 deploymentManager.js

// Pod 日志 API 已迁移至 logStreamManager.js
// /api/undeploy 已迁移至 deploymentManager.js

// /api/deployment-details 已删除（废弃，未使用）

// /api/assign-pod 已迁移至 deploymentManager.js

// /api/delete-service 已迁移至 deploymentManager.js
// /api/scale-deployment 已迁移至 deploymentManager.js

// /api/binding-services 已迁移至 deploymentManager.js

// /api/deployments 已迁移至 deploymentManager.js
// /api/test-model 已迁移至 deploymentManager.js

// WebSocket连接处理 - 优化版本，减少日志污染
wss.on('connection', (ws, req) => {
  if (isAuthActive()) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const { hash } = getAuthConfig();
    if (token !== hash) {
      ws.close(4401, 'Unauthorized');
      return;
    }
  }
  console.log('WebSocket client connected');
  
  // 发送状态更新的函数
  const sendStatusUpdate = async () => {
    try {
      const [pods, services] = await Promise.all([
        executeKubectl('get pods -A -o json').then(output => JSON.parse(output).items),
        executeKubectl('get services -o json').then(output => JSON.parse(output).items)
      ]);
      
      const statusData = {
        type: 'status_update',
        pods,
        services,
        timestamp: new Date().toISOString()
      };
      
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(statusData));
        console.log(`📡 Status update sent: ${pods.length} pods, ${services.length} services`);
      }
    } catch (error) {
      console.error('❌ Error fetching status for WebSocket:', error);
    }
  };
  
  // 🚀 优化：只在连接时发送一次初始状态，不再定时发送
  sendStatusUpdate();
  
  // 存储WebSocket连接，用于按需广播
  ws.isAlive = true;
  ws.lastActivity = Date.now();
  
  // 处理WebSocket消息
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      ws.lastActivity = Date.now();
      
      // 🎯 按需处理不同类型的消息
      switch (data.type) {
        case 'request_status_update':
          // 客户端主动请求状态更新
          console.log('📡 Client requested status update');
          sendStatusUpdate();
          break;
          
        case 'start_log_stream':
          console.log(`🔄 Starting log stream for ${data.jobName}/${data.podName} in ns=${data.namespace || '(default)'}`);
          startLogStream(ws, data.jobName, data.podName, data.namespace);
          break;

        case 'stop_log_stream':
          console.log(`⏹️ Stopping log stream for ${data.jobName}/${data.podName}`);
          stopLogStream(ws, data.jobName, data.podName, data.namespace);
          break;
          
        case 'stop_all_log_streams':
          console.log('⏹️ Stopping all log streams');
          stopAllLogStreams(ws);
          break;
          
        case 'ping':
          // 心跳检测
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          }
          break;
          
        default:
          console.log('📨 Received WebSocket message:', data.type);
      }
    } catch (error) {
      console.error('❌ Error parsing WebSocket message:', error);
    }
  });
  
  // 心跳检测
  ws.on('pong', () => {
    ws.isAlive = true;
    ws.lastActivity = Date.now();
  });
  
  ws.on('close', () => {
    console.log('🔌 WebSocket client disconnected');
    // 清理该连接的所有日志流
    stopAllLogStreams(ws);
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
    // 清理该连接的所有日志流
    stopAllLogStreams(ws);
  });
});

// 🚀 广播函数 - 向所有连接的客户端发送消息
function broadcast(message) {
  const messageStr = JSON.stringify({
    ...message,
    timestamp: new Date().toISOString()
  });
  
  let sentCount = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
      sentCount++;
    }
  });
  
  if (sentCount > 0) {
    console.log(`📡 Broadcast sent to ${sentCount} clients:`, message.type);
  }
}

// 🔄 按需状态更新广播
function broadcastStatusUpdate() {
  const message = {
    type: 'request_status_update_broadcast',
    source: 'server'
  };
  broadcast(message);
}

// 🔄 定时检查创建中的集群状态 - 每60秒检查一次
const clusterStatusCheckInterval = setInterval(async () => {
  try {
    const creatingClustersPath = path.join(__dirname, '../managed_clusters_info/creating-clusters.json');
    
    if (!fs.existsSync(creatingClustersPath)) return;
    
    const creatingClusters = JSON.parse(fs.readFileSync(creatingClustersPath, 'utf8'));
    
    for (const [clusterTag, clusterInfo] of Object.entries(creatingClusters)) {
      if (clusterInfo.type === 'eks' && clusterInfo.stackName && clusterInfo.currentStackStatus !== 'COMPLETED') {
        try {
          const stackStatus = await CloudFormationManager.getStackStatus(clusterInfo.stackName, clusterInfo.region);
          
          if (stackStatus.stackStatus === 'CREATE_COMPLETE') {
            console.log(`[Auto-Check] EKS cluster ${clusterTag} creation completed, registering...`);
            await registerCompletedCluster(clusterTag, 'active');
            updateCreatingClustersStatus(clusterTag, 'COMPLETED');
            
            broadcast({
              type: 'cluster_creation_completed',
              status: 'success',
              message: `EKS cluster ${clusterTag} created successfully. Configure dependencies in Cluster Information.`,
              clusterTag: clusterTag
            });
          }
        } catch (error) {
          console.error(`[Auto-Check] Error checking cluster ${clusterTag}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('[Auto-Check] Error in cluster status check:', error);
  }
}, 60000);

// 🔄 定时检查创建中的HyperPod集群状态 - 每20秒检查一次
const hyperPodStatusCheckInterval = setInterval(async () => {
  try {
    const { execSync } = require('child_process');
    const creatingClusters = hyperpodApiManager.getCreatingHyperPodClusters();
    
    for (const [clusterTag, clusterInfo] of Object.entries(creatingClusters)) {
      if (clusterInfo.stackName && clusterInfo.region) {
        try {
          // 检查是否已经在配置依赖
          if (clusterInfo.phase === 'CONFIGURING_DEPENDENCIES') {
            console.log(`[Auto-Check] ${clusterTag} is already configuring dependencies, skipping...`);
            continue;
          }

          // 跳过正在创建 CF Stack 的集群（create-stack API 可能尚未完成，此时 describe-stacks 会返回 "does not exist"）
          if (clusterInfo.phase === 'CREATING_STACK') {
            console.log(`[Auto-Check] ${clusterTag} is still creating CF stack, skipping...`);
            continue;
          }

          // 跳过正在删除的集群（由删除流程自行管理）
          if (clusterInfo.phase === 'DELETING_STACK') {
            try {
              const delCheckCmd = `aws cloudformation describe-stacks --stack-name ${clusterInfo.stackName} --region ${clusterInfo.region} --query 'Stacks[0].StackStatus' --output text`;
              const delStatus = execSync(delCheckCmd, { encoding: 'utf8', timeout: 10000 }).trim();

              if (delStatus === 'DELETE_COMPLETE') {
                console.log(`[Auto-Check] HyperPod stack ${clusterInfo.stackName} deletion completed`);
                broadcast({ type: 'hyperpod_deletion_completed', clusterTag, stackName: clusterInfo.stackName });
                hyperpodApiManager.updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
              } else {
                console.log(`[Auto-Check] ${clusterTag} is deleting (${delStatus}), skipping...`);
              }
            } catch (delError) {
              if (delError.message && delError.message.includes('does not exist')) {
                console.log(`[Auto-Check] HyperPod stack ${clusterInfo.stackName} deleted (no longer exists)`);
                broadcast({ type: 'hyperpod_deletion_completed', clusterTag, stackName: clusterInfo.stackName });
                hyperpodApiManager.updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
              } else {
                console.error(`[Auto-Check] Error checking deletion status for ${clusterTag}:`, delError);
              }
            }
            continue;
          }
          
          const checkCmd = `aws cloudformation describe-stacks --stack-name ${clusterInfo.stackName} --region ${clusterInfo.region} --query 'Stacks[0].StackStatus' --output text`;
          const stackStatus = execSync(checkCmd, { encoding: 'utf8', timeout: 10000 }).trim();
          
          if (stackStatus === 'CREATE_COMPLETE') {
            console.log(`[Auto-Check] HyperPod cluster ${clusterTag} creation completed, starting dependency configuration...`);

            // 立即更新状态为"配置中"，防止重复触发
            hyperpodApiManager.updateCreatingHyperPodStatus(clusterTag, {
              ...clusterInfo,
              phase: 'CONFIGURING_DEPENDENCIES',
              dependencyConfigStartedAt: new Date().toISOString()
            });

            // 执行依赖配置
            try {
              await hyperpodApiManager.registerCompletedHyperPod(clusterTag);
              
              broadcast({
                type: 'hyperpod_creation_completed',
                status: 'success',
                message: `HyperPod cluster created successfully: ${clusterInfo.stackName}`,
                clusterTag: clusterTag
              });
            } catch (error) {
              console.error(`[Auto-Check] Failed to configure dependencies for ${clusterTag}:`, error);
              
              broadcast({
                type: 'hyperpod_creation_completed',
                status: 'warning',
                message: `HyperPod cluster created, but dependency config failed: ${error.message}`,
                clusterTag: clusterTag
              });
            }
            
            // 无论成功失败都删除记录（集群已创建成功）
            hyperpodApiManager.updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
          }
          // 处理 CloudFormation 创建失败
          else if (stackStatus.includes('FAILED') || stackStatus.includes('ROLLBACK')) {
            console.log(`[Auto-Check] HyperPod cluster ${clusterTag} creation failed: ${stackStatus}`);

            // [FIX] 清理创建时写入的 hyperpod-config.json，避免残留影响下次创建
            // 相关：hyperpodApiManager.js saveHyperPodConfig() 在创建发起时写入此文件
            try {
              const metadataDir = path.join(__dirname, '../managed_clusters_info', clusterTag, 'metadata');
              const hpConfigPath = path.join(metadataDir, 'hyperpod-config.json');
              if (fs.existsSync(hpConfigPath)) {
                fs.unlinkSync(hpConfigPath);
                console.log(`[Auto-Check] Cleaned up residual hyperpod-config.json for ${clusterTag}`);
              }
            } catch (cleanupError) {
              console.warn(`[Auto-Check] Failed to cleanup hyperpod-config.json: ${cleanupError.message}`);
            }

            broadcast({
              type: 'hyperpod_creation_failed',
              status: 'error',
              message: `HyperPod creation failed: ${stackStatus}`,
              clusterTag: clusterTag,
              stackName: clusterInfo.stackName
            });

            // 清理临时状态记录
            hyperpodApiManager.updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
          }
        } catch (error) {
          // 处理 stack 不存在的情况（可能被手动删除）
          if (error.message && error.message.includes('does not exist')) {
            console.log(`[Auto-Check] HyperPod stack ${clusterInfo.stackName} does not exist, cleaning up record`);

            broadcast({
              type: 'hyperpod_creation_failed',
              status: 'error',
              message: `HyperPod stack no longer exists: ${clusterInfo.stackName}`,
              clusterTag: clusterTag,
              stackName: clusterInfo.stackName
            });

            hyperpodApiManager.updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
          } else {
            console.error(`[Auto-Check] Error checking HyperPod ${clusterTag}:`, error);
          }
        }
      }
    }
  } catch (error) {
    console.error('[Auto-Check] Error in HyperPod status check:', error);
  }
}, 20000);

// ❤️ WebSocket心跳检测 - 每30秒检查一次连接状态
const heartbeatInterval = setInterval(() => {
  const now = Date.now();
  let activeConnections = 0;
  
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      // 检查连接是否活跃（5分钟内有活动）
      if (now - ws.lastActivity < 300000) {
        ws.ping();
        activeConnections++;
      } else {
        console.log('🔌 Terminating inactive WebSocket connection');
        ws.terminate();
      }
    }
  });
  
  // 只在有连接时输出心跳日志
  if (activeConnections > 0) {
    console.log(`❤️ WebSocket heartbeat: ${activeConnections} active connections`);
  }
}, 30000);

// 🧹 进程清理函数 - 优化版本
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM signal - Server shutting down gracefully...');
  gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT signal (Ctrl+C) - Server shutting down gracefully...');
  gracefulShutdown('SIGINT');
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  console.error('Stack trace:', error.stack);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// 优雅关闭函数
function gracefulShutdown(signal) {
  console.log(`🔄 Starting graceful shutdown (signal: ${signal})...`);
  
  // 清理WebSocket心跳检测
  if (typeof heartbeatInterval !== 'undefined') {
    clearInterval(heartbeatInterval);
    console.log('✅ WebSocket heartbeat interval cleared');
  }
  
  // 关闭WebSocket服务器
  if (wss) {
    console.log(`📡 Closing WebSocket server (${wss.clients.size} active connections)...`);
    wss.close(() => {
      console.log('✅ WebSocket server closed');
    });
  }
  
  // 清理活跃的日志流 (使用 unifiedLogStreams)
  if (unifiedLogStreams && unifiedLogStreams.size > 0) {
    console.log(`🧹 Cleaning up ${unifiedLogStreams.size} active log streams...`);
    // 终止所有日志流进程
    unifiedLogStreams.forEach((stream, key) => {
      if (stream.process) {
        stream.process.kill('SIGTERM');
      }
      if (stream.logStream) {
        stream.logStream.end();
      }
    });
    unifiedLogStreams.clear();
    console.log('✅ Log streams cleaned up');
  }
  
  console.log('✅ Graceful shutdown completed');
  
  // 给一些时间让清理完成，然后退出
  setTimeout(() => {
    process.exit(signal === 'uncaughtException' || signal === 'unhandledRejection' ? 1 : 0);
  }, 1000);
}

// 停止某个WebSocket连接的所有日志流
function stopAllLogStreams(ws) {
  const streamsToStop = [];
  
  // 从统一日志流中移除该WebSocket连接
  unifiedLogStreams.forEach((stream, streamKey) => {
    if (stream.webSockets.has(ws)) {
      const [jobName, podName] = streamKey.split('-');
      streamsToStop.push({ jobName, podName });
    }
  });
  
  // 移除WebSocket连接
  streamsToStop.forEach(({ jobName, podName }) => {
    removeWebSocketFromLogStream(ws, jobName, podName);
  });
  
  if (streamsToStop.length > 0) {
    console.log(`🧹 Cleaned up ${streamsToStop.length} log streams for disconnected WebSocket`);
  }
}

const S3StorageManager = require('./s3StorageManager');
const s3StorageManager = new S3StorageManager();
const FSxStorageManager = require('./fsxStorageManager');
const fsxStorageManager = new FSxStorageManager();

// S3存储管理API
app.get('/api/s3-storages', async (req, res) => {
  const result = await s3StorageManager.getStorages();
  res.json(result);
});

// 获取S3存储默认值
app.get('/api/s3-storage-defaults', (req, res) => {
  const result = s3StorageManager.getStorageDefaults();
  res.json(result);
});

app.post('/api/s3-storages', async (req, res) => {
  const result = await s3StorageManager.createStorage(req.body);
  if (result.success) {
    broadcast({
      type: 's3_storage_created',
      status: 'success',
      message: `S3 storage ${req.body.name} created successfully`
    });
  }
  res.json(result);
});

app.delete('/api/s3-storages/:name', async (req, res) => {
  const result = await s3StorageManager.deleteStorage(req.params.name);
  if (result.success) {
    broadcast({
      type: 's3_storage_deleted',
      status: 'success',
      message: `S3 storage ${req.params.name} deleted successfully`
    });
  }
  res.json(result);
});

// FSx存储管理API
app.get('/api/fsx-storages', async (req, res) => {
  const result = await fsxStorageManager.getStorages();
  res.json(result);
});

app.post('/api/fsx-storages', async (req, res) => {
  const result = await fsxStorageManager.createStorage(req.body);
  if (result.success) {
    broadcast({
      type: 'fsx_storage_created',
      status: 'success',
      message: `FSx storage ${req.body.name} created successfully`
    });
  }
  res.json(result);
});

app.delete('/api/fsx-storages/:name', async (req, res) => {
  const result = await fsxStorageManager.deleteStorage(req.params.name);
  if (result.success) {
    broadcast({
      type: 'fsx_storage_deleted',
      status: 'success',
      message: `FSx storage ${req.params.name} deleted successfully`
    });
  }
  res.json(result);
});

// 获取FSx文件系统信息
app.post('/api/fsx-info', async (req, res) => {
  const { fileSystemId, region } = req.body;
  const result = await fsxStorageManager.getFSxInfo(fileSystemId, region);
  res.json(result);
});

// 增强的模型/数据集下载API
app.post('/api/download-model-enhanced', async (req, res) => {
  const { modelId } = req.body;

  if (!modelId) {
    return res.json({ success: false, error: 'ID is required' });
  }

  const result = await s3StorageManager.applyEnhancedDownloadJob(req.body);

  // 广播结果
  broadcast({
    type: 'model_download',
    status: result.success ? 'success' : 'error',
    message: result.success
      ? `Download started: ${modelId}`
      : `Failed to start download: ${result.error}`,
    jobName: result.jobName
  });

  res.json(result);
});

// S3存储信息API - 从s3-pv PersistentVolume获取桶信息
app.get('/api/s3-storage', async (req, res) => {
  const { storage } = req.query;
  const result = await s3StorageManager.listStorageContent(storage);
  res.json(result);
});

// 获取实例类型配置选项（从 config/instance-type-options.json 读取）
app.get('/api/config/instance-type-options', (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/instance-type-options.json');
    const types = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json({ success: true, instanceTypes: types });
  } catch (error) {
    console.error('Error reading instance-type-options.json:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取支持 EFA-only 网络接口的机型白名单（从 config/efa-only-instance-types.json 读取）
// 用于 UI 判断"加节点组"时是否显示 efa-only 开关。判定标准：EFA-supported 且多网卡。
app.get('/api/config/efa-only-instance-types', (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/efa-only-instance-types.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json({ success: true, instanceTypes: cfg.instanceTypes || [] });
  } catch (error) {
    console.error('Error reading efa-only-instance-types.json:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/config/instance-info', async (req, res) => {
  const { instanceType } = req.query;
  if (!instanceType) {
    return res.json({ success: false, error: 'instanceType query param required' });
  }
  try {
    const { getInstanceTypeInfo } = require('./utils/awsHelpers');
    const info = await getInstanceTypeInfo(instanceType);
    res.json({ success: true, ...info });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/config/instance-efa', async (req, res) => {
  const { instanceType } = req.query;
  if (!instanceType) {
    return res.json({ success: false, error: 'instanceType query param required' });
  }
  try {
    const { getInstanceEfaCount } = require('./utils/awsHelpers');
    const count = await getInstanceEfaCount(instanceType);
    res.json({ success: true, efaCount: count });
  } catch (error) {
    res.json({ success: true, efaCount: 0 });
  }
});

// 获取 UI 组件配置（控制各模块 tab/组件 显示/隐藏）
app.get('/api/config/app-status', (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/ui-component-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json({ success: true, config });
  } catch (error) {
    console.error('Error reading ui-component-config.json:', error.message);
    // 返回默认配置（全部开启）
    res.json({ success: true, config: { 'app-status': {}, 'training-recipes': {}, 'cluster-management': {} } });
  }
});

// 获取 Kubernetes Jobs（kubectl get jobs）
app.get('/api/k8s-jobs', async (req, res) => {
  try {
    const output = await executeKubectl('get jobs -o json');
    const data = JSON.parse(output);
    const jobs = (data.items || []).map(job => ({
      name: job.metadata?.name,
      namespace: job.metadata?.namespace || 'default',
      completions: job.spec?.completions || 1,
      succeeded: job.status?.succeeded || 0,
      failed: job.status?.failed || 0,
      active: job.status?.active || 0,
      startTime: job.status?.startTime,
      completionTime: job.status?.completionTime,
      creationTimestamp: job.metadata?.creationTimestamp,
      conditions: job.status?.conditions || []
    }));
    res.json({ success: true, jobs });
  } catch (error) {
    console.error('Error fetching k8s jobs:', error);
    res.json({ success: true, jobs: [] });
  }
});

// 删除 Kubernetes Job
app.delete('/api/k8s-jobs/:jobName', async (req, res) => {
  try {
    const { jobName } = req.params;
    await executeKubectl(`delete job ${jobName}`);
    res.json({ success: true, message: `Job ${jobName} deleted` });
  } catch (error) {
    console.error('Error deleting k8s job:', error);
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});


// 获取集群可用实例类型 API
app.get('/api/cluster/cluster-available-instance', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    const AWSHelpers = require('./utils/awsHelpers');

    console.log('Fetching cluster available instance types...');

    // 初始化结果数据结构
    const result = {
      success: true,
      data: {
        hyperpod: [],
        eksNodeGroup: [],
        karpenter: [],
        karpenterHyperPod: []  // 新增：Karpenter HyperPod 实例类型
      }
    };

    // 获取当前区域
    const region = AWSHelpers.getCurrentRegion();

    // 1. 获取 HyperPod 实例类型
    try {
      const nodesJson = execSync('kubectl get nodes -o json', { encoding: 'utf8', timeout: 10000 });
      const nodesData = JSON.parse(nodesJson);

      // 过滤HyperPod节点并统计实例类型
      const hyperPodNodes = nodesData.items.filter(node =>
        node.metadata.labels['sagemaker.amazonaws.com/compute-type'] === 'hyperpod'
      );

      const hyperPodTypeMap = new Map();
      hyperPodNodes.forEach(node => {
        const instanceType = node.metadata.labels['node.kubernetes.io/instance-type'];
        const instanceGroup = node.metadata.labels['sagemaker.amazonaws.com/instance-group-name'];

        if (instanceType && instanceType.startsWith('ml.')) {
          const key = `${instanceType}-${instanceGroup}`;
          if (!hyperPodTypeMap.has(key)) {
            hyperPodTypeMap.set(key, {
              type: instanceType,
              group: instanceGroup,
              count: 0
            });
          }
          hyperPodTypeMap.get(key).count++;
        }
      });

      result.data.hyperpod = Array.from(hyperPodTypeMap.values());
      console.log(`Found ${result.data.hyperpod.length} HyperPod instance types`);
    } catch (error) {
      console.warn('Error fetching HyperPod instance types:', error.message);
    }

    // 2. 获取 EKS NodeGroup 实例类型
    try {
      const nodesJson = execSync('kubectl get nodes -o json', { encoding: 'utf8', timeout: 10000 });
      const nodesData = JSON.parse(nodesJson);

      // 过滤EKS NodeGroup节点
      const eksNodes = nodesData.items.filter(node =>
        node.metadata.labels['alpha.eksctl.io/nodegroup-name'] &&
        !node.metadata.labels['sagemaker.amazonaws.com/compute-type']
      );

      const eksTypeMap = new Map();
      eksNodes.forEach(node => {
        const instanceType = node.metadata.labels['node.kubernetes.io/instance-type'];
        const nodeGroup = node.metadata.labels['alpha.eksctl.io/nodegroup-name'];

        if (instanceType && !instanceType.startsWith('ml.')) {
          const key = `${instanceType}-${nodeGroup}`;
          if (!eksTypeMap.has(key)) {
            eksTypeMap.set(key, {
              type: instanceType,
              nodeGroup: nodeGroup,
              count: 0
            });
          }
          eksTypeMap.get(key).count++;
        }
      });

      result.data.eksNodeGroup = Array.from(eksTypeMap.values());
      console.log(`Found ${result.data.eksNodeGroup.length} EKS NodeGroup instance types`);
    } catch (error) {
      console.warn('Error fetching EKS NodeGroup instance types:', error.message);
    }

    // 3. 获取 Karpenter NodePool 实例类型（分离 EC2 和 HyperPod）
    try {
      const nodePoolsJson = execSync('kubectl get nodepool -o json', { encoding: 'utf8', timeout: 10000 });
      const nodePoolsData = JSON.parse(nodePoolsJson);

      nodePoolsData.items.forEach(nodePool => {
        const nodePoolName = nodePool.metadata.name;
        const nodeClassRef = nodePool.spec?.template?.spec?.nodeClassRef;
        
        // 检查是否是 HyperpodNodeClass
        if (nodeClassRef?.kind === 'HyperpodNodeClass') {
          // 从 HyperpodNodeClass 获取实例类型
          try {
            const nodeClassName = nodeClassRef.name;
            const nodeClassJson = execSync(`kubectl get hyperpodnodeclass ${nodeClassName} -o json`, { encoding: 'utf8', timeout: 5000 });
            const nodeClassData = JSON.parse(nodeClassJson);
            
            // 从 status.instanceGroups 获取实例类型
            const statusInstanceGroups = nodeClassData.status?.instanceGroups || [];
            statusInstanceGroups.forEach(ig => {
              const instanceTypes = ig.instanceTypes || [];
              instanceTypes.forEach(instanceType => {
                result.data.karpenterHyperPod.push({
                  type: instanceType,
                  nodePool: nodePoolName,
                  available: true
                });
              });
            });
          } catch (ncError) {
            console.warn(`Failed to get HyperpodNodeClass for NodePool ${nodePoolName}:`, ncError.message);
          }
        }
      });

      console.log(`Found ${result.data.karpenter.length} Karpenter EC2 instance types`);
      console.log(`Found ${result.data.karpenterHyperPod.length} Karpenter HyperPod instance types`);
    } catch (error) {
      // Karpenter 未安装时静默处理，不输出错误日志
    }

    // 只打印摘要，不打印完整 JSON
    console.log('Cluster available instance types fetched:', {
      hyperpod: result.data?.hyperpod?.length || 0,
      eksNodeGroup: result.data?.eksNodeGroup?.length || 0,
      karpenter: result.data?.karpenter?.length || 0,
      karpenterHyperPod: result.data?.karpenterHyperPod?.length || 0
    });
    res.json(result);

  } catch (error) {
    console.error('Error fetching cluster available instance types:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 集群创建日志 API 已由 multiClusterAPIs 模块处理（见下方 /api/cluster/logs/:step 和 /api/cluster/logs-history）
// ==================== 多集群管理 API ====================
// 引入多集群管理模块
const MultiClusterAPIs = require('./multiClusterApis');
const MultiClusterStatus = require('./multiClusterStatus');

const multiClusterAPIs = new MultiClusterAPIs();
const multiClusterStatus = new MultiClusterStatus();

// 多集群管理API
app.get('/api/multi-cluster/list', (req, res) => multiClusterAPIs.handleGetClusters(req, res));
app.post('/api/multi-cluster/switch', (req, res) => multiClusterAPIs.handleSwitchCluster(req, res));
app.post('/api/multi-cluster/switch-kubectl', (req, res) => multiClusterAPIs.handleSwitchKubectlConfig(req, res));

// 集群导入API
app.post('/api/cluster/import', (req, res) => multiClusterAPIs.handleImportCluster(req, res));
app.post('/api/cluster/test-connection', (req, res) => multiClusterAPIs.handleTestConnection(req, res));
app.post('/api/cluster/:clusterTag/redetect-state', (req, res) => multiClusterAPIs.handleRedetectClusterState(req, res));

// 重写现有的集群API以支持多集群
app.post('/api/cluster/save-config', (req, res) => multiClusterAPIs.handleSaveConfig(req, res));
app.post('/api/cluster/launch', (req, res) => multiClusterAPIs.handleLaunch(req, res));
app.post('/api/cluster/configure', (req, res) => multiClusterAPIs.handleConfigure(req, res));
app.get('/api/cluster/logs/:step', (req, res) => multiClusterAPIs.handleGetLogs(req, res));
app.get('/api/cluster/logs-history', (req, res) => multiClusterAPIs.handleGetLogsHistory(req, res));
app.post('/api/cluster/clear-status-cache', (req, res) => multiClusterAPIs.handleClearStatusCache(req, res));

// 重写状态检查API以支持多集群
app.get('/api/cluster/step1-status', (req, res) => multiClusterStatus.handleStep1Status(req, res));
app.get('/api/cluster/step2-status', (req, res) => multiClusterStatus.handleStep2Status(req, res));
app.get('/api/cluster/cloudformation-status', (req, res) => multiClusterStatus.handleCloudFormationStatus(req, res));

// 节点组管理 API 已迁移至 nodeGroupApiManager.js

// HyperPod 实例管理 API 已迁移至 hyperpodApiManager.js

console.log('Multi-cluster management APIs loaded');

// 引入集群管理工具
const CloudFormationManager = require('./utils/cloudFormationManager');
const ClusterDependencyManager = require('./utils/clusterDependencyManager');
const ClusterManager = require('./clusterManager');
const clusterManager = new ClusterManager();

// 初始化 HyperPod API 管理模块
hyperpodApiManager.initialize(broadcast, clusterManager);

// 注册 HyperPod API 路由
// 路由前缀: /api/cluster (与原有路径保持一致)
app.use('/api/cluster', hyperpodApiManager.router);

console.log('HyperPod API Manager loaded');

// 初始化 NodeGroup API 管理模块
nodeGroupApiManager.initialize(broadcast, clusterManager);

// 注册 NodeGroup API 路由
// 路由前缀: /api/cluster (与原有路径保持一致)
app.use('/api/cluster', nodeGroupApiManager.router);

console.log('NodeGroup API Manager loaded');

// 注册日志流管理路由
// 路由前缀: /api/logs
app.use('/api/logs', logStreamManager.router);

console.log('Log Stream Manager loaded');

// `kubectl describe pod` —— Pending/Failed pod 用来看 events，比 logs 有用。
// name/namespace 仅允许 [a-zA-Z0-9.\-_]，拒绝任何 shell 元字符。
const SAFE_K8S_NAME = /^[a-zA-Z0-9][a-zA-Z0-9.\-_]*$/;
app.get('/api/pods/:namespace/:name/describe', async (req, res) => {
  const { namespace, name } = req.params;
  if (!SAFE_K8S_NAME.test(namespace) || !SAFE_K8S_NAME.test(name)) {
    return res.status(400).json({ success: false, error: 'Invalid namespace or pod name' });
  }
  try {
    const output = await executeKubectl(`describe pod ${name} -n ${namespace}`, 20000);
    res.json({ success: true, output });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err?.message || (typeof err === 'string' ? err : 'kubectl describe failed'),
    });
  }
});

// 初始化 MLflow API 管理模块
mlflowApiManager.initialize({ broadcast });

// 注册 MLflow API 路由
// 路由前缀: /api (保持原有路径)
app.use('/api', mlflowApiManager.router);

console.log('MLflow API Manager loaded');

// 初始化 EKS Creation 管理模块
eksCreationManager.initialize({
  broadcast,
  clusterManager,
  CloudFormationManager,
  ClusterDependencyManager,
  NetworkManager
});

// 注册 EKS Creation API 路由
// 路由前缀: /api/cluster (与原有路径保持一致)
app.use('/api/cluster', eksCreationManager.router);

console.log('EKS Creation Manager loaded');


// 初始化 Training Job 管理模块
trainingJobManager.initialize({
  broadcast,
  executeKubectl
});

// 注册 Training Job API 路由
// 路由前缀: /api (保持原有路径)
app.use('/api', trainingJobManager.router);

console.log('Training Job Manager loaded');

// 初始化 Deployment 管理模块
deploymentManager.initialize({
  broadcast,
  executeKubectl
});

// 注册 Deployment API 路由
app.use('/api', deploymentManager.router);

console.log('Deployment Manager loaded');

// CIDR生成相关API
app.get('/api/cluster/generate-cidr', async (req, res) => {
  const { region, excludeCidr } = req.query;
  const result = await NetworkManager.generateUniqueCidr(region, excludeCidr);

  if (result.success) {
    res.json(result);
  } else {
    res.status(result.error === 'AWS region is required' ? 400 : 500).json({ error: result.error });
  }
});

// 生成完整CIDR配置
app.post('/api/cluster/generate-cidr-config', async (req, res) => {
  const { region, customVpcCidr } = req.body;
  const result = await NetworkManager.generateCidrConfig(region, customVpcCidr);

  if (result.success) {
    res.json(result);
  } else {
    res.status(result.error === 'AWS region is required' ? 400 : 500).json({ error: result.error });
  }
});

// 验证CIDR格式和冲突
app.post('/api/cluster/validate-cidr', async (req, res) => {
  const { cidr, region } = req.body;
  const result = await NetworkManager.validateCidr(cidr, region);

  if (result.error === 'CIDR and region are required') {
    res.status(400).json({ error: result.error });
  } else if (result.success || result.valid === false) {
    // Both success=true and format validation failure (valid=false) return normally
    res.json(result);
  } else {
    res.status(500).json({ error: result.error });
  }
});

console.log('CIDR generation APIs loaded');

// 获取集群信息API
app.get('/api/cluster/info', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({ success: false, error: 'No active cluster selected' });
    }
    
    // 统一从 cluster_info.json 获取
    const clusterInfoPath = path.join(__dirname, '../managed_clusters_info', activeCluster, 'metadata/cluster_info.json');
    
    if (!fs.existsSync(clusterInfoPath)) {
      return res.status(404).json({ success: false, error: 'Cluster info not found' });
    }
    
    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
    
    res.json({
      success: true,
      activeCluster,
      eksClusterName: clusterInfo.eksCluster?.name || null,
      region: clusterInfo.region || null,
      vpcId: clusterInfo.eksCluster?.vpcId || null,
      isTerraform: clusterInfo.isTerraform || false
    });
  } catch (error) {
    console.error('Error getting cluster info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取S3存储桶列表（用于模型存储）
app.get('/api/cluster/s3-buckets', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.json({
        success: true,
        buckets: [],
        clusterBucket: null
      });
    }

    let clusterBucket = null;

    // 使用 s3StorageManager 获取模型存储的 S3 bucket（从 S3 CSI PV/PVC 中检测）
    try {
      const storageResult = await s3StorageManager.getStorages();

      if (storageResult.success && storageResult.storages.length > 0) {
        // 优先选择名为 's3-claim' 的存储（通常是主要的模型存储）
        let selectedStorage = storageResult.storages.find(s => s.pvcName === 's3-claim');

        // 如果没有 s3-claim，使用第一个存储
        if (!selectedStorage) {
          selectedStorage = storageResult.storages[0];
        }

        clusterBucket = {
          name: selectedStorage.bucketName,
          region: selectedStorage.region || 'us-west-2'
        };
        console.log(`Got S3 model storage bucket from s3StorageManager: ${selectedStorage.bucketName} (PVC: ${selectedStorage.pvcName})`);
      }
    } catch (error) {
      console.warn('Failed to get S3 bucket from s3StorageManager:', error.message);
    }

    const buckets = clusterBucket ? [clusterBucket] : [];

    res.json({
      success: true,
      buckets: buckets,
      clusterBucket: clusterBucket
    });
  } catch (error) {
    console.error('Error getting S3 buckets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取当前AWS配置的region
app.get('/api/aws/current-region', async (req, res) => {
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

// 获取可用区列表API
app.get('/api/cluster/availability-zones', async (req, res) => {
  const { region } = req.query;
  const result = await NetworkManager.getAvailabilityZones(region);

  if (result.success) {
    res.json(result);
  } else {
    res.status(result.error === 'Region parameter required' ? 400 : 500)
      .json({ success: false, error: result.error });
  }
});

// HyperPod 集群创建/删除 API 已迁移至 hyperpodApiManager.js

// 获取EKS节点组创建所需的子网信息
app.get('/api/cluster/subnets', async (req, res) => {
  try {
    const { promisify } = require('util');
    const execAsync = promisify(require('child_process').exec);
    
    // 获取当前活跃集群信息
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({ success: false, error: 'No active cluster selected' });
    }
    
    // 从metadata获取集群信息
    const MetadataUtils = require('./utils/metadataUtils');
    const clusterInfo = MetadataUtils.getClusterInfo(activeCluster);
    
    if (!clusterInfo) {
      return res.status(400).json({ success: false, error: 'Cluster metadata not found' });
    }
    
    // 从metadata获取基本信息
    const eksClusterName = clusterInfo.eksCluster.name;
    const region = clusterInfo.region;
    const vpcId = clusterInfo.eksCluster.vpcId;
    const securityGroupId = clusterInfo.eksCluster.securityGroupId;
    
    if (!vpcId) {
      return res.status(400).json({ success: false, error: 'VPC ID not found in metadata' });
    }
    
    // 获取子网信息（仍需要动态获取，因为子网信息不在metadata中）
    const subnetInfo = await CloudFormationManager.fetchSubnetInfo(vpcId, region);
    
    // 从metadata获取HyperPod使用的子网和Security Group
    let hyperPodSubnets = [];
    let hyperPodSecurityGroup = null;
    if (clusterInfo.hyperPodCluster) {
      const hpData = clusterInfo.hyperPodCluster;
      // 优先从 InstanceGroups[0].OverrideVpcConfig 获取子网，回退到 VpcConfig
      const overrideSubnets = hpData.InstanceGroups?.[0]?.OverrideVpcConfig?.Subnets;
      hyperPodSubnets = overrideSubnets || hpData.VpcConfig?.Subnets || [];
      hyperPodSecurityGroup = hpData.VpcConfig?.SecurityGroupIds?.[0] || null;
      console.log('Found HyperPod compute subnets:', hyperPodSubnets);
    } else {
      console.log('No HyperPod cluster found in metadata');
    }
    
    // 标记HyperPod使用的子网
    const markedSubnets = {
      publicSubnets: subnetInfo.publicSubnets,
      privateSubnets: subnetInfo.privateSubnets.map(subnet => ({
        ...subnet,
        isHyperPodSubnet: hyperPodSubnets.includes(subnet.subnetId)
      })),
      hyperPodSubnets: hyperPodSubnets
    };
    
    res.json({
      success: true,
      data: {
        eksClusterName,
        region,
        vpcId,
        securityGroupId,
        hyperPodSecurityGroup,
        ...markedSubnets
      }
    });
    
  } catch (error) {
    console.error('Error fetching subnets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// EKS 节点组删除/创建/依赖状态 API 已迁移至 nodeGroupApiManager.js

// HyperPod 状态检查 API 已迁移至 hyperpodApiManager.js

// 🎨 AWS Instance Types API for Advanced Scaling (Cache-based, no fallbacks)
app.get('/api/aws/instance-types', async (req, res) => {
  try {
    const ClusterManager = require('./clusterManager');
    const clusterManager = new ClusterManager();
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
app.post('/api/aws/instance-types/refresh', async (req, res) => {
  try {
    const ClusterManager = require('./clusterManager');
    const clusterManager = new ClusterManager();
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
app.post('/api/aws/instance-types/by-subnet', async (req, res) => {
  try {
    const { subnetId } = req.body;

    const ClusterManager = require('./clusterManager');
    const clusterManager = new ClusterManager();
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

console.log('AWS Instance Types API loaded');

// ==========================================
// Karpenter Management APIs
// ==========================================

const HyperPodKarpenterManager = require('./utils/hyperpodKarpenterManager');
const HyperPodKarpenterInstaller = require('./utils/hyperpodKarpenterInstaller');


// ==========================================
// HyperPod Karpenter Management APIs
// ==========================================

// 获取 HyperPod Karpenter 资源
app.get('/api/cluster/hyperpod-karpenter/resources', async (req, res) => {
  try {
    const resources = await HyperPodKarpenterManager.getHyperPodKarpenterResources();

    res.json({
      success: true,
      data: resources
    });
  } catch (error) {
    console.error('Error getting HyperPod Karpenter resources:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: {
        nodeClasses: [],
        nodePools: []
      }
    });
  }
});

// 删除 HyperPod Karpenter NodePool
app.delete('/api/cluster/hyperpod-karpenter/nodepool/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await HyperPodKarpenterManager.deleteNodePool(name);

    res.json(result);
  } catch (error) {
    console.error('Error deleting HyperPod Karpenter NodePool:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 删除 HyperpodNodeClass
app.delete('/api/cluster/hyperpod-karpenter/nodeclass/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await HyperPodKarpenterManager.deleteNodeClass(name);

    res.json(result);
  } catch (error) {
    console.error('Error deleting HyperpodNodeClass:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// 安装 HyperPod Karpenter
app.post('/api/cluster/hyperpod-karpenter/install', async (req, res) => {
  try {
    const { clusterTag, hyperPodClusterName } = req.body;

    console.log(`Installing HyperPod Karpenter for cluster: ${clusterTag}, HyperPod: ${hyperPodClusterName}`);

    const result = await HyperPodKarpenterInstaller.installHyperPodKarpenter(clusterTag, hyperPodClusterName);

    res.json(result);
  } catch (error) {
    console.error('Error installing HyperPod Karpenter:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取 HyperPod Karpenter 安装状态
app.get('/api/cluster/hyperpod-karpenter/status', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    const status = await HyperPodKarpenterInstaller.getInstallationStatus(activeCluster);

    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('Error getting HyperPod Karpenter status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: { installed: false }
    });
  }
});

// 创建 HyperPod Karpenter 资源
app.post('/api/cluster/hyperpod-karpenter/create-resource', async (req, res) => {
  try {
    const { instanceGroups } = req.body;

    if (!instanceGroups || instanceGroups.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Instance groups are required'
      });
    }

    const result = await HyperPodKarpenterManager.createHyperPodKarpenterResource(instanceGroups);

    res.json(result);
  } catch (error) {
    console.error('Error creating HyperPod Karpenter resource:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取指定 instance group 的 NodeClaim 列表
app.get('/api/cluster/hyperpod-karpenter/nodeclaims/:instanceGroupName', async (req, res) => {
  try {
    const nodeClaims = await HyperPodKarpenterManager.getNodeClaimsByInstanceGroup(req.params.instanceGroupName);
    res.json({ success: true, data: nodeClaims });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 删除 NodeClaim
app.delete('/api/cluster/hyperpod-karpenter/nodeclaim/:name', async (req, res) => {
  try {
    const result = await HyperPodKarpenterManager.deleteNodeClaim(req.params.name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

console.log('HyperPod Karpenter Management APIs loaded');

// ================================
// ==========================================
// HAMi GPU Virtualization APIs
// ==========================================

const HAMiManager = require('./utils/hamiManager');

// 安装/更新 HAMi
// HAMi GPU Virtualization APIs
// ================================

// 全局安装/配置 HAMi（幂等操作）
app.post('/api/cluster/hami/install', async (req, res) => {
  try {
    const { splitCount, nodePolicy, gpuPolicy } = req.body;
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
app.delete('/api/cluster/hami/uninstall', async (req, res) => {
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
app.get('/api/cluster/hami/status', async (req, res) => {
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
app.post('/api/cluster/hami/node/enable', async (req, res) => {
  try {
    const { nodeName } = req.body;
    
    if (!nodeName) {
      return res.status(400).json({
        success: false,
        message: 'Node name is required'
      });
    }

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
app.post('/api/cluster/hami/node/disable', async (req, res) => {
  try {
    const { nodeName } = req.body;
    
    if (!nodeName) {
      return res.status(400).json({
        success: false,
        message: 'Node name is required'
      });
    }

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

// HyperPod 节点 Reboot/Replace API 已迁移至 hyperpodApiManager.js

// 获取 AMP Workspace URL
app.get('/api/cluster/amp-workspace', async (req, res) => {
  try {
    const InferenceOperatorManager = require('./utils/inferenceOperatorManager');
    const inferenceOpManager = new InferenceOperatorManager(clusterManager);
    const result = await inferenceOpManager.getAmpWorkspace();
    res.json(result);
  } catch (error) {
    console.error('Error fetching AMP workspace:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// KEDA Auto Scaling APIs
// ================================

const KedaManager = require('./utils/kedaManager');
const ManagedScalingManager = require('./utils/managedScalingManager');

// 预览 KEDA YAML 配置 - TODO: 需要实现缺失的方法
app.post('/api/keda/preview', async (req, res) => {
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
app.post('/api/deploy-keda-scaling', async (req, res) => {
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
app.post('/api/keda/unified/preview', async (req, res) => {
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
app.post('/api/deploy-keda-scaling-unified', async (req, res) => {
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
app.get('/api/keda/status', async (req, res) => {
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

// 获取 HyperPod Inference Operator 部署列表
app.get('/api/inference-operator/deployments', async (req, res) => {
  try {
    const { stdout } = await execAsync(
      `kubectl get deployments -A -l deploying-service=hyperpod-inference -o json`
    );
    const result = JSON.parse(stdout);

    const deployments = result.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      replicas: item.spec.replicas,
      availableReplicas: item.status.availableReplicas || 0,
      creationTimestamp: item.metadata.creationTimestamp
    }));

    res.json({ success: true, deployments });
  } catch (error) {
    console.error('Error fetching inference operator deployments:', error);
    res.status(500).json({ success: false, error: error.message, deployments: [] });
  }
});

// Get available metrics for Inference Operator deployment
app.get('/api/inference-operator/deployment/:name/metrics', async (req, res) => {
  try {
    const { name } = req.params;
    const InferenceOperatorMetricsManager = require('./utils/inferenceOperatorMetricsManager');
    const result = await InferenceOperatorMetricsManager.getDeploymentMetrics(name);
    res.json(result);
  } catch (error) {
    console.error('Error fetching deployment metrics:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      businessMetrics: [],
      vllmMetrics: []
    });
  }
});

// Managed Inference Scaling - Preview ScaledObject YAML
app.post('/api/keda/preview-scaledobject', async (req, res) => {
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
app.post('/api/keda/deploy-scaledobject', async (req, res) => {
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
app.delete('/api/keda/scaledobject/:name', async (req, res) => {
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

console.log('KEDA Auto Scaling APIs loaded');

// ================================
// Advanced Scaling (SGLang Router) API
// ================================

const RoutingManager = require('./utils/routingManager');

// /api/sglang-deployments 已迁移至 deploymentManager.js

// 部署 Advanced Scaling 配置
app.post('/api/deploy-advanced-scaling', async (req, res) => {
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

// 获取Router部署列表
app.get('/api/routers', async (req, res) => {
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
app.get('/api/router-services', async (req, res) => {
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
app.delete('/api/routers/:deploymentName', async (req, res) => {
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
      // 广播删除完成消息
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
      // 广播删除失败消息
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
app.delete('/api/routers', async (req, res) => {
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

console.log('Advanced Scaling (SGLang Router) API loaded');

// SPA fallback: serve index.html for non-API routes (must be LAST route)
const indexHtmlPath = path.join(__dirname, '../client/build/index.html');
if (fs.existsSync(indexHtmlPath)) {
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'API endpoint not found' });
    }
    res.sendFile(indexHtmlPath);
  });
}

server.listen(PORT, () => {
  console.log('🚀 ========================================');
  console.log('🚀 HyperPod InstantStart Server Started');
  console.log('🚀 ========================================');
  console.log(`🌐 HTTP + WebSocket: http://localhost:${PORT}  (ws at /ws)`);
  console.log(`🌐 Multi-cluster management: enabled`);
  console.log(`⏰ Server started at: ${new Date().toISOString()}`);
  console.log(`🖥️  Node.js version: ${process.version}`);
  console.log(`💾 Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'} (${IS_PRODUCTION ? 'prod' : 'dev'} mode)`);
  console.log('🚀 ========================================');
  console.log('✅ Server is ready to accept connections');
});
