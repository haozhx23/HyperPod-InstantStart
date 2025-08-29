const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const fs = require('fs-extra');
const YAML = require('yaml');
const path = require('path');
const https = require('https');
const http = require('http');

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

const app = express();
const PORT = 3001;
const WS_PORT = 8081; // 改为8081避免端口冲突

app.use(cors());
app.use(express.json());

// WebSocket服务器用于实时更新
const wss = new WebSocket.Server({ port: WS_PORT });

// 存储活跃的日志流
const activeLogStreams = new Map();

// 日志存储配置
const LOG_BASE_DIR = path.join(__dirname, '..', 'logs', 'hyperpodpytorchjob');

// 确保日志目录存在
function ensureLogDirectory(jobName, podName) {
  const jobLogDir = path.join(LOG_BASE_DIR, jobName);
  if (!fs.existsSync(jobLogDir)) {
    fs.mkdirSync(jobLogDir, { recursive: true });
  }
  return path.join(jobLogDir, `${podName}.log`);
}

// 广播消息给所有连接的客户端
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// 执行kubectl命令的辅助函数 - 简化版错误优化
function executeKubectl(command, timeout = 30000) { // 默认30秒超时
  return new Promise((resolve, reject) => {
    console.log(`Executing kubectl command: kubectl ${command}`);
    
    const child = exec(`kubectl ${command}`, { timeout }, (error, stdout, stderr) => {
      if (error) {
        console.error(`kubectl command failed: kubectl ${command}`);
        console.error(`Error details:`, error);
        console.error(`Stderr:`, stderr);
        
        if (error.code === 'ETIMEDOUT') {
          console.error(`kubectl command timed out after ${timeout}ms: ${command}`);
          reject(new Error(`Command timed out after ${timeout/1000} seconds. The cluster may be slow to respond.`));
        } else {
          const errorMessage = error.message || stderr || 'Unknown kubectl error';
          
          // 针对特定情况优化错误消息
          let optimizedMessage = errorMessage;
          
          // 如果是获取hyperpodpytorchjob但资源类型不存在，这是正常情况
          if (command.includes('get hyperpodpytorchjob') && 
              errorMessage.includes(`doesn't have a resource type "hyperpodpytorchjob"`)) {
            optimizedMessage = 'No HyperPod training jobs found (HyperPod operator may not be installed)';
          }
          // 如果是资源不存在，使用更友好的消息
          else if (errorMessage.includes('not found') || errorMessage.includes('NotFound')) {
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
        console.log(`kubectl command succeeded: kubectl ${command}`);
        console.log(`Output:`, stdout);
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

// 生成模型标签的函数
function generateModelTag(modelId) {
  if (!modelId) return '';
  // 替换特殊字符，只保留字母数字和连字符
  return modelId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// 编码模型ID为Kubernetes标签兼容格式
function encodeModelIdForLabel(modelId) {
  if (!modelId) return '';
  
  // 对于常见的模型ID格式，使用简化的编码方式
  // 例如: Qwen/Qwen3-0.6B -> qwen3-06b
  //      microsoft/DialoGPT-medium -> microsoft-dialogpt-medium
  
  return modelId
    .toLowerCase()                    // 转为小写
    .replace(/\//g, '-')             // 斜杠替换为连字符
    .replace(/\./g, '')              // 移除点号
    .replace(/[^a-z0-9-]/g, '-')     // 其他特殊字符替换为连字符
    .replace(/-+/g, '-')             // 合并多个连字符
    .replace(/^-|-$/g, '');          // 移除首尾连字符
}

// 解码Kubernetes标签为原始模型ID
// 注意：由于使用了简化编码，这个函数主要用于向后兼容
// 新的编码方式是不可逆的，实际的模型ID应该从其他地方获取
function decodeModelIdFromLabel(encodedModelId) {
  if (!encodedModelId) return '';
  
  // 尝试处理旧的编码格式（向后兼容）
  if (encodedModelId.includes('--slash--')) {
    return encodedModelId
      .replace(/--slash--/g, '/')
      .replace(/--colon--/g, ':')
      .replace(/--dot--/g, '.')
      .replace(/--at--/g, '@')
      .replace(/--plus--/g, '+')
      .replace(/--equals--/g, '=')
      .replace(/--space--/g, ' ');
  }
  
  // 对于新的简化编码，直接返回（因为是不可逆的）
  return encodedModelId;
}

// 从VLLM/SGLang命令中提取模型ID
function extractModelIdFromVllmCommand(vllmCommandString) {
  if (!vllmCommandString) return '';
  
  // 清理命令字符串
  const cleanCommand = vllmCommandString
    .replace(/\\\s*\n/g, ' ')  // 处理反斜杠换行
    .replace(/\s+/g, ' ')      // 合并多个空格
    .trim();
  
  // 分割成参数数组
  const args = cleanCommand.split(/\s+/);
  
  // 1. 优先检查新的 vllm serve 格式
  // 格式: vllm serve /path/to/model [其他参数]
  const vllmServeIndex = args.findIndex(arg => arg === 'serve');
  if (vllmServeIndex !== -1 && vllmServeIndex + 1 < args.length) {
    // 检查前一个参数是否是 vllm 相关
    if (vllmServeIndex > 0 && args[vllmServeIndex - 1].includes('vllm')) {
      const modelPath = args[vllmServeIndex + 1];
      // 确保不是以 -- 开头的参数
      if (!modelPath.startsWith('--')) {
        return modelPath;
      }
    }
  }
  
  // 2. 检查传统的 --model 参数 (VLLM)
  const modelIndex = args.findIndex(arg => arg === '--model');
  if (modelIndex !== -1 && modelIndex + 1 < args.length) {
    return args[modelIndex + 1];
  }
  
  // 3. 检查 --model-path 参数 (SGLang)
  const modelPathIndex = args.findIndex(arg => arg === '--model-path');
  if (modelPathIndex !== -1 && modelPathIndex + 1 < args.length) {
    return args[modelPathIndex + 1];
  }
  
  // 4. 对于其他自定义命令，尝试查找可能的模型路径
  // 查找看起来像模型路径的参数（包含斜杠或常见模型名称模式）
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    // 跳过以 -- 开头的参数和它们的值
    if (arg.startsWith('--')) {
      i++; // 跳过参数值
      continue;
    }
    
    // 检查是否看起来像模型路径
    if (arg.includes('/') || 
        arg.match(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/) || // 格式如 "org/model"
        arg.match(/^\/[a-zA-Z0-9_\/.-]+$/) ||              // 绝对路径
        arg.match(/^[a-zA-Z0-9_.-]+$/) && arg.length > 3   // 简单模型名
    ) {
      return arg;
    }
  }
  
  return '';
}

// 生成NLB注解的函数
function generateNLBAnnotations(isExternal) {
  if (isExternal) {
    return `
    service.beta.kubernetes.io/aws-load-balancer-type: "external"
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"`;
  } else {
    return `
    service.beta.kubernetes.io/aws-load-balancer-type: "external"
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internal"
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"`;
  }
}

// 解析完整的VLLM/SGLang命令
function parseVllmCommand(vllmCommandString) {
  // 移除换行符和多余空格，处理反斜杠换行
  const cleanCommand = vllmCommandString
    .replace(/\\\s*\n/g, ' ')  // 处理反斜杠换行
    .replace(/\s+/g, ' ')      // 合并多个空格
    .trim();
  
  // 分割命令为数组
  const parts = cleanCommand.split(' ').filter(part => part.trim());
  
  // 检查命令是否为空
  if (parts.length === 0) {
    throw new Error('Command cannot be empty');
  }
  
  // 检查是否为已知的命令格式（用于优化处理，但不强制要求）
  const isVllmCommand = parts.includes('python3') && parts.includes('-m') && parts.includes('vllm.entrypoints.openai.api_server');
  const isVllmServeCommand = parts.includes('vllm') && parts.includes('serve');
  const isSglangCommand = parts.includes('python3') && parts.includes('-m') && parts.includes('sglang.launch_server');
  
  let entrypointIndex = -1, tensorParallelSize = 1;
  
  if (isVllmCommand) {
    // 传统VLLM命令处理: python3 -m vllm.entrypoints.openai.api_server
    entrypointIndex = parts.findIndex(part => part === 'vllm.entrypoints.openai.api_server');
    const args = parts.slice(entrypointIndex + 1);
    
    // 解析tensor-parallel-size用于GPU配置
    const tensorParallelIndex = args.findIndex(arg => arg === '--tensor-parallel-size');
    if (tensorParallelIndex !== -1 && tensorParallelIndex + 1 < args.length) {
      tensorParallelSize = parseInt(args[tensorParallelIndex + 1]) || 1;
    }
  } else if (isVllmServeCommand) {
    // 新VLLM serve命令处理: vllm serve /path/to/model
    entrypointIndex = parts.findIndex(part => part === 'serve');
    const args = parts.slice(entrypointIndex + 1);
    
    // 解析tensor-parallel-size用于GPU配置
    const tensorParallelIndex = args.findIndex(arg => arg === '--tensor-parallel-size');
    if (tensorParallelIndex !== -1 && tensorParallelIndex + 1 < args.length) {
      tensorParallelSize = parseInt(args[tensorParallelIndex + 1]) || 1;
    }
  } else if (isSglangCommand) {
    // SGLang命令处理
    entrypointIndex = parts.findIndex(part => part === 'sglang.launch_server');
    const args = parts.slice(entrypointIndex + 1);
    
    // 解析tp-size用于GPU配置 (SGLang使用--tp-size而不是--tensor-parallel-size)
    const tpSizeIndex = args.findIndex(arg => arg === '--tp-size');
    if (tpSizeIndex !== -1 && tpSizeIndex + 1 < args.length) {
      tensorParallelSize = parseInt(args[tpSizeIndex + 1]) || 1;
    }
  } else {
    // 对于其他命令格式，尝试通用的GPU参数解析
    // 查找常见的GPU相关参数
    const gpuParams = ['--tensor-parallel-size', '--tp-size', '--gpus', '--gpu-count'];
    for (const param of gpuParams) {
      const paramIndex = parts.findIndex(arg => arg === param);
      if (paramIndex !== -1 && paramIndex + 1 < parts.length) {
        const value = parseInt(parts[paramIndex + 1]);
        if (!isNaN(value) && value > 0) {
          tensorParallelSize = value;
          break;
        }
      }
    }
  }
  
  const args = entrypointIndex >= 0 ? parts.slice(entrypointIndex + 1) : parts.slice(1);
  
  return {
    fullCommand: parts,
    args: args,
    tensorParallelSize: tensorParallelSize,
    commandType: (isVllmCommand || isVllmServeCommand) ? 'vllm' : (isSglangCommand ? 'sglang' : 'custom')
  };
}

// 改进的HTTP请求代理函数
function makeHttpRequest(url, payload, method = 'POST') {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? https : http;
      
      const isGetRequest = method.toUpperCase() === 'GET';
      const postData = isGetRequest ? '' : JSON.stringify(payload);
      
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method.toUpperCase(),
        headers: {
          'User-Agent': 'Model-Deployment-UI/1.0'
        },
        timeout: 30000 // 30秒超时
      };
      
      // 只有POST请求才需要Content-Type和Content-Length
      if (!isGetRequest) {
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(postData);
      }
      
      console.log(`Making HTTP ${method} request to: ${url}`);
      console.log(`Request options:`, JSON.stringify(options, null, 2));
      if (!isGetRequest) {
        console.log(`Payload:`, postData);
      }
      
      const req = httpModule.request(options, (res) => {
        let data = '';
        
        console.log(`Response status: ${res.statusCode}`);
        console.log(`Response headers:`, JSON.stringify(res.headers, null, 2));
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          console.log(`Response data:`, data);
          
          // 处理不同的响应状态
          if (res.statusCode >= 200 && res.statusCode < 300) {
            // 成功响应
            try {
              const jsonData = JSON.parse(data);
              resolve({
                success: true,
                status: res.statusCode,
                data: jsonData
              });
            } catch (parseError) {
              // 如果不是JSON，返回原始文本
              console.log('Response is not JSON, returning as text');
              resolve({
                success: true,
                status: res.statusCode,
                data: data,
                isText: true
              });
            }
          } else {
            // 错误响应
            try {
              const errorData = JSON.parse(data);
              resolve({
                success: false,
                status: res.statusCode,
                error: errorData.error || `HTTP ${res.statusCode}`,
                data: errorData
              });
            } catch (parseError) {
              resolve({
                success: false,
                status: res.statusCode,
                error: `HTTP ${res.statusCode}: ${data}`,
                data: data
              });
            }
          }
        });
      });
      
      req.on('error', (error) => {
        console.error('HTTP request error:', error);
        reject({
          success: false,
          error: `Network error: ${error.message}`
        });
      });
      
      req.on('timeout', () => {
        console.error('HTTP request timeout');
        req.destroy();
        reject({
          success: false,
          error: 'Request timeout (30s)'
        });
      });
      
      // 只有非GET请求才写入payload
      if (!isGetRequest && postData) {
        req.write(postData);
      }
      req.end();
      
    } catch (error) {
      console.error('HTTP request setup error:', error);
      reject({
        success: false,
        error: `Request setup error: ${error.message}`
      });
    }
  });
}

// 获取集群节点GPU使用情况 - V2优化版本
app.get('/api/cluster-status', handleClusterStatusV2);

// 集群状态缓存管理API
app.post('/api/cluster-status/clear-cache', handleClearCache);
app.get('/api/cluster-status/cache-status', handleCacheStatus);

// 应用状态V2 API - 优化版本
app.get('/api/v2/pods', handlePodsV2);
app.get('/api/v2/services', handleServicesV2);
app.get('/api/v2/app-status', handleAppStatusV2);
app.post('/api/v2/app-status/clear-cache', handleClearAppCache);
app.get('/api/v2/app-status/cache-status', handleAppCacheStatus);

// 获取Pod状态
app.get('/api/pods', async (req, res) => {
  try {
    console.log('Fetching pods...');
    const output = await executeKubectl('get pods -o json');
    const pods = JSON.parse(output);
    console.log('Pods fetched:', pods.items.length, 'pods');
    res.json(pods.items);
  } catch (error) {
    console.error('Pods fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 获取Service状态
app.get('/api/services', async (req, res) => {
  try {
    console.log('Fetching services...');
    const output = await executeKubectl('get services -o json');
    const services = JSON.parse(output);
    console.log('Services fetched:', services.items.length, 'services');
    res.json(services.items);
  } catch (error) {
    console.error('Services fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

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
    
    console.log(`Proxying ${method} request to: ${url}`);
    if (method.toUpperCase() !== 'GET') {
      console.log(`Payload:`, JSON.stringify(payload, null, 2));
    }
    
    const result = await makeHttpRequest(url, payload, method);
    
    console.log('Proxy result:', JSON.stringify(result, null, 2));
    res.json(result);
    
  } catch (error) {
    console.error('Proxy request error:', error);
    res.json({
      success: false,
      error: error.error || error.message || 'Request failed'
    });
  }
});

// 生成并部署YAML配置 - 仅用于推理部署（VLLM和Ollama）
app.post('/api/deploy', async (req, res) => {
  try {
    const {
      replicas,
      huggingFaceToken,
      deploymentType,
      vllmCommand,
      ollamaModelId,
      gpuCount,
      isExternal = true,  // 默认为external
      modelId,  // 添加modelId参数，用于VLLM部署
      dockerImage = 'vllm/vllm-openai:latest'  // 添加dockerImage参数，默认值
    } = req.body;

    console.log('Inference deployment request:', { 
      deploymentType, 
      ollamaModelId, 
      replicas, 
      isExternal,
      dockerImage
    });

    let templatePath, newYamlContent, finalModelTag;

    // 生成NLB注解
    const nlbAnnotations = generateNLBAnnotations(isExternal);
    console.log(`Generated NLB annotations (external: ${isExternal}):`, nlbAnnotations);

    if (deploymentType === 'ollama') {
      // 处理Ollama部署 - 使用模型ID生成标签
      finalModelTag = generateModelTag(ollamaModelId);
      console.log(`Generated model tag from "${ollamaModelId}": "${finalModelTag}"`);
      
      templatePath = path.join(__dirname, '../templates/ollama-template.yaml');
      const templateContent = await fs.readFile(templatePath, 'utf8');
      
      // 替换模板中的占位符 - 注意顺序：先替换更具体的占位符
      newYamlContent = templateContent
        .replace(/ENCODED_MODEL_ID/g, encodeModelIdForLabel(ollamaModelId)) // 先替换ENCODED_MODEL_ID
        .replace(/MODEL_TAG/g, finalModelTag)
        .replace(/OLLAMA_MODEL_ID/g, ollamaModelId)
        .replace(/REPLICAS_COUNT/g, replicas.toString())
        .replace(/GPU_COUNT/g, gpuCount.toString())
        .replace(/NLB_ANNOTATIONS/g, nlbAnnotations);
      
    } else {
      // 处理VLLM/SGLang部署
      const parsedCommand = parseVllmCommand(vllmCommand);
      console.log('Parsed command:', parsedCommand);
      
      // 从命令中提取模型ID
      const extractedModelId = extractModelIdFromVllmCommand(vllmCommand);
      console.log(`Extracted model ID from command: "${extractedModelId}"`);
      
      // 基于提取的模型ID自动生成tag
      finalModelTag = generateModelTag(extractedModelId);
      console.log(`Auto-generated model tag from "${extractedModelId}": "${finalModelTag}"`);
      
      // 编码模型ID用于Kubernetes标签
      const encodedModelId = encodeModelIdForLabel(extractedModelId);
      console.log(`Encoded model ID: "${encodedModelId}"`);

      // 使用统一模板，根据命令类型确定服务引擎
      const servEngine = parsedCommand.commandType === 'sglang' ? 'sglang' : 'vllm';
      console.log(`Using service engine: ${servEngine} for command type: ${parsedCommand.commandType}`);

      templatePath = path.join(__dirname, '../templates/vllm-sglang-template.yaml');
      const templateContent = await fs.readFile(templatePath, 'utf8');
      
      // 生成HuggingFace token环境变量（如果提供了token）
      let hfTokenEnv = '';
      if (huggingFaceToken && huggingFaceToken.trim() !== '') {
        hfTokenEnv = `
            - name: HUGGING_FACE_HUB_TOKEN
              value: "${huggingFaceToken}"`;
      }
      
      // 替换模板中的占位符 - 注意顺序：先替换更具体的占位符
      newYamlContent = templateContent
        .replace(/SERVENGINE/g, servEngine) // 新增：替换服务引擎标识
        .replace(/ENCODED_MODEL_ID/g, encodedModelId) // 先替换ENCODED_MODEL_ID
        .replace(/MODEL_TAG/g, finalModelTag)
        .replace(/MODEL_ID/g, extractedModelId) // 然后替换MODEL_ID
        .replace(/REPLICAS_COUNT/g, replicas.toString())
        .replace(/GPU_COUNT/g, parsedCommand.tensorParallelSize.toString())
        .replace(/HF_TOKEN_ENV/g, hfTokenEnv)
        .replace(/VLLM_COMMAND/g, JSON.stringify(parsedCommand.fullCommand))
        .replace(/DOCKER_IMAGE/g, dockerImage)
        .replace(/NLB_ANNOTATIONS/g, nlbAnnotations);
    }
    
    // 保存到项目目录中的deployments文件夹
    const deploymentsDir = path.join(__dirname, '../deployments');
    await fs.ensureDir(deploymentsDir); // 确保目录存在
    
    const accessType = isExternal ? 'external' : 'internal';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tempYamlPath = path.join(deploymentsDir, `${finalModelTag}-${deploymentType}-${accessType}-${timestamp}.yaml`);
    await fs.writeFile(tempYamlPath, newYamlContent);
    
    console.log(`Generated YAML saved to: ${tempYamlPath}`);
    
    // 执行kubectl apply
    const applyOutput = await executeKubectl(`apply -f ${tempYamlPath}`);
    
    // 广播部署状态更新
    broadcast({
      type: 'deployment',
      status: 'success',
      message: `Successfully deployed model: ${finalModelTag} (${accessType} access)`,
      output: applyOutput
    });
    
    res.json({
      success: true,
      message: 'Deployment successful',
      output: applyOutput,
      yamlPath: tempYamlPath,
      generatedYaml: newYamlContent,
      deploymentType,
      modelTag: finalModelTag,
      accessType
    });
    
  } catch (error) {
    console.error('Deployment error:', error);
    
    broadcast({
      type: 'deployment',
      status: 'error',
      message: `Deployment failed: ${error.message}`
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 生成并部署HyperPod Torch训练任务 - 专门用于Torch训练
app.post('/api/launch-torch-training', async (req, res) => {
  try {
    console.log('Raw torch training request body:', JSON.stringify(req.body, null, 2));
    
    const {
      trainingJobName,
      dockerImage = '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
      instanceType = 'ml.g5.12xlarge',
      nprocPerNode = 1,
      replicas = 1,
      efaCount = 16,
      entryPythonScriptPath,
      pythonScriptParameters,
      mlflowTrackingUri = '',
      logMonitoringConfig
    } = req.body;

    console.log('Torch training launch request parsed:', { 
      trainingJobName,
      dockerImage,
      instanceType,
      nprocPerNode,
      replicas,
      efaCount,
      entryPythonScriptPath,
      pythonScriptParameters,
      mlflowTrackingUri,
      logMonitoringConfig: logMonitoringConfig ? 'present' : 'empty'
    });

    // 验证必需参数
    if (!trainingJobName) {
      return res.status(400).json({
        success: false,
        error: 'Training job name is required'
      });
    }

    if (!entryPythonScriptPath) {
      return res.status(400).json({
        success: false,
        error: 'Entry Python Script Path is required'
      });
    }

    if (!pythonScriptParameters) {
      return res.status(400).json({
        success: false,
        error: 'Python Script Parameters are required'
      });
    }

    // 读取Torch训练任务模板
    const templatePath = path.join(__dirname, '../templates/hyperpod-training-torch-template.yaml');
    const templateContent = await fs.readFile(templatePath, 'utf8');
    
    // 处理日志监控配置
    let logMonitoringConfigYaml = '';
    if (logMonitoringConfig && logMonitoringConfig.trim() !== '') {
      // 添加适当的缩进
      const indentedConfig = logMonitoringConfig
        .split('\n')
        .map(line => line.trim() ? `    ${line}` : line)
        .join('\n');
      logMonitoringConfigYaml = `
    logMonitoringConfiguration: 
${indentedConfig}`;
    }
    
    // 处理Python脚本参数 - 确保多行参数在YAML中正确格式化
    let formattedPythonParams = pythonScriptParameters;
    if (pythonScriptParameters.includes('\\')) {
      // 如果包含反斜杠换行符，将其转换为单行格式
      formattedPythonParams = pythonScriptParameters
        .replace(/\\\s*\n\s*/g, ' ')  // 将反斜杠换行替换为空格
        .replace(/\s+/g, ' ')         // 合并多个空格
        .trim();
    }
    
    // 替换模板中的占位符
    const newYamlContent = templateContent
      .replace(/TRAINING_JOB_NAME/g, trainingJobName)
      .replace(/DOCKER_IMAGE/g, dockerImage)
      .replace(/INSTANCE_TYPE/g, instanceType)
      .replace(/NPROC_PER_NODE/g, nprocPerNode.toString())
      .replace(/REPLICAS_COUNT/g, replicas.toString())
      .replace(/EFA_PER_NODE/g, efaCount.toString())
      .replace(/TORCH_RECIPE_PYPATH_PH/g, entryPythonScriptPath)
      .replace(/TORCH_RECIPE_PYPARAMS_PH/g, formattedPythonParams)
      .replace(/SM_MLFLOW_ARN/g, mlflowTrackingUri)
      .replace(/LOG_MONITORING_CONFIG/g, logMonitoringConfigYaml);

    console.log('Generated torch training YAML content:', newYamlContent);

    // 生成时间戳
    const timestamp = Date.now();
    
    // 生成临时文件名（用于kubectl apply）
    const tempFileName = `torch-training-${trainingJobName}-${timestamp}.yaml`;
    const tempFilePath = path.join(__dirname, '../temp', tempFileName);

    // 生成永久保存的文件名（保存到templates/training/目录）
    const permanentFileName = `torch_${timestamp}.yaml`;
    const permanentFilePath = path.join(__dirname, '../templates/training', permanentFileName);

    // 确保temp目录存在
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 确保templates/training目录存在
    const trainingTemplateDir = path.join(__dirname, '../templates/training');
    if (!fs.existsSync(trainingTemplateDir)) {
      fs.mkdirSync(trainingTemplateDir, { recursive: true });
    }

    // 写入临时文件（用于kubectl apply）
    await fs.writeFile(tempFilePath, newYamlContent);
    console.log(`Torch training YAML written to temp file: ${tempFilePath}`);

    // 写入永久文件（保存到templates/training/目录）
    await fs.writeFile(permanentFilePath, newYamlContent);
    console.log(`Torch training YAML saved permanently to: ${permanentFilePath}`);

    // 应用YAML配置 - 训练任务可能需要更长时间
    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`, 60000); // 60秒超时
    console.log('Torch training job apply output:', applyOutput);

    // 清理临时文件
    try {
      await fs.unlink(tempFilePath);
      console.log(`Temporary file deleted: ${tempFilePath}`);
    } catch (cleanupError) {
      console.warn(`Failed to delete temporary file: ${cleanupError.message}`);
    }

    // 广播训练任务启动状态更新
    broadcast({
      type: 'training_launch',
      status: 'success',
      message: `Successfully launched torch training job: ${trainingJobName}`,
      output: applyOutput
    });

    res.json({
      success: true,
      message: `Torch training job "${trainingJobName}" launched successfully`,
      trainingJobName: trainingJobName,
      savedTemplate: permanentFileName,
      savedTemplatePath: permanentFilePath,
      output: applyOutput
    });

  } catch (error) {
    console.error('Torch training launch error details:', {
      message: error.message,
      stack: error.stack,
      error: error
    });
    
    const errorMessage = error.message || error.toString() || 'Unknown error occurred';
    
    broadcast({
      type: 'training_launch',
      status: 'error',
      message: `Torch training launch failed: ${errorMessage}`
    });
    
    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

// 生成并部署HyperPod训练任务 - 专门用于LlamaFactory训练任务
app.post('/api/launch-training', async (req, res) => {
  try {
    console.log('Raw request body:', JSON.stringify(req.body, null, 2));
    
    const {
      trainingJobName,
      dockerImage = 'pytorch/pytorch:latest',
      instanceType = 'ml.g5.12xlarge',
      nprocPerNode = 1,
      replicas = 1,
      efaCount = 0,
      lmfRecipeRunPath,
      lmfRecipeYamlFile,
      mlflowTrackingUri = '',
      logMonitoringConfig
    } = req.body;

    console.log('Training launch request parsed:', { 
      trainingJobName,
      dockerImage,
      instanceType,
      nprocPerNode,
      replicas,
      efaCount,
      lmfRecipeRunPath,
      lmfRecipeYamlFile,
      mlflowTrackingUri,
      logMonitoringConfig: logMonitoringConfig ? 'present' : 'empty'
    });

    // 验证必需参数
    if (!trainingJobName) {
      return res.status(400).json({
        success: false,
        error: 'Training job name is required'
      });
    }

    if (!lmfRecipeRunPath) {
      return res.status(400).json({
        success: false,
        error: 'LlamaFactory Recipe Run Path is required'
      });
    }

    if (!lmfRecipeYamlFile) {
      return res.status(400).json({
        success: false,
        error: 'LlamaFactory Config YAML File Name is required'
      });
    }

    // 读取训练任务模板
    const templatePath = path.join(__dirname, '../templates/hyperpod-training-lmf-template.yaml');
    const templateContent = await fs.readFile(templatePath, 'utf8');
    
    // 处理日志监控配置
    let logMonitoringConfigYaml = '';
    if (logMonitoringConfig && logMonitoringConfig.trim() !== '') {
      // 添加适当的缩进
      const indentedConfig = logMonitoringConfig
        .split('\n')
        .map(line => line.trim() ? `    ${line}` : line)
        .join('\n');
      logMonitoringConfigYaml = `
    logMonitoringConfiguration: 
${indentedConfig}`;
    }
    
    // 替换模板中的占位符
    const newYamlContent = templateContent
      .replace(/TRAINING_JOB_NAME/g, trainingJobName)
      .replace(/DOCKER_IMAGE/g, dockerImage)
      .replace(/INSTANCE_TYPE/g, instanceType)
      .replace(/NPROC_PER_NODE/g, nprocPerNode.toString())
      .replace(/REPLICAS_COUNT/g, replicas.toString())
      .replace(/EFA_PER_NODE/g, efaCount.toString())
      .replace(/LMF_RECIPE_RUNPATH_PH/g, lmfRecipeRunPath)
      .replace(/LMF_RECIPE_YAMLFILE_PH/g, lmfRecipeYamlFile)
      .replace(/SM_MLFLOW_ARN/g, mlflowTrackingUri)
      .replace(/LOG_MONITORING_CONFIG/g, logMonitoringConfigYaml);

    console.log('Generated training YAML content:', newYamlContent);

    // 生成时间戳
    const timestamp = Date.now();
    
    // 生成临时文件名（用于kubectl apply）
    const tempFileName = `training-${trainingJobName}-${timestamp}.yaml`;
    const tempFilePath = path.join(__dirname, '../temp', tempFileName);

    // 生成永久保存的文件名（保存到templates/training/目录）
    const permanentFileName = `lma_${timestamp}.yaml`;
    const permanentFilePath = path.join(__dirname, '../templates/training', permanentFileName);

    // 确保temp目录存在
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 确保templates/training目录存在
    const trainingTemplateDir = path.join(__dirname, '../templates/training');
    if (!fs.existsSync(trainingTemplateDir)) {
      fs.mkdirSync(trainingTemplateDir, { recursive: true });
    }

    // 写入临时文件（用于kubectl apply）
    await fs.writeFile(tempFilePath, newYamlContent);
    console.log(`Training YAML written to temp file: ${tempFilePath}`);

    // 写入永久文件（保存到templates/training/目录）
    await fs.writeFile(permanentFilePath, newYamlContent);
    console.log(`Training YAML saved permanently to: ${permanentFilePath}`);

    // 应用YAML配置 - 训练任务可能需要更长时间
    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`, 60000); // 60秒超时
    console.log('Training job apply output:', applyOutput);

    // 清理临时文件
    try {
      await fs.unlink(tempFilePath);
      console.log(`Temporary file deleted: ${tempFilePath}`);
    } catch (cleanupError) {
      console.warn(`Failed to delete temporary file: ${cleanupError.message}`);
    }

    // 广播训练任务启动状态更新
    broadcast({
      type: 'training_launch',
      status: 'success',
      message: `Successfully launched training job: ${trainingJobName}`,
      output: applyOutput
    });

    res.json({
      success: true,
      message: `Training job "${trainingJobName}" launched successfully`,
      trainingJobName: trainingJobName,
      savedTemplate: permanentFileName,
      savedTemplatePath: permanentFilePath,
      output: applyOutput
    });

  } catch (error) {
    console.error('Training launch error details:', {
      message: error.message,
      stack: error.stack,
      error: error
    });
    
    const errorMessage = error.message || error.toString() || 'Unknown error occurred';
    
    broadcast({
      type: 'training_launch',
      status: 'error',
      message: `Training launch failed: ${errorMessage}`
    });
    
    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

// 保存LlamaFactory配置
app.post('/api/llamafactory-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/llamafactory-config.json');
    
    // 确保config目录存在
    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('LlamaFactory config saved:', config);
    
    res.json({
      success: true,
      message: 'LlamaFactory configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving training config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 加载LlamaFactory配置
app.get('/api/llamafactory-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/llamafactory-config.json');
    
    if (!fs.existsSync(configPath)) {
      // 返回默认配置
      const defaultConfig = {
        trainingJobName: 'torchrecipe-1',
        dockerImage: 'ACCOUNTID.dkr.ecr.REGION.amazonaws.com/REPONAME:latest',
        instanceType: 'ml.g5.12xlarge',
        nprocPerNode: 1,
        replicas: 1,
        efaCount: 16,
        lmfRecipeRunPath: '/s3/train-recipes/llama-factory-project/',
        lmfRecipeYamlFile: 'yaml_template.yaml',
        mlflowTrackingUri: '',
        logMonitoringConfig: ''
      };
      
      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }
    
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    console.log('LlamaFactory config loaded:', config);
    
    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading training config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 保存Script配置
app.post('/api/script-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/script-config.json');
    
    // 确保config目录存在
    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('Script config saved:', config);
    
    res.json({
      success: true,
      message: 'Script configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving script config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 加载Script配置
app.get('/api/script-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/script-config.json');
    
    if (!fs.existsSync(configPath)) {
      // 返回默认配置
      const defaultConfig = {
        trainingJobName: 'hypd-recipe-script-1',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
        instanceType: 'ml.g5.12xlarge',
        nprocPerNode: 1,
        replicas: 1,
        efaCount: 16,
        projectPath: '/s3/training_code/my-training-project/',
        entryPath: 'train.py',
        mlflowTrackingUri: '',
        logMonitoringConfig: ''
      };
      
      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }
    
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    console.log('Script config loaded:', config);
    
    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading script config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 生成并部署HyperPod Script训练任务 - 专门用于Script训练
app.post('/api/launch-script-training', async (req, res) => {
  try {
    console.log('Raw script training request body:', JSON.stringify(req.body, null, 2));
    
    const {
      trainingJobName,
      dockerImage = '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
      instanceType = 'ml.g5.12xlarge',
      nprocPerNode = 1,
      replicas = 1,
      efaCount = 16,
      projectPath,
      entryPath,
      mlflowTrackingUri = '',
      logMonitoringConfig
    } = req.body;

    console.log('Script training launch request parsed:', { 
      trainingJobName,
      dockerImage,
      instanceType,
      nprocPerNode,
      replicas,
      efaCount,
      projectPath,
      entryPath,
      mlflowTrackingUri,
      logMonitoringConfig: logMonitoringConfig ? 'present' : 'empty'
    });

    // 验证必需参数
    if (!trainingJobName) {
      return res.status(400).json({
        success: false,
        error: 'Training job name is required'
      });
    }

    if (!projectPath) {
      return res.status(400).json({
        success: false,
        error: 'Project Path is required'
      });
    }

    if (!entryPath) {
      return res.status(400).json({
        success: false,
        error: 'Entry Script Path is required'
      });
    }

    // 读取Script训练任务模板
    const templatePath = path.join(__dirname, '../templates/hyperpod-training-script-template.yaml');
    const templateContent = await fs.readFile(templatePath, 'utf8');
    
    // 处理日志监控配置
    let logMonitoringConfigYaml = '';
    if (logMonitoringConfig && logMonitoringConfig.trim() !== '') {
      // 添加适当的缩进
      const indentedConfig = logMonitoringConfig
        .split('\n')
        .map(line => line.trim() ? `    ${line}` : line)
        .join('\n');
      logMonitoringConfigYaml = `
    logMonitoringConfiguration: 
${indentedConfig}`;
    }
    
    // 替换模板中的占位符
    const newYamlContent = templateContent
      .replace(/TRAINING_JOB_NAME/g, trainingJobName)
      .replace(/DOCKER_IMAGE/g, dockerImage)
      .replace(/INSTANCE_TYPE/g, instanceType)
      .replace(/NPROC_PER_NODE/g, nprocPerNode.toString())
      .replace(/REPLICAS_COUNT/g, replicas.toString())
      .replace(/EFA_PER_NODE/g, efaCount.toString())
      .replace(/SCRIPT_RECIPE_PROJECTPATH_PH/g, projectPath)
      .replace(/SCRIPT_RECIPE_ENTRYPATH_PH/g, entryPath)
      .replace(/SM_MLFLOW_ARN/g, mlflowTrackingUri)
      .replace(/LOG_MONITORING_CONFIG/g, logMonitoringConfigYaml);

    console.log('Generated script training YAML content:', newYamlContent);

    // 生成时间戳
    const timestamp = Date.now();
    
    // 生成临时文件名（用于kubectl apply）
    const tempFileName = `script-training-${trainingJobName}-${timestamp}.yaml`;
    const tempFilePath = path.join(__dirname, '../temp', tempFileName);

    // 生成永久保存的文件名（保存到templates/training/目录）
    const permanentFileName = `script_${timestamp}.yaml`;
    const permanentFilePath = path.join(__dirname, '../templates/training', permanentFileName);

    // 确保temp目录存在
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 确保templates/training目录存在
    const trainingTemplateDir = path.join(__dirname, '../templates/training');
    if (!fs.existsSync(trainingTemplateDir)) {
      fs.mkdirSync(trainingTemplateDir, { recursive: true });
    }

    // 写入临时文件（用于kubectl apply）
    await fs.writeFile(tempFilePath, newYamlContent);
    console.log(`Script training YAML written to temp file: ${tempFilePath}`);

    // 写入永久文件（保存到templates/training/目录）
    await fs.writeFile(permanentFilePath, newYamlContent);
    console.log(`Script training YAML saved permanently to: ${permanentFilePath}`);

    // 应用YAML配置 - 训练任务可能需要更长时间
    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`, 60000); // 60秒超时
    console.log('Script training job apply output:', applyOutput);

    // 清理临时文件
    try {
      await fs.unlink(tempFilePath);
      console.log(`Temporary file deleted: ${tempFilePath}`);
    } catch (cleanupError) {
      console.warn(`Failed to delete temporary file: ${cleanupError.message}`);
    }

    // 广播训练任务启动状态更新
    broadcast({
      type: 'training_launch',
      status: 'success',
      message: `Successfully launched script training job: ${trainingJobName}`,
      output: applyOutput
    });

    res.json({
      success: true,
      message: `Script training job "${trainingJobName}" launched successfully`,
      trainingJobName: trainingJobName,
      savedTemplate: permanentFileName,
      savedTemplatePath: permanentFilePath,
      output: applyOutput
    });

  } catch (error) {
    console.error('Script training launch error details:', {
      message: error.message,
      stack: error.stack,
      error: error
    });
    
    const errorMessage = error.message || error.toString() || 'Unknown error occurred';
    
    broadcast({
      type: 'training_launch',
      status: 'error',
      message: `Script training launch failed: ${errorMessage}`
    });
    
    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

// 保存Torch配置
app.post('/api/torch-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/torch-config.json');
    
    // 确保config目录存在
    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('Torch config saved:', config);
    
    res.json({
      success: true,
      message: 'Torch configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving torch config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 加载Torch配置
app.get('/api/torch-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/torch-config.json');
    
    if (!fs.existsSync(configPath)) {
      // 返回默认配置
      const defaultConfig = {
        trainingJobName: 'hypd-recipe-torch-1',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
        instanceType: 'ml.g5.12xlarge',
        nprocPerNode: 1,
        replicas: 1,
        efaCount: 16,
        entryPythonScriptPath: '/s3/training_code/model-training-with-hyperpod-training-operator/torch-training.py',
        pythonScriptParameters: '--learning_rate 1e-5 \\\n--batch_size 1',
        mlflowTrackingUri: '',
        logMonitoringConfig: ''
      };
      
      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }
    
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    console.log('Torch config loaded:', config);
    
    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading torch config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 保存verl配置
app.post('/api/verl-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/verl-config.json');
    
    // 确保config目录存在
    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('VERL config saved:', config);
    
    res.json({
      success: true,
      message: 'VERL configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving VERL config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 加载verl配置
app.get('/api/verl-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/verl-config.json');
    
    if (!fs.existsSync(configPath)) {
      // 返回默认配置
      const defaultConfig = {
        trainingJobName: 'verl-training-job-1',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/verl-training:latest',
        instanceType: 'ml.p4d.24xlarge',
        nprocPerNode: 8,
        replicas: 2,
        baseModel: 'meta-llama/Llama-2-7b-hf',
        rewardModel: 'anthropic/hh-rlhf-reward-model',
        learningRate: 1e-5,
        batchSize: 32,
        maxSteps: 1000,
        saveSteps: 100,
        evalSteps: 50,
        warmupSteps: 100,
        entryScriptPath: '/s3/verl_training/scripts/train_verl.py',
        mlflowTrackingUri: '',
        advancedConfig: ''
      };
      
      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }
    
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    console.log('VERL config loaded:', config);
    
    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading VERL config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取所有HyperPod训练任务
app.get('/api/training-jobs', async (req, res) => {
  try {
    console.log('Fetching HyperPod training jobs...');
    const output = await executeKubectl('get hyperpodpytorchjob -o json');
    const result = JSON.parse(output);
    
    const trainingJobs = result.items.map(job => ({
      name: job.metadata.name,
      namespace: job.metadata.namespace || 'default',
      creationTimestamp: job.metadata.creationTimestamp,
      status: job.status || {},
      spec: {
        replicas: job.spec?.replicaSpecs?.[0]?.replicas || 0,
        nprocPerNode: job.spec?.nprocPerNode || 0
      }
    }));
    
    console.log(`Found ${trainingJobs.length} training jobs:`, trainingJobs.map(j => j.name));
    
    res.json({
      success: true,
      jobs: trainingJobs
    });
  } catch (error) {
    console.error('Error fetching training jobs:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      jobs: []
    });
  }
});

// 删除指定的HyperPod训练任务
app.delete('/api/training-jobs/:jobName', async (req, res) => {
  try {
    const { jobName } = req.params;
    console.log(`Deleting training job: ${jobName}`);
    
    const output = await executeKubectl(`delete hyperpodpytorchjob ${jobName}`);
    console.log('Delete output:', output);
    
    // 广播删除状态更新
    broadcast({
      type: 'training_job_deleted',
      status: 'success',
      message: `Training job "${jobName}" deleted successfully`,
      jobName: jobName
    });
    
    res.json({
      success: true,
      message: `Training job "${jobName}" deleted successfully`,
      output: output
    });
  } catch (error) {
    console.error('Error deleting training job:', error);
    
    broadcast({
      type: 'training_job_deleted',
      status: 'error',
      message: `Failed to delete training job: ${error.message}`
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// MLflow配置管理

const CONFIG_FILE = path.join(__dirname, '../config/mlflow-metric-config.json');

// 确保配置目录存在
const configDir = path.dirname(CONFIG_FILE);
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// 默认MLflow配置
const DEFAULT_MLFLOW_CONFIG = {
  tracking_uri: '',
  experiment_id: '',
  sync_configs: {}
};

// 读取MLflow配置
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

// 保存MLflow配置
function saveMlflowConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving MLflow config:', error);
    return false;
  }
}

// 获取MLflow配置
app.get('/api/mlflow-metric-config', (req, res) => {
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

// 保存MLflow配置
app.post('/api/mlflow-metric-config', (req, res) => {
  try {
    const { tracking_uri } = req.body;
    
    if (!tracking_uri) {
      return res.status(400).json({
        success: false,
        error: 'tracking_uri is required'
      });
    }

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

// 测试MLflow连接
app.post('/api/mlflow-metric-config/test', async (req, res) => {
  try {
    const { tracking_uri } = req.body;
    
    if (!tracking_uri) {
      return res.status(400).json({
        success: false,
        error: 'tracking_uri is required'
      });
    }

    console.log(`Testing MLflow connection to: ${tracking_uri}`);
    
    const { spawn } = require('child_process');
    
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
    
    // 确保temp目录存在
    const tempDir = path.dirname(tempScriptPath);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    fs.writeFileSync(tempScriptPath, testScript);
    
    const pythonPath = path.join(__dirname, '../.venv/bin/python');
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

// MLflow跨账户同步API
app.post('/api/mlflow-sync', async (req, res) => {
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

    // 验证JSON配置
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

    // 验证source和destination ARN不能相同
    if (configObj.source_mlflow_arn === configObj.shared_mlflow_arn) {
      return res.status(400).json({
        success: false,
        error: 'Source MLflow ARN and Shared MLflow ARN cannot be the same. Please ensure you are syncing to a different MLflow server.'
      });
    }

    // 添加时间戳
    configObj.setup_date = new Date().toISOString();

    console.log(`Starting MLflow sync for experiment ${experimentIdentifier}...`);
    
    // 1. 保存配置到mlflow-metric-config.json
    const currentConfig = readMlflowConfig();
    const updatedConfig = {
      ...currentConfig,
      experiment_name: experimentIdentifier,  // 改为experiment_name
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

    // 2. 创建临时配置文件供Python脚本使用
    const tempConfigPath = path.join(__dirname, '../temp/sync-config-temp.json');
    
    // 确保temp目录存在
    const tempDir = path.dirname(tempConfigPath);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    fs.writeFileSync(tempConfigPath, JSON.stringify(configObj, null, 2));

    // 3. 调用Python同步脚本
    const { spawn } = require('child_process');
    const pythonPath = path.join(__dirname, '../.venv/bin/python');
    const syncScriptPath = path.join(__dirname, '../mlflow/cross_account_sync.py');
    
    const pythonProcess = spawn(pythonPath, [
      syncScriptPath,
      '--config-file', tempConfigPath,
      '--experiment-name', experimentIdentifier
    ], {
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

// 获取训练历史数据（从MLflow）
app.get('/api/training-history', async (req, res) => {
  try {
    console.log('Fetching training history from MLflow...');
    
    // 读取当前MLflow配置
    const mlflowConfig = readMlflowConfig();
    console.log('Using MLflow URI:', mlflowConfig.tracking_uri);
    
    const { spawn } = require('child_process');
    const path = require('path');
    
    // 使用项目内虚拟环境的Python执行脚本，传递配置参数
    const pythonPath = path.join(__dirname, '../.venv/bin/python');
    const scriptPath = path.join(__dirname, '../mlflow/get_training_history.py');
    
    const pythonProcess = spawn(pythonPath, [scriptPath, mlflowConfig.tracking_uri], {
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
      if (stderr) {
        console.log('Python script stderr:', stderr);
      }
      
      if (code !== 0) {
        console.error(`Python script exited with code ${code}`);
        return res.status(500).json({ 
          success: false, 
          error: `Failed to fetch training history: exit code ${code}`,
          stderr: stderr
        });
      }
      
      try {
        const result = JSON.parse(stdout);
        console.log(`Training history fetched: ${result.total} records`);
        res.json(result);
      } catch (parseError) {
        console.error('Failed to parse Python script output:', parseError);
        console.error('Raw output:', stdout);
        res.status(500).json({ 
          success: false, 
          error: 'Failed to parse training history data',
          raw_output: stdout
        });
      }
    });
    
    pythonProcess.on('error', (error) => {
      console.error('Failed to start Python script:', error);
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

// 获取训练任务关联的pods
app.get('/api/training-jobs/:jobName/pods', async (req, res) => {
  try {
    const { jobName } = req.params;
    console.log(`Fetching pods for training job: ${jobName}`);
    
    // 获取所有pods，然后筛选出属于该训练任务的pods
    const output = await executeKubectl('get pods -o json');
    const result = JSON.parse(output);
    
    // 筛选出属于该训练任务的pods
    const trainingPods = result.items.filter(pod => {
      const labels = pod.metadata.labels || {};
      const ownerReferences = pod.metadata.ownerReferences || [];
      
      // 检查是否通过标签或ownerReferences关联到训练任务
      return labels['training-job-name'] === jobName || 
             labels['app'] === jobName ||
             ownerReferences.some(ref => ref.name === jobName) ||
             pod.metadata.name.includes(jobName);
    });
    
    const pods = trainingPods.map(pod => ({
      name: pod.metadata.name,
      namespace: pod.metadata.namespace || 'default',
      status: pod.status.phase,
      creationTimestamp: pod.metadata.creationTimestamp,
      nodeName: pod.spec.nodeName,
      containerStatuses: pod.status.containerStatuses || []
    }));
    
    console.log(`Found ${pods.length} pods for training job ${jobName}:`, pods.map(p => p.name));
    
    res.json({
      success: true,
      pods: pods
    });
  } catch (error) {
    console.error('Error fetching training job pods:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      pods: []
    });
  }
});

// 获取完整日志文件
app.get('/api/logs/:jobName/:podName', (req, res) => {
  try {
    const { jobName, podName } = req.params;
    const logFilePath = path.join(LOG_BASE_DIR, jobName, `${podName}.log`);
    
    if (fs.existsSync(logFilePath)) {
      res.sendFile(path.resolve(logFilePath));
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'Log file not found',
        path: logFilePath
      });
    }
  } catch (error) {
    console.error('Error serving log file:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 下载完整日志文件
app.get('/api/logs/:jobName/:podName/download', (req, res) => {
  try {
    const { jobName, podName } = req.params;
    const logFilePath = path.join(LOG_BASE_DIR, jobName, `${podName}.log`);
    
    if (fs.existsSync(logFilePath)) {
      res.download(logFilePath, `${podName}.log`, (err) => {
        if (err) {
          console.error('Error downloading log file:', err);
          res.status(500).json({ 
            success: false, 
            error: 'Failed to download log file' 
          });
        }
      });
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'Log file not found',
        path: logFilePath
      });
    }
  } catch (error) {
    console.error('Error downloading log file:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 获取日志文件信息
app.get('/api/logs/:jobName/:podName/info', (req, res) => {
  try {
    const { jobName, podName } = req.params;
    const logFilePath = path.join(LOG_BASE_DIR, jobName, `${podName}.log`);
    
    if (fs.existsSync(logFilePath)) {
      const stats = fs.statSync(logFilePath);
      res.json({
        success: true,
        info: {
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime,
          path: logFilePath
        }
      });
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'Log file not found' 
      });
    }
  } catch (error) {
    console.error('Error getting log file info:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 删除部署 - 改进版本
app.post('/api/undeploy', async (req, res) => {
  try {
    const { modelTag, deleteType } = req.body;
    
    if (!modelTag) {
      return res.status(400).json({
        success: false,
        error: 'Model tag is required'
      });
    }
    
    console.log(`Undeploying model: ${modelTag}, type: ${deleteType}`);
    
    // 构建可能的资源名称
    const possibleDeployments = [
      `vllm-${modelTag}-inference`,
      `sglang-${modelTag}-inference`,
      `olm-${modelTag}-inference`,
      `${modelTag}-inference`  // 备用格式
    ];
    
    const possibleServices = [
      `vllm-${modelTag}-nlb`,
      `sglang-${modelTag}-nlb`,
      `olm-${modelTag}-nlb`,
      `${modelTag}-nlb`,
      `${modelTag}-service`  // 备用格式
    ];
    
    let deleteCommands = [];
    let deletedResources = [];
    
    // 根据删除类型决定删除哪些资源
    if (deleteType === 'all' || deleteType === 'deployment') {
      possibleDeployments.forEach(deploymentName => {
        deleteCommands.push(`delete deployment ${deploymentName} --ignore-not-found=true`);
      });
      deletedResources.push('Deployment');
    }
    
    if (deleteType === 'all' || deleteType === 'service') {
      possibleServices.forEach(serviceName => {
        deleteCommands.push(`delete service ${serviceName} --ignore-not-found=true`);
      });
      deletedResources.push('Service');
    }
    
    // 执行删除命令
    const results = [];
    let actuallyDeleted = 0;
    
    for (const command of deleteCommands) {
      try {
        const output = await executeKubectl(command);
        const success = !output.includes('not found');
        results.push({
          command,
          success: true,
          output: output.trim(),
          actuallyDeleted: success
        });
        if (success) actuallyDeleted++;
      } catch (error) {
        results.push({
          command,
          success: false,
          error: error.error || error.message,
          actuallyDeleted: false
        });
      }
    }
    
    // 等待一下让资源完全删除
    if (actuallyDeleted > 0) {
      console.log(`Waiting for resources to be fully deleted...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // 广播删除状态更新
    broadcast({
      type: 'undeployment',
      status: 'success',
      message: `Successfully deleted resources for ${modelTag} (${actuallyDeleted} resources)`,
      results: results
    });
    
    res.json({
      success: true,
      message: actuallyDeleted > 0 
        ? `Successfully deleted ${actuallyDeleted} resource(s)` 
        : 'No resources found to delete (may already be deleted)',
      deletedResources: deletedResources,
      results: results,
      modelTag: modelTag,
      actuallyDeleted: actuallyDeleted
    });
    
  } catch (error) {
    console.error('Undeploy error:', error);
    
    broadcast({
      type: 'undeployment',
      status: 'error',
      message: `Failed to undeploy ${req.body.modelTag}: ${error.message}`
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取部署详细信息（包含模型元数据）
app.get('/api/deployment-details', async (req, res) => {
  try {
    console.log('Fetching deployment details with metadata...');
    
    // 获取所有deployment
    const deploymentsOutput = await executeKubectl('get deployments -o json');
    const deployments = JSON.parse(deploymentsOutput);
    
    // 获取所有service
    const servicesOutput = await executeKubectl('get services -o json');
    const services = JSON.parse(servicesOutput);
    
    // 过滤出模型相关的部署并提取元数据
    const modelDeployments = deployments.items
      .filter(deployment => 
        deployment.metadata.name.includes('vllm') || 
        deployment.metadata.name.includes('olm') ||
        deployment.metadata.name.includes('inference')
      )
      .map(deployment => {
        const labels = deployment.metadata.labels || {};
        const appLabel = labels.app;
        
        // 查找对应的service
        const matchingService = services.items.find(service => 
          service.spec.selector?.app === appLabel
        );
        
        // 从标签中提取模型信息
        const modelType = labels['model-type'] || 'unknown';
        const encodedModelId = labels['model-id'] || 'unknown';
        const modelTag = labels['model-tag'] || 'unknown';
        
        // 确定最终的模型ID - 优先从容器命令中提取原始ID
        let modelId = 'unknown';
        
        // 对于VLLM部署，从容器命令中提取原始模型ID
        if (modelType === 'vllm') {
          try {
            const containers = deployment.spec?.template?.spec?.containers || [];
            const vllmContainer = containers.find(c => c.name === 'vllm-openai');
            if (vllmContainer && vllmContainer.command) {
              const command = vllmContainer.command;
              
              // 1. 优先检查新的 vllm serve 格式
              const serveIndex = command.findIndex(arg => arg === 'serve');
              if (serveIndex !== -1 && serveIndex + 1 < command.length) {
                // 检查前一个参数是否是 vllm 相关
                if (serveIndex > 0 && command[serveIndex - 1].includes('vllm')) {
                  const modelPath = command[serveIndex + 1];
                  // 确保不是以 -- 开头的参数
                  if (!modelPath.startsWith('--')) {
                    modelId = modelPath;
                  }
                }
              }
              
              // 2. 如果没找到，检查传统的 --model 参数
              if (modelId === 'unknown') {
                const modelIndex = command.findIndex(arg => arg === '--model');
                if (modelIndex !== -1 && modelIndex + 1 < command.length) {
                  modelId = command[modelIndex + 1]; // 获取--model参数后的值
                }
              }
            }
          } catch (error) {
            console.log('Failed to extract model ID from VLLM command:', error.message);
          }
        }
        
        // 对于Ollama部署，从postStart生命周期钩子中提取模型ID
        if (modelType === 'ollama' && modelId === 'unknown') {
          try {
            const containers = deployment.spec?.template?.spec?.containers || [];
            const ollamaContainer = containers.find(c => c.name === 'ollama');
            if (ollamaContainer && ollamaContainer.lifecycle?.postStart?.exec?.command) {
              const command = ollamaContainer.lifecycle.postStart.exec.command;
              // 查找包含"ollama pull"的命令
              const commandStr = command.join(' ');
              const pullMatch = commandStr.match(/ollama pull ([^\s\\]+)/);
              if (pullMatch) {
                modelId = pullMatch[1]; // 提取模型ID
                console.log('Extracted Ollama model ID from postStart:', modelId);
              }
            }
          } catch (error) {
            console.log('Failed to extract model ID from Ollama postStart command:', error.message);
          }
        }
        
        // 对于无法提取的情况，使用解码逻辑
        if (modelId === 'unknown' && encodedModelId !== 'unknown') {
          modelId = decodeModelIdFromLabel(encodedModelId);
        }
        
        // 获取服务URL
        let serviceUrl = '';
        if (matchingService) {
          const ingress = matchingService.status?.loadBalancer?.ingress?.[0];
          if (ingress) {
            const host = ingress.hostname || ingress.ip;
            const port = matchingService.spec.ports?.[0]?.port || 8000;
            serviceUrl = `http://${host}:${port}`;
          }
        }
        
        return {
          deploymentName: deployment.metadata.name,
          serviceName: matchingService?.metadata.name || 'N/A',
          modelType: modelType,
          modelId: modelId,
          modelTag: modelTag,
          serviceUrl: serviceUrl,
          status: deployment.status.readyReplicas === deployment.spec.replicas ? 'Ready' : 'Pending',
          replicas: deployment.spec.replicas,
          readyReplicas: deployment.status.readyReplicas || 0,
          hasService: !!matchingService,
          isExternal: matchingService?.metadata?.annotations?.['service.beta.kubernetes.io/aws-load-balancer-scheme'] === 'internet-facing'
        };
      });
    
    console.log('Deployment details fetched:', modelDeployments.length, 'deployments');
    res.json(modelDeployments);
    
  } catch (error) {
    console.error('Deployment details fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 获取已部署的模型列表
app.get('/api/deployments', async (req, res) => {
  try {
    console.log('Fetching deployments...');
    
    // 获取所有deployment
    const deploymentsOutput = await executeKubectl('get deployments -o json');
    const deployments = JSON.parse(deploymentsOutput);
    
    // 获取所有service
    const servicesOutput = await executeKubectl('get services -o json');
    const services = JSON.parse(servicesOutput);
    
    // 过滤出VLLM和Ollama相关的部署
    const modelDeployments = deployments.items.filter(deployment => 
      deployment.metadata.name.includes('vllm') || 
      deployment.metadata.name.includes('olm') ||
      deployment.metadata.name.includes('inference')
    );
    
    // 为每个部署匹配对应的service
    const deploymentList = modelDeployments.map(deployment => {
      const appLabel = deployment.metadata.labels?.app;
      const matchingService = services.items.find(service => 
        service.spec.selector?.app === appLabel
      );
      
      // 从deployment名称提取model tag和类型
      const deploymentName = deployment.metadata.name;
      let modelTag = 'unknown';
      let deploymentType = 'unknown';
      
      if (deploymentName.startsWith('vllm-') && deploymentName.endsWith('-inference')) {
        modelTag = deploymentName.slice(5, -10); // 移除 'vllm-' 前缀和 '-inference' 后缀
        deploymentType = 'VLLM';
      } else if (deploymentName.startsWith('sglang-') && deploymentName.endsWith('-inference')) {
        modelTag = deploymentName.slice(7, -10); // 移除 'sglang-' 前缀和 '-inference' 后缀
        deploymentType = 'SGLANG';
      } else if (deploymentName.startsWith('olm-') && deploymentName.endsWith('-inference')) {
        modelTag = deploymentName.slice(4, -10); // 移除 'olm-' 前缀和 '-inference' 后缀
        deploymentType = 'Ollama';
      }
      
      // 检查是否为external访问
      const isExternal = matchingService?.metadata?.annotations?.['service.beta.kubernetes.io/aws-load-balancer-scheme'] === 'internet-facing';
      
      return {
        modelTag,
        deploymentType,
        deploymentName: deployment.metadata.name,
        serviceName: matchingService?.metadata.name || 'N/A',
        replicas: deployment.spec.replicas,
        readyReplicas: deployment.status.readyReplicas || 0,
        status: deployment.status.readyReplicas === deployment.spec.replicas ? 'Ready' : 'Pending',
        createdAt: deployment.metadata.creationTimestamp,
        hasService: !!matchingService,
        serviceType: matchingService?.spec.type || 'N/A',
        isExternal: isExternal,
        externalIP: matchingService?.status?.loadBalancer?.ingress?.[0]?.hostname || 
                   matchingService?.status?.loadBalancer?.ingress?.[0]?.ip || 'Pending'
      };
    });
    
    console.log('Deployments fetched:', deploymentList.length, 'model deployments');
    res.json(deploymentList);
    
  } catch (error) {
    console.error('Deployments fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 测试模型API（生成cURL命令）
app.post('/api/test-model', async (req, res) => {
  const { serviceUrl, payload } = req.body;
  
  try {
    let parsedPayload;
    
    try {
      parsedPayload = JSON.parse(payload);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    
    const curlCommand = `curl -X POST "${serviceUrl}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(parsedPayload, null, 2)}'`;
    
    res.json({
      curlCommand,
      fullUrl: serviceUrl,
      message: 'Use the curl command to test your model'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// WebSocket连接处理 - 优化版本，减少日志污染
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  
  // 发送状态更新的函数
  const sendStatusUpdate = async () => {
    try {
      const [pods, services] = await Promise.all([
        executeKubectl('get pods -o json').then(output => JSON.parse(output).items),
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
          console.log(`🔄 Starting log stream for ${data.jobName}/${data.podName}`);
          startLogStream(ws, data.jobName, data.podName);
          break;
          
        case 'stop_log_stream':
          console.log(`⏹️ Stopping log stream for ${data.jobName}/${data.podName}`);
          stopLogStream(ws, data.jobName, data.podName);
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
  
  // 清理活跃的日志流
  if (activeLogStreams && activeLogStreams.size > 0) {
    console.log(`🧹 Cleaning up ${activeLogStreams.size} active log streams...`);
    activeLogStreams.clear();
    console.log('✅ Log streams cleaned up');
  }
  
  console.log('✅ Graceful shutdown completed');
  
  // 给一些时间让清理完成，然后退出
  setTimeout(() => {
    process.exit(signal === 'uncaughtException' || signal === 'unhandledRejection' ? 1 : 0);
  }, 1000);
}

// 启动pod日志流
function startLogStream(ws, jobName, podName) {
  const streamKey = `${jobName}-${podName}`;
  
  // 如果已经有该pod的日志流，先停止它
  if (activeLogStreams.has(streamKey)) {
    stopLogStream(ws, jobName, podName);
  }
  
  console.log(`Starting log stream for pod: ${podName} in job: ${jobName}`);
  
  // 创建日志文件路径
  const logFilePath = ensureLogDirectory(jobName, podName);
  const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  
  // 启动kubectl logs命令
  const logProcess = spawn('kubectl', ['logs', '-f', podName], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  // 存储进程引用和文件流
  activeLogStreams.set(streamKey, {
    process: logProcess,
    logStream: logStream,
    ws: ws,
    jobName: jobName,
    podName: podName
  });
  
  // 处理标准输出
  logProcess.stdout.on('data', (data) => {
    const logLine = data.toString();
    const timestamp = new Date().toISOString();
    
    // 写入文件（带时间戳）
    logStream.write(`[${timestamp}] ${logLine}`);
    
    // 发送到前端
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'log_data',
        jobName: jobName,
        podName: podName,
        data: logLine,
        timestamp: timestamp
      }));
    }
  });
  
  // 处理标准错误
  logProcess.stderr.on('data', (data) => {
    const errorLine = data.toString();
    const timestamp = new Date().toISOString();
    
    console.error(`Log stream error for ${podName}:`, errorLine);
    
    // 写入错误到文件
    logStream.write(`[${timestamp}] ERROR: ${errorLine}`);
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'log_error',
        jobName: jobName,
        podName: podName,
        error: errorLine,
        timestamp: timestamp
      }));
    }
  });
  
  // 处理进程退出
  logProcess.on('close', (code) => {
    console.log(`Log stream for ${podName} closed with code: ${code}`);
    
    // 关闭文件流
    logStream.end();
    activeLogStreams.delete(streamKey);
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'log_stream_closed',
        jobName: jobName,
        podName: podName,
        code: code,
        timestamp: new Date().toISOString()
      }));
    }
  });
  
  // 处理进程错误
  logProcess.on('error', (error) => {
    console.error(`Log stream process error for ${podName}:`, error);
    
    // 关闭文件流
    logStream.end();
    activeLogStreams.delete(streamKey);
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'log_stream_error',
        jobName: jobName,
        podName: podName,
        error: error.message,
        timestamp: new Date().toISOString()
      }));
    }
  });
}

// 停止特定pod的日志流
function stopLogStream(ws, jobName, podName) {
  const streamKey = `${jobName}-${podName}`;
  const streamInfo = activeLogStreams.get(streamKey);
  
  if (streamInfo) {
    console.log(`Stopping log stream for pod: ${podName}`);
    streamInfo.process.kill('SIGTERM');
    
    // 关闭文件流
    if (streamInfo.logStream) {
      streamInfo.logStream.end();
    }
    
    activeLogStreams.delete(streamKey);
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'log_stream_stopped',
        jobName: jobName,
        podName: podName,
        timestamp: new Date().toISOString()
      }));
    }
  }
}

// 停止某个WebSocket连接的所有日志流
function stopAllLogStreams(ws) {
  const streamsToStop = [];
  
  for (const [streamKey, streamInfo] of activeLogStreams.entries()) {
    if (streamInfo.ws === ws) {
      streamsToStop.push(streamKey);
    }
  }
  
  streamsToStop.forEach(streamKey => {
    const streamInfo = activeLogStreams.get(streamKey);
    if (streamInfo) {
      console.log(`Stopping log stream: ${streamKey}`);
      streamInfo.process.kill('SIGTERM');
      
      // 关闭文件流
      if (streamInfo.logStream) {
        streamInfo.logStream.end();
      }
      
      activeLogStreams.delete(streamKey);
    }
  });
}

// 模型下载API
app.post('/api/download-model', async (req, res) => {
  try {
    const { modelId, hfToken } = req.body;
    
    if (!modelId) {
      return res.json({ success: false, error: 'Model ID is required' });
    }
    
    console.log(`Starting model download for: ${modelId}`);
    
    // 读取HF下载模板
    const templatePath = path.join(__dirname, '..', 'templates', 'hf-download-template.yaml');
    let template = await fs.readFile(templatePath, 'utf8');
    
    // 生成模型标签
    const modelTag = generateModelTag(modelId);
    
    // 替换基本变量
    const replacements = {
      'HF_MODEL_ID': modelId,
      'MODEL_TAG': modelTag
    };
    
    // 处理HF Token环境变量
    if (hfToken && hfToken.trim()) {
      const tokenEnv = `
        - name: HF_TOKEN
          value: "${hfToken.trim()}"`;
      template = template.replace('env:HF_TOKEN_ENV', `env:${tokenEnv}`);
      
      // 同时在hf download命令中启用token
      template = template.replace('#  --token=$HF_TOKEN', '          --token=$HF_TOKEN \\');
    } else {
      // 移除HF_TOKEN_ENV占位符，保留其他环境变量
      template = template.replace('      env:HF_TOKEN_ENV', '      env:');
    }
    
    // 替换其他变量
    Object.keys(replacements).forEach(key => {
      const regex = new RegExp(key, 'g');
      template = template.replace(regex, replacements[key]);
    });
    
    // 确保deployments目录存在
    const deploymentsDir = path.join(__dirname, '..', 'deployments');
    await fs.ensureDir(deploymentsDir);
    
    // 保存生成的YAML文件
    const deploymentFile = path.join(deploymentsDir, `model-download-${modelTag}.yaml`);
    await fs.writeFile(deploymentFile, template);
    
    console.log(`Generated deployment file: ${deploymentFile}`);
    
    // 应用到Kubernetes
    try {
      const result = await executeKubectl(`apply -f "${deploymentFile}"`);
      console.log('kubectl apply result:', result);
      
      // 广播部署状态更新
      broadcast({
        type: 'model_download',
        status: 'success',
        message: `Model download started for ${modelId}`,
        modelId: modelId,
        modelTag: modelTag
      });
      
      res.json({ 
        success: true, 
        message: `Model download initiated for ${modelId}`,
        modelTag: modelTag
      });
      
    } catch (kubectlError) {
      console.error('kubectl apply error:', kubectlError);
      res.json({ 
        success: false, 
        error: `Failed to apply deployment: ${kubectlError.error || kubectlError}` 
      });
    }
    
  } catch (error) {
    console.error('Model download error:', error);
    res.json({ success: false, error: error.message });
  }
});

// S3存储信息API - 从s3-pv PersistentVolume获取桶信息
app.get('/api/s3-storage', async (req, res) => {
  try {
    console.log('Fetching S3 storage information from s3-pv...');
    
    let bucketName = null;
    let bucketInfo = null;
    let region = null;
    
    try {
      // 直接从s3-pv PersistentVolume获取S3桶信息
      const pvResult = await executeKubectl('get pv s3-pv -o json');
      const pvData = JSON.parse(pvResult);
      
      console.log('PV data retrieved:', JSON.stringify(pvData, null, 2));
      
      // 从PV的spec.csi.volumeAttributes中提取S3桶信息
      if (pvData.spec && pvData.spec.csi && pvData.spec.csi.volumeAttributes) {
        const volumeAttributes = pvData.spec.csi.volumeAttributes;
        
        // 常见的S3 CSI驱动器属性名称
        bucketName = volumeAttributes.bucketName || 
                    volumeAttributes.bucket || 
                    volumeAttributes['s3.bucket'] ||
                    volumeAttributes['csi.storage.k8s.io/bucket'];
        
        region = volumeAttributes.region || 
                volumeAttributes['s3.region'] ||
                volumeAttributes['csi.storage.k8s.io/region'];
        
        bucketInfo = {
          storageClass: pvData.spec.storageClassName,
          capacity: pvData.spec.capacity?.storage,
          accessModes: pvData.spec.accessModes,
          csiDriver: pvData.spec.csi?.driver,
          volumeHandle: pvData.spec.csi?.volumeHandle,
          region: region
        };
        
        console.log(`Extracted bucket info: bucket=${bucketName}, region=${region}`);
      }
      
      // 如果从volumeAttributes中没有找到，尝试从volumeHandle中解析
      if (!bucketName && pvData.spec && pvData.spec.csi && pvData.spec.csi.volumeHandle) {
        const volumeHandle = pvData.spec.csi.volumeHandle;
        console.log('Trying to extract bucket from volumeHandle:', volumeHandle);
        
        // volumeHandle通常包含桶名，格式可能是: s3://bucket-name 或 bucket-name
        if (volumeHandle.startsWith('s3://')) {
          bucketName = volumeHandle.replace('s3://', '').split('/')[0];
        } else if (volumeHandle.includes('::')) {
          // 某些CSI驱动使用 region::bucket-name 格式
          const parts = volumeHandle.split('::');
          if (parts.length >= 2) {
            region = parts[0];
            bucketName = parts[1];
          }
        } else {
          // 直接使用volumeHandle作为桶名
          bucketName = volumeHandle;
        }
        
        console.log(`Extracted from volumeHandle: bucket=${bucketName}, region=${region}`);
      }
      
      // 检查 mountOptions 中的 region 信息
      if (!region && pvData.spec && pvData.spec.mountOptions) {
        const mountOptions = pvData.spec.mountOptions;
        console.log('Checking mountOptions for region:', mountOptions);
        
        for (const option of mountOptions) {
          if (typeof option === 'string' && option.startsWith('region ')) {
            region = option.replace('region ', '').trim();
            console.log(`Found region in mountOptions: ${region}`);
            break;
          }
        }
      }
      
      // 更新 bucketInfo 中的 region 信息
      if (bucketInfo && region) {
        bucketInfo.region = region;
        console.log(`Updated bucketInfo with region: ${region}`);
      }
      
      // 如果还是没有找到，尝试从annotations中获取
      if (!bucketName && pvData.metadata && pvData.metadata.annotations) {
        const annotations = pvData.metadata.annotations;
        bucketName = annotations['s3.bucket'] || 
                    annotations['csi.storage.k8s.io/bucket'] ||
                    annotations['volume.beta.kubernetes.io/bucket'];
        
        if (!region) {
          region = annotations['s3.region'] || 
                  annotations['csi.storage.k8s.io/region'] ||
                  annotations['volume.beta.kubernetes.io/region'];
        }
        
        console.log(`Extracted from annotations: bucket=${bucketName}, region=${region}`);
      }
      
    } catch (pvError) {
      console.error('Could not get s3-pv PV info:', pvError.error);
      return res.json({
        success: false,
        error: `Failed to get s3-pv PersistentVolume: ${pvError.error}`,
        bucketInfo: null
      });
    }
    
    // 验证是否成功获取到桶名
    if (!bucketName) {
      return res.json({
        success: false,
        error: 'Could not extract S3 bucket name from s3-pv PersistentVolume',
        bucketInfo: bucketInfo,
        message: 'S3 bucket information not found in PV configuration'
      });
    }
    
    console.log(`Using S3 bucket: ${bucketName} in region: ${region || 'default'}`);
    
    // 尝试列出S3内容 - 只获取一级目录和文件
    try {
      const s3ListResult = await new Promise((resolve, reject) => {
        const s3Command = region ? 
          `aws s3 ls s3://${bucketName}/ --region ${region}` :
          `aws s3 ls s3://${bucketName}/`;
          
        console.log('Executing S3 command:', s3Command);
        
        exec(s3Command, (error, stdout, stderr) => {
          if (error) {
            console.error('S3 command error:', error.message);
            console.error('S3 command stderr:', stderr);
            reject({ error: error.message, stderr });
          } else {
            resolve(stdout);
          }
        });
      });
      
      // 解析S3 ls输出
      const s3Items = [];
      if (s3ListResult.trim()) {
        const lines = s3ListResult.trim().split('\n');
        console.log(`Processing ${lines.length} S3 items...`);
        
        lines.forEach(line => {
          const trimmedLine = line.trim();
          if (!trimmedLine) return;
          
          // S3 ls 输出格式:
          // 对于目录: "                           PRE dirname/"
          // 对于文件: "2023-08-06 05:48:52       1234 filename.txt"
          
          if (trimmedLine.includes('PRE ')) {
            // 这是一个目录
            const dirName = trimmedLine.split('PRE ')[1];
            s3Items.push({
              key: dirName,
              name: dirName.replace('/', ''),
              size: null,
              lastModified: null,
              type: 'folder',
              storageClass: null
            });
          } else {
            // 这是一个文件
            const parts = trimmedLine.split(/\s+/);
            if (parts.length >= 3) {
              const date = parts[0];
              const time = parts[1];
              const size = parseInt(parts[2]);
              const fileName = parts.slice(3).join(' ');
              
              s3Items.push({
                key: fileName,
                name: fileName,
                size: size,
                lastModified: `${date} ${time}`,
                type: 'file',
                storageClass: 'STANDARD'
              });
            }
          }
        });
      }
      
      console.log(`Successfully retrieved ${s3Items.length} items from S3`);
      
      res.json({
        success: true,
        data: s3Items,
        bucketInfo: {
          bucket: bucketName,
          region: region || 'us-east-1',
          ...bucketInfo
        }
      });
      
    } catch (s3Error) {
      console.error('S3 list error:', s3Error);
      res.json({
        success: false,
        error: `Failed to list S3 contents: ${s3Error.error || s3Error}`,
        bucketInfo: {
          bucket: bucketName,
          region: region || 'us-east-1',
          ...bucketInfo
        }
      });
    }
    
  } catch (error) {
    console.error('S3 storage API error:', error);
    res.json({ 
      success: false, 
      error: error.message,
      bucketInfo: null
    });
  }
});

// ==================== 集群管理 API ====================

// 保存集群配置到 init_envs 文件

// 执行集群配置脚本 (Step 2)
// ==================== 集群管理 API ====================

// 日志管理类
class ClusterLogManager {
  constructor() {
    this.baseDir = path.join(__dirname, '../tmp/cluster-management');
    this.logsDir = path.join(this.baseDir, 'logs');
    this.currentDir = path.join(this.baseDir, 'current');
    this.metadataDir = path.join(this.baseDir, 'metadata');
    
    // 确保目录存在
    [this.baseDir, this.logsDir, this.currentDir, this.metadataDir].forEach(dir => {
      fs.ensureDirSync(dir);
    });
  }

  createLogFile(step) {
    const timestamp = new Date().toISOString()
      .replace(/:/g, '-')
      .replace(/\..+/, '')
      .replace('T', '_');
    
    const logFileName = `${timestamp}_${step}.log`;
    const logFilePath = path.join(this.logsDir, logFileName);
    const currentLinkPath = path.join(this.currentDir, `${step}.log`);
    
    // 创建日志文件
    fs.writeFileSync(logFilePath, '');
    
    // 创建/更新软链接
    if (fs.existsSync(currentLinkPath)) {
      fs.unlinkSync(currentLinkPath);
    }
    fs.symlinkSync(path.relative(this.currentDir, logFilePath), currentLinkPath);
    
    return {
      logFilePath,
      logId: path.basename(logFileName, '.log')
    };
  }

  getCurrentLogContent(step) {
    const currentLogPath = path.join(this.currentDir, `${step}.log`);
    if (fs.existsSync(currentLogPath)) {
      return fs.readFileSync(currentLogPath, 'utf8');
    }
    return '';
  }

  updateStatus(step, status) {
    const statusFile = path.join(this.metadataDir, `${step}_status.json`);
    const statusData = {
      step,
      status,
      timestamp: new Date().toISOString(),
      logId: this.getCurrentLogId(step)
    };
    fs.writeFileSync(statusFile, JSON.stringify(statusData, null, 2));
  }

  getCurrentLogId(step) {
    const currentLogPath = path.join(this.currentDir, `${step}.log`);
    if (fs.existsSync(currentLogPath)) {
      const realPath = fs.readlinkSync(currentLogPath);
      return path.basename(realPath, '.log');
    }
    return null;
  }
}

const logManager = new ClusterLogManager();

// 检查 Step 1 状态的函数 - 基于 CloudFormation
async function checkStep1Status() {
  try {
    // 使用多集群管理器获取活跃集群配置
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeCluster = clusterManager.getActiveCluster();
    
    if (!activeCluster) {
      return { status: 'unknown', error: 'No active cluster found' };
    }

    // 从活跃集群的配置目录读取
    const configDir = clusterManager.getClusterConfigDir(activeCluster);
    const initEnvsPath = path.join(configDir, 'init_envs');
    
    if (!fs.existsSync(initEnvsPath)) {
      return { status: 'unknown', error: `init_envs not found for cluster: ${activeCluster}` };
    }
    
    const envContent = fs.readFileSync(initEnvsPath, 'utf8');
    
    // 首先解析 CLUSTER_TAG
    const clusterTagMatch = envContent.match(/export CLUSTER_TAG=(.+)/);
    if (!clusterTagMatch) {
      return { status: 'unknown', error: 'CLUSTER_TAG not found in init_envs' };
    }
    
    const clusterTag = clusterTagMatch[1].trim();
    const stackName = `full-stack-${clusterTag}`;
    
    // 检查状态缓存文件
    const statusCacheFile = path.join(logManager.metadataDir, 'step1_status_cache.json');
    let cachedStatus = null;
    
    if (fs.existsSync(statusCacheFile)) {
      try {
        cachedStatus = JSON.parse(fs.readFileSync(statusCacheFile, 'utf8'));
        // 如果堆栈名称没有变化且状态是完成，直接返回缓存
        if (cachedStatus.stackName === stackName && cachedStatus.status === 'completed') {
          console.log(`Using cached status for stack: ${stackName}`);
          return cachedStatus;
        }
      } catch (error) {
        console.warn('Failed to read status cache:', error);
      }
    }
    
    console.log(`Checking CloudFormation status for stack: ${stackName}`);
    
    // 查询 CloudFormation 状态
    const command = `aws cloudformation describe-stacks --stack-name "${stackName}" --output json`;
    
    return new Promise((resolve) => {
      exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
        let result;
        
        if (error) {
          console.error('CloudFormation query error:', error.message);
          if (stderr.includes('does not exist')) {
            result = { status: 'not_started', stackName };
          } else {
            result = { status: 'error', error: error.message, stackName };
          }
        } else {
          try {
            const cfResult = JSON.parse(stdout);
            if (cfResult.Stacks && cfResult.Stacks.length > 0) {
              const stack = cfResult.Stacks[0];
              const cfStatus = stack.StackStatus;
              
              console.log(`CloudFormation status: ${cfStatus}`);
              
              let status;
              if (cfStatus === 'CREATE_COMPLETE' || cfStatus === 'UPDATE_COMPLETE') {
                status = 'completed';
              } else if (cfStatus.includes('IN_PROGRESS')) {
                status = 'running';
              } else if (cfStatus.includes('FAILED')) {
                status = 'failed';
              } else {
                status = 'unknown';
              }
              
              result = {
                status,
                stackName,
                cloudFormationStatus: cfStatus,
                lastUpdated: stack.LastUpdatedTime || stack.CreationTime,
                clusterTag: clusterTag
              };
            } else {
              result = { status: 'not_found', stackName };
            }
          } catch (parseError) {
            console.error('Error parsing CloudFormation response:', parseError);
            result = { status: 'error', error: 'Failed to parse CloudFormation response', stackName };
          }
        }
        
        // 缓存状态到文件
        try {
          fs.writeFileSync(statusCacheFile, JSON.stringify(result, null, 2));
        } catch (cacheError) {
          console.warn('Failed to cache status:', cacheError);
        }
        
        resolve(result);
      });
    });

  } catch (error) {
    console.error('Error in checkStep1Status:', error);
    return { status: 'error', error: error.message };
  }
}

// 检查 Step 2 状态的函数 - 基于 Kubernetes 资源
async function checkStep2Status() {
  try {
    // 使用多集群管理器获取活跃集群配置
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeCluster = clusterManager.getActiveCluster();
    
    if (!activeCluster) {
      return { status: 'unknown', error: 'No active cluster found' };
    }

    // 从活跃集群的配置目录读取
    const configDir = clusterManager.getClusterConfigDir(activeCluster);
    const initEnvsPath = path.join(configDir, 'init_envs');
    
    if (!fs.existsSync(initEnvsPath)) {
      return { status: 'unknown', error: `init_envs not found for cluster: ${activeCluster}` };
    }
    
    const envContent = fs.readFileSync(initEnvsPath, 'utf8');
    const clusterTagMatch = envContent.match(/export CLUSTER_TAG=(.+)/);
    const clusterTag = clusterTagMatch ? clusterTagMatch[1].trim() : activeCluster;
    
    // 检查活跃集群的状态缓存文件
    const metadataDir = clusterManager.getClusterMetadataDir(activeCluster);
    const statusCacheFile = path.join(metadataDir, 'step2_status_cache.json');
    let cachedStatus = null;
    
    if (fs.existsSync(statusCacheFile)) {
      try {
        cachedStatus = JSON.parse(fs.readFileSync(statusCacheFile, 'utf8'));
        // 如果集群标签没有变化且状态是完成，直接返回缓存
        if (cachedStatus.clusterTag === clusterTag && cachedStatus.status === 'completed') {
          console.log(`Using cached Step 2 status for cluster: ${clusterTag}`);
          return cachedStatus;
        }
      } catch (error) {
        console.warn('Failed to read Step 2 status cache:', error);
      }
    }
    
    console.log(`Checking Step 2 (Kubernetes) status for cluster: ${clusterTag}`);
    
    const checks = [];
    
    // 检查 1: S3 CSI Node Pods (在 kube-system 命名空间)
    const checkS3CSINodes = new Promise((resolve) => {
      exec('kubectl get pods -n kube-system -l app=s3-csi-node -o json', { timeout: 10000 }, (error, stdout) => {
        if (error) {
          resolve({ name: 's3-mount', status: 'missing', error: error.message });
        } else {
          try {
            const result = JSON.parse(stdout);
            const pods = result.items || [];
            
            if (pods.length === 0) {
              resolve({ name: 's3-mount', status: 'missing', message: 'No s3-csi-node pods found' });
            } else {
              const runningPods = pods.filter(pod => pod.status?.phase === 'Running');
              const readyPods = pods.filter(pod => {
                const conditions = pod.status?.conditions || [];
                return conditions.some(condition => 
                  condition.type === 'Ready' && condition.status === 'True'
                );
              });
              
              resolve({
                name: 's3-mount',
                status: readyPods.length === pods.length ? 'ready' : 'not_ready'
              });
            }
          } catch (parseError) {
            resolve({ name: 's3-mount', status: 'error', error: 'Failed to parse s3-csi-node pods data' });
          }
        }
      });
    });

    // 检查 2: HyperPod Training Operator Pod
    const checkHPOperator = new Promise((resolve) => {
      exec('kubectl get pods -A -l app.kubernetes.io/name=hp-training-operator -o json', { timeout: 10000 }, (error, stdout) => {
        if (error) {
          resolve({ name: 'training-op', status: 'missing', error: error.message });
        } else {
          try {
            const result = JSON.parse(stdout);
            const pods = result.items || [];
            
            if (pods.length === 0) {
              resolve({ name: 'training-op', status: 'missing' });
            } else {
              const runningPods = pods.filter(pod => pod.status?.phase === 'Running');
              resolve({
                name: 'training-op',
                status: runningPods.length > 0 ? 'ready' : 'not_ready'
              });
            }
          } catch (parseError) {
            resolve({ name: 'training-op', status: 'error', error: 'Failed to parse pods data' });
          }
        }
      });
    });

    // 检查 3: 特定的 controller manager pod
    const checkControllerManager = new Promise((resolve) => {
      exec('kubectl get pods -A -o name | grep -E "hp-training-controller-manager|training-operator"', { timeout: 10000 }, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve({ name: 'controller-manager', status: 'missing' });
        } else {
          const pods = stdout.trim().split('\n').filter(line => line.trim());
          resolve({ 
            name: 'controller-manager', 
            status: pods.length > 0 ? 'ready' : 'missing',
            pods: pods
          });
        }
      });
    });

    // 等待所有检查完成
    const results = await Promise.all([checkS3CSINodes, checkHPOperator, checkControllerManager]);
    
    // 判断整体状态
    const readyCount = results.filter(result => result.status === 'ready').length;
    const missingCount = results.filter(result => result.status === 'missing').length;
    const errorCount = results.filter(result => result.status === 'error').length;

    let overallStatus;
    if (readyCount === results.length) {
      overallStatus = 'completed';
    } else if (errorCount > 0) {
      overallStatus = 'error';
    } else if (missingCount === results.length) {
      overallStatus = 'not_started';
    } else {
      overallStatus = 'partial'; // 部分组件就绪
    }

    const result = {
      status: overallStatus,
      checks: results,
      summary: {
        total: results.length,
        ready: readyCount,
        missing: missingCount,
        error: errorCount
      },
      clusterTag: clusterTag,
      lastChecked: new Date().toISOString()
    };
    
    // 缓存状态到文件
    try {
      fs.writeFileSync(statusCacheFile, JSON.stringify(result, null, 2));
    } catch (cacheError) {
      console.warn('Failed to cache Step 2 status:', cacheError);
    }
    
    return result;

  } catch (error) {
    console.error('Error in checkStep2Status:', error);
    return { status: 'error', error: error.message };
  }
}

// 执行集群配置脚本 (Step 2) - 使用 nohup 后台执行

// 获取 MLFlow 服务器信息 API - 支持多集群
app.get('/api/cluster/mlflow-info', (req, res) => {
  try {
    // 使用多集群管理器获取活跃集群的MLflow信息
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeCluster = clusterManager.getActiveCluster();
    
    if (!activeCluster) {
      return res.json({
        success: false,
        error: 'No active cluster found'
      });
    }

    // 从活跃集群的配置目录读取MLflow信息
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

// 清除状态缓存 API

// 获取 Step 1 状态 API

// 获取日志内容 API
// 旧的日志API - 已被多集群API替代
/*
app.get('/api/cluster/logs/:step', (req, res) => {
  try {
    const { step } = req.params;
    const { offset = 0 } = req.query;
    
    const logContent = logManager.getCurrentLogContent(step);
    const statusFile = path.join(logManager.metadataDir, `${step}_status.json`);
    
    let status = { status: 'idle' };
    if (fs.existsSync(statusFile)) {
      status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    }

    // 支持增量读取（从指定偏移量开始）
    const newContent = logContent.slice(parseInt(offset));
    
    res.json({
      success: true,
      data: {
        content: newContent,
        fullContent: logContent,
        totalLength: logContent.length,
        status: status.status,
        timestamp: status.timestamp,
        logId: status.logId
      }
    });

  } catch (error) {
    console.error('Error reading logs:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
});
*/

// 获取历史日志列表
app.get('/api/cluster/logs-history', (req, res) => {
  try {
    const logFiles = fs.readdirSync(logManager.logsDir)
      .filter(file => file.endsWith('.log'))
      .map(file => {
        const filePath = path.join(logManager.logsDir, file);
        const stats = fs.statSync(filePath);
        const [timestamp, step] = file.replace('.log', '').split('_');
        
        return {
          filename: file,
          step: step,
          timestamp: timestamp.replace(/_/g, 'T').replace(/-/g, ':'),
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({
      success: true,
      data: logFiles
    });

  } catch (error) {
    console.error('Error getting log history:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
});

// 获取 CloudFormation 堆栈状态 - 从 init_envs 自动读取堆栈名称
// ==================== 多集群管理 API ====================
// 引入多集群管理模块
const MultiClusterAPIs = require('./multi-cluster-apis');
const MultiClusterStatus = require('./multi-cluster-status');

const multiClusterAPIs = new MultiClusterAPIs();
const multiClusterStatus = new MultiClusterStatus();

// 多集群管理API
app.get('/api/multi-cluster/list', (req, res) => multiClusterAPIs.handleGetClusters(req, res));
app.post('/api/multi-cluster/switch', (req, res) => multiClusterAPIs.handleSwitchCluster(req, res));
app.post('/api/multi-cluster/switch-kubectl', (req, res) => multiClusterAPIs.handleSwitchKubectlConfig(req, res));

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

console.log('Multi-cluster management APIs loaded');

app.listen(PORT, () => {
  console.log('🚀 ========================================');
  console.log('🚀 HyperPod InstantStart Server Started');
  console.log('🚀 ========================================');
  console.log(`📡 HTTP Server: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket Server: ws://localhost:${WS_PORT}`);
  console.log(`🌐 Multi-cluster management: enabled`);
  console.log(`⏰ Server started at: ${new Date().toISOString()}`);
  console.log(`🖥️  Node.js version: ${process.version}`);
  console.log(`💾 Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('🚀 ========================================');
  console.log('✅ Server is ready to accept connections');
});
