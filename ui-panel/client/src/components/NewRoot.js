import React, { Suspense } from 'react';
import { Layout, Spin } from 'antd';
import { Outlet } from 'react-router-dom';
import { useSelector } from 'react-redux';
import AppHeader from './AppHeader';
import AppSidebar from './AppSidebar';
import { selectConnectionStatus } from '../store/selectors';

const { Content } = Layout;

function getConnectionStatusIndicator(status) {
  switch (status) {
    case 'connected':
      return '🟢';
    case 'connecting':
      return '🟡';
    case 'disconnected':
      return '🟠';
    case 'error':
      return '🔴';
    default:
      return '🔴';
  }
}

export default function NewRoot() {
  const connectionStatus = useSelector(selectConnectionStatus);

  return (
    <Layout className="app-layout">
      <AppHeader
        connectionStatus={connectionStatus}
        getConnectionStatusIndicator={() => getConnectionStatusIndicator(connectionStatus)}
      />
      <Layout hasSider style={{ background: '#fff' }}>
        <AppSidebar />
        {/* body 有 zoom，vh 是物理视口值不随 zoom 缩，所以这里除以 --zoom-factor
            才能让 Content 实际占满视口；--zoom-factor 由 index.js 从 REACT_APP_UI_ZOOM 注入。 */}
        <Content style={{ minHeight: 'calc((100vh - 64px) / var(--zoom-factor))', overflow: 'auto' }}>
          {/* 页面是 React.lazy 按路由拆的 chunk（见 App.js），首次进入时在这里等它下载 */}
          <Suspense fallback={<div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>}>
            <Outlet />
          </Suspense>
        </Content>
      </Layout>
    </Layout>
  );
}
