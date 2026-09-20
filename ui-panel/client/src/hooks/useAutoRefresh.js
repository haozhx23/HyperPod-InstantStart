import { useEffect, useRef, useCallback } from 'react';

// 周期性自动刷新配置。
//
// 这里的值只是服务端配置到达之前（或读取失败时）的兜底默认值。真源是
// config/refresh-config.json，由 loadRefreshConfig() 在应用启动时拉取。
// 生产部署中该目录是挂载进容器的（start-prod.sh 的 -v $(pwd)/config:/app/config），
// 所以改间隔只需要改文件 + 刷新浏览器，不需要重新构建前端。
const REFRESH_CONFIG = {
  INTERVAL: 60000,
  ENABLED: true
};

// 全局刷新管理器
class RefreshManager {
  constructor() {
    this.subscribers = new Map();
    this.interval = null;
    this.isRunning = false;
  }

  // 回调总数（一个 id 下可能挂多个）
  callbackCount() {
    let total = 0;
    this.subscribers.forEach(group => { total += group.size; });
    return total;
  }

  /**
   * 订阅周期性刷新
   *
   * id 是分组名而非唯一键：同一 id 下可挂多个回调，同组件的两个实例不会互相覆盖。
   * 退订优先用返回值，它只摘掉本次注册的这一个。
   *
   * @returns {Function} 只退订本次注册的回调
   */
  subscribe(id, callback) {
    if (typeof callback !== 'function') {
      console.error(`RefreshManager: subscribe('${id}') 需要一个回调函数`);
      return () => {};
    }

    let group = this.subscribers.get(id);
    if (!group) {
      group = new Set();
      this.subscribers.set(id, group);
    }
    group.add(callback);

    // 第一个回调出现时启动定时器
    if (this.callbackCount() === 1 && REFRESH_CONFIG.ENABLED) {
      this.start();
    }

    console.log(`RefreshManager: Subscribed ${id}, total callbacks: ${this.callbackCount()}`);

    return () => this.unsubscribe(id, callback);
  }

  /**
   * 取消订阅
   * @param {string} id - 分组标识
   * @param {Function} [callback] - 只退订这个回调；省略则清掉该 id 下全部回调
   */
  unsubscribe(id, callback) {
    const group = this.subscribers.get(id);
    if (!group) return;

    if (callback) {
      group.delete(callback);
    } else {
      group.clear();
    }

    if (group.size === 0) {
      this.subscribers.delete(id);
    }

    // 没有任何回调了就停表
    if (this.callbackCount() === 0) {
      this.stop();
    }

    console.log(`RefreshManager: Unsubscribed ${id}, total callbacks: ${this.callbackCount()}`);
  }

  // 启动定时器
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.interval = setInterval(() => {
      console.log(`RefreshManager: Auto-refreshing ${this.callbackCount()} callbacks`);
      this.notifyAll();
    }, REFRESH_CONFIG.INTERVAL);
    
    console.log(`RefreshManager: Started with interval ${REFRESH_CONFIG.INTERVAL}ms`);
  }

  // 停止定时器
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    console.log('RefreshManager: Stopped');
  }

  // 通知所有订阅者，逐个隔离错误
  notifyAll() {
    this.subscribers.forEach((group, id) => {
      for (const callback of Array.from(group)) {
        try {
          callback();
        } catch (error) {
          console.error(`RefreshManager: Error calling callback for ${id}:`, error);
        }
      }
    });
  }

  // 手动触发刷新
  triggerRefresh() {
    console.log(`RefreshManager: Manual refresh triggered for ${this.callbackCount()} callbacks`);
    this.notifyAll();
  }

  // 获取配置
  getConfig() {
    return { ...REFRESH_CONFIG };
  }

  // 更新配置
  updateConfig(newConfig) {
    const oldInterval = REFRESH_CONFIG.INTERVAL;
    const oldEnabled = REFRESH_CONFIG.ENABLED;
    Object.assign(REFRESH_CONFIG, newConfig);

    if (oldEnabled !== REFRESH_CONFIG.ENABLED) {
      // 被关掉就立即停表；被打开则只在已有订阅者时启动
      // （还没有订阅者时交给 subscribe() 触发，避免空转）
      if (!REFRESH_CONFIG.ENABLED) {
        this.stop();
      } else if (this.callbackCount() > 0) {
        this.start();
      }
    } else if (oldInterval !== REFRESH_CONFIG.INTERVAL && this.isRunning) {
      // 间隔改变：重启定时器让新间隔生效
      this.stop();
      this.start();
    }

    console.log('RefreshManager: Config updated', REFRESH_CONFIG);
  }
}

// 全局实例
const refreshManager = new RefreshManager();

// 从服务端拉取刷新配置并应用。幂等：重复调用只会真正生效一次。
// 由 App.js 的 AppBootstrap 在启动时调用一次。
// 定时器可能在配置到达之前就已由 subscribe() 启动，updateConfig() 会在间隔变化时重启它。
export async function loadRefreshConfig() {
  if (loadRefreshConfig._done) return REFRESH_CONFIG;
  // 缓存在飞的请求：App.js 和 GlobalRefreshButton 会各调一次，避免发两个 GET
  if (loadRefreshConfig._inflight) return loadRefreshConfig._inflight;

  loadRefreshConfig._inflight = (async () => {
    try {
      const response = await fetch('/api/config/refresh');
      const data = await response.json();

      if (data && data.success && data.config) {
        loadRefreshConfig._done = true;
        refreshManager.updateConfig({
          INTERVAL: data.config.autoRefreshIntervalMs,
          ENABLED: data.config.autoRefreshEnabled
        });
      } else {
        console.warn('[RefreshManager] /api/config/refresh returned no config, keeping defaults');
      }
    } catch (error) {
      // fail soft：拿不到配置继续用默认 60s，但不静默——让它在 console 里可见
      console.warn(
        `[RefreshManager] Failed to load /api/config/refresh (${error.message}), keeping defaults:`,
        REFRESH_CONFIG
      );
    } finally {
      loadRefreshConfig._inflight = null;
    }

    return REFRESH_CONFIG;
  })();

  return loadRefreshConfig._inflight;
}

// 自定义Hook
export const useAutoRefresh = (id, refreshCallback, options = {}) => {
  const { 
    enabled = true, 
    immediate = true 
  } = options;
  
  const callbackRef = useRef(refreshCallback);
  const enabledRef = useRef(enabled);
  
  // 更新回调引用
  useEffect(() => {
    callbackRef.current = refreshCallback;
  }, [refreshCallback]);
  
  // 更新启用状态
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  
  // 包装的回调函数，检查是否启用
  const wrappedCallback = useCallback(() => {
    if (enabledRef.current && callbackRef.current) {
      callbackRef.current();
    }
  }, []);
  
  // 手动刷新函数
  const manualRefresh = useCallback(() => {
    if (callbackRef.current) {
      callbackRef.current();
    }
  }, []);
  
  useEffect(() => {
    if (!enabled) return;
    
    // 订阅自动刷新（用返回的退订函数，只摘掉自己这一个回调）
    const unsubscribe = refreshManager.subscribe(id, wrappedCallback);

    // 立即执行一次（如果需要）
    if (immediate && refreshCallback) {
      refreshCallback();
    }

    return unsubscribe;
  }, [id, enabled, immediate, wrappedCallback]);
  
  return {
    manualRefresh,
    refreshManager,
    config: refreshManager.getConfig()
  };
};

// 导出刷新管理器实例，供其他组件使用
export { refreshManager };
export default useAutoRefresh;
