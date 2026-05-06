import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { selectDeploymentStatus } from '../store/selectors';
import {
  Form,
  Input, 
  Button, 
  Space, 
  Alert,
  Tooltip,
  Typography,
  Radio,
  Select
} from 'antd';
import { 
  RocketOutlined, 
  InfoCircleOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  GlobalOutlined,
  ThunderboltOutlined,
  LinkOutlined,
  ReloadOutlined
} from '@ant-design/icons';

const { Option } = Select;

const ServiceConfigPanel = ({ onDeploy }) => {
  const deploymentStatus = useSelector(selectDeploymentStatus);
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [modelPools, setModelPools] = useState([]);
  const [modelPoolsLoading, setModelPoolsLoading] = useState(false);

  // 获取可用的模型池
  const fetchModelPools = async () => {
    setModelPoolsLoading(true);
    try {
      console.log('🔍 Fetching model pools...');
      const response = await fetch('/api/deployments');
      const data = await response.json();
      
      console.log('📦 All deployments received:', data);
      
      // 过滤出模型池类型的部署
      const pools = data.filter(deployment => 
        deployment.deploymentType === 'model-pool' ||
        (deployment.labels && deployment.labels['deployment-type'] === 'model-pool')
      );
      
      console.log('🎯 Filtered model pools:', pools.length, pools.map(p => ({
        name: p.deploymentName,
        type: p.deploymentType,
        labels: p.labels
      })));
      
      setModelPools(pools);
    } catch (error) {
      console.error('❌ Error fetching model pools:', error);
    } finally {
      setModelPoolsLoading(false);
    }
  };

  useEffect(() => {
    fetchModelPools();
  }, []);

  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      await onDeploy(values);
    } catch (error) {
      console.error('Error in service deployment:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusAlert = () => {
    if (!deploymentStatus) return null;
    
    const { status, message } = deploymentStatus;
    
    if (status === 'success') {
      return (
        <Alert
          message="Service Deployment Successful"
          description={message}
          type="success"
          icon={<CheckCircleOutlined />}
          showIcon
          closable
          style={{ marginBottom: 16 }}
        />
      );
    } else if (status === 'error') {
      return (
        <Alert
          message="Service Deployment Failed"
          description={message}
          type="error"
          icon={<ExclamationCircleOutlined />}
          showIcon
          closable
          style={{ marginBottom: 16 }}
        />
      );
    }
    
    return null;
  };

  return (
    <>
      {getStatusAlert()}
      
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          serviceType: 'external'
        }}
      >
        <Form.Item
          label={
            <Space>
              Service Name
              <Tooltip title="Name for the business service (e.g., production-chat, testing-api)">
                <InfoCircleOutlined />
              </Tooltip>
            </Space>
          }
          name="serviceName"
          rules={[
            { required: true, message: 'Please input service name!' },
            { pattern: /^[a-z0-9-]+$/, message: 'Only lowercase letters, numbers and hyphens allowed' }
          ]}
        >
          <Input 
            placeholder="e.g., production-chat, testing-api"
            style={{ fontFamily: 'monospace' }}
          />
        </Form.Item>

        <Form.Item
          label={
            <Space>
              Model Pool
              <Tooltip title="Select the model pool to connect this service to">
                <InfoCircleOutlined />
              </Tooltip>
            </Space>
          }
        >
          <div style={{ display: 'flex', gap: '8px' }}>
            <Form.Item
              name="modelPool"
              rules={[{ required: true, message: 'Please select a model pool!' }]}
              style={{ flex: 1, marginBottom: 0 }}
              noStyle={false}
            >
              <Select
                placeholder={modelPools.length === 0 ? "No model pools found" : "Select model pool"}
                loading={modelPoolsLoading}
                notFoundContent={modelPoolsLoading ? "Loading..." : "No model pools available"}
                style={{ width: '100%' }}
              >
                {modelPools.map(pool => (
                  <Option key={pool.deploymentName} value={pool.deploymentName}>
                    {pool.deploymentName} ({pool.deploymentType}) - {pool.status}
                  </Option>
                ))}
              </Select>
            </Form.Item>
            <Button
              icon={<ReloadOutlined />}
              loading={modelPoolsLoading}
              onClick={fetchModelPools}
              title="Refresh model pools"
            />
          </div>
        </Form.Item>


        <Form.Item
          label={
            <Space>
              Service Type
              <Tooltip title="Select the service exposure type">
                <InfoCircleOutlined />
              </Tooltip>
            </Space>
          }
          name="serviceType"
          rules={[
            { required: true, message: 'Please select service type!' }
          ]}
        >
          <Radio.Group>
            <Radio value="external">
              <Space>
                <GlobalOutlined />
                External Access
              </Space>
            </Radio>
            <Radio value="clusterip">
              <Space>
                <LinkOutlined />
                Cluster IP
              </Space>
            </Radio>
          </Radio.Group>
        </Form.Item>

        <Form.Item>
          <Button 
            type="primary" 
            htmlType="submit" 
            loading={loading}
            icon={<RocketOutlined />}
            size="large"
            block
          >
            {loading ? 'Deploying Service...' : 'Deploy Business Service'}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
};

export default ServiceConfigPanel;
