/**
 * EKS / HyperPod node-group table column builders extracted from
 * NodeGroupManagerRedux.js. Each builder receives the component-scoped action
 * renderer (and, for HyperPod, the managed-autoscaling resource map) as explicit
 * params and returns the antd column array verbatim — behavior is identical to
 * the inline definitions. Pure cell renderers come from ./nodeGroupRenderHelpers.
 *
 * buildHyperPodColumns carries a HyperPod-Karpenter release-sentinel block (the
 * managed "Karpenter" tag in the Capacity Type cell, plus the matching builder
 * param). That feature SHIPS in the standard manifest but is WITHHELD in the
 * .ec2 (self-managed EKS) manifest — so under the EC2 release these markers strip
 * cleanly and the builder runs without the managed-autoscaling param. NOTE: this
 * concerns the HyperPod-side autoscaler only; the EC2-side Karpenter feature is
 * separate and is intentionally not referenced in this module.
 *
 * Covered by NodeGroupManagerRedux.test.js, which seeds EKS + HyperPod groups so
 * these render functions actually execute under test.
 */
import React from 'react';
import { Space, Tag } from 'antd';
import { renderStatus, renderScaling, renderCount } from './nodeGroupRenderHelpers';

export const buildEksColumns = ({ renderEKSActions }) => [
  { title: 'Node Group Name', dataIndex: 'name', key: 'name', width: '22%' },
  { title: 'Status', dataIndex: 'status', key: 'status', width: '10%', render: renderStatus },
  { title: 'Instance Types', dataIndex: 'instanceTypes', key: 'instanceTypes', width: '14%', render: types => types?.join(', ') },
  { title: 'AZ', dataIndex: 'availabilityZones', key: 'availabilityZones', width: '14%', render: azs => azs?.join(', ') || '-' },
  {
    title: 'Capacity Type',
    dataIndex: 'capacityType',
    key: 'capacityType',
    width: '16%',
    render: (capacityType) => {
      if (!capacityType) return <Tag color="orange">Spot</Tag>;
      const type = capacityType.toLowerCase();
      return (
        <Tag color={type === 'on_demand' || type === 'on-demand' ? 'green' : 'orange'}>
          {type === 'on_demand' || type === 'on-demand' ? 'OD' : 'Spot'}
        </Tag>
      );
    }
  },
  { title: 'Min/Max/Desired', key: 'scaling', width: '12%', render: renderScaling },
  { title: 'Actions', key: 'actions', width: '12%', render: renderEKSActions }
];

export const buildHyperPodColumns = ({
  renderHyperPodActions,
  hyperpodKarpenterResources,
}) => [
  { title: 'Instance Group Name', dataIndex: 'name', key: 'name', width: '22%' },
  { title: 'Status', dataIndex: 'status', key: 'status', width: '10%', render: renderStatus },
  { title: 'Instance Type', dataIndex: 'instanceType', key: 'instanceType', width: '14%' },
  { title: 'AZ', dataIndex: 'availabilityZone', key: 'availabilityZone', width: '14%' },
  {
    title: 'Capacity Type',
    dataIndex: 'capacityType',
    key: 'capacityType',
    width: '16%',
    render: (capacityType, record) => {
      const type = capacityType ? capacityType.toLowerCase() : 'on-demand';
      const isManaged = hyperpodKarpenterResources.managedInstanceGroups &&
                       hyperpodKarpenterResources.managedInstanceGroups.includes(record.name);

      const getTypeConfig = (t) => {
        if (t === 'spot') return { color: 'orange', label: 'Spot' };
        if (t === 'training-plan') return { color: 'purple', label: 'FTP' };
        return { color: 'green', label: 'OD' };
      };
      const config = getTypeConfig(type);

      return (
        <Space>
          <Tag color={config.color}>{config.label}</Tag>
          {isManaged && (
            <Tag color="blue">Karpenter</Tag>
          )}
          {record.interfaceType === 'efa-only' && (
            <Tag color="geekblue">EFA-only</Tag>
          )}
        </Space>
      );
    }
  },
  { title: 'Current/Target', key: 'count', width: '12%', render: renderCount },
  { title: 'Actions', key: 'actions', width: '12%', render: renderHyperPodActions }
];
