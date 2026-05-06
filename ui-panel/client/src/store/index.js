import { configureStore } from '@reduxjs/toolkit';
import clustersReducer from './slices/clustersSlice';
import nodeGroupsReducer from './slices/nodeGroupsSlice';
import inferenceReducer from './slices/inferenceSlice';
import trainingReducer from './slices/trainingSlice';
import clusterStatusReducer from './slices/clusterStatusSlice';
import appStatusReducer from './slices/appStatusSlice';
import globalRefreshReducer from './slices/globalRefreshSlice';
import webSocketReducer from './slices/webSocketSlice';

// 定义 Redux store 配置
export const store = configureStore({
  reducer: {
    clusters: clustersReducer,
    nodeGroups: nodeGroupsReducer,
    inference: inferenceReducer,
    training: trainingReducer,
    clusterStatus: clusterStatusReducer,
    appStatus: appStatusReducer,
    globalRefresh: globalRefreshReducer,
    webSocket: webSocketReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false, // 避免非序列化数据问题
    }),
  devTools: process.env.NODE_ENV !== 'production', // 在非生产环境中启用 Redux DevTools
});

// 为 TypeScript 项目导出类型
// export type AppDispatch = typeof store.dispatch;
// export type RootState = ReturnType<typeof store.getState>;