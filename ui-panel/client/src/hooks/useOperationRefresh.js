/**
 * 操作触发刷新管理器
 *
 * 职责：收到「某个操作已完成」的信号（多数来自 wsMessageHandlers.js 的 WebSocket
 * 广播）后，按 refreshConfig.OPERATION_REFRESH 定义的时序刷新相关面板。
 *
 * 为什么需要 delayed：AWS 侧是最终一致的。节点组创建成功的广播到达时，
 * describe 出来的状态往往还是旧的，所以配置里会再排 30s / 120s 的补刷。
 * 这是这套机制唯一不可替代的能力——事件总线只能同步广播。
 *
 * 两个注册表：
 *   1. 本管理器的 refreshSubscribers（subscribe/unsubscribe）
 *   2. resourceEventBus
 * 配置里的组件 ID 先查前者，查不到则回退到事件总线定向派发。两套命名空间是历史遗留，
 * 回退是为了让 `['cluster-status']` 这类只注册在总线上的 ID 也能命中。两边都查不到时
 * **无条件 console.error**——这类失配曾经只在 dev 环境打 warn，导致配置表里 35 处
 * 引用长期静默失效（2026-09-20 修）。
 */

import { getOperationRefreshConfig, getRefreshConfig } from '../config/refreshConfig';
import resourceEventBus from '../utils/resourceEventBus';

class OperationRefreshManager {
  constructor() {
    this.refreshSubscribers = new Map();
    this.operationConfig = getOperationRefreshConfig() || {};
    this.debugConfig = getRefreshConfig('DEBUG');

    if (this.debugConfig.enableRefreshTracing) {
      console.log('OperationRefreshManager initialized');
    }
  }

  /**
   * 注册刷新回调
   *
   * componentId 是分组名而非唯一键：同一 id 下可挂多个回调，同组件的两个实例不会
   * 互相覆盖。退订优先用返回值，它只摘掉本次注册的这一个。
   *
   * @param {string} componentId - 分组标识
   * @param {Function} refreshCallback - 刷新回调函数
   * @returns {Function} 只退订本次注册的回调
   */
  subscribe(componentId, refreshCallback) {
    if (typeof refreshCallback !== 'function') {
      console.error(`[OperationRefresh] subscribe('${componentId}') 需要一个回调函数`);
      return () => {};
    }

    let group = this.refreshSubscribers.get(componentId);
    if (!group) {
      group = new Set();
      this.refreshSubscribers.set(componentId, group);
    }
    group.add(refreshCallback);

    if (this.debugConfig.enableRefreshTracing) {
      console.log(`Component '${componentId}' subscribed to operation refresh (${group.size} on this id)`);
    }

    return () => this.unsubscribe(componentId, refreshCallback);
  }

  /**
   * 取消订阅
   * @param {string} componentId - 分组标识
   * @param {Function} [refreshCallback] - 只退订这个回调；省略则清掉该 id 下全部回调
   */
  unsubscribe(componentId, refreshCallback) {
    const group = this.refreshSubscribers.get(componentId);
    if (!group) return;

    if (refreshCallback) {
      group.delete(refreshCallback);
    } else {
      group.clear();
    }

    if (group.size === 0) {
      this.refreshSubscribers.delete(componentId);
    }

    if (this.debugConfig.enableRefreshTracing) {
      console.log(`Component '${componentId}' unsubscribed from operation refresh (${group.size} left)`);
    }
  }

  /**
   * 调用某个 id 下的全部回调，逐个隔离错误
   * @returns {Promise[]} 每个回调一个 promise
   */
  _invokeGroup(componentId, group) {
    return Array.from(group).map(callback =>
      Promise.resolve()
        .then(() => callback())
        .catch(error => {
          console.error(`Refresh failed for ${componentId}:`, error);
        })
    );
  }

  /**
   * 触发操作后刷新
   * @param {string} operationType - 操作类型（键取自 refreshConfig.OPERATION_REFRESH）
   * @param {Object} operationData - 操作数据，仅用于日志
   */
  async triggerOperationRefresh(operationType, operationData = {}) {
    const config = this.operationConfig[operationType];
    if (!config) {
      if (this.debugConfig.enableRefreshTracing) {
        console.warn(`No refresh config found for operation: ${operationType}`);
      }
      return;
    }

    if (this.debugConfig.enableRefreshTracing) {
      console.log(`🎯 Triggering refresh for operation: ${operationType}`, operationData);
    }

    try {
      // 立即刷新
      if (config.immediate && config.immediate.length > 0) {
        await this.executeRefresh(config.immediate, 'immediate', operationType);
      }

      // 延迟刷新：等 AWS 最终一致后补刷，不 await（否则会把调用方挂住两分钟）
      if (config.delayed && config.delayed.length > 0) {
        config.delayed.forEach(({ components, delay }) => {
          setTimeout(async () => {
            try {
              await this.executeRefresh(components, `delayed-${delay}ms`, operationType);
            } catch (error) {
              console.error(`Delayed refresh failed for ${operationType}:`, error);
            }
          }, delay);
        });
      }
    } catch (error) {
      console.error(`Operation refresh failed for ${operationType}:`, error);
    }
  }

