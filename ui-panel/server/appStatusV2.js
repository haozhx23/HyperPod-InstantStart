const { exec } = require('child_process');

/**
 * 应用状态服务 V2 - 优化版本
 * 主要改进：
 * 1. 统一的 Pods/Services 查询
 * 2. 智能缓存策略
 * 3. 并发控制和去重
 * 4. 数据预处理和状态计算
 * 5. 更好的错误处理和超时控制
 */

class AppStatusV2 {
  constructor() {
    this.cache = {
      pods: { data: null, timestamp: 0, ttl: 15000 }, // 15秒缓存
      services: { data: null, timestamp: 0, ttl: 30000 }, // 30秒缓存
      combined: { data: null, timestamp: 0, ttl: 15000 } // 组合数据缓存
    };
    this.defaultTimeout = 20000; // 20秒默认超时
    this.activeQueries = new Map(); // 防止重复查询
  }

  /**
   * 带超时和去重的kubectl执行函数
   */
  executeKubectlWithDedup(command, timeout = this.defaultTimeout) {
    // 如果相同命令正在执行，返回现有的Promise
    if (this.activeQueries.has(command)) {
      console.log(`Reusing active query: kubectl ${command}`);
      return this.activeQueries.get(command);
    }

    const queryPromise = new Promise((resolve, reject) => {
      const child = exec(`kubectl ${command}`, (error, stdout, stderr) => {
        this.activeQueries.delete(command); // 清理活跃查询
        
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
        this.activeQueries.delete(command);
        reject(new Error(`Command timeout after ${timeout}ms: kubectl ${command}`));
      }, timeout);

      child.on('exit', () => {
        clearTimeout(timer);
      });
    });

    this.activeQueries.set(command, queryPromise);
    return queryPromise;
  }

  /**
   * 检查缓存是否有效
   */
  isCacheValid(cacheKey) {
    const cache = this.cache[cacheKey];
    const now = Date.now();
    return cache.data && (now - cache.timestamp) < cache.ttl;
  }

  /**
   * 更新缓存
   */
  updateCache(cacheKey, data) {
    this.cache[cacheKey] = {
      data: { ...data, cached: false },
      timestamp: Date.now(),
      ttl: this.cache[cacheKey].ttl
    };
  }

  /**
   * 获取缓存数据
   */
  getCachedData(cacheKey) {
    return { ...this.cache[cacheKey].data, cached: true };
  }

  /**
   * 获取 Pods 状态（带缓存）
   */
  async getPods(forceRefresh = false) {
    if (!forceRefresh && this.isCacheValid('pods')) {
      console.log('Returning cached pods data');
      return this.getCachedData('pods');
    }

    try {
      console.log('Fetching fresh pods data...');
      const startTime = Date.now();
      
      const output = await this.executeKubectlWithDedup('get pods -o json', 15000);
      const podsData = JSON.parse(output);
      
      // 预处理 Pod 数据
      const processedPods = this.processPods(podsData.items || []);
      
      const result = {
        pods: processedPods,
        rawPods: podsData.items || [],
        fetchTime: Date.now() - startTime,
        timestamp: Date.now(),
        count: processedPods.length,
        version: 'v2'
      };

      this.updateCache('pods', result);
      console.log(`Pods data fetched in ${result.fetchTime}ms: ${result.count} pods`);
      
      return result;
    } catch (error) {
      console.error('Pods fetch error:', error);
      throw {
        error: error.message || 'Failed to fetch pods',
        timestamp: Date.now(),
        version: 'v2'
      };
    }
  }

  /**
   * 获取 Services 状态（带缓存）
   */
  async getServices(forceRefresh = false) {
    if (!forceRefresh && this.isCacheValid('services')) {
      console.log('Returning cached services data');
      return this.getCachedData('services');
    }

    try {
      console.log('Fetching fresh services data...');
      const startTime = Date.now();
      
      const output = await this.executeKubectlWithDedup('get services -o json', 15000);
      const servicesData = JSON.parse(output);
      
      // 预处理 Service 数据
      const processedServices = this.processServices(servicesData.items || []);
      
      const result = {
        services: processedServices,
        rawServices: servicesData.items || [],
        fetchTime: Date.now() - startTime,
        timestamp: Date.now(),
        count: processedServices.length,
        version: 'v2'
      };

      this.updateCache('services', result);
      console.log(`Services data fetched in ${result.fetchTime}ms: ${result.count} services`);
      
      return result;
    } catch (error) {
      console.error('Services fetch error:', error);
      throw {
        error: error.message || 'Failed to fetch services',
        timestamp: Date.now(),
        version: 'v2'
      };
    }
  }

