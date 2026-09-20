/**
 * 操作后刷新的时序配置
 *
 * 唯一消费者是 hooks/useOperationRefresh.js。每个 key 是一个操作类型（由
 * utils/wsMessageHandlers.js 在收到对应 WebSocket 广播时触发），值定义：
 *
 *   immediate: [componentId]              收到广播后立刻刷新
 *   delayed:   [{ components, delay }]    delay 毫秒后再刷一次
 *
 * delayed 存在的理由是 AWS 侧最终一致：广播到达时 describe 出来的状态往往还是旧的。
 * `['all']` 表示刷新所有已注册订阅者（走 operationRefreshManager.refreshAll()）。
 *
 * ── 组件 ID 必须真实存在 ──────────────────────────────────────────────
 * ID 会先在 operationRefreshManager.refreshSubscribers 里查，查不到再回退到
 * resourceEventBus 定向派发，两边都没有就会 console.error。
 *
 * 当前有效的 ID：
 *   operationRefreshManager: app-status, pods-services, nodegroup-manager,
 *                            training-history, cluster-management-redux,
 *                            eks-cluster-creation, s3-storage-manager
 *   resourceEventBus:        app-status, cluster-status
 *
 * 2026-09-20 清理：`status-monitor` 是改名前的旧 ID（现为 `app-status`），11 处引用
 * 已改名并去重；`training-monitor`（TrainingMonitorPanelRedux 没有订阅任何机制）和
 * `deployment-manager`（无任何注册）共 7 处引用已删除。改这个表时请对照上面的清单，
 * 加不存在的 ID 不会报错在构建期，只会在运行时 console.error。
 *
 * 同时删除了 5 个无读取方的配置段（DEFAULT、COMPONENT_PRIORITIES、
 * REFRESH_STRATEGIES、CACHE、UI）。周期性自动刷新的间隔现在由
 * config/refresh-config.json 提供，见 hooks/useAutoRefresh.js。
 */

export const REFRESH_CONFIG = {
  OPERATION_REFRESH: {
    'cluster-launch': {
      immediate: ['cluster-status'],
      delayed: [
        { components: ['cluster-status'], delay: 5000 },
        { components: ['all'], delay: 30000 },
        { components: ['all'], delay: 120000 }
      ]
    },
    'cluster-configure': {
      immediate: ['cluster-status'],
      delayed: [
        { components: ['cluster-status'], delay: 5000 },
        { components: ['all'], delay: 30000 }
      ]
    },
    'model-deploy': {
      immediate: ['app-status', 'pods-services'],
      delayed: [
        { components: ['app-status', 'cluster-status'], delay: 3000 },
        { components: ['all'], delay: 10000 }
      ]
    },
    'service-deploy': {
      immediate: ['app-status', 'pods-services'],
      delayed: [
        { components: ['cluster-status'], delay: 3000 },
        { components: ['all'], delay: 8000 }
      ]
    },
    'service-delete': {
      immediate: ['app-status', 'pods-services'],
      delayed: [
        { components: ['cluster-status'], delay: 3000 },
        { components: ['all'], delay: 5000 }
      ]
    },
    'model-undeploy': {
      immediate: ['app-status', 'pods-services'],
      delayed: [
        { components: ['cluster-status'], delay: 3000 }, // 等待资源清理完成
        { components: ['all'], delay: 8000 } // 确保所有相关状态更新
      ]
    },
    'model-download': {
      immediate: ['app-status', 'pods-services'],
      delayed: [
        { components: ['cluster-status'], delay: 3000 },
        { components: ['all'], delay: 8000 } // 8秒后全局刷新，确保下载完成
      ]
    },
    'training-start': {
      immediate: ['app-status', 'pods-services'],
      delayed: [
        { components: ['cluster-status'], delay: 5000 },
        { components: ['all'], delay: 10000 } // 10秒后全局刷新，确保训练启动
      ]
    },
    'training-stop': {
      immediate: ['app-status', 'pods-services'],
      delayed: [
        { components: ['cluster-status'], delay: 3000 },
        { components: ['all'], delay: 5000 }
      ]
    },
    'rayjob-delete': {
      immediate: ['training-history', 'app-status', 'pods-services'],
      delayed: [
        { components: ['cluster-status'], delay: 5000 },
        { components: ['all'], delay: 10000 }
      ]
    },
    'pod-assign': {
      immediate: ['app-status', 'pods-services'],
      delayed: [
        { components: ['all'], delay: 5000 }
      ]
    },
    'training-delete': {
      immediate: ['training-history', 'app-status', 'pods-services'],
      delayed: [
        { components: ['cluster-status'], delay: 5000 }, // 等待K8s资源清理
        { components: ['all'], delay: 10000 } // 确保训练日志和历史记录更新
      ]
    },
    'hyperpod-create': {
      immediate: ['nodegroup-manager', 'cluster-status', 'app-status'],
      delayed: [
        { components: ['all'], delay: 5000 } // HyperPod创建状态更新
      ]
    },
    'nodegroup-create': {
      immediate: ['nodegroup-manager', 'cluster-status', 'app-status'],
      delayed: [
        { components: ['all'], delay: 5000 } // EKS节点组创建状态更新
      ]
    },
    'nodegroup-scale': {
      immediate: ['nodegroup-manager', 'cluster-status', 'pods-services'],
      delayed: [
        { components: ['app-status'], delay: 5000 }, // 等待节点状态更新
        { components: ['all'], delay: 10000 } // 确保所有相关状态更新
      ]
    },
    'hyperpod-software-update': {
      immediate: ['nodegroup-manager', 'cluster-status'],
      delayed: [
        { components: ['app-status', 'pods-services'], delay: 5000 }, // 等待集群状态更新
        { components: ['all'], delay: 15000 } // 软件更新可能需要更长时间
      ]
    },
    // 移除karpenter-install和karpenter-uninstall的复杂刷新配置
    // 按照简化架构思路：用户会通过定时/手动刷新查看kubectl的真实状态
  },

  // 开发和调试配置
  DEBUG: {
    enablePerformanceLogging: process.env.NODE_ENV === 'development',
    enableRefreshTracing: process.env.NODE_ENV === 'development',
    logRefreshHistory: true,
    maxLogHistory: 100
  }
};

// 环境特定配置覆盖
const ENVIRONMENT_OVERRIDES = {
  development: {
    DEBUG: {
      enablePerformanceLogging: true,
      enableRefreshTracing: true
    }
  },

  production: {
    DEBUG: {
      enablePerformanceLogging: false,
      enableRefreshTracing: false
    }
  }
};

// 应用环境特定覆盖
const currentEnv = process.env.NODE_ENV || 'development';
const envOverrides = ENVIRONMENT_OVERRIDES[currentEnv] || {};

// 深度合并配置
const mergeDeep = (target, source) => {
  const result = { ...target };

  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = mergeDeep(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
};

// 导出最终配置
export const FINAL_REFRESH_CONFIG = mergeDeep(REFRESH_CONFIG, envOverrides);

// 便捷访问函数
export const getRefreshConfig = (section = null) => {
  if (section) {
    return FINAL_REFRESH_CONFIG[section] || {};
  }
  return FINAL_REFRESH_CONFIG;
};

export const getOperationRefreshConfig = (operationType = null) => {
  if (operationType) {
    return FINAL_REFRESH_CONFIG.OPERATION_REFRESH[operationType] || null;
  }
  return FINAL_REFRESH_CONFIG.OPERATION_REFRESH;
};

export default FINAL_REFRESH_CONFIG;
