import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { selectDeploymentStatus } from '../store/selectors';
import useInstanceInfo from '../hooks/useInstanceInfo';
import { useRecipeConfig } from '../utils/useRecipeConfig';
import RecipeConfigActions from './RecipeConfigActions';
import {
  Form,
  Input,
  InputNumber,
  Button,
  Space,
  Row,
  Col,
  Alert,
  Typography,
  Select,
  Checkbox
} from 'antd';
import {
  RocketOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  DatabaseOutlined,
  CloudServerOutlined
} from '@ant-design/icons';

const { Text } = Typography;

const VerlRecipePanel = ({ onLaunch, hyperPodInstanceTypes, instanceTypesLoading, refreshInstanceTypes }) => {
  const deploymentStatus = useSelector(selectDeploymentStatus);
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const { fetchInstanceInfo, infoLoading } = useInstanceInfo(form, { gpu: 'gpuPerNode', efa: 'efaPerNode' });

  const { saving, loadConfig, saveConfig } = useRecipeConfig({
    endpoint: '/api/verl-config',
    form,
  });

  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      await saveConfig({ silent: true, values }).catch(() => {});
      await onLaunch({ ...values, recipeType: 'verl' });
    } finally {
      setLoading(false);
    }
  };

  const getStatusAlert = () => {
    if (!deploymentStatus) return null;

    const { type, status, message: statusMessage } = deploymentStatus;
    
    if (type === 'training_launch') {
      return (
        <Alert
          message={statusMessage}
          type={status === 'success' ? 'success' : 'error'}
          showIcon
          style={{ marginBottom: 16 }}
        />
      );
    }
    
    return null;
  };

  return (
    <div>
      <RecipeConfigActions
        saving={saving}
        onSave={() => saveConfig()}
        onReload={async () => {
          await loadConfig().catch(() => {});
          await refreshInstanceTypes?.();
        }}
        reloadTooltip="Reload Configuration and Refresh Instance Types"
      />
      {getStatusAlert()}

      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          jobName: 'verl-training-a1',
          instanceType: '',
          entryPointPath: '/s3/train-recipes/verl-project/src/qwen-3b-grpo-kuberay.sh',
          dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/hypd-verl:latest',
          workerReplicas: 1,
          gpuPerNode: 4,
          efaPerNode: 1,
          mounts: ['s3']
        }}
      >
        {/* 基础配置 */}
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <RocketOutlined />
                  <Text strong>Job Name</Text>
                </Space>
              }
              name="jobName"
              rules={[
                { required: true, message: 'Please input job name!' },
                { pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, message: 'Invalid job name format' }
              ]}
            >
              <Input placeholder="verl-training-a1" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <CloudServerOutlined />
                  <Text strong>Instance Type</Text>
                </Space>
              }
              name="instanceType"
              rules={[{ required: true, message: 'Please select instance type!' }]}
            >
              <Select
                placeholder="Select HyperPod instance type"
                options={hyperPodInstanceTypes}
                loading={instanceTypesLoading}
                showSearch
                filterOption={(inputValue, option) =>
                  option.label.toLowerCase().indexOf(inputValue.toLowerCase()) !== -1
                }
                onSelect={(value, option) => {
                  // 如果选择的是从集群获取的选项，提取实例类型；否则使用原值
                  const instanceType = option.instanceType || value.split('-')[0];
                  form.setFieldValue('instanceType', instanceType);
                  fetchInstanceInfo(instanceType);
                }}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>

        {/* Docker Image - 单独一行 */}
        <Form.Item
          label={
            <Space>
              <DatabaseOutlined />
              <Text strong>Docker Image</Text>
            </Space>
          }
          name="dockerImage"
          rules={[{ required: true, message: 'Please input docker image!' }]}
        >
          <Input placeholder="633205212955.dkr.ecr.us-west-2.amazonaws.com/hypd-verl:latest" />
        </Form.Item>

        {/* 挂载选择：S3 默认勾选，FSx 可选；勾选项会注入到 RayJob YAML 的 volumes/volumeMounts */}
        <Form.Item
          label={
            <Space>
              <DatabaseOutlined />
              <Text strong>Storage Mounts</Text>
            </Space>
          }
          name="mounts"
          extra="S3 mounts at /s3, FSx at /fsx. Select what to mount into head & worker pods."
        >
          <Checkbox.Group
            options={[
              { label: 'S3 (/s3, s3-claim)', value: 's3' },
              { label: 'FSx (/fsx, fsx-claim)', value: 'fsx' },
            ]}
          />
        </Form.Item>

        {/* Entry Point配置 */}
        <Form.Item
          label={
            <Space>
              <CodeOutlined />
              <Text strong>Entry Point Script Path</Text>
            </Space>
          }
          name="entryPointPath"
          rules={[{ required: true, message: 'Please input entry point path!' }]}
        >
          <Input placeholder="/s3/train-recipes/verl-project/src/qwen-3b-grpo-kuberay.sh" />
        </Form.Item>

        {/* 资源配置 */}
        <Row gutter={16}>
          <Col span={6}>
            <Form.Item
              label={
                <Space>
                  <ThunderboltOutlined />
                  <Text strong>Num Node for Header</Text>
                </Space>
              }
              extra="at least 1 header replica is required"
            >
              <InputNumber value={1} disabled style={{ width: '100%', color: '#999' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label={
                <Space>
                  <ThunderboltOutlined />
                  <Text strong>Num Nodes for Worker</Text>
                </Space>
              }
              name="workerReplicas"
              rules={[{ required: true, message: 'Please input worker replicas!' }]}
              extra="0-N workers (0 means head and worker on one single node)"
            >
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label={
                <Space>
                  <SettingOutlined />
                  <Text strong>Request Num of GPUs per Node</Text>
                </Space>
              }
              name="gpuPerNode"
              rules={[{ required: true, message: 'Please input GPU count!' }]}
            >
              <InputNumber min={1} max={8} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label={
                <Space>
                  <SettingOutlined />
                  <Text strong>Request Num of EFAs per Node</Text>
                </Space>
              }
              name="efaPerNode"
              rules={[{ required: true, message: 'Please input EFA count!' }]}
            >
              <InputNumber min={0} max={32} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        {/* 部署按钮 */}
        <Form.Item style={{ marginTop: 24 }}>
          <Button
            type="primary"
            htmlType="submit"
            icon={<PlayCircleOutlined />}
            loading={loading}
            disabled={infoLoading}
            size="large"
            block
          >
            Launch Ray Training
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default VerlRecipePanel;
