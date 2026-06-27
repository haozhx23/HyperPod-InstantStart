/**
 * Pure pod-status helpers extracted verbatim from StatusMonitorRedux.js.
 *
 * getPodStatus derives a display status string from a k8s pod object;
 * getPodStatusColor maps that to an antd status color; getPodStatusIcon maps it
 * to an antd icon element. All three are pure (no hooks, no component state) and
 * were file-local, so extracting them is behavior-preserving. None carry a
 * @release marker.
 */
import React from 'react';
import { CheckCircleOutlined, ExclamationCircleOutlined, LoadingOutlined } from '@ant-design/icons';

// Pod状态相关函数
export const getPodStatus = (pod) => {
  // 优先检查是否正在删除（Terminating）
  if (pod.metadata?.deletionTimestamp) {
    return 'Terminating';
  }

  const phase = pod.status?.phase;
  const containerStatuses = pod.status?.containerStatuses || [];

  // 检查容器状态，透传容器的实际状态原因
  for (const containerStatus of containerStatuses) {
    if (containerStatus.state?.waiting?.reason) {
      return containerStatus.state.waiting.reason;
    }
    if (containerStatus.state?.terminated?.reason) {
      return containerStatus.state.terminated.reason;
    }
  }

  // 透传 Pod phase
  return phase || 'Unknown';
};

export const getPodStatusColor = (status) => {
  const statusLower = status?.toLowerCase() || '';

  // 成功状态
  if (['running', 'succeeded', 'completed'].includes(statusLower)) {
    return 'success';
  }

  // 错误状态
  if (['failed', 'error', 'imagepullbackoff', 'errimagepull',
       'crashloopbackoff', 'oomkilled'].includes(statusLower)) {
    return 'error';
  }

  // 警告状态
  if (['terminating', 'pending', 'unknown'].includes(statusLower)) {
    return 'warning';
  }

  // 默认处理中状态（包括 ContainerCreating 等）
  return 'processing';
};

export const getPodStatusIcon = (status) => {
  const statusLower = status?.toLowerCase() || '';

  // 成功状态
  if (['running', 'succeeded', 'completed'].includes(statusLower)) {
    return <CheckCircleOutlined />;
  }

  // 错误状态
  if (['failed', 'error', 'imagepullbackoff', 'errimagepull',
       'crashloopbackoff', 'oomkilled'].includes(statusLower)) {
    return <ExclamationCircleOutlined />;
  }

  // 默认加载中图标
  return <LoadingOutlined />;
};
