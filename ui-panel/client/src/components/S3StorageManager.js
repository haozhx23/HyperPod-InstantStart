import React, { useState, useEffect } from 'react';
import { Card, Form, Input, Button, Table, Space, message, Modal, Typography, Tag, Row, Col, Alert } from 'antd';
import { CloudOutlined, DeleteOutlined, CheckCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import operationRefreshManager from '../hooks/useOperationRefresh';

const { Text } = Typography;

const S3StorageManager = ({ onStorageChange }) => {
  const [form] = Form.useForm();
  const [storages, setStorages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);

  // 获取默认值
  const fetchDefaults = async () => {
    try {
      const response = await fetch('/api/s3-storage-defaults');
      const result = await response.json();
      if (result.success && result.defaults) {
        form.setFieldsValue(result.defaults);
        setDefaultsLoaded(true);
      }
    } catch (error) {
      console.error('Error fetching S3 storage defaults:', error);
    }
  };

  // 获取S3存储列表
  const fetchStorages = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/s3-storages');
      const result = await response.json();
      if (result.success) {
        setStorages(result.storages || []);
      }
    } catch (error) {
      console.error('Error fetching S3 storages:', error);
    } finally {
      setLoading(false);
    }
  };

  // 创建S3存储配置
  const handleCreateStorage = async (values) => {
    try {
      setCreateLoading(true);
      const response = await fetch('/api/s3-storages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      
      const result = await response.json();
      if (result.success) {
        message.success(`S3 storage ${values.name} created successfully`);
        form.resetFields();
        fetchStorages();
        onStorageChange && onStorageChange(); // 触发父组件刷新
      } else {
        message.error(`Failed to create S3 storage: ${result.error}`);
      }
    } catch (error) {
      console.error('Error creating S3 storage:', error);
      message.error('Failed to create S3 storage');
    } finally {
      setCreateLoading(false);
    }
  };

  // 删除S3存储配置
  const handleDeleteStorage = async (name) => {
    Modal.confirm({
      title: 'Delete S3 Storage',
      content: `Are you sure you want to delete storage "${name}"? This will remove the PV/PVC configuration.`,
      onOk: async () => {
        try {
          const response = await fetch(`/api/s3-storages/${name}`, {
            method: 'DELETE'
          });
          
          const result = await response.json();
          if (result.success) {
            message.success(`S3 storage ${name} deleted successfully`);
            fetchStorages();
            onStorageChange && onStorageChange(); // 触发父组件刷新
          } else {
            message.error(`Failed to delete S3 storage: ${result.error}`);
          }
        } catch (error) {
          console.error('Error deleting S3 storage:', error);
          message.error('Failed to delete S3 storage');
        }
      }
    });
  };

  useEffect(() => {
    fetchStorages();
    fetchDefaults(); // 获取默认值（含 region）
    
    // 注册操作刷新监听
    const componentId = 's3-storage-manager';
    const unsubscribe = operationRefreshManager.subscribe(componentId, async () => {
      console.log('🔄 S3 Storage Manager: refresh triggered');
      await fetchStorages();
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (text) => <Text strong>{text}</Text>
    },
    {
      title: 'Bucket',
      dataIndex: 'bucketName',
      key: 'bucketName',
      render: (text) => <Text code>{text}</Text>
    },
    {
      title: 'Region',
      dataIndex: 'region',
      key: 'region'
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status) => (
        <Tag color={status === 'Ready' ? 'green' : 'orange'} icon={<CheckCircleOutlined />}>
          {status}
        </Tag>
      )
    },
    {
      title: 'PVC Name',
      dataIndex: 'pvcName',
      key: 'pvcName',
      render: (text) => <Text type="secondary">{text}</Text>
    },
    {
      title: 'Actions',
      key: 'actions',
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
        {/* 创建S3存储 */}
        <Card 
          title={
            <Space>
              <CloudOutlined />
              Create S3 Storage
            </Space>
          }
          size="small"
        >
          <Alert
            message='Use "s3-claim" and filled bucket name for first time config.'
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
                  <Input placeholder="Default: s3-claim" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  name="bucketName"
                  label="S3 Bucket Name"
                  rules={[{ required: true, message: 'Please input S3 bucket name' }]}
                >
                  <Input placeholder="Auto-detected from container" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  name="region"
                  label="AWS Region"
                  rules={[{ required: true, message: 'Please input AWS region' }]}
                >
                  <Input disabled />
                </Form.Item>
              </Col>
            </Row>
            
            <Form.Item>
              <Button 
                type="primary" 
                htmlType="submit" 
                loading={createLoading}
              >
                Create S3 Provision
              </Button>
            </Form.Item>
          </Form>
        </Card>

        {/* S3存储列表 */}
        <Card 
          title="S3 Storage Configurations"
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
            scroll={{ y: 200 }}
          />
        </Card>
      </Space>
    
  );
};

export default S3StorageManager;
