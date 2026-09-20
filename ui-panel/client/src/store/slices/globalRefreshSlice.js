import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import {
  fetchClusterStatus,
  fetchPendingGPUs,
  refreshClusterData
} from './clusterStatusSlice';
import {
  fetchPods,
  fetchServices,
  fetchRayJobs,
  fetchBindingServices,
  refreshAllAppStatus
} from './appStatusSlice';

// 全局刷新 thunk - 智能决定刷新哪些数据
export const globalRefresh = createAsyncThunk(
  'globalRefresh/globalRefresh',
  async (options = {}, { dispatch, getState, rejectWithValue }) => {
    try {
      const startTime = Date.now();
      const {
        source = 'manual',
        refreshClusterStatus = true,
        refreshAppStatus = true,
        force = false
      } = options;

      console.log(`Starting global refresh from source: ${source}`);

      const state = getState();
      const now = Date.now();
      const results = [];
      const errors = [];

      // 检查是否需要刷新（基于最后更新时间）
      const shouldRefresh = (lastUpdate, minInterval = 30000) => {
        if (force) return true;
        if (!lastUpdate) return true;
        return (now - new Date(lastUpdate).getTime()) > minInterval;
      };

      // 并行执行需要刷新的操作
      const refreshPromises = [];

      // 1. 集群状态刷新
      if (refreshClusterStatus) {
        const clusterLastUpdate = state.clusterStatus?.lastUpdate;
        if (shouldRefresh(clusterLastUpdate)) {
          refreshPromises.push(
            dispatch(refreshClusterData()).unwrap()
              .then(result => {
                results.push({ type: 'cluster-status', success: true, result });
                return result;
              })
              .catch(error => {
                errors.push({ type: 'cluster-status', error: error.message });
                throw error;
              })
          );
        } else {
          console.log('Skipping cluster status refresh - too recent');
        }
      }

      // 2. 应用状态刷新
      if (refreshAppStatus) {
        const appLastUpdate = state.appStatus?.lastUpdate;
        if (shouldRefresh(appLastUpdate)) {
          refreshPromises.push(
            dispatch(refreshAllAppStatus()).unwrap()
              .then(result => {
                results.push({ type: 'app-status', success: true, result });
                return result;
              })
              .catch(error => {
                errors.push({ type: 'app-status', error: error.message });
                throw error;
              })
          );
        } else {
          console.log('Skipping app status refresh - too recent');
        }
      }

      // 训练 / 推理 / 节点组不在这里刷新。
      // 这三类面板通过 operationRefreshManager 注册订阅，由调用方（标题栏的
      // GlobalRefreshButton）在 dispatch 本 thunk 的同时调 refreshAll() 覆盖，
      // 不需要在 Redux 层再复制一份各自的拉取逻辑。
      // 2026-09-20：原先这里是三个只打 console.log 的 TODO 分支。

      // 等待所有操作完成
      const settledResults = await Promise.allSettled(refreshPromises);

      const endTime = Date.now();
      const duration = endTime - startTime;

      // 统计结果
      const successCount = results.length;
      const errorCount = errors.length;
      const totalOperations = successCount + errorCount;

      const refreshResult = {
        success: errorCount === 0 || successCount > 0, // 至少有一个成功就算成功
        timestamp: new Date().toISOString(),
        source,
        duration,
        totalOperations,
        successCount,
        errorCount,
        results,
        errors
      };

      console.log('Global refresh completed:', {
        duration,
        success: refreshResult.success,
        operations: totalOperations,
        errors: errorCount
      });

      if (errors.length > 0 && successCount === 0) {
        return rejectWithValue({
          message: `All refresh operations failed: ${errors.map(e => e.error).join(', ')}`,
          errors,
          duration
        });
      }

      return refreshResult;

    } catch (error) {
      console.error('Global refresh failed:', error);
      return rejectWithValue({
        message: error.message,
        duration: Date.now() - Date.now(),
        timestamp: new Date().toISOString()
      });
    }
  }
);

// 自动刷新 thunk - 定时触发的刷新
export const autoRefresh = createAsyncThunk(
  'globalRefresh/autoRefresh',
  async (_, { dispatch, getState }) => {
    const state = getState();

    if (!state.globalRefresh.autoRefreshEnabled) {
      return { skipped: true, reason: 'Auto refresh disabled' };
    }

    if (state.globalRefresh.isRefreshing) {
      return { skipped: true, reason: 'Already refreshing' };
    }

    // 自动刷新只刷新关键数据，且不强制刷新
    return dispatch(globalRefresh({
      source: 'auto',
      refreshClusterStatus: true,
      refreshAppStatus: true,
      force: false
    }));
  }
);

