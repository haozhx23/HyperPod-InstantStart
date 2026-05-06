import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  Tooltip,
  Select,
  AutoComplete
} from 'antd';
import {
  ExperimentOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  DatabaseOutlined,
  CloudServerOutlined,
  QuestionCircleOutlined
} from '@ant-design/icons';

const { TextArea } = Input;
const { Panel } = Collapse;
const { Text } = Typography;

const MSSwiftRecipePanel = ({ onLaunch, hyperPodInstanceTypes, instanceTypesLoading, refreshInstanceTypes }) => {
  const deploymentStatus = useSelector(selectDeploymentStatus);
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const { fetchInstanceInfo, infoLoading } = useInstanceInfo(form, { gpu: 'nprocPerNode', efa: 'efaCount' });
  const [commandOptions, setCommandOptions] = useState([]);
  const [commandsMap, setCommandsMap] = useState({});
  const loadedCommandsRef = useRef(false);

  const { saving, loadConfig, saveConfig } = useRecipeConfig({
    endpoint: '/api/msswift-config',
    form,
  });

  const loadCommandOptions = useCallback(async () => {
    try {
      const response = await fetch('/api/msswift-commands');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (!result.success) throw new Error(result.error || 'Load commands failed');

      setCommandsMap(result.commands);
      setCommandOptions(Object.keys(result.commands).map((key) => ({ label: key, value: key })));
    } catch (error) {
      console.error('Error loading MS-Swift commands:', error);
    }
  }, []);

  useEffect(() => {
    if (loadedCommandsRef.current) return;
    loadedCommandsRef.current = true;
    loadCommandOptions();
  }, [loadCommandOptions]);

  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      await saveConfig({ silent: true, values }).catch(() => {});

      // 将 key 转换为 value 用于 YAML 填充
      let commandValue = commandsMap[values.msswiftCommandType];
      if (!commandValue) {
        // 手动输入的命令，根据前缀自动转换
        const input = values.msswiftCommandType.trim();
        if (input.startsWith('swift ')) {
          commandValue = `swift.cli.${input.substring(6)}`;
        } else if (input.startsWith('megatron ')) {
          commandValue = `swift.cli._megatron.${input.substring(9)}`;
        } else {
          // 其他情况直接透传
          commandValue = input;
        }
      }
      
      await onLaunch({ 
        ...values, 
        msswiftCommandType: commandValue,
        recipeType: 'msswift' 
      });
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
          await Promise.allSettled([
            loadConfig(),
            loadCommandOptions(),
            refreshInstanceTypes?.(),
          ]);
        }}
        reloadTooltip="Reload Configuration, Commands and Instance Types"
      />
      {getStatusAlert()}

      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
      >
        {/* 基础配置 */}
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <ExperimentOutlined />
                  <Text strong>Job Name</Text>
                </Space>
              }
              name="trainingJobName"
              rules={[
                { required: true, message: 'Please input training job name!' },
                { pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, message: 'Invalid job name format' }
              ]}
            >
              <Input placeholder="msswift-1" />
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

        {/* Docker Image */}
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
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <SettingOutlined />
                  <Text strong>Request Num of EFAs per Node</Text>
                </Space>
              }
              name="efaCount"
              rules={[{ required: true, message: 'Please input EFA count!' }]}
            >
              <InputNumber min={0} max={32} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <SettingOutlined />
                  <Text strong>Request Num of GPUs per Node</Text>
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
                  <Text strong>Request Num of Nodes</Text>
                </Space>
              }
              name="replicas"
              rules={[{ required: true, message: 'Please input replicas/the amount nodes!' }]}
            >
              <InputNumber min={1} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        {/* MS-Swift配置 */}
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <CodeOutlined />
                  <Text strong>MS-Swift Project</Text>
                  <Tooltip title="MS-Swift repo exists in this path">
                    <QuestionCircleOutlined style={{ color: '#1890ff' }} />
                  </Tooltip>
                </Space>
              }
              name="msswiftRecipeRunPath"
              rules={[{ required: true, message: 'Please input MS-Swift recipe run path!' }]}
            >
              <Input placeholder="/s3/train-recipes/ms-swift-project/" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <CodeOutlined />
                  <Text strong>MS-Swift Command Type</Text>
                </Space>
              }
              name="msswiftCommandType"
              rules={[{ required: true, message: 'Please select or input command type!' }]}
            >
              <AutoComplete
                placeholder="Select or type command type"
                options={commandOptions}
                filterOption={(inputValue, option) =>
                  option.label.toLowerCase().indexOf(inputValue.toLowerCase()) >= 0
                }
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <CodeOutlined />
                  <Text strong>MS-Swift Config File Name</Text>
                </Space>
              }
              name="msswiftRecipeYamlFile"
              rules={[
                { required: true, message: 'Please input config file name!' }
              ]}
            >
              <Input placeholder="qwen06b_full_sft_template.yaml" />
            </Form.Item>
          </Col>
        </Row>

        {/* MLFlow配置 */}
        {/* Temporarily hidden - SageMaker MLFlow ARN field
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
        */}

        {/* 高级配置 */}
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
            disabled={infoLoading}
            size="large"
            className="training-btn"
            block
          >
            Launch HyperPod Training
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default MSSwiftRecipePanel;
