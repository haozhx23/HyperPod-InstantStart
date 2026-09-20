const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
// exec 不再直接用：kubectl 一律走 runKubectl，execSync 仍用于两处 aws CLI 同步查询
const { spawn, execSync } = require('./utils/exec');
// 唯一的 kubectl 执行层：统一 maxBuffer/超时/在飞去重/错误规整，并注入 --context
const { runKubectl } = require('./utils/kubectl');
// 路由错误的唯一兜底响应点（E8）；挂载在文件末尾、所有路由之后
const { routeErrorHandler } = require('./utils/asyncRoute');
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
  handleCacheStatus,
} = require('./clusterStatusV2');

// 引入应用状态V2模块
const {
  appStatusV2,
  handlePodsV2,
  handleServicesV2,
  handleAppStatusV2,
  handleClearAppCache,
  handleAppCacheStatus
} = require('./appStatusV2');

// /api/proxy-request* 的目标校验（SSRF）。复用 appStatusV2 的 Service 缓存构造白名单，
// 数据源与前端挑选可测服务的来源相同，UI 能发起的请求必然在名单内。
const ssrfGuard = require('./utils/ssrfGuard');

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
const { authMiddleware, verifyHandler, isAuthActive, getAuthConfig, safeCompare } = require('./utils/authMiddleware');
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

// 日志路径统一由 logStreamManager 负责：它做名称白名单 + 目录包含性校验。
// 这里曾经有一份重复的 LOGS_BASE_DIR / ensureLogDirectory，且没有任何校验，
// 而参数直接来自 WebSocket 消息——能在 logs/ 之外建目录、写 .log 文件。
const { ensureLogDirectory, isSafeName } = logStreamManager;

