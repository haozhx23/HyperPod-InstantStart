/**
 * Pure presentational helpers extracted from ClusterManagementRedux.js.
 *
 * getDependencyStatusDisplay maps (dependenciesStatus, cluster) to a status Tag;
 * getDependencyButtonProps maps dependenciesStatus to the configure-button's
 * text/disabled/type/icon. Both are pure given their arguments (no hooks, no
 * component state) and were small inline closures, so extracting them is
 * behavior-preserving. Neither carries a @release marker.
 *
 * ClusterManagementRedux is the most sentinel-dense component (7 release-gated
 * feature toggles interwoven into one JSX tree); only these sentinel-free pure
 * helpers are extracted. Deeper structural decomposition is intentionally
 * deferred — see REFACTOR.md.
 */
import React from 'react';
import { Typography, Tag } from 'antd';
import { SettingOutlined, CheckCircleOutlined, ReloadOutlined } from '@ant-design/icons';

const { Text } = Typography;

export const getDependencyStatusDisplay = (dependenciesStatus, cluster) => {
  if (!dependenciesStatus) {
    return <Text type="secondary">Loading...</Text>;
  }

  // 检查是否是导入的集群类型
  const isImported = cluster?.type === 'imported';

  if (isImported) {
    // 导入的集群：显示实际配置状态（不再区分有无HyperPod）
    if (dependenciesStatus?.configured) {
      return <Tag color="green">Configured</Tag>;
    } else {
      return <Tag color="warning">Not Configured</Tag>;
    }
  } else {
    // 创建的集群：显示配置状态
    if (dependenciesStatus?.configured) {
      return <Tag color="green">Configured</Tag>;
    } else if (dependenciesStatus?.detected && dependenciesStatus?.effectiveStatus) {
      return <Tag color="blue">Detected</Tag>;
    } else {
      return <Tag color="warning">Not Configured</Tag>;
    }
  }
};

export const getDependencyButtonProps = (dependenciesStatus) => {
  // 导入的集群也可以配置依赖（移除了原有的禁用逻辑）

  if (!dependenciesStatus) {
    return {
      text: 'Configure Dependencies',
      disabled: true,
      type: 'default',
      icon: <SettingOutlined />
    };
  }

  switch (dependenciesStatus.status) {
    case 'pending':
      return {
        text: 'Configure Dependencies',
        disabled: false,
        type: 'primary',
        icon: <SettingOutlined />
      };
    case 'configuring':
      return {
        text: 'Configuring...',
        disabled: true,
        type: 'primary',
        icon: <SettingOutlined />
      };
    case 'success':
      return {
        text: 'Dependencies Configured',
        disabled: true,
        type: 'default',
        icon: <CheckCircleOutlined />
      };
    case 'failed':
      return {
        text: 'Retry Configuration',
        disabled: false,
        type: 'default',
        icon: <ReloadOutlined />
      };
    default:
      return {
        text: 'Configure Dependencies',
        disabled: true,
        type: 'default',
        icon: <SettingOutlined />
      };
  }
};
