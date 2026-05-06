import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import ThemeProvider from './components/ThemeProvider';
import AuthGate from './components/AuthGate';
import LegacyRoot from './components/LegacyRoot';
import NewRoot from './components/NewRoot';
import ScaleDebugOverlay from './components/debug/ScaleDebugOverlay';
import useWebSocket from './hooks/useWebSocket';
import { fetchAppStatusConfig } from './store/slices/appStatusSlice';
import InferencePage from './pages/InferencePage';
import TrainingPage from './pages/TrainingPage';
import TrainingJobsPage from './pages/TrainingJobsPage';
import TrainingHistoryPage from './pages/TrainingHistoryPage';
import StoragePage from './pages/StoragePage';
import MonitoringPage from './pages/MonitoringPage';
import ClusterManagementPage from './pages/ClusterManagementPage';
import './utils/authFetch';
import './App.css';
import './styles/dynamic-theme.css';

// 顶层 bootstrap：在路由之上初始化 WebSocket 单例 + 拉取 UI 组件可见性配置
// (ui-component-config.json → tabConfig / recipeConfig / clusterConfig)。
// 之前 fetchAppStatusConfig 只在 LegacyRoot 里 dispatch，导致新路由默认 UI 下
// config 一直是空对象，`xxx !== 'off'` 默认通过，隐藏项会意外显示出来。
function AppBootstrap({ children }) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch(fetchAppStatusConfig());
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
              <Route path="/legacy/*" element={<LegacyRoot />} />
              <Route element={<NewRoot />}>
                <Route path="/" element={<Navigate to="/cluster-management" replace />} />
                <Route path="/inference" element={<InferencePage />} />
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
