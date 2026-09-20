/**
 * AppHeader - 应用头部组件
 *
 * 这个组件被提取出来以支持不同项目的品牌定制:
 * - HyperPod: 使用 CloudServerOutlined 图标
 * - Neuron: 使用 neuron-logo.png 和自定义颜色
 *
 * Neuron 项目通过 overlay 覆盖此文件实现品牌定制
 */
import React from 'react';
import { Layout } from 'antd';
import { CloudServerOutlined } from '@ant-design/icons';
import { getActiveTheme } from '../config/themeConfig';
import GlobalRefreshButtonRedux from './GlobalRefreshButtonRedux';

const { Header } = Layout;

function AppHeader({ connectionStatus, getConnectionStatusIndicator }) {
  const theme = getActiveTheme();

  return (
    <Header
      className={`theme-header ${theme.name === 'aws' ? 'aws-header' : ''}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px'
      }}
    >
      <h1 className="theme-header-title">
        <CloudServerOutlined style={{ marginRight: '8px' }} />
        HyperPod InstantStart
        <span className="theme-header-subtitle">
          Unified Platform
        </span>
        <span style={{
          fontSize: '11px',
          color: '#d9d9d9',
          marginLeft: '12px',
          fontWeight: 'normal'
        }}>
          Version: {process.env.REACT_APP_VERSION || 'dev'}
        </span>
      </h1>

      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div style={{
          fontSize: '12px',
          lineHeight: '1',
          display: 'flex',
          alignItems: 'center',
          gap: '6px'
        }}>
          <span style={{ color: '#d9d9d9' }}>
            {connectionStatus === 'connected' ? 'Connected' :
             connectionStatus === 'connecting' ? 'Connecting' :
             connectionStatus === 'disconnected' ? 'Disconnected' : 'Error'}
          </span>
          {getConnectionStatusIndicator()}
        </div>

        {/* 全局刷新按钮：按钮样式是按深色标题栏配的（透明底 + 白字白边）。
            Neuron 项目通过 overlay 覆盖本文件定制品牌时，注意保留这一项。 */}
        <GlobalRefreshButtonRedux size="small" />
      </div>
    </Header>
  );
}

export default AppHeader;
