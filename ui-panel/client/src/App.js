import React, { useEffect, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import ThemeProvider from './components/ThemeProvider';
import AuthGate from './components/AuthGate';
import NewRoot from './components/NewRoot';
import ScaleDebugOverlay from './components/debug/ScaleDebugOverlay';
import useWebSocket from './hooks/useWebSocket';
import { loadRefreshConfig } from './hooks/useAutoRefresh';
import { fetchAppStatusConfig } from './store/slices/appStatusSlice';
import './utils/authFetch';
import './App.css';
import './styles/dynamic-theme.css';

// 每个页面单独打一个 chunk，进入对应路由时才下载（R4）。<Suspense> 在 NewRoot 里包住
// <Outlet />，加载期间头部和侧边栏保持不动。被 `paths` 剥离的页面，它的 lazy 声明必须
// 和原来的静态 import 一样留在 sentinel 块里——check-imports 现在也会检查 import()。
const InferencePage = lazy(() => import('./pages/InferencePage'));
const ManagedInferencePage = lazy(() => import('./pages/ManagedInferencePage'));
const TrainingPage = lazy(() => import('./pages/TrainingPage'));
const TrainingJobsPage = lazy(() => import('./pages/TrainingJobsPage'));
const TrainingHistoryPage = lazy(() => import('./pages/TrainingHistoryPage'));
const StoragePage = lazy(() => import('./pages/StoragePage'));
const MonitoringPage = lazy(() => import('./pages/MonitoringPage'));
const ClusterManagementPage = lazy(() => import('./pages/ClusterManagementPage'));

// 顶层 bootstrap：在路由之上初始化 WebSocket 单例 + 拉取 UI 组件可见性配置
// (ui-component-config.json → tabConfig / recipeConfig / clusterConfig)。
// 之前 fetchAppStatusConfig 只在旧版单页 UI（已于 2026-11-06 删除）里 dispatch，
// 导致按页路由的 UI 下 config 一直是空对象，`xxx !== 'off'` 默认通过，隐藏项会意外显示出来。
function AppBootstrap({ children }) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch(fetchAppStatusConfig());
    // 周期性自动刷新的间隔来自 config/refresh-config.json（默认 60s）。
    // 失败时 useAutoRefresh 保留内置默认值，不阻塞启动。
    loadRefreshConfig();
  }, [dispatch]);
  useWebSocket();
  return children;
}

function App() {
  return (
    <ThemeProvider>
      <AuthGate>
        <AppBootstrap>
          <BrowserRouter>
            <Routes>
              <Route element={<NewRoot />}>
                <Route path="/" element={<Navigate to="/cluster-management" replace />} />
                <Route path="/inference" element={<InferencePage />} />
                <Route path="/managed-inference" element={<ManagedInferencePage />} />
                <Route path="/training" element={<TrainingJobsPage />} />
                <Route path="/training-recipes" element={<TrainingPage />} />
                <Route path="/training-history" element={<TrainingHistoryPage />} />
                <Route path="/storage" element={<StoragePage />} />
                <Route path="/monitoring" element={<MonitoringPage />} />
                <Route path="/cluster-management" element={<ClusterManagementPage />} />
                <Route path="*" element={<Navigate to="/cluster-management" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
          <ScaleDebugOverlay />
        </AppBootstrap>
      </AuthGate>
    </ThemeProvider>
  );
}

export default App;
