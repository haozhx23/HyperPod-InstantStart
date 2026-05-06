import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { selectDeploymentStatus } from '../store/selectors';
import useInstanceInfo from '../hooks/useInstanceInfo';
import { useRecipeConfig } from '../utils/useRecipeConfig';
import RecipeConfigActions from './RecipeConfigActions';
import EnvVarListField from './EnvVarListField';
import {
  Form, Input, InputNumber, Button, Space, Row, Col, Alert, Typography, Select, Tooltip
} from 'antd';
import {
  RocketOutlined, PlayCircleOutlined, SettingOutlined, ThunderboltOutlined,
  CodeOutlined, DatabaseOutlined, CloudServerOutlined
} from '@ant-design/icons';

const { Text } = Typography;

const HyperPodJobPanel = ({ onLaunch, hyperPodInstanceTypes, instanceTypesLoading, refreshInstanceTypes }) => {
  const deploymentStatus = useSelector(selectDeploymentStatus);
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const { fetchInstanceInfo, infoLoading } = useInstanceInfo(form, { gpu: 'nprocPerNode', efa: 'efaPerNode' });

  const { saving, loadConfig, saveConfig } = useRecipeConfig({
    endpoint: '/api/hyperpodrun-job-config',
    form,
  });

  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      await saveConfig({ silent: true, values }).catch(() => {});
      await onLaunch({ ...values, recipeType: 'hyperpodrun-job' });
    } finally {
      setLoading(false);
    }
  };

  const getStatusAlert = () => {
    if (!deploymentStatus) return null;
    const { type, status, message: statusMessage } = deploymentStatus;
    if (type === 'training_launch') {
      return <Alert message={statusMessage} type={status === 'success' ? 'success' : 'error'} showIcon style={{ marginBottom: 16 }} />;
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

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Entry script runs via HyperPodPyTorchJob. Operator injects NNODES and NPROC_PER_NODE; your script calls hyperpodrun itself."
      />

      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          jobName: 'hyperpodrun-job-1',
          dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
          instanceType: '',
          entryScriptPath: '/fsx/my-project/run.sh',
          replicas: 1,
          nprocPerNode: 1,
          efaPerNode: 0,
          envVars: [],
        }}
      >
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={<Space><RocketOutlined /><Text strong>Job Name</Text></Space>}
              name="jobName"
              rules={[
                { required: true, message: 'Please input job name!' },
                { pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, message: 'Invalid job name format' }
              ]}
            >
              <Input placeholder="hyperpodrun-job-1" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label={<Space><CloudServerOutlined /><Text strong>Instance Type</Text></Space>}
              name="instanceType"
              rules={[{ required: true, message: 'Please select instance type!' }]}
            >
              <Select
                placeholder="Select HyperPod instance type"
                options={hyperPodInstanceTypes}
                loading={instanceTypesLoading}
                showSearch
                filterOption={(input, option) => option.label.toLowerCase().includes(input.toLowerCase())}
                onSelect={(value, option) => {
                  const instanceType = option.instanceType || value.split('-')[0];
                  form.setFieldValue('instanceType', instanceType);
                  fetchInstanceInfo(instanceType);
                }}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          label={<Space><DatabaseOutlined /><Text strong>Docker Image</Text></Space>}
          name="dockerImage"
          rules={[{ required: true, message: 'Please input docker image!' }]}
        >
          <Input placeholder="e.g. <acct>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>" />
        </Form.Item>

        <Form.Item
          label={
            <Tooltip title="Absolute path inside container. /s3 and /fsx are pre-mounted.">
              <Space><CodeOutlined /><Text strong>Entry Script Path (.sh)</Text></Space>
            </Tooltip>
          }
          name="entryScriptPath"
          rules={[{ required: true, message: 'Please input entry script path!' }]}
        >
          <Input placeholder="/fsx/my-project/run.sh" />
        </Form.Item>

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item
              label={<Space><ThunderboltOutlined /><Text strong>Replicas (Nodes)</Text></Space>}
              name="replicas"
              rules={[{ required: true, message: 'Required' }]}
            >
              <InputNumber min={1} max={64} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={<Space><SettingOutlined /><Text strong>GPUs per Node (nprocPerNode)</Text></Space>}
              name="nprocPerNode"
              rules={[{ required: true, message: 'Required' }]}
            >
              <InputNumber min={1} max={8} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={<Space><SettingOutlined /><Text strong>EFAs per Node</Text></Space>}
              name="efaPerNode"
              rules={[{ required: true, message: 'Required' }]}
            >
              <InputNumber min={0} max={32} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <EnvVarListField />

        <Form.Item style={{ marginTop: 24 }}>
          <Button type="primary" htmlType="submit" icon={<PlayCircleOutlined />} loading={loading} disabled={infoLoading} size="large" block>
            Launch HyperPod Job
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default HyperPodJobPanel;
