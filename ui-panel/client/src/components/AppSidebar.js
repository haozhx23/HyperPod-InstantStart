import React, { useState } from 'react';
import { Layout, Menu, Button } from 'antd';
import {
  RocketOutlined,
  ExperimentOutlined,
  HistoryOutlined,
  DatabaseOutlined,
  DashboardOutlined,
  SettingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ReadOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { selectPagesConfig } from '../store/selectors';

const { Sider } = Layout;

// Menu key = route path so location → highlight is direct.
// pageKey (for config lookup) 对应 ui-component-config.json pages.{pageKey}
// 顺序与原顶部 Tab 一致：Cluster Mgmt → Storage → Inference → Training → History，
// Monitoring 为新增项放在末尾。
const MENU_ITEMS = [
  { key: '/cluster-management', pageKey: 'cluster-management', icon: <SettingOutlined />, label: 'Cluster Management' },
  { key: '/storage', pageKey: 'storage', icon: <DatabaseOutlined />, label: 'Storage' },
  { key: '/inference', pageKey: 'inference', icon: <RocketOutlined />, label: 'Inference' },
  { key: '/training', pageKey: 'training', icon: <ExperimentOutlined />, label: 'Training' },
  { key: '/training-recipes', pageKey: 'training-recipes', icon: <ReadOutlined />, label: 'Training Recipes' },
  { key: '/training-history', pageKey: 'training-history', icon: <HistoryOutlined />, label: 'Training History' },
  { key: '/monitoring', pageKey: 'monitoring', icon: <DashboardOutlined />, label: 'Monitoring' },
];

// R2 note: we deliberately do NOT pass `breakpoint` / `onBreakpoint` to Sider.
// Doing so would make Sider read window.innerWidth via matchMedia, which is not
// affected by body-level `zoom: 0.75` and would cause visual/hit-test drift.
// Collapsed state is fully user-controlled via the toggle button below.
export default function AppSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const pagesConfig = useSelector(selectPagesConfig);

  // pages config 未加载前或未声明该 page 时默认放行;仅 explicit 'off' 时隐藏。
  // Menu items 上挂的 pageKey 会被扔掉,给 antd Menu 干净的 {key,icon,label}。
  const visibleItems = MENU_ITEMS
    .filter((m) => pagesConfig[m.pageKey]?.enabled !== 'off')
    .map(({ pageKey, ...rest }) => rest);

  // Match longest prefix so nested routes (future Phase 2) also highlight correctly.
  const selectedKey =
    visibleItems.map((m) => m.key)
      .filter((k) => location.pathname === k || location.pathname.startsWith(k + '/'))
      .sort((a, b) => b.length - a.length)[0] || '';

  return (
    <Sider
      width={220}
      collapsedWidth={64}
      collapsed={collapsed}
      trigger={null}
      theme="light"
      style={{
        borderRight: '1px solid #f0f0f0',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: collapsed ? 'center' : 'flex-end',
          padding: '8px 12px',
          borderBottom: '1px solid #f0f0f0',
        }}
      >
        <Button
          type="text"
          size="small"
          icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        />
      </div>
      <Menu
        mode="inline"
        selectedKeys={selectedKey ? [selectedKey] : []}
        items={visibleItems}
        onClick={({ key }) => navigate(key)}
        style={{ borderRight: 0 }}
      />
    </Sider>
  );
}
