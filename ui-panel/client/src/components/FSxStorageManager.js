import React, { useState, useEffect } from 'react';
import { Card, Form, Input, Button, Table, Space, message, Modal, Typography, Tag, Row, Col, Alert, Spin } from 'antd';
import { CloudOutlined, DeleteOutlined, CheckCircleOutlined, ReloadOutlined, InfoCircleOutlined } from '@ant-design/icons';

const { Text } = Typography;

const FSxStorageManager = ({ onStorageChange }) => {
  const [form] = Form.useForm();
  const [storages, setStorages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [fsxInfoLoading, setFsxInfoLoading] = useState(false);
  const [fsxInfo, setFsxInfo] = useState(null);

  // 获取活跃集群的 AWS region。FSx Lustre 必须与集群在同一 region（和 VPC），
  // 不能用 /api/aws/current-region（那是面板主机的 region，集群可能在别的 region）。
  const fetchClusterRegion = async () => {
    try {
      const response = await fetch('/api/aws/active-region');
      const result = await response.json();
      if (result.success && result.region) {
        form.setFieldValue('region', result.region);
      }
    } catch (error) {
      console.error('Error fetching active cluster AWS region:', error);
    }
  };

  // 获取FSx存储列表
  const fetchStorages = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/fsx-storages');
      const result = await response.json();
      if (result.success) {
        setStorages(result.storages || []);
        
        // 如果没有任何 FSx 配置，设置默认 name 为 fsx-claim
        if (result.storages.length === 0) {
          form.setFieldValue('name', 'fsx-claim');
        }
      }
    } catch (error) {
      console.error('Error fetching FSx storages:', error);
    } finally {
      setLoading(false);
    }
  };

  // 获取FSx文件系统信息
  const handleGetFSxInfo = async () => {
    const fileSystemId = form.getFieldValue('fileSystemId');
    const region = form.getFieldValue('region');

    if (!fileSystemId) {
      message.warning('Please input File System ID first');
      return;
    }

    try {
      setFsxInfoLoading(true);
      const response = await fetch('/api/fsx-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileSystemId, region })
      });

      const result = await response.json();
      if (result.success) {
        setFsxInfo(result.fsxInfo);
        message.success('FSx information retrieved successfully');
      } else {
        message.error(`Failed to get FSx info: ${result.error}`);
        setFsxInfo(null);
      }
    } catch (error) {
      console.error('Error getting FSx info:', error);
      message.error('Failed to get FSx information');
      setFsxInfo(null);
    } finally {
      setFsxInfoLoading(false);
    }
  };

  // 创建FSx存储配置
  const handleCreateStorage = async (values) => {
    try {
      setCreateLoading(true);
      const response = await fetch('/api/fsx-storages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });

      const result = await response.json();
      if (result.success) {
        message.success(`FSx storage ${values.name} created successfully`);
        form.resetFields();
        fetchClusterRegion(); // resetFields 会清空 region，而该字段不可编辑
        setFsxInfo(null);
        fetchStorages();
        onStorageChange && onStorageChange();
      } else {
        message.error(`Failed to create FSx storage: ${result.error}`);
      }
    } catch (error) {
      console.error('Error creating FSx storage:', error);
      message.error('Failed to create FSx storage');
    } finally {
      setCreateLoading(false);
    }
  };

  // 删除FSx存储配置
  const handleDeleteStorage = async (name) => {
    Modal.confirm({
      title: 'Delete FSx Storage',
      content: `Are you sure you want to delete storage "${name}"? This will remove the PV/PVC configuration.`,
      onOk: async () => {
        try {
          const response = await fetch(`/api/fsx-storages/${name}`, {
            method: 'DELETE'
          });

          const result = await response.json();
          if (result.success) {
            message.success(`FSx storage ${name} deleted successfully`);
            fetchStorages();
            onStorageChange && onStorageChange();
          } else {
            message.error(`Failed to delete FSx storage: ${result.error}`);
          }
        } catch (error) {
          console.error('Error deleting FSx storage:', error);
          message.error('Failed to delete FSx storage');
        }
      }
    });
  };

  useEffect(() => {
    fetchStorages();
    fetchClusterRegion();
  }, []);

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 120,
      render: (text) => <Text strong>{text}</Text>
    },
    {
      title: 'File System ID',
      dataIndex: 'fileSystemId',
      key: 'fileSystemId',
      width: 180,
      render: (text) => <Text code>{text}</Text>
    },
    {
      title: 'PVC Name',
      dataIndex: 'pvcName',
      key: 'pvcName',
      width: 120,
      render: (text) => <Text type="secondary">{text}</Text>
    },
    {
      title: 'Mount',
      dataIndex: 'mountName',
      key: 'mountName',
      width: 100
    },
    {
      title: 'AZ',
      key: 'az',
      width: 100,
      render: (_, record) => {
        const azs = Object.values(record.subnetAZs || {});
        const uniqueAZs = [...new Set(azs)];
        return (
          <Space direction="vertical" size="small">
            {uniqueAZs.map(az => (
              <Text key={az} style={{ fontSize: '11px' }}>{az}</Text>
            ))}
          </Space>
        );
      }
    },
    {
      title: 'Subnets',
      key: 'subnets',
      width: 180,
      render: (_, record) => (
        <Space direction="vertical" size="small">
          {(record.subnetIds || []).map(subnet => (
            <Text key={subnet} code style={{ fontSize: '11px' }}>{subnet}</Text>
          ))}
        </Space>
      )
    },
    {
      title: 'Security Groups',
      dataIndex: 'securityGroupIds',
      key: 'securityGroupIds',
      width: 150,
      render: (sgs) => (
        <Space direction="vertical" size="small">
          {(sgs || []).map(sg => (
            <Text key={sg} code style={{ fontSize: '11px' }}>{sg}</Text>
          ))}
        </Space>
      )
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status) => (
        <Tag color={status === 'Ready' ? 'green' : 'orange'} icon={<CheckCircleOutlined />}>
          {status}
        </Tag>
      )
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      fixed: 'right',
      render: (_, record) => (
        <Button
          type="text"
          danger
          icon={<DeleteOutlined />}
          onClick={() => handleDeleteStorage(record.name)}
        >
          Delete
        </Button>
      )
    }
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {/* 创建FSx存储 */}
      <Card
        title={
          <Space>
            <CloudOutlined />
            Create FSx Lustre Storage
          </Space>
        }
        size="small"
      >
        <Alert
          message='Use "fsx-claim" for first time config. Name is required for multiple FSx file systems.'
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />

        <Form
          form={form}
          layout="vertical"
          onFinish={handleCreateStorage}
        >
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="name"
                label="Storage Name"
                rules={[{ required: true, message: 'Please input storage name' }]}
              >
                <Input placeholder="fsx-claim" />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item
                name="fileSystemId"
                label="File System ID"
                rules={[{ required: true, message: 'Please input FSx file system ID' }]}
              >
                <Input placeholder="fs-0123456789abcdef" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                name="region"
                label="AWS Region"
                tooltip="The active cluster's Region. The FSx file system must be in the same Region and VPC as the cluster."
                rules={[{ required: true, message: 'Please input AWS region' }]}
              >
                <Input disabled />
              </Form.Item>
            </Col>
          </Row>

          {/* FSx 信息预览 */}
          {fsxInfo && (
            <Alert
              message="FSx File System Information"
              description={
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  <Text><strong>DNS Name:</strong> {fsxInfo.dnsName}</Text>
                  <Text><strong>Mount Name:</strong> {fsxInfo.mountName}</Text>
                  <Text><strong>Storage Capacity:</strong> {fsxInfo.storageCapacity} GB</Text>
                  <Text><strong>Lifecycle:</strong> {fsxInfo.lifecycle}</Text>
                  <Text>
                    <strong>Subnets:</strong> {(fsxInfo.subnetIds || []).map(subnet => {
                      const az = fsxInfo.subnetAZs?.[subnet];
                      return az ? `${subnet} (${az})` : subnet;
                    }).join(', ')}
                  </Text>
                  <Text><strong>Security Groups:</strong> {(fsxInfo.securityGroupIds || []).join(', ')}</Text>
                </Space>
              }
              type="success"
              showIcon
              closable
              onClose={() => setFsxInfo(null)}
              icon={<InfoCircleOutlined />}
              style={{ marginBottom: 16 }}
            />
          )}

          <Form.Item>
            <Space>
              <Button
                icon={<InfoCircleOutlined />}
                onClick={handleGetFSxInfo}
                loading={fsxInfoLoading}
              >
                Get FSx Info
              </Button>
              <Button
                type="primary"
                htmlType="submit"
                loading={createLoading}
                disabled={!fsxInfo}
              >
                Create FSx Provision
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>

      {/* FSx存储列表 */}
      <Card
        title="FSx Storage Configurations"
        extra={
          <Button
            type="text"
            icon={<ReloadOutlined />}
            onClick={fetchStorages}
            loading={loading}
          >
            Refresh
          </Button>
        }
      >
        <Table
          columns={columns}
          dataSource={storages}
          rowKey="name"
          loading={loading}
          size="small"
          pagination={false}
          scroll={{ x: 1200, y: 200 }}
        />
      </Card>
    </Space>
  );
};

export default FSxStorageManager;
