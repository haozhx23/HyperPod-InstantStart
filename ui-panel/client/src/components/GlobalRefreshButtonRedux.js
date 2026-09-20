/**
 * 全局刷新按钮（标题栏）
 *
 * 一个手动「刷新全部」按钮 + 一个自动刷新设置浮层。挂载在 AppHeader 右侧。
 *
 * 手动刷新做两件事：
 *   1. dispatch(globalRefresh)  —— 直接刷 Redux 里的集群状态和应用状态，
 *      不依赖任何面板是否挂载。
 *   2. operationRefreshManager.refreshAll() —— 通知所有已注册的面板
 *      （节点组、训练历史、集群管理、EKS 创建、S3 存储，以及事件总线订阅者）。
 * 两者合起来才是真正的「全局」；单靠前者只覆盖两类数据。
 *
 * 自动刷新**不自建定时器**。全应用只有一个周期性定时器，即 hooks/useAutoRefresh.js
 * 里的 refreshManager；这里只是往它注册一个订阅者，并通过它的 updateConfig()
 * 调整开关和间隔。间隔的默认值来自 config/refresh-config.json。
 *
 * 2026-09-20 从 313 行裁到当前规模：删掉了刷新统计、Recent Activity 历史列表和
 * 错误徽章——那些是给调试刷新系统本身用的自我遥测，对使用者没有信息量。
 */

import React, { useEffect, useCallback, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { Button, Tooltip, Switch, Input, Popover, Typography } from 'antd';
import { ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import { globalRefresh, autoRefresh, setAutoRefreshEnabled, setAutoRefreshInterval } from '../store/slices/globalRefreshSlice';
import { selectIsGlobalRefreshing, selectLastGlobalRefreshTime } from '../store/selectors';
import operationRefreshManager from '../hooks/useOperationRefresh';
import { refreshManager, loadRefreshConfig } from '../hooks/useAutoRefresh';

const { Text } = Typography;

const SUBSCRIBER_ID = 'global-refresh-button';

const GlobalRefreshButtonRedux = ({ style = {}, size = 'default', showAutoRefresh = true }) => {
  const dispatch = useDispatch();

  const isRefreshing = useSelector(selectIsGlobalRefreshing);
  const lastRefreshTime = useSelector(selectLastGlobalRefreshTime);

  // 开关与间隔的真源是 refreshManager（它又由 config/refresh-config.json 播种），
  // 这里只保留一份镜像用于渲染。
  const [enabled, setEnabled] = useState(() => refreshManager.getConfig().ENABLED);
  const [intervalMs, setIntervalMs] = useState(() => refreshManager.getConfig().INTERVAL);

  // 启动时用服务端配置播种。loadRefreshConfig 幂等且会复用在飞请求，
  // 因此和 App.js 里的那次调用不会重复发起 GET。
  useEffect(() => {
    let cancelled = false;
    loadRefreshConfig().then(config => {
      if (cancelled) return;
      setEnabled(config.ENABLED);
      setIntervalMs(config.INTERVAL);
      // 同步给 Redux：autoRefresh thunk 用 state.globalRefresh.autoRefreshEnabled 做闸门
      dispatch(setAutoRefreshEnabled(config.ENABLED));
      dispatch(setAutoRefreshInterval(config.INTERVAL));
    });
    return () => { cancelled = true; };
  }, [dispatch]);

  // 往唯一的周期性定时器注册订阅者，而不是自己 setInterval
  useEffect(() => {
    return refreshManager.subscribe(SUBSCRIBER_ID, () => {
      dispatch(autoRefresh());
    });
  }, [dispatch]);

  const handleManualRefresh = useCallback(async () => {
    if (isRefreshing) return;
    try {
      await Promise.all([
        dispatch(globalRefresh({ source: 'manual', force: true })).unwrap(),
        operationRefreshManager.refreshAll({ operationType: 'manual-global-refresh' })
      ]);
    } catch (error) {
      console.error('Manual refresh failed:', error);
    }
  }, [dispatch, isRefreshing]);

  const handleToggle = useCallback((checked) => {
    setEnabled(checked);
    dispatch(setAutoRefreshEnabled(checked));
    refreshManager.updateConfig({ ENABLED: checked });
  }, [dispatch]);

  const handleIntervalChange = useCallback((event) => {
    const seconds = parseInt(event.target.value, 10);
    if (!Number.isFinite(seconds) || seconds < 5) return;
    const ms = seconds * 1000;
    setIntervalMs(ms);
    dispatch(setAutoRefreshInterval(ms));
    refreshManager.updateConfig({ INTERVAL: ms });
  }, [dispatch]);

  const formatInterval = (ms) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m`;
  };

  const formatTime = (timestamp) => (
    timestamp ? new Date(timestamp).toLocaleTimeString() : 'Never'
  );

  const settingsContent = (
    <div style={{ width: 260, padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Switch checked={enabled} onChange={handleToggle} size="small" />
        <Text style={{ marginLeft: 8 }}>
          Auto refresh ({formatInterval(intervalMs)})
        </Text>
      </div>

      {enabled && (
        <div style={{ marginTop: 10 }}>
          <Text type="secondary">Interval (seconds):</Text>
          <Input
            size="small"
            type="number"
            min={5}
            max={3600}
            defaultValue={intervalMs / 1000}
            onBlur={handleIntervalChange}
            onPressEnter={handleIntervalChange}
            style={{ width: 80, marginLeft: 8 }}
          />
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          本次会话内有效。默认值来自 config/refresh-config.json。
        </Text>
      </div>
    </div>
  );

  const tooltipTitle = (
    <div>
      <div>Refresh all panels</div>
      <div style={{ fontSize: 11, opacity: 0.8 }}>
        Last refresh: {formatTime(lastRefreshTime)}
      </div>
      {enabled && (
        <div style={{ fontSize: 11, opacity: 0.8 }}>
          Auto: every {formatInterval(intervalMs)}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Tooltip title={tooltipTitle} placement="bottom">
        <Button
          type={isRefreshing ? 'primary' : 'default'}
          icon={<ReloadOutlined spin={isRefreshing} />}
          size={size}
          loading={isRefreshing}
          onClick={handleManualRefresh}
          disabled={isRefreshing}
          style={{
            ...style,
            backgroundColor: isRefreshing ? undefined : 'transparent',
            borderColor: isRefreshing ? undefined : 'rgba(255, 255, 255, 0.65)',
            color: isRefreshing ? undefined : '#ffffff'
          }}
        >
          Refresh
        </Button>
      </Tooltip>

      {showAutoRefresh && (
        <Popover content={settingsContent} title="Auto Refresh" trigger="click" placement="bottomRight">
          <Button
            icon={<SettingOutlined />}
            size={size}
            type="text"
            style={{
              padding: '0 8px',
              color: 'rgba(255, 255, 255, 0.9)',
              backgroundColor: 'transparent'
            }}
          />
        </Popover>
      )}
    </div>
  );
};

export default GlobalRefreshButtonRedux;