const globalRefreshSlice = createSlice({
  name: 'globalRefresh',
  initialState: {
    // 当前状态
    isRefreshing: false,
    lastRefreshTime: null,

    // 自动刷新配置
    autoRefreshEnabled: false,
    autoRefreshInterval: 60000, // 默认 1 分钟
    autoRefreshTimerId: null,

    // 刷新历史
    refreshHistory: [],
    maxHistorySize: 50,

    // 统计信息
    stats: {
      totalRefreshes: 0,
      successfulRefreshes: 0,
      failedRefreshes: 0,
      averageDuration: 0,
      lastError: null,
      successRate: 100
    },

    // 错误信息
    error: null
  },
  reducers: {
    // 启用/禁用自动刷新
    setAutoRefreshEnabled: (state, action) => {
      state.autoRefreshEnabled = action.payload;
      if (!action.payload) {
        // 清除定时器 ID（实际清除在组件层面处理）
        state.autoRefreshTimerId = null;
      }
    },

    // 设置自动刷新间隔
    setAutoRefreshInterval: (state, action) => {
      const interval = Math.max(10000, action.payload); // 最小 10 秒
      state.autoRefreshInterval = interval;
    },

    // 设置定时器 ID
    setAutoRefreshTimerId: (state, action) => {
      state.autoRefreshTimerId = action.payload;
    },

    // 清除错误
    clearError: (state) => {
      state.error = null;
      state.stats.lastError = null;
    },

    // 清除刷新历史
    clearRefreshHistory: (state) => {
      state.refreshHistory = [];
    },

    // 重置统计信息
    resetStats: (state) => {
      state.stats = {
        totalRefreshes: 0,
        successfulRefreshes: 0,
        failedRefreshes: 0,
        averageDuration: 0,
        lastError: null,
        successRate: 100
      };
    },

    // 添加刷新记录到历史
    addRefreshRecord: (state, action) => {
      const record = {
        ...action.payload,
        id: Date.now(),
        timestamp: action.payload.timestamp || new Date().toISOString()
      };

      state.refreshHistory.unshift(record);

      // 保持历史记录大小限制
      if (state.refreshHistory.length > state.maxHistorySize) {
        state.refreshHistory = state.refreshHistory.slice(0, state.maxHistorySize);
      }
    },

    // 更新统计信息
    updateStats: (state, action) => {
      const { success, duration, error } = action.payload;

      state.stats.totalRefreshes += 1;

      if (success) {
        state.stats.successfulRefreshes += 1;
      } else {
        state.stats.failedRefreshes += 1;
        state.stats.lastError = error || 'Unknown error';
      }

      // 计算成功率
      state.stats.successRate = Math.round(
        (state.stats.successfulRefreshes / state.stats.totalRefreshes) * 100
      );

      // 计算平均时长（简单移动平均）
      if (duration) {
        const currentAvg = state.stats.averageDuration || 0;
        const totalRefreshes = state.stats.totalRefreshes;
        state.stats.averageDuration = Math.round(
          (currentAvg * (totalRefreshes - 1) + duration) / totalRefreshes
        );
      }
    }
  },
  extraReducers: (builder) => {
    // 处理全局刷新
    builder
      .addCase(globalRefresh.pending, (state, action) => {
        state.isRefreshing = true;
        state.error = null;
      })
      .addCase(globalRefresh.fulfilled, (state, action) => {
        state.isRefreshing = false;
        state.lastRefreshTime = action.payload.timestamp;

        // 添加到历史记录
        globalRefreshSlice.caseReducers.addRefreshRecord(state, {
          payload: {
            ...action.payload,
            type: 'manual'
          }
        });

        // 更新统计信息
        globalRefreshSlice.caseReducers.updateStats(state, {
          payload: {
            success: action.payload.success,
            duration: action.payload.duration,
            error: action.payload.success ? null : action.payload.errors?.join(', ')
          }
        });
      })
      .addCase(globalRefresh.rejected, (state, action) => {
        state.isRefreshing = false;
        state.error = action.payload?.message || action.error?.message;

        // 添加错误记录到历史
        globalRefreshSlice.caseReducers.addRefreshRecord(state, {
          payload: {
            success: false,
            error: state.error,
            duration: action.payload?.duration || 0,
            source: 'manual',
            timestamp: new Date().toISOString()
          }
        });

        // 更新统计信息
        globalRefreshSlice.caseReducers.updateStats(state, {
          payload: {
            success: false,
            duration: action.payload?.duration || 0,
            error: state.error
          }
        });
      })

    // 处理自动刷新
      .addCase(autoRefresh.fulfilled, (state, action) => {
        if (!action.payload.skipped) {
          // 自动刷新成功，更新时间
          state.lastRefreshTime = new Date().toISOString();
        }
      });
  }
});

export const {
  setAutoRefreshEnabled,
  setAutoRefreshInterval,
  setAutoRefreshTimerId,
  clearError,
  clearRefreshHistory,
  resetStats,
  addRefreshRecord,
  updateStats
} = globalRefreshSlice.actions;

export default globalRefreshSlice.reducer;