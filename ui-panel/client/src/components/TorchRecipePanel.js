import React, { useState, useEffect, useRef } from 'react';
import {
  Card,
  Form,
  Input,
  InputNumber,
  Button,
  Space,
  Row,
  Col,
  Alert,
  Collapse,
  Typography,
  message,
  Tooltip
} from 'antd';
import {
  FireOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  ReloadOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  DatabaseOutlined,
  CloudServerOutlined
} from '@ant-design/icons';

const { TextArea } = Input;
const { Panel } = Collapse;
const { Text } = Typography;

const TorchRecipePanel = ({ onLaunch, deploymentStatus }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showLogMonitoring, setShowLogMonitoring] = useState(false);
  const hasLoadedConfig = useRef(false); // 使用useRef防止重复加载

  // 加载保存的配置
  useEffect(() => {
    if (!hasLoadedConfig.current) {
      hasLoadedConfig.current = true;
      loadSavedConfig();
    }
  }, []);

  const loadSavedConfig = async () => {
    try {
      const response = await fetch('/api/torch-config/load');
      const result = await response.json();
      
      if (result.success) {
        form.setFieldsValue(result.config);
        if (result.config.logMonitoringConfig && result.config.logMonitoringConfig.trim() !== '') {
          setShowLogMonitoring(true);
        }
        
        if (!result.isDefault) {
          message.success('Previous configuration loaded');
        }
      }
    } catch (error) {
      console.error('Error loading config:', error);
      message.error('Failed to load saved configuration');
    }
  };

  const saveConfig = async () => {
    try {
      setSaving(true);
      const values = await form.validateFields();
      
      const response = await fetch('/api/torch-config/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });
      
      const result = await response.json();
      
      if (result.success) {
        message.success('Configuration saved successfully');
      } else {
        message.error(`Failed to save configuration: ${result.error}`);
      }
    } catch (error) {
      console.error('Error saving config:', error);
      message.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      // 自动保存配置
      await fetch('/api/torch-config/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });
      
      // 启动torch训练任务 - 直接调用torch训练API
      const response = await fetch('/api/launch-torch-training', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });
      
      const result = await response.json();
      
      if (result.success) {
        // 训练任务启动成功，不需要再调用onLaunch
        console.log('Torch training job launched successfully:', result.message);
      } else {
        throw new Error(result.error || 'Failed to launch torch training');
      }
    } catch (error) {
      console.error('Error launching torch training:', error);
      throw error;
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
    <Card 
      title={
        <Space>
          <FireOutlined />
          Torch Recipe
        </Space>
      }
      extra={
        <Space>
          <Tooltip title="Save Configuration">
            <Button 
              icon={<SaveOutlined />} 
              onClick={saveConfig}
              loading={saving}
              size="small"
            />
          </Tooltip>
          <Tooltip title="Reload Configuration">
            <Button 
              icon={<ReloadOutlined />} 
              onClick={loadSavedConfig}
              size="small"
            />
          </Tooltip>
        </Space>
      }
    >
      {getStatusAlert()}
      
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          trainingJobName: 'hypd-recipe-torch-1',
          dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
          instanceType: 'ml.g5.12xlarge',
          nprocPerNode: 1,
          replicas: 1,
          efaCount: 16,
          entryPythonScriptPath: '/s3/training_code/model-training-with-hyperpod-training-operator/torch-training.py',
          pythonScriptParameters: '--learning_rate 1e-5 \\\n--batch_size 1',
          mlflowTrackingUri: '',
          logMonitoringConfig: ''
        }}
      >
        {/* 基础配置 */}
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <FireOutlined />
                  <Text strong>Training Job Name</Text>
                </Space>
              }
              name="trainingJobName"
              rules={[
                { required: true, message: 'Please input training job name!' },
                { pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, message: 'Invalid job name format' }
              ]}
            >
              <Input placeholder="hypd-recipe-torch-1" />
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
          <Input placeholder="633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest" />
        </Form.Item>

        {/* 资源配置 */}
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <SettingOutlined />
                  <Text strong>Num Proc Per Node</Text>
                </Space>
              }
              name="nprocPerNode"
              rules={[{ required: true, message: 'Please input number of processes/gpus per node!' }]}
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
                  <SettingOutlined />
                  <Text strong>EFA Count</Text>
                </Space>
              }
              name="efaCount"
              rules={[{ required: true, message: 'Please input EFA count!' }]}
            >
              <InputNumber min={0} max={32} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        {/* Python脚本配置 */}
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
          <Input placeholder="/s3/training_code/model-training-with-hyperpod-training-operator/torch-training.py" />
        </Form.Item>

        {/* Python脚本参数 */}
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

        {/* MLFlow配置 */}
        <Form.Item
          label={
            <Space>
              <DatabaseOutlined />
              <Text strong>SageMaker MLFlow ARN (Optional)</Text>
            </Space>
          }
          name="mlflowTrackingUri"
          rules={[
            { 
              pattern: /^(arn:aws:sagemaker:|$)/, 
              message: 'Must be a valid SageMaker ARN or leave empty to disable MLFlow' 
            }
          ]}
          extra="Leave empty to disable MLFlow tracking for this training job"
        >
          <Input placeholder="" />
        </Form.Item>

        {/* 高级配置 - 可折叠 */}
        <Collapse 
          ghost
          onChange={(keys) => setShowLogMonitoring(keys.includes('logMonitoring'))}
        >
          <Panel 
            header={
              <Space>
                <SettingOutlined />
                <Text strong>Advanced Settings</Text>
              </Space>
            } 
            key="logMonitoring"
          >
            <Form.Item
              label={
                <Space>
                  <DatabaseOutlined />
                  <Text strong>Log Monitoring Configuration (Optional)</Text>
                </Space>
              }
              name="logMonitoringConfig"
              extra="YAML format configuration for log monitoring"
            >
              <TextArea
                rows={6}
                placeholder={`logMonitoringConfiguration: 
  - name: "JobStart"
    logPattern: ".*Experiment configuration.*"
    expectedStartCutOffInSeconds: 120
  - name: "HighLossDetection"
    logPattern: ".*\\[train\\.py:\\d+\\] Batch \\d+ Loss: (\\d+\\.\\d+).*"
    metricThreshold: 1
    operator: "lteq"
    metricEvaluationDataPoints: 100`}
              />
            </Form.Item>
          </Panel>
        </Collapse>

        {/* 部署按钮 */}
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
            Launch Training Job
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
};

export default TorchRecipePanel;