  /**
   * 刷新所有已注册的订阅者（refreshConfig 里 components: ['all'] 的落点）
   *
   * 同时覆盖本管理器的 refreshSubscribers 和 resourceEventBus 的订阅者。
   *
   * @param {Object} meta - { operationType, refreshType }，仅用于日志
   */
  async refreshAll(meta = {}) {
    const { operationType, refreshType } = meta;
    const subscriberIds = Array.from(this.refreshSubscribers.keys());

    if (this.debugConfig.enableRefreshTracing) {
      console.log(
        `🌐 refreshAll (${refreshType || 'n/a'} / ${operationType || 'n/a'}): ` +
        `${subscriberIds.length} direct subscribers + resourceEventBus`
      );
    }

    const promises = [];
    subscriberIds.forEach(componentId => {
      const group = this.refreshSubscribers.get(componentId);
      if (group) promises.push(...this._invokeGroup(componentId, group));
    });

    // 广播给事件总线全部订阅者（emit 自身对每个回调做了 try/catch）
    try {
      resourceEventBus.emit('operation-refresh-all', { operationType, refreshType });
    } catch (error) {
      console.error('refreshAll: resourceEventBus.emit failed:', error);
    }

    await Promise.allSettled(promises);
  }

  /**
   * 执行刷新
   * @param {Array} components - 要刷新的组件 ID 列表，或 ['all']
   * @param {string} refreshType - 刷新类型，仅用于日志
   * @param {string} operationType - 操作类型，仅用于日志
   */
  async executeRefresh(components, refreshType, operationType) {
    if (this.debugConfig.enableRefreshTracing) {
      console.log(`🔄 Executing ${refreshType} refresh for ${operationType}:`, components);
    }

    const refreshPromises = [];

    if (components.includes('all')) {
      refreshPromises.push(this.refreshAll({ operationType, refreshType }));
    } else {
      const unresolved = [];

      components.forEach(componentId => {
        const group = this.refreshSubscribers.get(componentId);
        if (group && group.size > 0) {
          refreshPromises.push(...this._invokeGroup(componentId, group));
        } else {
          unresolved.push(componentId);
        }
      });

      // 回退到事件总线定向派发（`cluster-status` 只注册在总线上）
      if (unresolved.length > 0) {
        const delivered = resourceEventBus.emitTo(unresolved, 'operation-refresh', {
          operationType,
          refreshType
        });

        const missing = unresolved.filter(id => !delivered.includes(id));
        if (missing.length > 0) {
          // 无条件报错：两个注册表都没有这个 ID，说明配置引用了不存在的组件。
          // 不要把这里改回 debug 门控——那正是历史上 35 处引用静默失效的原因。
          console.error(
            `[OperationRefresh] ${operationType} / ${refreshType}: ` +
            `配置引用了未注册的组件 ID: ${missing.join(', ')}。` +
            `请修正 config/refreshConfig.js，或让对应组件注册订阅。`
          );
        }
      }
    }

    if (refreshPromises.length > 0) {
      const results = await Promise.allSettled(refreshPromises);

      if (this.debugConfig.enablePerformanceLogging) {
        const successCount = results.filter(r => r.status === 'fulfilled').length;
        const errorCount = results.filter(r => r.status === 'rejected').length;
        console.log(`${refreshType} refresh completed: ${successCount} success, ${errorCount} errors`);
      }
    }
  }

  /**
   * 销毁管理器
   */
  destroy() {
    this.refreshSubscribers.clear();

    if (this.debugConfig.enableRefreshTracing) {
      console.log('OperationRefreshManager destroyed');
    }
  }
}

// 创建全局单例实例
const operationRefreshManager = new OperationRefreshManager();

// 开发环境下暴露到window对象，便于调试
if (process.env.NODE_ENV === 'development') {
  window.operationRefreshManager = operationRefreshManager;
}

export default operationRefreshManager;
