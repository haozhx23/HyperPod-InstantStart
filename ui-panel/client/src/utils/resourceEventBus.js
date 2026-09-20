/**
 * 资源事件总线
 *
 * 设计原则：
 * 1. 组件自己决定是否需要刷新（订阅事件）
 * 2. 操作方只负责触发事件（不关心谁刷新）
 *
 * componentId 是**分组名而非唯一键**：一个 id 下可以挂多个回调（`Map<id, Set<cb>>`）。
 * 这样同一组件挂载两个实例时不会互相覆盖——早期实现是 `Map<id, cb>`，后挂载的实例会
 * 顶掉先挂载的，且先卸载的那个会把后者一并退订。
 *
 * 退订优先用 subscribe() 返回的函数，它只摘掉自己那一个回调：
 *
 *     useEffect(() => resourceEventBus.subscribe('app-status', cb), []);
 *
 * unsubscribe(id) 不带回调时会清掉该 id 下的全部回调，多实例场景下别这么用。
 */

class ResourceEventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    this.enabled = true;
    this.debugMode = process.env.NODE_ENV === 'development';
  }

  /**
   * 组件订阅资源变化事件
   * @param {string} componentId - 分组标识，同一 id 可有多个订阅者
   * @param {Function} callback - 刷新回调，签名 (eventType, metadata)
   * @returns {Function} 只退订本次注册的这个回调
   */
  subscribe(componentId, callback) {
    if (typeof callback !== 'function') {
      console.error(`[ResourceEventBus] subscribe('${componentId}') 需要一个回调函数`);
      return () => {};
    }

    let group = this.listeners.get(componentId);
    if (!group) {
      group = new Set();
      this.listeners.set(componentId, group);
    }
    group.add(callback);

    if (this.debugMode) {
      console.log(`[ResourceEventBus] ${componentId} subscribed (${group.size} on this id)`);
    }

    return () => this.unsubscribe(componentId, callback);
  }

  /**
   * 取消订阅
   * @param {string} componentId - 分组标识
   * @param {Function} [callback] - 只退订这个回调；省略则清掉该 id 下全部回调
   */
  unsubscribe(componentId, callback) {
    const group = this.listeners.get(componentId);
    if (!group) return;

    if (callback) {
      group.delete(callback);
    } else {
      group.clear();
    }

    if (group.size === 0) {
      this.listeners.delete(componentId);
    }

    if (this.debugMode) {
      console.log(`[ResourceEventBus] ${componentId} unsubscribed (${group.size} left)`);
    }
  }

  /**
   * 把一个事件投递给一组回调，逐个隔离错误
   * @returns {number} 实际调用的回调数
   */
  _deliver(componentId, group, eventType, metadata) {
    let count = 0;
    for (const callback of Array.from(group)) {
      count += 1;
      try {
        callback(eventType, metadata);
      } catch (error) {
        console.error(`[ResourceEventBus] Error refreshing ${componentId}:`, error);
      }
    }
    return count;
  }

  /**
   * 广播：通知所有订阅者，由各自判断要不要刷新
   * @param {string} eventType - 事件类型
   * @param {Object} metadata - 事件元数据
   */
  emit(eventType = 'resource-changed', metadata = {}) {
    if (!this.enabled) {
      if (this.debugMode) {
        console.log(`[ResourceEventBus] Event bus disabled, skipping emit: ${eventType}`);
      }
      return;
    }

    if (this.debugMode) {
      console.log(`[ResourceEventBus] Emitting event: ${eventType}`, metadata);
    }

    this.listeners.forEach((group, componentId) => {
      this._deliver(componentId, group, eventType, metadata);
    });
  }

  /**
   * 定向派发：只通知 ids 里已注册的订阅者，不波及其他人。
   *
   * `emit()` 是广播，而 refreshConfig 里 `components: ['cluster-status']` 这种指名
   * 刷新需要定向投递，否则会顺带刷掉无关面板。
   *
   * @param {string[]} ids - 目标 componentId 列表
   * @param {string} eventType - 事件类型
   * @param {Object} metadata - 事件元数据
   * @returns {string[]} 实际投递到的 componentId（供调用方判断哪些 ID 无人接收）
   */
  emitTo(ids, eventType = 'resource-changed', metadata = {}) {
    if (!this.enabled) {
      if (this.debugMode) {
        console.log(`[ResourceEventBus] Event bus disabled, skipping emitTo: ${eventType}`);
      }
      return [];
    }

    const delivered = [];
    for (const componentId of ids) {
      const group = this.listeners.get(componentId);
      if (!group || group.size === 0) continue;

      // 投递已发生就算命中，回调自身抛错不代表 ID 未注册
      delivered.push(componentId);
      this._deliver(componentId, group, eventType, metadata);
    }

    if (this.debugMode && delivered.length > 0) {
      console.log(`[ResourceEventBus] emitTo ${eventType} → ${delivered.join(', ')}`);
    }

    return delivered;
  }

  /**
   * 启用/禁用事件总线
   * @param {boolean} enabled - 是否启用
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    console.log(`[ResourceEventBus] Event bus ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * 获取当前订阅的 componentId 列表
   */
  getSubscribers() {
    return Array.from(this.listeners.keys());
  }

  /**
   * 回调总数（一个 id 可能对应多个）
   */
  getCallbackCount() {
    let total = 0;
    this.listeners.forEach(group => { total += group.size; });
    return total;
  }

  /**
   * 清空所有订阅者
   */
  clear() {
    this.listeners.clear();
    console.log('[ResourceEventBus] All subscribers cleared');
  }
}

// 创建全局单例
const resourceEventBus = new ResourceEventBus();

// 开发环境下暴露到 window 对象
if (process.env.NODE_ENV === 'development') {
  window.resourceEventBus = resourceEventBus;
}

export default resourceEventBus;