// 执行 kubectl 命令的辅助函数。
//
// 2026-09-20：实现搬到 `utils/kubectl.js`，这里只是保留函数名的薄壳。原先这里是三份
// 近似实现中最完整的一份（含错误消息优化与成功摘要日志），另两份在 appStatusV2.js 与
// clusterStatusV2.js，行为各不相同——那正是 D3（maxBuffer 不一致、缺在飞去重）和
// D5（reject 普通对象导致真实 stderr 被吞）的来源。收敛后所有 kubectl 调用还会显式
// 带 `--context`，见 utils/kubectlContext.js。
// 同时删掉了 index.js 里那个无调用方的 optimizeErrorMessage（E4 记录的死代码）——
// 它的逻辑与本函数内联的那份重复，现在只在 utils/kubectl.js 里有一份。
function executeKubectl(command, timeout = 30000) { // 默认30秒超时
  return runKubectl(command, { timeout, optimizeError: true, logSuccess: true });
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

/**
 * streamKey 的唯一构造点。
 *
 * 注意这个 key 不可反解：jobName、namespace、podName 自身都含连字符，
 * `split('-')` 拿不回原始字段。需要 jobName/podName/namespace 时读 stream 记录里
 * 存的字段，需要删除时直接用 streamKey——不要再尝试从 key 反解。
 * （2026-09-20：`stopAllLogStreams` 曾用 split('-') 反解，导致所有含连字符的作业名
 * 都清理失败，kubectl logs -f 子进程永久泄漏。）
 */
function buildStreamKey(jobName, podName, namespace) {
  // 包含 namespace，避免跨 ns 同名 pod 冲突（例如 kube-system 和 default 里都可能有 dns pod）
  return namespace ? `${jobName}-${namespace}-${podName}` : `${jobName}-${podName}`;
}

// 启动统一日志流（支持自动收集和WebSocket流式传输）
function startUnifiedLogStream(jobName, podName, options = {}) {
  const { ws = null, autoCollection = false, namespace = null } = options;
  const streamKey = buildStreamKey(jobName, podName, namespace);

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
    namespace: namespace,   // 存下来，清理和诊断都不需要再反解 streamKey
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

/**
 * 按 streamKey 摘掉一个 WebSocket，必要时回收整条流。
 * 这是唯一的回收实现；按 jobName/podName 退订的入口走 removeWebSocketFromLogStream。
 * @returns {boolean} 是否真的回收了底层进程
 */
function detachWebSocketByStreamKey(ws, streamKey) {
  const stream = unifiedLogStreams.get(streamKey);
  if (!stream) {
    console.warn(`[logstream] 要退订的流不存在: ${streamKey}`);
    return false;
  }

  stream.webSockets.delete(ws);
  console.log(`Removed WebSocket from log stream ${streamKey}, remaining: ${stream.webSockets.size}`);

  // 如果没有WebSocket连接且不是自动收集，停止日志流
  if (stream.webSockets.size === 0 && !stream.autoCollection) {
    console.log(`No more WebSocket connections for ${streamKey}, stopping log stream`);
    stream.process.kill();
    stream.logStream.end();
    unifiedLogStreams.delete(streamKey);
    return true;
  }
  return false;
}

// 从统一日志流中移除WebSocket连接
function removeWebSocketFromLogStream(ws, jobName, podName, namespace) {
  detachWebSocketByStreamKey(ws, buildStreamKey(jobName, podName, namespace));
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
  // 这三个值直接来自 WebSocket 消息体，且会流向两处危险的地方：
  // 文件路径（ensureLogDirectory）和 kubectl 参数（spawn）。在入口一次挡掉，
  // 不要依赖下游各自校验。namespace 可以缺省（走 kubectl 当前上下文）。
  const invalid = [];
  if (!isSafeName(jobName)) invalid.push(`jobName=${JSON.stringify(jobName)}`);
  if (!isSafeName(podName)) invalid.push(`podName=${JSON.stringify(podName)}`);
  if (namespace !== undefined && namespace !== null && !isSafeName(namespace)) {
    invalid.push(`namespace=${JSON.stringify(namespace)}`);
  }

  if (invalid.length > 0) {
    const detail = `非法的日志流参数: ${invalid.join(', ')}`;
    console.warn(`[logstream] 拒绝启动日志流 — ${detail}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'log_stream_error',
        jobName, podName,
        error: detail,
        timestamp: new Date().toISOString()
      }));
    }
    return;
  }

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

    // SSRF 防护：这个路由把响应体原样回传，所以目标必须先受限。
    // 第一层挡协议与链路本地/IMDS/回环，第二层要求目标是本集群一个真实 Service。
    const inspected = await ssrfGuard.inspectTarget(url);
    if (!inspected.ok) {
      console.warn(`[proxy-request] 拒绝目标 ${url}: ${inspected.reason}`);
      return res.status(400).json({ success: false, error: `目标不被允许: ${inspected.reason}` });
    }

    const servicesResult = await appStatusV2.getServices();
    const allowlist = ssrfGuard.buildAllowlist(servicesResult?.services);
    const matched = ssrfGuard.matchAllowlist(inspected.urlObj, allowlist);
    if (!matched.ok) {
      console.warn(`[proxy-request] 拒绝目标 ${url}: ${matched.reason}`);
      return res.status(400).json({ success: false, error: `目标不被允许: ${matched.reason}` });
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

    // SSRF 防护：这个路由的目标必然是本机的 port-forward 端口，所以允许回环，
    // 但要求端口等于服务端自己即将建立的 localPort——否则就能借它扫本机其它端口。
    // 链路本地/IMDS 仍然无条件拦。
    const inspected = await ssrfGuard.inspectTarget(url, { allowLoopback: true });
    if (!inspected.ok) {
      console.warn(`[proxy-request-portforward] 拒绝目标 ${url}: ${inspected.reason}`);
      return res.status(400).json({ success: false, error: `目标不被允许: ${inspected.reason}` });
    }
    const portCheck = ssrfGuard.checkPortForwardTarget(inspected.urlObj, localPort);
    if (!portCheck.ok) {
      console.warn(`[proxy-request-portforward] 拒绝目标 ${url}: ${portCheck.reason}`);
      return res.status(400).json({ success: false, error: `目标不被允许: ${portCheck.reason}` });
    }

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
    if (!safeCompare(token, hash)) {
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

// EKS 创建完成的注册走 reconcile-on-read：由 GET /api/cluster/creating-clusters
// （eksCreationManager.js）在被查询时检测 CREATE_COMPLETE → 注册 → 清理 → 广播。
//
// 这里曾有一个 60 秒的 setInterval 做同一件事，但它调用的 registerCompletedCluster /
// updateCreatingClustersStatus 定义在 eksCreationManager.js 且从未被导入到本文件作用域，
// 每次触发都抛 ReferenceError 并被 catch 吞掉，实际从未生效。2026-09-20 移除。
//
// 不要重新加回来：creating-clusters.json 是 readFileSync → 改 → writeFileSync，没有任何
// 锁；再加一个并发 writer 会和 HTTP handler 抢写、丢更新。EKS 完成只需要登记 metadata
// （幂等、廉价），放在读路径上是安全的。
//
// 下面的 HyperPod 定时器是另一回事，必须保留：它触发 registerCompletedHyperPod()，会跑
// helm 安装依赖，分钟级、不可重入、且不能依赖浏览器是否开着。

// 🔄 定时检查创建中的HyperPod集群状态 - 每20秒检查一次
const hyperPodStatusCheckInterval = setInterval(async () => {
  try {
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

  // 清理 HyperPod 创建状态轮询：它会 execSync 调 CloudFormation 并写 metadata，
  // 关机过程中再触发一次可能写出半完成状态
  if (typeof hyperPodStatusCheckInterval !== 'undefined') {
    clearInterval(hyperPodStatusCheckInterval);
    console.log('✅ HyperPod status check interval cleared');
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
  // 先收集再删除：不要在 forEach 遍历 Map 的过程中 delete。
  // 直接收 streamKey，不从 key 反解字段（见 buildStreamKey 的注释）。
  const streamKeys = [];
  unifiedLogStreams.forEach((stream, streamKey) => {
    if (stream.webSockets.has(ws)) {
      streamKeys.push(streamKey);
    }
  });

  let reaped = 0;
  streamKeys.forEach(streamKey => {
    if (detachWebSocketByStreamKey(ws, streamKey)) reaped++;
  });

  if (streamKeys.length > 0) {
    console.log(`🧹 Cleaned up ${streamKeys.length} log streams for disconnected WebSocket (回收进程 ${reaped} 个)`);
  }
}

const S3StorageManager = require('./s3StorageManager');
const s3StorageManager = new S3StorageManager();

// S3 存储路由（/api/s3-storages*, /api/s3-storage-defaults）已抽离到 ./routes/storage.js（Phase 3 波3）

// /api/download-model-enhanced 与 /api/s3-storage 已抽离到 ./routes/storage.js（Phase 3 波3）

// 配置查询路由（/api/config/*）已抽离到 ./routes/config.js（Phase 3 试点）
// 见 index.js 末尾的 app.use('/api/config', configRoutes.router)

// k8s-jobs 路由（/api/k8s-jobs*）已抽离到 ./routes/jobs.js（Phase 3 波4）


// /api/cluster/cluster-available-instance 已抽离到 ./routes/availableInstance.js（Phase 3 波N；public 路由，内含一个随功能剥离的分支）

// 多集群管理 + 集群生命周期委托路由（/api/multi-cluster/*, /api/cluster/{import,launch,configure,logs,*-status} 等）
// 已抽离到 ./routes/clusterLifecycle.js（Phase 3 波6，自包含 multiClusterAPIs/multiClusterStatus 实例）
// 节点组管理 API 已迁移至 nodeGroupApiManager.js；HyperPod 实例管理 API 已迁移至 hyperpodApiManager.js

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
// /api/pods/:namespace/:name/describe 已抽离到 ./routes/pods.js（Phase 3 波9）

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

// 配置查询路由（/api/config/*）— 只读、无注入依赖（Phase 3 抽离试点）
const configRoutes = require('./routes/config');
app.use('/api/config', configRoutes.router);
console.log('Config routes loaded');

// AWS / 集群只读查询路由（/api/aws/*, /api/cluster/availability-zones）— 注入 clusterManager 单例（Phase 3 波2）
const awsInfoRoutes = require('./routes/awsInfo');
awsInfoRoutes.initialize({ clusterManager });
app.use('/api', awsInfoRoutes.router);
console.log('AWS info routes loaded');

// S3 存储 / 模型下载路由（/api/s3-storages*, /api/download-model-enhanced 等）— 注入 broadcast + s3StorageManager（Phase 3 波3）
const storageRoutes = require('./routes/storage');
storageRoutes.initialize({ broadcast, s3StorageManager });
app.use('/api', storageRoutes.router);
console.log('Storage routes loaded');

// k8s-jobs 路由（/api/k8s-jobs*）— 注入 executeKubectl（Phase 3 波4）
const jobsRoutes = require('./routes/jobs');
jobsRoutes.initialize({ executeKubectl });
app.use('/api', jobsRoutes.router);
console.log('Jobs routes loaded');

// SGLang Router 路由（/api/routers*, /api/router-services）— 注入 broadcast（Phase 3 波4）
const routingRoutes = require('./routes/routing');
routingRoutes.initialize({ broadcast });
app.use('/api', routingRoutes.router);
console.log('Routing routes loaded');

// CIDR 生成/校验路由（/api/cluster/generate-cidr*, /validate-cidr）— 零注入（Phase 3 波5）
const cidrRoutes = require('./routes/cidr');
app.use('/api', cidrRoutes.router);
console.log('CIDR routes loaded');

// HAMi GPU 虚拟化路由（/api/cluster/hami/*）— 注入 clusterManager（Phase 3 波5）
const hamiRoutes = require('./routes/hami');
hamiRoutes.initialize({ clusterManager });
app.use('/api', hamiRoutes.router);
console.log('HAMi routes loaded');

// 多集群 + 集群生命周期委托路由 — 自包含（Phase 3 波6）
const clusterLifecycleRoutes = require('./routes/clusterLifecycle');
app.use('/api', clusterLifecycleRoutes.router);
console.log('Cluster lifecycle routes loaded');

// 集群信息查询路由（/api/cluster/info, /s3-buckets, /subnets, /compute-subnets）— 注入 clusterManager + s3StorageManager（Phase 3 波7）
const clusterInfoRoutes = require('./routes/clusterInfo');
clusterInfoRoutes.initialize({ clusterManager, s3StorageManager });
app.use('/api', clusterInfoRoutes.router);
console.log('Cluster info routes loaded');

// KEDA 自动扩缩容路由（/api/keda/*, /deploy-keda-scaling*）— 注入 broadcast（Phase 3 波8）
const scalingRoutes = require('./routes/scaling');
scalingRoutes.initialize({ broadcast });
app.use('/api', scalingRoutes.router);
console.log('Scaling routes loaded');

// Pod describe 路由（/api/pods/:ns/:name/describe）— 注入 executeKubectl（Phase 3 波9）
const podsRoutes = require('./routes/pods');
podsRoutes.initialize({ executeKubectl });
app.use('/api', podsRoutes.router);
console.log('Pods routes loaded');


// FSx Lustre 存储路由（/api/fsx-storages*, /api/fsx-info）— 注入 broadcast（Phase 3 波N，整文件经 manifest paths 在该功能 withheld 时删除）
const fsxStorageRoutes = require('./routes/fsxStorage');
fsxStorageRoutes.initialize({ broadcast });
app.use('/api', fsxStorageRoutes.router);
console.log('FSx storage routes loaded');


// HyperPod Karpenter 路由（/api/cluster/hyperpod-karpenter/*）— 注入 clusterManager（Phase 3 波N；独立 Karpenter 功能）。变体：标准版 public:true 随发布，.ec2 变体 public:false（本块整体剥离）。
const hyperpodKarpenterRoutes = require('./routes/hyperpodKarpenter');
hyperpodKarpenterRoutes.initialize({ clusterManager });
app.use('/api', hyperpodKarpenterRoutes.router);
console.log('HyperPod Karpenter routes loaded');

// HyperPod Inference Operator 路由（/api/inference-operator/*, /api/cluster/amp-workspace）— 注入 clusterManager（Phase 3 波N，当前 public:true 随发布）
const inferenceOperatorRoutes = require('./routes/inferenceOperator');
inferenceOperatorRoutes.initialize({ clusterManager });
app.use('/api', inferenceOperatorRoutes.router);
console.log('Inference Operator routes loaded');

// Managed Inference ScaledObject 路由（/api/keda/*-scaledobject, /api/keda/scaledobject/:name）— 注入 broadcast（Phase 3 波N；std 发布 / .ec2 剥离）
const managedScalingRoutes = require('./routes/managedScaling');
managedScalingRoutes.initialize({ broadcast });
app.use('/api', managedScalingRoutes.router);
console.log('Managed scaling routes loaded');

// 集群可用实例类型路由（/api/cluster/cluster-available-instance）— public 路由（内含一个随功能剥离的分支）（Phase 3 波N）
const availableInstanceRoutes = require('./routes/availableInstance');
app.use('/api', availableInstanceRoutes.router);
console.log('Available instance routes loaded');

// CIDR 生成/校验路由（/api/cluster/generate-cidr*, /validate-cidr）已抽离到 ./routes/cidr.js（Phase 3 波5）

// /api/cluster/info 与 /api/cluster/s3-buckets 已抽离到 ./routes/clusterInfo.js（Phase 3 波7）

// /api/aws/current-region 与 /api/cluster/availability-zones 已抽离到 ./routes/awsInfo.js（Phase 3 波2）

// HyperPod 集群创建/删除 API 已迁移至 hyperpodApiManager.js

// /api/cluster/subnets 与 /api/cluster/compute-subnets 已抽离到 ./routes/clusterInfo.js（Phase 3 波7）

// EKS 节点组删除/创建/依赖状态 API 已迁移至 nodeGroupApiManager.js

// HyperPod 状态检查 API 已迁移至 hyperpodApiManager.js

// /api/aws/instance-types{,/refresh,/by-subnet} 已抽离到 ./routes/awsInfo.js（Phase 3 波2）

console.log('AWS Instance Types API loaded');


// ================================
// HAMi GPU 虚拟化路由（/api/cluster/hami/*）已抽离到 ./routes/hami.js（Phase 3 波5）

// HyperPod 节点 Reboot/Replace API 已迁移至 hyperpodApiManager.js

// KEDA free 路由（/api/keda/*, /deploy-keda-scaling*）已抽离到 ./routes/scaling.js（Phase 3 波8）

// Advanced Scaling (SGLang Router) — /api/deploy-advanced-scaling 已并入 ./routes/routing.js（Phase 3 波9）
// /api/sglang-deployments 已迁移至 deploymentManager.js

// SGLang Router 路由（/api/routers*, /api/router-services）已抽离到 ./routes/routing.js（Phase 3 波4）

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

// 错误兜底中间件（E8）——必须挂在**所有**路由之后，包括上面的 SPA fallback，
// 否则 Express 不会把它当错误处理器用。配套的 `asyncHandler` 在各路由文件里：
// express 4 不接管 async handler 返回的 Promise，**不包 asyncHandler 的 handler
// 抛出时根本到不了这里**，仍会走下面的 unhandledRejection → 关停整个进程。
// 只加中间件不包 handler 等于没修。
app.use(routeErrorHandler);

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