  /**
   * 获取组合的应用状态（Pods + Services）
   */
  async getAppStatus(forceRefresh = false) {
    if (!forceRefresh && this.isCacheValid('combined')) {
      console.log('Returning cached combined app status');
      return this.getCachedData('combined');
    }

    try {
      console.log('Fetching fresh combined app status...');
      const startTime = Date.now();
      
      // 并行获取 Pods 和 Services
      const [podsResult, servicesResult] = await Promise.allSettled([
        this.getPods(forceRefresh),
        this.getServices(forceRefresh)
      ]);

      const pods = podsResult.status === 'fulfilled' ? podsResult.value : { pods: [], error: podsResult.reason };
      const services = servicesResult.status === 'fulfilled' ? servicesResult.value : { services: [], error: servicesResult.reason };

      // 计算应用状态统计
      const stats = this.calculateAppStats(pods.pods || [], services.services || []);
      
      const result = {
        pods: pods.pods || [],
        services: services.services || [],
        rawPods: pods.rawPods || [],
        rawServices: services.rawServices || [],
        stats,
        fetchTime: Date.now() - startTime,
        timestamp: Date.now(),
        version: 'v2',
        errors: {
          pods: pods.error || null,
          services: services.error || null
        }
      };

      this.updateCache('combined', result);
      console.log(`Combined app status fetched in ${result.fetchTime}ms`);
      
      return result;
    } catch (error) {
      console.error('Combined app status error:', error);
      throw {
        error: error.message || 'Failed to fetch app status',
        timestamp: Date.now(),
        version: 'v2'
      };
    }
  }

  /**
   * 预处理 Pod 数据，添加状态计算
   */
  processPods(pods) {
    return pods.map(pod => {
      const status = this.calculatePodStatus(pod);
      const resources = this.extractPodResources(pod);
      
      return {
        ...pod,
        processedStatus: status,
        resources,
        age: this.calculateAge(pod.metadata?.creationTimestamp),
        ready: status.ready,
        restarts: this.calculateRestarts(pod)
      };
    });
  }

  /**
   * 预处理 Service 数据
   */
  processServices(services) {
    return services.map(service => ({
      ...service,
      endpoints: this.extractServiceEndpoints(service),
      age: this.calculateAge(service.metadata?.creationTimestamp),
      type: service.spec?.type || 'ClusterIP'
    }));
  }

  /**
   * 计算 Pod 状态
   */
  calculatePodStatus(pod) {
    const phase = pod.status?.phase;
    const conditions = pod.status?.conditions || [];
    const containerStatuses = pod.status?.containerStatuses || [];
    
    const readyCondition = conditions.find(c => c.type === 'Ready');
    const ready = readyCondition?.status === 'True';
    
    let status = phase?.toLowerCase() || 'unknown';
    let reason = null;
    
    if (phase === 'Running' && !ready) {
      status = 'not-ready';
      reason = readyCondition?.reason || 'ContainerNotReady';
    }
    
    // 检查容器状态
    const failedContainer = containerStatuses.find(cs => 
      cs.state?.waiting?.reason || cs.state?.terminated?.reason
    );
    
    if (failedContainer) {
      reason = failedContainer.state?.waiting?.reason || 
               failedContainer.state?.terminated?.reason;
    }

    return {
      phase,
      status,
      ready,
      reason,
      conditions: conditions.length,
      containers: containerStatuses.length
    };
  }

  /**
   * 提取 Pod 资源信息
   */
  extractPodResources(pod) {
    const containers = pod.spec?.containers || [];
    let totalCpu = 0;
    let totalMemory = 0;
    let totalGpu = 0;

    containers.forEach(container => {
      const requests = container.resources?.requests || {};
      const limits = container.resources?.limits || {};
      
      // 简单的资源计算（实际应用中可能需要更复杂的解析）
      if (requests['nvidia.com/gpu']) {
        totalGpu += parseInt(requests['nvidia.com/gpu']) || 0;
      }
    });

    return { totalCpu, totalMemory, totalGpu };
  }

  /**
   * 提取 Service 端点信息
   */
  extractServiceEndpoints(service) {
    const ports = service.spec?.ports || [];
    const clusterIP = service.spec?.clusterIP;
    const type = service.spec?.type;
    
    return {
      clusterIP,
      type,
      ports: ports.map(port => ({
        name: port.name,
        port: port.port,
        targetPort: port.targetPort,
        protocol: port.protocol || 'TCP'
      }))
    };
  }

