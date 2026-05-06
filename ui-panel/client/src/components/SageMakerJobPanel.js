import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { selectDeploymentStatus } from '../store/selectors';
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
  Switch
} from 'antd';
import {
  CloudOutlined,
  PlayCircleOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  DatabaseOutlined,
  CloudServerOutlined
} from '@ant-design/icons';

const { TextArea } = Input;
const { Text } = Typography;

const SageMakerJobPanel = ({ onLaunch }) => {
  const deploymentStatus = useSelector(selectDeploymentStatus);
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const { saving, loadConfig, saveConfig } = useRecipeConfig({
    endpoint: '/api/sagemaker-config',
    form,
  });

  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      // 生成UUID后4位并添加到trainingJobName
      const uuid = Math.random().toString(36).substr(2, 4);
      const updatedValues = {
        ...values,
        trainingJobName: `${values.trainingJobName}-${uuid}`
      };

      await saveConfig({ silent: true, values: updatedValues }).catch(() => {});

      const response = await fetch('/api/launch-sagemaker-job', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatedValues),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();

      if (result.success) {
        console.log('SageMaker job launched successfully:', result.message);
      } else {
        throw new Error(result.error || 'Failed to launch SageMaker job');
      }
    } catch (error) {
      console.error('Error launching SageMaker job:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const getStatusAlert = () => {
    if (!deploymentStatus) return null;

    const { type, status, message: statusMessage } = deploymentStatus;
    
    if (type === 'sagemaker_launch') {
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
        onReload={() => loadConfig().catch(() => {})}
        reloadTooltip="Reload Configuration"
      />
      {getStatusAlert()}

      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          trainingJobName: 'sagemaker-job',
          dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
          instanceType: 'ml.g5.12xlarge',
          nprocPerNode: 1,
          replicas: 1,
          smJobDir: 'sample-job-1',
          entryPythonScriptPath: 'codes/launcher.py',
          pythonScriptParameters: '--learning_rate 1e-5 \\\n--batch_size 1',
          enableSpotTraining: false,
          maxWaitTimeInSeconds: 1800
        }}
      >
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <CloudOutlined />
                  <Text strong>Training Job Name</Text>
                </Space>
              }
              name="trainingJobName"
              rules={[
                { required: true, message: 'Please input training job name!' },
                { pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, message: 'Invalid job name format' }
              ]}
            >
              <Input placeholder="sagemaker-job-1" />
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
              rules={[{ required: true, message: 'Please input instance type!' }]}
            >
              <Input placeholder="ml.g5.12xlarge" />
            </Form.Item>
          </Col>
        </Row>

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
          <Input placeholder="633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest" />
        </Form.Item>

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <ThunderboltOutlined />
                  <Text strong>GPUs per Node</Text>
                </Space>
              }
              name="nprocPerNode"
              rules={[{ required: true, message: 'Please input number of GPUs per node!' }]}
            >
              <InputNumber min={1} max={64} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <ThunderboltOutlined />
                  <Text strong>Num Replicas</Text>
                </Space>
              }
              name="replicas"
              rules={[{ required: true, message: 'Please input replicas/the amount nodes!' }]}
            >
              <InputNumber min={1} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <DatabaseOutlined />
                  <Text strong>SageMaker Job Dir</Text>
                </Space>
              }
              name="smJobDir"
              rules={[{ required: true, message: 'Please input SageMaker job directory!' }]}
            >
              <Input placeholder="sample-job-1" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <CodeOutlined />
                  <Text strong>Entry Python Script Path</Text>
                </Space>
              }
              name="entryPythonScriptPath"
              rules={[
                { required: true, message: 'Please input entry Python script path!' }
              ]}
            >
              <Input placeholder="codes/launcher.py" />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          label={
            <Space>
              <CodeOutlined />
              <Text strong>Python Script Parameters</Text>
            </Space>
          }
          name="pythonScriptParameters"
          rules={[{ required: true, message: 'Please input Python script parameters!' }]}
          extra="Command line arguments for the Python script"
        >
          <TextArea
            rows={3}
            placeholder="--learning_rate 1e-5 \
--batch_size 1"
          />
        </Form.Item>

        <Form.Item
          label={
            <Space>
              <Text strong>Enable Spot Training</Text>
            </Space>
          }
          name="enableSpotTraining"
          valuePropName="checked"
          extra="Use managed spot training to reduce costs"
        >
          <Switch />
        </Form.Item>

        <Form.Item style={{ marginTop: 24 }}>
          <Button
            type="primary"
            htmlType="submit"
            icon={<PlayCircleOutlined />}
            loading={loading}
            size="large"
            className="training-btn"
            block
          >
            Launch SageMaker Training Job
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default SageMakerJobPanel;
