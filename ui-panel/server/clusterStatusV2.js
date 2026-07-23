const { exec } = require('child_process');

/**
 * 集群状态服务 V2 - 优化版本
 * 主要改进：
 * 1. 批量查询：只调用 2 次 kubectl（nodes + pods），而非每节点多次
 * 2. 内存计算：在内存中计算每个节点的 GPU 使用情况
 * 3. 添加超时机制
 * 4. 实现缓存策略
 * 5. 更好的错误处理
 */

class ClusterStatusV2 {
  constructor() {
    this.cache = {
      data: null,
      timestamp: 0,
      ttl: 30000 // 30秒缓存
    };
    this.defaultTimeout = 30000; // 30秒默认超时
  }

  /**
   * 带超时的kubectl执行函数
   */
  executeKubectlWithTimeout(command, timeout = this.defaultTimeout) {
    return new Promise((resolve, reject) => {
      const child = exec(`kubectl ${command}`, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          console.error(`kubectl error: ${error.message}`);
          reject({ error: error.message, stderr, command });
        } else {
          resolve(stdout.trim());
        }
      });

      // 设置超时
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command timeout after ${timeout}ms: kubectl ${command}`));
      }, timeout);

      child.on('exit', () => {
        clearTimeout(timer);
      });
    });
  }

  /**
   * 精简 Pod 数据，只保留计算 GPU 使用所需的字段
   * 可将数据量从 ~1MB 减少到 ~12KB
   */
  minimizePodData(pods) {
    return pods.map(pod => ({
      nodeName: pod.spec?.nodeName,
      phase: pod.status?.phase,
      nodeSelector: pod.spec?.nodeSelector,
      gpuRequest: this.getPodGPURequestFromSpec(pod.spec)
    }));
  }

  /**
   * 从 pod.spec 计算 GPU 请求数
   */
  getPodGPURequestFromSpec(spec) {
    if (!spec?.containers) return 0;
    return spec.containers.reduce((sum, container) => {
      const gpuRequest = container.resources?.requests?.['nvidia.com/gpu'];
      return sum + (parseInt(gpuRequest) || 0);
    }, 0);
  }

  /**
   * 计算 Pod 的 GPU 请求数（兼容精简后的数据）
   */
  getPodGPURequest(pod) {
    // 支持精简后的数据格式
    if (pod.gpuRequest !== undefined) return pod.gpuRequest;
    return this.getPodGPURequestFromSpec(pod.spec);
  }

  /**
   * 批量获取所有节点的 GPU 信息（优化版本）
   * 只需要传入已获取的 nodes 和 pods 数据，在内存中计算
   */
  getAllNodesGPUInfoBatch(nodes, allPods, hyperPodCapacityTypeMap = {}) {
    console.log(`Processing GPU info for ${nodes.length} nodes (batch mode)...`);
    
    // 按节点名分组 Pod（使用精简后的 pod.nodeName）
    const podsByNode = {};
    const pendingPods = [];
    
    for (const pod of allPods) {
      const nodeName = pod.nodeName;
      if (nodeName) {
        if (!podsByNode[nodeName]) podsByNode[nodeName] = [];
        podsByNode[nodeName].push(pod);
      } else if (pod.phase === 'Pending') {
        pendingPods.push(pod);
      }
    }

    // 处理每个节点
    return nodes.map(node => {
      const nodeName = node.metadata.name;
      const labels = node.metadata?.labels || {};
      const nodeReady = node.status?.conditions?.find(c => c.type === 'Ready')?.status === 'True';
      
      const instanceType = labels['node.kubernetes.io/instance-type'] || 
                          labels['beta.kubernetes.io/instance-type'] || 'Unknown';
      
      // HyperPod capacity type
      let capacityType = null;
      if (labels['sagemaker.amazonaws.com/compute-type'] === 'hyperpod') {
        const igName = labels['sagemaker.amazonaws.com/instance-group-name'];
        if (igName && hyperPodCapacityTypeMap[igName]) {
          capacityType = hyperPodCapacityTypeMap[igName];
        }
      }

      // GPU 容量（从 node 对象直接获取）
      const totalGPU = parseInt(node.status?.capacity?.['nvidia.com/gpu']) || 0;
      const allocatableGPU = parseInt(node.status?.allocatable?.['nvidia.com/gpu']) || 0;

      // 计算已使用 GPU（排除 Succeeded/Failed，使用精简后的 pod.phase）
      const nodePods = podsByNode[nodeName] || [];
      const usedGPU = nodePods
        .filter(pod => !['Succeeded', 'Failed'].includes(pod.phase))
        .reduce((sum, pod) => sum + this.getPodGPURequest(pod), 0);

      // 计算 Pending GPU（使用精简后的 pod.nodeSelector）
      const pendingGPU = pendingPods
        .filter(pod => {
          const selector = pod.nodeSelector;
          if (!selector) return true;
          return Object.entries(selector).every(([k, v]) => labels[k] === v);
        })
        .reduce((sum, pod) => sum + this.getPodGPURequest(pod), 0);

      return {
        nodeName,
        instanceType,
        labels,
        capacityType,
        totalGPU,
        usedGPU,
        availableGPU: Math.max(0, allocatableGPU - usedGPU),
        allocatableGPU,
        pendingGPU,
        nodeReady,
        fetchTime: Date.now()
      };
    });
  }

  /**
   * 检查缓存是否有效
   */
  isCacheValid() {
    const now = Date.now();
    return this.cache.data && (now - this.cache.timestamp) < this.cache.ttl;
  }

  /**
   * 更新缓存
   */
  updateCache(data) {
    this.cache = {
      data: { ...data, cached: false },
      timestamp: Date.now(),
      ttl: 30000
    };
  }

  /**
   * 获取缓存数据
   */
  getCachedData() {
    return { ...this.cache.data, cached: true };
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.cache = {
      data: null,
      timestamp: 0,
      ttl: 30000
    };
    console.log('Cluster status cache cleared');
  }

  /**
   * 获取 HyperPod 实例组的 Capacity Type 映射
   */
  async getHyperPodCapacityTypeMap() {
    try {
      const ClusterManager = require('./clusterManager');
      const AWSHelpers = require('./utils/awsHelpers');
      const fs = require('fs');
      const path = require('path');
      
      const clusterManager = new ClusterManager();
      const activeClusterName = clusterManager.getActiveCluster();
      
      if (!activeClusterName) {
        return {};
      }

      // 从 metadata 获取 HyperPod 集群信息
      const metadataDir = clusterManager.getClusterMetadataDir(activeClusterName);
      const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
      
      if (!fs.existsSync(clusterInfoPath)) {
        return {};
      }

      const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
      
      if (!clusterInfo.hyperPodCluster) {
        return {};
      }

      const hpClusterName = clusterInfo.hyperPodCluster.ClusterName;
      // 运维路径:优先使用该(活跃)集群自身的 region,主机 region 仅作兜底
      const { getEffectiveRegion } = require('./utils/regionResolver');
      const region = clusterInfo.region || getEffectiveRegion(activeClusterName);
      
      // 获取最新的 HyperPod 集群状态
      const hpData = await AWSHelpers.describeHyperPodCluster(hpClusterName, region);
      
      // 构建 instance group name -> capacity type 的映射
      const capacityTypeMap = {};
      for (const ig of hpData.InstanceGroups || []) {
        const capacityType = ig.CapacityRequirements?.Spot ? 'spot' : 'on-demand';
        capacityTypeMap[ig.InstanceGroupName] = capacityType;
      }
      
      console.log('HyperPod capacity type map:', capacityTypeMap);
      return capacityTypeMap;
    } catch (error) {
      console.warn('Failed to get HyperPod capacity type map:', error.message);
      return {};
    }
  }

  /**
   * 主要的集群状态获取方法（优化版：只调用 2 次 kubectl）
   */
  async getClusterStatus(forceRefresh = false) {
    const startTime = Date.now();
    
    // 检查缓存（除非强制刷新）
    if (!forceRefresh && this.isCacheValid()) {
      console.log('Returning cached cluster status');
      return this.getCachedData();
    }

    try {
      console.log('Fetching fresh cluster status (batch mode)...');
      
      // 并行获取所有节点和所有 Pod（只调用 2 次 kubectl）
      const [nodesOutput, podsOutput] = await Promise.all([
        this.executeKubectlWithTimeout('get nodes -o json', 15000),
        this.executeKubectlWithTimeout('get pods -A -o json', 15000)
      ]);
      
      const nodesData = JSON.parse(nodesOutput);
      const podsData = JSON.parse(podsOutput);
      
      // 立即精简 Pod 数据，释放内存（~1MB → ~12KB）
      const minimizedPods = this.minimizePodData(podsData.items || []);
      
      if (!nodesData.items || nodesData.items.length === 0) {
        console.log('No nodes found in cluster, returning empty result');
        return { nodes: [], fetchTime: Date.now() - startTime, timestamp: Date.now(), nodeCount: 0, version: 'v2-batch' };
      }

      // 获取 HyperPod capacity type 映射
      const hyperPodCapacityTypeMap = await this.getHyperPodCapacityTypeMap();

      // 在内存中计算所有节点的 GPU 信息（无额外 kubectl 调用）
      const gpuUsage = this.getAllNodesGPUInfoBatch(
        nodesData.items, 
        minimizedPods, 
        hyperPodCapacityTypeMap
      );
      
      const fetchTime = Date.now() - startTime;
      const result = {
        nodes: gpuUsage,
        fetchTime,
        timestamp: Date.now(),
        nodeCount: gpuUsage.length,
        version: 'v2-batch'
      };
      
      // 更新缓存
      this.updateCache(result);
      
      console.log(`Cluster status V2 (batch) fetched in ${fetchTime}ms: ${gpuUsage.length} nodes`);
      return result;
      
    } catch (error) {
      console.error('Cluster status V2 error:', error);
      throw {
        error: error.message || 'Failed to fetch cluster status',
        timestamp: Date.now(),
        fetchTime: Date.now() - startTime,
        version: 'v2-batch'
      };
    }
  }

  /**
   * 获取集群统计信息（使用已有数据，无额外 kubectl 调用）
   * 注意：allPods 应该是精简后的数据格式
   */
  getClusterStats(nodes, allPods = []) {
    // 计算节点相关的统计
    const nodeStats = nodes.reduce((stats, node) => ({
      totalNodes: stats.totalNodes + 1,
      readyNodes: stats.readyNodes + (node.nodeReady ? 1 : 0),
      totalGPUs: stats.totalGPUs + node.totalGPU,
      usedGPUs: stats.usedGPUs + node.usedGPU,
      availableGPUs: stats.availableGPUs + node.availableGPU,
      allocatableGPUs: stats.allocatableGPUs + node.allocatableGPU,
      errorNodes: stats.errorNodes + (node.error ? 1 : 0)
    }), {
      totalNodes: 0,
      readyNodes: 0,
      totalGPUs: 0,
      usedGPUs: 0,
      availableGPUs: 0,
      allocatableGPUs: 0,
      errorNodes: 0
    });

    // 计算全局 Pending GPU（使用精简后的 pod.phase）
    const pendingGPUs = allPods
      .filter(pod => pod.phase === 'Pending')
      .reduce((sum, pod) => sum + this.getPodGPURequest(pod), 0);

    return {
      ...nodeStats,
      pendingGPUs
    };
  }
}

// 创建单例实例
const clusterStatusV2 = new ClusterStatusV2();

// Express路由处理函数
const handleClusterStatusV2 = async (req, res) => {
  try {
    const forceRefresh = req.query.force === 'true';
    const result = await clusterStatusV2.getClusterStatus(forceRefresh);
    res.json(result);
  } catch (error) {
    console.error('Cluster status API error:', error);
    res.status(500).json(error);
  }
};

// 清除缓存的路由处理函数
const handleClearCache = (req, res) => {
  clusterStatusV2.clearCache();
  res.json({ 
    success: true, 
    message: 'Cluster status cache cleared',
    timestamp: Date.now()
  });
};

// 获取缓存状态的路由处理函数
const handleCacheStatus = (req, res) => {
  const isValid = clusterStatusV2.isCacheValid();
  res.json({
    cached: isValid,
    timestamp: clusterStatusV2.cache.timestamp,
    ttl: clusterStatusV2.cache.ttl,
    age: Date.now() - clusterStatusV2.cache.timestamp
  });
};

module.exports = {
  ClusterStatusV2,
  clusterStatusV2,
  handleClusterStatusV2,
  handleClearCache,
  handleCacheStatus
};