  /**
   * 计算重启次数
   */
  calculateRestarts(pod) {
    const containerStatuses = pod.status?.containerStatuses || [];
    return containerStatuses.reduce((total, cs) => total + (cs.restartCount || 0), 0);
  }

  /**
   * 计算年龄
   */
  calculateAge(creationTimestamp) {
    if (!creationTimestamp) return 'Unknown';
    
    const created = new Date(creationTimestamp);
    const now = new Date();
    const diffMs = now - created;
    
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    
    if (days > 0) return `${days}d${hours}h`;
    if (hours > 0) return `${hours}h${minutes}m`;
    return `${minutes}m`;
  }

  /**
   * 计算应用状态统计
   */
  calculateAppStats(pods, services) {
    const podStats = pods.reduce((stats, pod) => {
      const status = pod.processedStatus?.status || 'unknown';
      stats.total++;
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
      
      if (pod.processedStatus?.ready) stats.ready++;
      if (pod.resources?.totalGpu > 0) stats.withGpu++;
      
      return stats;
    }, {
      total: 0,
      ready: 0,
      withGpu: 0,
      byStatus: {}
    });

    const serviceStats = services.reduce((stats, service) => {
      stats.total++;
      const type = service.type || 'ClusterIP';
      stats.byType[type] = (stats.byType[type] || 0) + 1;
      return stats;
    }, {
      total: 0,
      byType: {}
    });

    return {
      pods: podStats,
      services: serviceStats,
      overall: {
        healthScore: podStats.total > 0 ? Math.round((podStats.ready / podStats.total) * 100) : 100
      }
    };
  }

  /**
   * 清除所有缓存
   */
  clearAllCache() {
    Object.keys(this.cache).forEach(key => {
      this.cache[key] = {
        data: null,
        timestamp: 0,
        ttl: this.cache[key].ttl
      };
    });
    console.log('All app status cache cleared');
  }

  /**
   * 清除特定缓存
   */
  clearCache(cacheKey) {
    if (this.cache[cacheKey]) {
      this.cache[cacheKey] = {
        data: null,
        timestamp: 0,
        ttl: this.cache[cacheKey].ttl
      };
      console.log(`App status cache cleared: ${cacheKey}`);
    }
  }
}

// 创建单例实例
const appStatusV2 = new AppStatusV2();

// Express路由处理函数
const handlePodsV2 = async (req, res) => {
  try {
    const forceRefresh = req.query.force === 'true';
    const result = await appStatusV2.getPods(forceRefresh);
    res.json(result);
  } catch (error) {
    console.error('Pods V2 API error:', error);
    res.status(500).json(error);
  }
};

const handleServicesV2 = async (req, res) => {
  try {
    const forceRefresh = req.query.force === 'true';
    const result = await appStatusV2.getServices(forceRefresh);
    res.json(result);
  } catch (error) {
    console.error('Services V2 API error:', error);
    res.status(500).json(error);
  }
};

const handleAppStatusV2 = async (req, res) => {
  try {
    const forceRefresh = req.query.force === 'true';
    const result = await appStatusV2.getAppStatus(forceRefresh);
    res.json(result);
  } catch (error) {
    console.error('App Status V2 API error:', error);
    res.status(500).json(error);
  }
};

const handleClearAppCache = (req, res) => {
  const { type } = req.body;
  
  if (type && ['pods', 'services', 'combined'].includes(type)) {
    appStatusV2.clearCache(type);
  } else {
    appStatusV2.clearAllCache();
  }
  
  res.json({ 
    success: true, 
    message: `App status cache cleared${type ? `: ${type}` : ''}`,
    timestamp: Date.now()
  });
};

const handleAppCacheStatus = (req, res) => {
  const cacheStatus = {};
  
  Object.keys(appStatusV2.cache).forEach(key => {
    const cache = appStatusV2.cache[key];
    cacheStatus[key] = {
      cached: appStatusV2.isCacheValid(key),
      timestamp: cache.timestamp,
      ttl: cache.ttl,
      age: Date.now() - cache.timestamp
    };
  });
  
  res.json(cacheStatus);
};

module.exports = {
  AppStatusV2,
  appStatusV2,
  handlePodsV2,
  handleServicesV2,
  handleAppStatusV2,
  handleClearAppCache,
  handleAppCacheStatus
};
