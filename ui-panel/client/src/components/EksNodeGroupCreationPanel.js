import React, { useState, useEffect } from 'react';
import { Card, Form, Input, Select, InputNumber, Button, Switch, message, Space, Typography, AutoComplete } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

const { Text } = Typography;
const { Option } = Select;

const EksNodeGroupCreationPanel = ({ onCreated }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [clusterInfo, setClusterInfo] = useState(null);
  const [eksSecurityGroup, setEksSecurityGroup] = useState(null);
  const [availabilityZones, setAvailabilityZones] = useState([]);
  const [azLoading, setAzLoading] = useState(false);
  const [instanceTypeOptions, setInstanceTypeOptions] = useState([]);

  useEffect(() => {
    fetchClusterInfo();
    fetch('/api/config/instance-type-options').then(r => r.json()).then(d => {
      if (d.success) setInstanceTypeOptions(d.instanceTypes.map(t => t.replace(/^ml\./, '')));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (clusterInfo?.region) {
      fetchAvailabilityZones(clusterInfo.region);
    }
  }, [clusterInfo?.region]);

  const fetchClusterInfo = async () => {
    try {
      const response = await fetch('/api/cluster/subnets');
      const result = await response.json();

      if (result.success) {
        setClusterInfo({
          eksClusterName: result.data.eksClusterName,
          region: result.data.region,
          vpcId: result.data.vpcId
        });
        setEksSecurityGroup(result.data.securityGroupId);
      } else {
        message.error(`Failed to fetch cluster info: ${result.error}`);
      }
    } catch (error) {
      message.error(`Error fetching cluster info: ${error.message}`);
    }
  };

  const fetchAvailabilityZones = async (region) => {
    setAzLoading(true);
    try {
      const response = await fetch(`/api/cluster/availability-zones?region=${region}`);
      const result = await response.json();
      if (result.success) {
        setAvailabilityZones(result.zones || []);
      }
    } catch (error) {
      console.error('Error fetching availability zones:', error);
    } finally {
      setAzLoading(false);
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);

      const response = await fetch('/api/cluster/create-nodegroup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userConfig: values
        }),
      });

      const result = await response.json();

      if (result.success) {
        message.success('EKS node group creation started successfully!');
        form.resetFields();
        if (onCreated) {
          onCreated();
        }
      } else {
        message.error(`Failed to create node group: ${result.error}`);
      }
    } catch (error) {
      message.error(`Error creating node group: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="Create EKS Node Group" size="small">
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          minSize: 0,
          maxSize: 3,
          desiredCapacity: 1,
          volumeSize: 200,
          useSpotInstances: false
        }}
      >
        {/* 只读集群信息 */}
        <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
          <Text type="secondary">
            <strong>EKS Cluster:</strong> {clusterInfo?.eksClusterName || 'Loading...'}
          </Text>
          <Text type="secondary">
            <strong>Region:</strong> {clusterInfo?.region || 'Loading...'}
          </Text>
          <Text type="secondary">
            <strong>VPC:</strong> {clusterInfo?.vpcId || 'Loading...'}
          </Text>
          <Text type="secondary">
            <strong>Security Group:</strong> {eksSecurityGroup || 'Loading...'}
          </Text>
        </Space>

        <Form.Item
          name="nodeGroupName"
          label="Node Group Name"
          rules={[{ required: true, message: 'Please input node group name!' }]}
        >
          <Input placeholder="gpu-nodegroup-1" />
        </Form.Item>

        <Form.Item
          name="availabilityZone"
          label="Availability Zone"
          rules={[{ required: true, message: 'Please select availability zone!' }]}
        >
          <Select placeholder="Select availability zone" loading={azLoading}>
            {availabilityZones.map(az => (
              <Option key={az.ZoneName} value={az.ZoneName}>
                {az.ZoneName} ({az.ZoneId})
              </Option>
            ))}
          </Select>
        </Form.Item>

        <Form.Item
          name="instanceType"
          label="Instance Type"
          rules={[{ required: true, message: 'Please select or input instance type!' }]}
        >
          <AutoComplete
            placeholder="Select or type GPU instance type"
            options={instanceTypeOptions.map(type => ({ value: type, label: type }))}
            filterOption={(inputValue, option) =>
              option.value.toLowerCase().indexOf(inputValue.toLowerCase()) !== -1
            }
          />
        </Form.Item>

        <Space style={{ width: '100%' }}>
          <Form.Item
            name="minSize"
            label="Min Size"
            rules={[{ required: true, message: 'Required!' }]}
          >
            <InputNumber min={0} max={100} style={{ width: 80 }} />
          </Form.Item>

          <Form.Item
            name="maxSize"
            label="Max Size"
            rules={[{ required: true, message: 'Required!' }]}
          >
            <InputNumber min={1} max={100} style={{ width: 80 }} />
          </Form.Item>

          <Form.Item
            name="desiredCapacity"
            label="Desired"
            rules={[{ required: true, message: 'Required!' }]}
          >
            <InputNumber min={0} max={100} style={{ width: 80 }} />
          </Form.Item>

          <Form.Item
            name="volumeSize"
            label="Volume Size (GB)"
            rules={[{ required: true, message: 'Required!' }]}
          >
            <InputNumber min={20} max={1000} style={{ width: 120 }} />
          </Form.Item>
        </Space>

        <Form.Item name="useSpotInstances" label="Use Spot Instances" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item
          name="capacityReservationId"
          label="Capacity Reservation ID (Optional)"
          extra="For Capacity Block instances. If provided, Spot option will be ignored."
        >
          <Input placeholder="cr-0123456789abcdef0" />
        </Form.Item>

        <Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            icon={<PlusOutlined />}
            block
          >
            Create Node Group
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
};

export default EksNodeGroupCreationPanel;
