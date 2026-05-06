import { useState, useMemo, useCallback, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { selectDeploymentStatus } from '../store/selectors';
import resourceEventBus from '../utils/resourceEventBus';
import {
  Form,
  Input,
  InputNumber,
  Button,
  Space,
  Alert,
  Tooltip,
  Row,
  Col,
  AutoComplete,
  Select,
  Radio,
  message
} from 'antd';
import {
  RocketOutlined,
  InfoCircleOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  CodeOutlined,
  GlobalOutlined,
  DockerOutlined,
  TagOutlined,
  LinkOutlined,
  ThunderboltOutlined,
  DatabaseOutlined,
  ReloadOutlined
} from '@ant-design/icons';

const { TextArea } = Input;
const { Option, OptGroup } = Select;


const ConfigPanel = () => {
  const deploymentStatus = useSelector(selectDeploymentStatus);
  const [deploymentForm] = Form.useForm();
  const [loading, setLoading] = useState(false);

  // 实例类型相关状态
  const [instanceTypes, setInstanceTypes] = useState({
    hyperpod: [],
    eksNodeGroup: [],
    karpenter: [],
    karpenterHyperPod: []  // 新增：Karpenter HyperPod 实例类型
  });
  const [instanceTypesLoading, setInstanceTypesLoading] = useState(false);

  // Docker镜像预设选项 - 使用useMemo避免重新创建导致焦点丢失
  const dockerImageOptions = useMemo(() => [
    {
      value: 'vllm/vllm-openai:latest',
      label: 'vllm/vllm-openai:latest'
    },
    {
      value: 'lmsysorg/sglang:latest',
      label: 'lmsysorg/sglang:latest'
    },
    {
      value: 'vllm/vllm-openai:gptoss',
      label: 'vllm/vllm-openai:gptoss'
    }
  ], []);

  // 根据Docker镜像获取对应的默认命令
  const getDefaultCommandByImage = useCallback((dockerImage) => {
    if (!dockerImage) {
      return ''; // 没有选择镜像时返回空命令
    }
    
    if (dockerImage.includes('sglang')) {
      return `python3 -m sglang.launch_server \\
--model-path Qwen/Qwen3-0.6B \\
--tp-size 1 \\
--host 0.0.0.0 \\
--port 8000 \\
--trust-remote-code`;
    } else if (dockerImage.includes('gptoss')) {
      return `vllm serve \\
/s3/openai/gpt-oss-120b \\
--tensor-parallel-size 2 \\
--host 0.0.0.0 \\
--port 8000 \\
--trust-remote-code`;
    } else {
      // 默认VLLM serve命令
      return `vllm serve \\
/s3/Qwen-Qwen3-0.6B \\
--max-num-seqs 32 \\
--max-model-len 1280 \\
--tensor-parallel-size 1 \\
--host 0.0.0.0 \\
--port 8000 \\
--trust-remote-code`;
    }
  }, []);

  // 处理Docker镜像选择变化
  const handleDockerImageChange = useCallback((value) => {
    const newCommand = getDefaultCommandByImage(value);
    deploymentForm.setFieldsValue({ deploymentCommand: newCommand });
  }, [getDefaultCommandByImage, deploymentForm]);

  // 获取集群可用实例类型
  const fetchInstanceTypes = useCallback(async () => {
    setInstanceTypesLoading(true);
    try {
      const response = await fetch('/api/cluster/cluster-available-instance');
      const data = await response.json();

      if (data.success) {
        setInstanceTypes(data.data);
        console.log('Instance types loaded:', data.data);
      } else {
        console.error('Failed to fetch instance types:', data.error);
      }
    } catch (error) {
      console.error('Error fetching instance types:', error);
    } finally {
      setInstanceTypesLoading(false);
    }
  }, []);

  // 组件挂载时获取实例类型
  useEffect(() => {
    fetchInstanceTypes();
  }, []); // 只在组件挂载时执行一次，避免全局刷新触发重新加载

  // 移除不再使用的过滤函数

  // 使用useMemo优化实例类型选项渲染，避免频繁重新创建
  const instanceTypeOptions = useMemo(() => (
    <>
      <OptGroup label="HyperPod (ml.*)">
        {instanceTypes.hyperpod.map(type => (
          <Option key={`hp-${type.type}`} value={type.type}>
            {type.type} ({type.group}) [{type.count} nodes]
          </Option>
        ))}
      </OptGroup>
      <OptGroup label="HyperPod Karpenter (ml.*)">
        {instanceTypes.karpenterHyperPod.map((type, index) => (
          <Option key={`kar-hp-${type.type}-${type.nodePool}-${index}`} value={`${type.type}#karpenter-hyperpod#${type.nodePool}`}>
            {type.type} (Karpenter: {type.nodePool})
          </Option>
        ))}
      </OptGroup>
      <OptGroup label="EC2">
        {/* EKS NodeGroup 实例 */}
        {instanceTypes.eksNodeGroup.map(type => (
          <Option key={`eks-${type.type}-${type.nodeGroup}`} value={type.type}>
            {type.type} (NodeGroup: {type.nodeGroup}) [{type.count} nodes]
          </Option>
        ))}
        {/* Karpenter 实例 - 使用唯一的key和value来避免相同机型选择冲突 */}
        {instanceTypes.karpenter.map((type, index) => (
          <Option key={`kar-${type.type}-${type.nodePool}-${index}`} value={`${type.type}#karpenter-ec2#${type.nodePool}`}>
            {type.type} (Karpenter: {type.nodePool})
          </Option>
        ))}
      </OptGroup>
    </>
  ), [instanceTypes]);

  // 校验Container Entry命令格式
  const validateDeploymentCommand = (_, value) => {
    // 允许留空，使用容器镜像的默认 ENTRYPOINT/CMD
    if (!value || !value.trim()) {
      return Promise.resolve();
    }

    // 如果有值，检查命令是否有效
    const cleanCommand = value
      .replace(/\\\s*\n/g, ' ')  // 处理反斜杠换行
      .replace(/\s+/g, ' ')      // 合并多个空格
      .trim();

    if (!cleanCommand) {
      return Promise.reject(new Error('Please input a valid command!'));
    }

    return Promise.resolve();
  };

  // 移除标签切换处理 - 不再需要

  // 处理实例类型选择，将Karpenter特殊格式转换为纯实例类型，并去重
  const processInstanceTypes = (instanceTypes) => {
    if (!instanceTypes || !Array.isArray(instanceTypes)) {
      return []; // 返回空数组而不是原值
    }

    // 处理格式转换
    const processedTypes = instanceTypes.map(type => {
      // 如果是Karpenter的特殊格式（type#source#nodePool），提取纯实例类型
      if (type.includes('#')) {
        return type.split('#')[0];
      }
      return type;
    });

    // 去重：确保没有重复的实例类型传递给后端
    return [...new Set(processedTypes)];
  };

  const handleSubmit = async (values) => {
    console.log('handleSubmit called with values:', values);

    setLoading(true);
    try {
      const deploymentConfig = {
        ...values,
        // 处理实例类型，确保后端接收到纯实例类型数组
        instanceTypes: processInstanceTypes(values.instanceTypes),
        // 如果未填写命令，传递空字符串，后端将使用镜像默认 ENTRYPOINT/CMD
        deploymentCommand: values.deploymentCommand && values.deploymentCommand.trim()
          ? values.deploymentCommand
          : ''
      };

      console.log('deploymentConfig:', deploymentConfig);
      console.log('Calling /api/deploy/container');

      const response = await fetch('/api/deploy/container', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deploymentConfig),
      });

      const result = await response.json();
      console.log('API response:', result);

      if (result.success) {
        message.success(`Container deployment successful: ${result.deploymentTag}`);
        // 触发刷新事件
        resourceEventBus.emit('model-deploy', {
          deploymentTag: result.deploymentTag,
          deploymentType: 'container'
        });
      } else {
        message.error(`Deployment failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Error in handleSubmit:', error);
      message.error('Failed to deploy container');
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
          message="Deployment Successful"
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
          message="Deployment Failed"
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

  const DeploymentForm = () => (
    <Form
      form={deploymentForm}
      layout="vertical"
      onFinish={handleSubmit}
      onFinishFailed={(errorInfo) => {
        console.log('Deployment Form validation failed:', errorInfo);
      }}
      initialValues={{
        replicas: 1,
        gpuCount: 1,
        gpuMemory: -1,
        instanceTypes: [],
        serviceType: 'clusterip',
        deploymentName: '',
        dockerImage: '', // 改为空，用户必须选择
        deploymentCommand: '', // 命令也为空，等待用户选择镜像后自动填充
        port: 8000, // 添加端口默认值
        cpuRequest: -1, // 修改为-1，表示不设置限制
        memoryRequest: -1 // 修改为-1，表示不设置限制
      }}
    >
      <Row gutter={16}>
        <Col span={12}>
          <Form.Item
            label={
              <Space>
                <TagOutlined />
                Deployment Name
                <Tooltip title="用于Kubernetes资源命名的标识符">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            name="deploymentName"
            rules={[
              { required: true, message: 'Please input deployment name!' },
              { pattern: /^[a-z0-9-]+$/, message: 'Only lowercase letters, numbers and hyphens allowed' }
            ]}
          >
            <Input 
              placeholder="e.g., qwen3-chat, llama2-7b"
              style={{ fontFamily: 'monospace' }}
            />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item
            label={
              <Space>
                <ThunderboltOutlined />
                Replicas
                <Tooltip title="Number of pod replicas to deploy">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            name="replicas"
            rules={[
              { required: true, message: 'Please input replica count!' },
              { type: 'number', min: 1, max: 10, message: 'Replicas must be between 1 and 10' }
            ]}
          >
            <InputNumber 
              min={1} 
              max={10} 
              style={{ width: '100%' }}
              placeholder="Number of replicas"
            />
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={6}>
          <Form.Item
            label={
              <Space>
                GPU Count (per replica)
                <Tooltip title="Number of GPUs allocated per replica. Set to 0 for CPU-only deployment">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            name="gpuCount"
            rules={[
              { required: true, message: 'Please input GPU count!' },
              { type: 'number', min: 0, max: 8, message: 'GPU count must be between 0 and 8' }
            ]}
          >
            <InputNumber
              min={0}
              max={8}
              style={{ width: '100%' }}
              placeholder="Number of GPUs per replica"
            />
          </Form.Item>
        </Col>
        <Col span={6}>
          <Form.Item
            label={
              <Space>
                GPU Memory (HAMi)
                <Tooltip title="GPU memory in MB. -1 to use full GPU without HAMi">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            name="gpuMemory"
            rules={[
              { required: true, message: 'Please input GPU memory!' },
              { type: 'number', min: -1, message: 'GPU memory must be -1 or positive' }
            ]}
          >
            <InputNumber 
              min={-1}
              addonAfter="MB"
              style={{ width: '100%' }}
              placeholder="-1 (ignore HAMi)"
            />
          </Form.Item>
        </Col>
        <Col span={6}>
          <Form.Item
            label="CPU Request"
            name="cpuRequest"
            rules={[
              { required: true, message: 'Please input CPU request!' },
              { type: 'number', min: -1, max: 32, message: 'CPU must be between -1 and 32 cores (-1 = no limit)' }
            ]}
          >
            <InputNumber
              min={-1}
              max={32}
              addonAfter="cores"
              style={{ width: '100%' }}
              placeholder="-1 (no limit)"
            />
          </Form.Item>
        </Col>
        <Col span={6}>
          <Form.Item
            label="Memory Request"
            name="memoryRequest"
            rules={[
              { required: true, message: 'Please input memory request!' },
              { type: 'number', min: -1, max: 512, message: 'Memory must be between -1 and 512 Gi (-1 = no limit)' }
            ]}
          >
            <InputNumber
              min={-1}
              max={512}
              addonAfter="Gi"
              style={{ width: '100%' }}
              placeholder="-1 (no limit)"
            />
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={24}>
          <Form.Item
            label={
              <Space>
                Instance Types
                <Tooltip title="Select one or more instance types for hybrid scheduling">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            required
          >
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                name="instanceTypes"
                noStyle
                rules={[
                  {
                    required: true,
                    message: 'Please select at least one instance type!',
                    validator: (_, value) => {
                      const processed = processInstanceTypes(value);
                      if (!processed || processed.length === 0) {
                        return Promise.reject(new Error('Please select at least one instance type!'));
                      }
                      return Promise.resolve();
                    }
                  }
                ]}
              >
                <Select
                  mode="multiple"
                  placeholder="Select instance types"
                  loading={instanceTypesLoading}
                  style={{ fontFamily: 'monospace', flex: 1 }}
                  allowClear
                  notFoundContent={instanceTypesLoading ? 'Loading...' : 'No instance types available'}
                >
                  {instanceTypeOptions}
                </Select>
              </Form.Item>
              <Button
                icon={<ReloadOutlined />}
                loading={instanceTypesLoading}
                onClick={fetchInstanceTypes}
                title="Refresh instance types"
              />
            </Space.Compact>
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={18}>
          <Form.Item
            label={
              <Space>
                <DockerOutlined />
                Docker Image
                <Tooltip title="Select preset image or input custom image address">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            name="dockerImage"
            rules={[{ required: true, message: 'Please select or input docker image!' }]}
          >
            <AutoComplete
              options={dockerImageOptions}
              placeholder="Select Docker image to auto-generate command, or input your own image repo"
              style={{ fontFamily: 'monospace' }}
              onChange={handleDockerImageChange}
              filterOption={false}
              allowClear
            />
          </Form.Item>
        </Col>
        <Col span={6}>
          <Form.Item
            label={
              <Space>
                <GlobalOutlined />
                Port
              </Space>
            }
            name="port"
            initialValue={8000}
            rules={[{ required: true, message: 'Please input port!' }]}
          >
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item
        label={
          <Space>
            <CodeOutlined />
            EntryPoint Command (Optional)
            <Tooltip title="Leave empty to use container's default ENTRYPOINT/CMD. Or specify custom command, e.g. python3 -m project.main --model HuggingfaceID">
              <InfoCircleOutlined />
            </Tooltip>
          </Space>
        }
        name="deploymentCommand"
        rules={[{ validator: validateDeploymentCommand }]}
      >
        <TextArea
          rows={8}
          placeholder="Leave empty to use container's default ENTRYPOINT/CMD, or enter custom command..."
          style={{ fontFamily: 'monospace', fontSize: '12px' }}
        />
      </Form.Item>

      {/* Service Type配置 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={12}>
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
              <Radio value="modelpool">
                <Space>
                  <DatabaseOutlined />
                  Model Pool
                </Space>
              </Radio>
            </Radio.Group>
          </Form.Item>
        </Col>
        <Col span={12}>
          {/* 预留空间用于将来的配置选项 */}
        </Col>
      </Row>

      <div style={{ marginBottom: 16, padding: 12, backgroundColor: '#f0f9ff', borderRadius: 6 }}>
        <div style={{ fontSize: '12px', color: '#0369a1', marginBottom: 8 }}>
          <strong>Container Deployment Instructions:</strong>
        </div>
        <div style={{ fontSize: '11px', color: '#0c4a6e' }}>
          • Supports any EntryPoint and parameters, e.g. python3 -m project.main --model HuggingfaceID<br/>
          • Supports vLLM, SGLang and any custom containers<br/>
          • GPU count per model replica must match parameters like tp/pp<br/>
          • Ensure commands are executable in container environment
        </div>
      </div>

      {/* 部署按钮 - 全宽 */}
      <Form.Item>
        <Button
          type="primary"
          htmlType="submit"
          loading={loading}
          icon={<RocketOutlined />}
          size="large"
          block
          className="deploy-btn"
        >
          {loading ? 'Deploying Model...' : 'Deploy Model'}
        </Button>
      </Form.Item>
    </Form>
  );

  // Ollama 表单已移除 - 不再需要

  return (
    <div>
      {getStatusAlert()}

      {/* 直接显示Container配置表单，无需Tab层级 */}
      <DeploymentForm />
    </div>
  );
};

export default ConfigPanel;
