/**
 * Pure cell renderers extracted from NodeGroupManagerRedux.js.
 *
 * renderStatus maps a node-group status to an antd Tag; renderScaling and
 * renderCount format scaling/count strings. All three are pure (no hooks, no
 * component state) and were used only by the eks/hyperPod column arrays, so
 * extracting them is behavior-preserving. None carry a @release marker.
 */
import React from 'react';
import { Tag } from 'antd';

export const renderStatus = (status) => {
  const statusColors = {
    'ACTIVE': 'green',
    'InService': 'green',
    'CREATING': 'blue',
    'UPDATING': 'orange',
    'DELETING': 'red',
    'CREATE_FAILED': 'red',
    'DELETE_FAILED': 'red'
  };
  return <Tag color={statusColors[status] || 'default'}>{status}</Tag>;
};

export const renderScaling = (record) => {
  const { minSize, maxSize, desiredSize } = record.scalingConfig || {};
  return `${minSize}/${maxSize}/${desiredSize}`;
};

export const renderCount = (record) => {
  return `${record.currentCount}/${record.targetCount}`;
};
