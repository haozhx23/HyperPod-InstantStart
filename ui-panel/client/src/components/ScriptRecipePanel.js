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
  Collapse,
  Typography,
  Select
} from 'antd';
import {
  CodeOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  FolderOutlined,
  FileOutlined,
  CloudServerOutlined
} from '@ant-design/icons';

const { TextArea } = Input;
const { Panel } = Collapse;
const { Text } = Typography;

const ScriptRecipePanel = ({ onLaunch, hyperPodInstanceTypes, instanceTypesLoading, refreshInstanceTypes }) => {
  const deploymentStatus = useSelector(selectDeploymentStatus);
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const { fetchInstanceInfo, infoLoading } = useInstanceInfo(form, { gpu: 'nprocPerNode', efa: 'efaCount' });

  const { saving, loadConfig, saveConfig } = useRecipeConfig({
    endpoint: '/api/script-config',
    form,
  });

  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      await saveConfig({ silent: true, values }).catch(() => {});
      await onLaunch({ ...values, recipeType: 'script' });
    } catch (error) {
      console.error('Error launching script training:', error);
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
          trainingJobName: 'hypd-recipe-script-1',
          dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
          instanceType: '',
          nprocPerNode: 1,
          replicas: 1,
          efaCount: 16,
          projectPath: '/s3/training_code/my-training-project/',
          entryPath: 'train.py',
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
                  <CodeOutlined />
                  <Text strong>Training Job Name</Text>
                </Space>
              }
              name="trainingJobName"
              rules={[
                { required: true, message: 'Please input training job name!' },
                { pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, message: 'Invalid job name format' }
              ]}
            >
              <Input placeholder="hypd-recipe-script-1" />
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
              <CloudServerOutlined />
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
          <Col span={8}>
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
          <Col span={8}>
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
          <Col span={8}>
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

        {/* Script配置 - 核心部分 */}
        <Row gutter={16}>
          <Col span={16}>
            <Form.Item
              label={
                <Space>
                  <FolderOutlined />
                  <Text strong>Project Path</Text>
                </Space>
              }
              name="projectPath"
              rules={[
                { required: true, message: 'Please input project path!' },
                { pattern: /^\//, message: 'Project path must start with /' }
              ]}
              extra="The root directory of your training project (e.g., /s3/training_code/my-project/)"
            >
              <Input placeholder="/s3/training_code/my-training-project/" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <FileOutlined />
                  <Text strong>Entry Script</Text>
                </Space>
              }
              name="entryPath"
              rules={[
                { required: true, message: 'Please input entry script path!' }
              ]}
              extra="Relative to project path"
            >
              <Input placeholder="train.py" />
            </Form.Item>
          </Col>
        </Row>

        {/* MLFlow配置 */}
        <Form.Item
          label={
            <Space>
              <CloudServerOutlined />
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
        <Collapse ghost>
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
                  <SettingOutlined />
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
    logPattern: ".*Training started.*"
    expectedStartCutOffInSeconds: 120
  - name: "HighLossDetection"
    logPattern: ".*Loss: (\\d+\\.\\d+).*"
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
            disabled={infoLoading}
            size="large"
            className="training-btn"
            block
          >
            Launch Script Training Job
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default ScriptRecipePanel;
