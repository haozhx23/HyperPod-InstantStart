import { useState, useMemo, useCallback, useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { selectDeploymentStatus } from '../store/selectors';
import { clearDeploymentStatus } from '../store/slices/webSocketSlice';
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
  message,
  Collapse,
  Switch,
  Card,
  Typography,
  Divider,
  Radio
} from 'antd';
import {
  RocketOutlined,
  InfoCircleOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  CodeOutlined,
  DockerOutlined,
  TagOutlined,
  ThunderboltOutlined,
  DatabaseOutlined,
  GlobalOutlined,
  CloudServerOutlined,
  ReloadOutlined,
  ThunderboltFilled,
  ApiOutlined,
  LinkOutlined
} from '@ant-design/icons';

const { TextArea } = Input;
const { Option } = Select;
const { Panel } = Collapse;
const { Text, Paragraph } = Typography;

const ManagedInferencePanel = ({ engine = 'vllm' }) => {
  const deploymentStatus = useSelector(selectDeploymentStatus);
  const dispatch = useDispatch();
  const [deploymentForm] = Form.useForm();
  const [loading, setLoading] = useState(false);

  // Engine-aware 默认值。两个 tab 共用本组件，通过 engine prop 区分。
  // sglang 隐藏 Advanced Features，并把默认镜像/端口/启动命令切到 SGLang 风格。
  const isVllm = engine === 'vllm';
  const defaultDockerImage = isVllm
    ? 'vllm/vllm-openai:latest'
    : 'lmsysorg/sglang:latest';
  const defaultPort = isVllm ? 8000 : 22022;

  // KV Cache 和 Intelligent Routing 状态
  const [enableKvCache, setEnableKvCache] = useState(false);
  const [enableL1Cache, setEnableL1Cache] = useState(false);
  const [enableL2Cache, setEnableL2Cache] = useState(false);
  const [l2CacheBackend, setL2CacheBackend] = useState('tieredstorage'); // 'tieredstorage' or 'redis'
  const [enableIntelligentRouting, setEnableIntelligentRouting] = useState(false);
  const [routingStrategy, setRoutingStrategy] = useState('prefixaware');

  // Prefetch：默认开启 —— operator init container 预拉模型到 /opt/ml/model
  const [prefetchEnabled, setPrefetchEnabled] = useState(true);

  // 实例类型相关状态 - 只需要 HyperPod 实例类型
  const [instanceTypes, setInstanceTypes] = useState({
    hyperpod: [],
    karpenterHyperPod: []
  });
  const [instanceTypesLoading, setInstanceTypesLoading] = useState(false);
  const [s3Buckets, setS3Buckets] = useState([]);
  const [s3Region, setS3Region] = useState('');

  // 路由策略选项和说明
  const routingStrategyOptions = useMemo(() => [
    {
      value: 'prefixaware',
      label: 'Prefix-aware',
      description: 'Best for workloads with common prompt prefixes. Maintains tree structure to track cached prefixes.',
      recommended: true
    },
    {
      value: 'roundrobin',
      label: 'Round-robin',
      description: 'Simple load balancing. Distributes requests evenly across workers without cache optimization.'
    },
    {
      value: 'session',
      label: 'Session-based',
      description: 'Routes same session to same worker. Ideal for chatbots maintaining conversation context.',
      requiresSessionKey: true
    },
    {
      value: 'kvaware',
      label: 'KV-aware',
      description: 'Advanced cache management with centralized controller. Requires HuggingFace models and tokenization.',
      requiresSessionKey: true,
      advanced: true
    }
  ], []);

  // Docker镜像预设选项
  const dockerImageOptions = useMemo(() => [
    {
      value: 'vllm/vllm-openai:latest',
      label: 'vllm/vllm-openai:latest'
    },
    {
      value: 'lmsysorg/sglang:latest',
      label: 'lmsysorg/sglang:latest'
    }
  ], []);

  // 根据Docker镜像获取对应的默认命令（bash 风格，参考 ConfigPanel）
  const getDefaultCommandByImage = useCallback((dockerImage, deploymentName) => {
    if (!dockerImage) {
      return '';
    }

    const modelName = deploymentName || 'model-name';

    if (dockerImage.includes('sglang')) {
      return `python3 -m sglang.launch_server \\
--model-path /opt/ml/model \\
--host 0.0.0.0 \\
--port 22022 \\
--tp-size 1 \\
--enable-metrics \\
--trust-remote-code`;
    } else {
      // vLLM: 显示完整命令（用户友好），后端会自动去掉 vllm serve
      // 必须包含 --model /opt/ml/model 参数
      return `vllm serve \\
--model /opt/ml/model \\
--served-model-name ${modelName} \\
--port 8000 \\
--max-num-seqs 32 \\
--max-model-len 1280 \\
--tensor-parallel-size 1 \\
--dtype auto`;
    }
  }, []);

  // 处理Docker镜像选择变化
  const handleDockerImageChange = useCallback((value) => {
    const deploymentName = deploymentForm.getFieldValue('deploymentName');
    const newCommand = getDefaultCommandByImage(value, deploymentName);
    deploymentForm.setFieldsValue({ workerCommand: newCommand });

    // SGLang 使用 22022 端口，vLLM 使用 8000
    const defaultPort = value.includes('sglang') ? 22022 : 8000;
    deploymentForm.setFieldsValue({ port: defaultPort });
  }, [getDefaultCommandByImage, deploymentForm]);

  // 处理 Deployment Name 变化
  const handleDeploymentNameChange = useCallback((e) => {
    const deploymentName = e.target.value;
    const dockerImage = deploymentForm.getFieldValue('dockerImage');
    if (dockerImage) {
      const newCommand = getDefaultCommandByImage(dockerImage, deploymentName);
      deploymentForm.setFieldsValue({ workerCommand: newCommand });
    }
  }, [getDefaultCommandByImage, deploymentForm]);

  // 获取集群可用实例类型
  const fetchInstanceTypes = useCallback(async () => {
    setInstanceTypesLoading(true);
    try {
      const response = await fetch('/api/cluster/cluster-available-instance');
      const data = await response.json();

      if (data.success) {
        setInstanceTypes({
          hyperpod: data.data.hyperpod || [],
          karpenterHyperPod: data.data.karpenterHyperPod || []
        });
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

  // 获取 S3 存储桶和默认 region
  const fetchS3Buckets = useCallback(async () => {
    try {
      // 获取集群信息以获取默认 region 和 S3 bucket
      const clusterInfoResponse = await fetch('/api/cluster/info');
      const clusterInfo = await clusterInfoResponse.json();

      if (clusterInfo.success) {
        // 设置默认 region
        if (clusterInfo.region) {
          deploymentForm.setFieldsValue({ s3Region: clusterInfo.region });
          setS3Region(clusterInfo.region);
        }

        // 尝试获取 S3 bucket（从环境变量或 metadata）
        const s3Response = await fetch('/api/cluster/s3-buckets');
        const s3Data = await s3Response.json();

        if (s3Data.success && s3Data.clusterBucket) {
          deploymentForm.setFieldsValue({
            s3BucketName: s3Data.clusterBucket.name
          });
          setS3Buckets([s3Data.clusterBucket]);
        }
      }
    } catch (error) {
      console.error('Error fetching cluster info:', error);
    }
  }, [deploymentForm]);

  // 获取 AMP Workspace URL
  // 组件挂载时获取数据
  useEffect(() => {
    fetchInstanceTypes();
    fetchS3Buckets();
  }, [fetchInstanceTypes, fetchS3Buckets]);

  // 实例类型选项
  const instanceTypeOptions = useMemo(() => {
    const options = [];

    // HyperPod 实例
    if (instanceTypes.hyperpod.length > 0) {
      options.push(
        <Select.OptGroup key="hyperpod" label="HyperPod (ml.*)">
          {instanceTypes.hyperpod.map(type => (
            <Option key={`hp-${type.type}`} value={type.type}>
              {type.type} ({type.group}) [{type.count} nodes]
            </Option>
          ))}
        </Select.OptGroup>
      );
    }

    // Karpenter HyperPod 实例
    if (instanceTypes.karpenterHyperPod.length > 0) {
      options.push(
        <Select.OptGroup key="karpenter-hyperpod" label="Karpenter HyperPod (ml.*)">
          {instanceTypes.karpenterHyperPod.map((type, index) => (
            <Option key={`kar-hp-${type.type}-${type.nodePool}-${index}`} value={type.type}>
              {type.type} (Karpenter: {type.nodePool})
            </Option>
          ))}
        </Select.OptGroup>
      );
    }

    return options;
  }, [instanceTypes]);

  const handleSubmit = async (values) => {
    console.log('ManagedInferencePanel handleSubmit called with values:', values);

    setLoading(true);
    try {
      const deploymentConfig = {
        ...values,
        prefetchEnabled,
        // KV Cache 配置
        kvCache: enableKvCache ? {
          enableL1Cache: enableL1Cache,
          enableL2Cache: enableL2Cache,
          l2CacheBackend: enableL2Cache ? l2CacheBackend : undefined,
          l2CacheUrl: (enableL2Cache && l2CacheBackend === 'redis') ? values.l2CacheUrl : undefined
        } : undefined,
        // Intelligent Routing 配置
        intelligentRouting: enableIntelligentRouting ? {
          enabled: true,
          strategy: routingStrategy,
          sessionKey: (routingStrategy === 'session' || routingStrategy === 'kvaware')
            ? values.sessionKey
            : undefined
        } : undefined
      };

      console.log('Managed inference deployment config:', deploymentConfig);
      console.log('Calling /api/deploy/managed-inference');

      const response = await fetch('/api/deploy/managed-inference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deploymentConfig),
      });

      const result = await response.json();
      console.log('API response:', result);

      if (result.success) {
        message.success(`Managed inference deployment successful: ${result.deploymentTag}`);
        // 触发刷新事件
        resourceEventBus.emit('model-deploy', {
          deploymentTag: result.deploymentTag,
          deploymentType: 'managed-inference'
        });
      } else {
        message.error(`Deployment failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Error in handleSubmit:', error);
      message.error('Failed to submit deployment');
    } finally {
      setLoading(false);
    }
  };

  const getStatusAlert = () => {
    if (!deploymentStatus) return null;

    const { status, message: msg } = deploymentStatus;
    const onClose = () => dispatch(clearDeploymentStatus());

    if (status === 'success') {
      return (
        <Alert
          message="Deployment Successful"
          description={msg}
          type="success"
          icon={<CheckCircleOutlined />}
          showIcon
          closable
          onClose={onClose}
          style={{ marginBottom: 16 }}
        />
      );
    } else if (status === 'error') {
      return (
        <Alert
          message="Deployment Failed"
          description={msg}
          type="error"
          icon={<ExclamationCircleOutlined />}
          showIcon
          closable
          onClose={onClose}
          style={{ marginBottom: 16 }}
        />
      );
    }

    return null;
  };

  return (
    <div>
      {getStatusAlert()}

      <Form
        form={deploymentForm}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          replicas: 1,
          gpuCount: 1,
          gpuMemory: -1,
          port: defaultPort,
          cpuRequest: -1,
          memoryRequest: -1,
          s3Region: '',
          dockerImage: defaultDockerImage,
          workerCommand: getDefaultCommandByImage(defaultDockerImage)
        }}
      >
        <Row gutter={16}>
          <Col span={18}>
            <Form.Item
              label={
                <Space>
                  <TagOutlined />
                  Deployment Name
                  <Tooltip title="Kubernetes resource identifier (will be used as model name)">
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
                placeholder="e.g., qwen3-06b, llama2-7b"
                style={{ fontFamily: 'monospace' }}
                onChange={handleDeploymentNameChange}
              />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label={
                <Space>
                  <ThunderboltOutlined />
                  Replicas
                  <Tooltip title="Number of pod replicas">
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
                placeholder="Replicas"
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={6}>
            <Form.Item
              label={
                <Space>
                  GPU Count
                  <Tooltip title="Number of GPUs per replica">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="gpuCount"
              rules={[
                { required: true, message: 'Please input GPU count!' },
                { type: 'number', min: 1, max: 8, message: 'GPU count must be between 1 and 8' }
              ]}
            >
              <InputNumber
                min={1}
                max={8}
                style={{ width: '100%' }}
                placeholder="GPUs"
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
              label={
                <Space>
                  CPU
                  <Tooltip title="-1 = no limit, or specify cores">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="cpuRequest"
              rules={[
                { required: true, message: 'Required' },
                { type: 'number', min: -1, message: 'Must be -1 or positive' }
              ]}
            >
              <InputNumber
                min={-1}
                addonAfter="cores"
                placeholder="-1"
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label={
                <Space>
                  Memory
                  <Tooltip title="-1 = no limit, or specify Gi">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="memoryRequest"
              rules={[
                { required: true, message: 'Required' },
                { type: 'number', min: -1, message: 'Must be -1 or positive' }
              ]}
            >
              <InputNumber
                min={-1}
                addonAfter="Gi"
                placeholder="-1"
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={24}>
            <Form.Item
              label={
                <Space>
                  <CloudServerOutlined />
                  Instance Type
                  <Tooltip title="Select HyperPod instance type (ml.*)">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              required
            >
              <Space.Compact style={{ width: '100%' }}>
                <Form.Item
                  name="instanceType"
                  noStyle
                  rules={[
                    { required: true, message: 'Please select an instance type!' }
                  ]}
                >
                  <Select
                    placeholder="Select instance type"
                    loading={instanceTypesLoading}
                    style={{ fontFamily: 'monospace', flex: 1 }}
                    allowClear
                    notFoundContent={instanceTypesLoading ? 'Loading...' : 'No HyperPod instance types available'}
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
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <DockerOutlined />
                  Docker Image
                  <Tooltip title="Select preset image or input custom image">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="dockerImage"
              rules={[{ required: true, message: 'Please select or input docker image!' }]}
            >
              <AutoComplete
                options={dockerImageOptions}
                placeholder="Select Docker image"
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
                  <Tooltip title="Container port for inference">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="port"
              rules={[{ required: true, message: 'Please input port!' }]}
            >
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label={
                <Space>
                  Service Type
                  <Tooltip title="External: Internet-facing NLB, Internal: ClusterIP only">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="serviceType"
              initialValue="internal"
              rules={[{ required: true, message: 'Please select service type!' }]}
            >
              <Radio.Group>
                <Radio value="external">
                  <Space>
                    <GlobalOutlined />
                    External
                  </Space>
                </Radio>
                <Radio value="internal">
                  <Space>
                    <LinkOutlined />
                    Internal
                  </Space>
                </Radio>
              </Radio.Group>
            </Form.Item>
          </Col>
        </Row>

        <Alert
          message={
            <Space>
              <span>S3 Model Source: Configure the S3 location where your model is stored.</span>
              <Divider type="vertical" />
              <Switch
                checked={prefetchEnabled}
                onChange={setPrefetchEnabled}
                size="small"
              />
              <Text strong>Prefetch model to local storage</Text>
              <Tooltip title="When ON, an init container pre-downloads the model from S3 to /opt/ml/model before the inference container starts. Avoids cold-start network stall. Default: ON.">
                <InfoCircleOutlined />
              </Tooltip>
            </Space>
          }
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <GlobalOutlined />
                  S3 Region
                  <Tooltip title="AWS region (auto-filled from cluster)">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="s3Region"
              rules={[{ required: true, message: 'Please input S3 region!' }]}
            >
              <Input
                placeholder="e.g., us-west-2"
                style={{ fontFamily: 'monospace' }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <DatabaseOutlined />
                  S3 Bucket
                  <Tooltip title="S3 bucket containing the model">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="s3BucketName"
              rules={[{ required: true, message: 'Please input S3 bucket!' }]}
            >
              <Input
                placeholder="e.g., my-model-bucket"
                style={{ fontFamily: 'monospace' }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <DatabaseOutlined />
                  Model Path
                  <Tooltip title="Path to model within S3 bucket">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="modelLocation"
              rules={[{ required: true, message: 'Please input model path!' }]}
            >
              <Input
                placeholder="e.g., Qwen-Qwen3-0.6B"
                style={{ fontFamily: 'monospace' }}
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          label={
            <Space>
              <CodeOutlined />
              Worker Command
              <Tooltip title="Container entrypoint command. Keep /opt/ml/model unchanged - it's the mounted model path.">
                <InfoCircleOutlined />
              </Tooltip>
            </Space>
          }
          name="workerCommand"
          rules={[{ required: true, message: 'Please input worker command!' }]}
          extra="/opt/ml/model (DO NOT change) automatically mapped to above S3 model path"
        >
          <TextArea
            rows={8}
            placeholder="Select Docker image first, default command will be auto-generated"
            style={{ fontFamily: 'monospace', fontSize: '12px' }}
          />
        </Form.Item>

        {isVllm && (
          <>
            <Alert
              message={
                <Space>
                  <ThunderboltOutlined />
                  <Text strong>Advanced Features (Optional, vLLM support only)</Text>
                </Space>
              }
              type="info"
              showIcon={false}
              style={{ marginBottom: 16, marginTop: 16 }}
            />

            <Collapse
              defaultActiveKey={[]}
              style={{ marginBottom: 24 }}
            >
          {/* KV Cache Configuration */}
          <Panel
            header={
              <Space>
                <DatabaseOutlined />
                <Text strong>KV Cache Configuration</Text>
                <Switch
                  checked={enableKvCache}
                  onChange={(checked) => {
                    setEnableKvCache(checked);
                    if (!checked) {
                      setEnableL1Cache(false);
                      setEnableL2Cache(false);
                    }
                  }}
                  onClick={(_, e) => e.stopPropagation()}
                />
                {enableKvCache && (
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    (L1: {enableL1Cache ? 'ON' : 'OFF'}, L2: {enableL2Cache ? 'ON' : 'OFF'})
                  </Text>
                )}
              </Space>
            }
            key="kv-cache"
          >
            <Card size="small" style={{ marginBottom: 16, backgroundColor: '#e6f7ff' }}>
              <Paragraph style={{ marginBottom: 0, fontSize: '13px' }}>
                <strong>KV Cache</strong> stores computed key-value pairs to accelerate inference:
                <ul style={{ marginTop: 8, marginBottom: 0 }}>
                  <li><strong>L1 Cache:</strong> Local CPU memory on each node (fastest access)</li>
                  <li><strong>L2 Cache:</strong> Shared Redis storage across nodes (enables cache sharing)</li>
                </ul>
              </Paragraph>
            </Card>

            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Card
                size="small"
                title={
                  <Space>
                    <Switch
                      checked={enableL1Cache}
                      onChange={setEnableL1Cache}
                      disabled={!enableKvCache}
                    />
                    <Text>L1 Cache (Local CPU Memory)</Text>
                  </Space>
                }
                style={{ 
                  borderColor: enableL1Cache ? '#52c41a' : '#d9d9d9',
                  opacity: enableKvCache ? 1 : 0.5
                }}
              >
                <Text type="secondary" style={{ fontSize: '12px' }}>
                  Fastest access to recently computed key-value pairs. Recommended for all deployments.
                </Text>
              </Card>

              <Card
                size="small"
                title={
                  <Space>
                    <Switch
                      checked={enableL2Cache}
                      onChange={setEnableL2Cache}
                      disabled={!enableKvCache}
                    />
                    <Text>L2 Cache (Shared Storage)</Text>
                  </Space>
                }
                style={{
                  borderColor: enableL2Cache ? '#52c41a' : '#d9d9d9',
                  opacity: enableKvCache ? 1 : 0.5
                }}
              >
                <Text type="secondary" style={{ fontSize: '12px', display: 'block', marginBottom: 12 }}>
                  Enables cache sharing across multiple nodes via Tiered Storage or Redis.
                </Text>

                {enableL2Cache && (
                  <>
                    <Form.Item
                      label="L2 Cache Backend"
                      style={{ marginBottom: 12 }}
                    >
                      <Select
                        value={l2CacheBackend}
                        onChange={setL2CacheBackend}
                        disabled={!enableKvCache || !enableL2Cache}
                        style={{ width: '100%' }}
                      >
                        <Option value="tieredstorage">
                          <Space>
                            <Text>Tiered Storage</Text>
                            <Text type="success" style={{ fontSize: '11px' }}>(Recommended)</Text>
                          </Space>
                        </Option>
                        <Option value="redis">Redis</Option>
                      </Select>
                    </Form.Item>

                    {l2CacheBackend === 'redis' && (
                      <>
                        <Form.Item
                          label="Redis URL"
                          name="l2CacheUrl"
                          rules={[
                            { required: l2CacheBackend === 'redis', message: 'Redis URL is required when using Redis backend' },
                            { pattern: /^redis:\/\/.+/, message: 'Must start with redis://' }
                          ]}
                          style={{ marginBottom: 8 }}
                        >
                          <Input
                            placeholder="redis://redis.default.svc.cluster.local:6379"
                            style={{ fontFamily: 'monospace' }}
                            disabled={!enableKvCache || !enableL2Cache}
                          />
                        </Form.Item>
                        <Alert
                          message="Redis URL Format"
                          description={
                            <Text code style={{ fontSize: '11px' }}>
                              redis://{'<service-name>.<namespace>.svc.cluster.local:6379'}
                            </Text>
                          }
                          type="info"
                          showIcon
                          style={{ fontSize: '12px' }}
                        />
                      </>
                    )}
                  </>
                )}
              </Card>
            </Space>
          </Panel>

          {/* Intelligent Routing Configuration */}
          <Panel
            header={
              <Space>
                <ApiOutlined />
                <Text strong>Intelligent Routing</Text>
                <Switch
                  checked={enableIntelligentRouting}
                  onChange={setEnableIntelligentRouting}
                  onClick={(_, e) => e.stopPropagation()}
                />
                {enableIntelligentRouting && (
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    ({routingStrategyOptions.find(opt => opt.value === routingStrategy)?.label})
                  </Text>
                )}
              </Space>
            }
            key="intelligent-routing"
          >
            <Card size="small" style={{ marginBottom: 16, backgroundColor: '#e6f7ff' }}>
              <Paragraph style={{ marginBottom: 0, fontSize: '13px' }}>
                <strong>Intelligent Routing</strong> optimizes request distribution across workers to maximize cache reuse and performance.
              </Paragraph>
            </Card>

            <Form.Item
              label="Routing Strategy"
              name="routingStrategy"
              initialValue="prefixaware"
              rules={[{ required: enableIntelligentRouting, message: 'Please select a routing strategy' }]}
            >
              <Select
                disabled={!enableIntelligentRouting}
                onChange={(value) => setRoutingStrategy(value)}
                style={{ width: '100%' }}
                optionLabelProp="label"
              >
                {routingStrategyOptions.map(option => (
                  <Option 
                    key={option.value} 
                    value={option.value}
                    label={
                      <Space>
                        <Text strong>{option.label}</Text>
                        {option.recommended && (
                          <Text type="success" style={{ fontSize: '11px' }}>(Recommended)</Text>
                        )}
                        {option.advanced && (
                          <Text type="warning" style={{ fontSize: '11px' }}>(Advanced)</Text>
                        )}
                      </Space>
                    }
                  >
                    <Space direction="vertical" size={0} style={{ width: '100%' }}>
                      <Space>
                        <Text strong>{option.label}</Text>
                        {option.recommended && (
                          <Text type="success" style={{ fontSize: '11px' }}>(Recommended)</Text>
                        )}
                        {option.advanced && (
                          <Text type="warning" style={{ fontSize: '11px' }}>(Advanced)</Text>
                        )}
                      </Space>
                      <Text type="secondary" style={{ fontSize: '12px' }}>
                        {option.description}
                      </Text>
                    </Space>
                  </Option>
                ))}
              </Select>
            </Form.Item>

            {/* Session Key - 仅在 session 或 kvaware 策略时显示 */}
            {enableIntelligentRouting && (routingStrategy === 'session' || routingStrategy === 'kvaware') && (
              <Form.Item
                label={
                  <Space>
                    Session Key
                    <Tooltip title="Request field used to identify sessions (e.g., user_id, session_id)">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="sessionKey"
                rules={[
                  { 
                    required: true, 
                    message: 'Session key is required for session-based and kv-aware routing' 
                  }
                ]}
                initialValue="user_id"
              >
                <Input
                  placeholder="e.g., user_id, session_id"
                  style={{ fontFamily: 'monospace' }}
                />
              </Form.Item>
            )}

            {/* 策略说明卡片 */}
            {enableIntelligentRouting && (
              <Card size="small" style={{ marginTop: 16, backgroundColor: '#fffbe6' }}>
                <Text strong style={{ fontSize: '12px', display: 'block', marginBottom: 8 }}>
                  Strategy Comparison:
                </Text>
                <ul style={{ fontSize: '11px', marginBottom: 0, paddingLeft: 20 }}>
                  <li><strong>Prefix-aware:</strong> Best general-purpose choice, good cache reuse</li>
                  <li><strong>Round-robin:</strong> Simplest, no cache optimization</li>
                  <li><strong>Session-based:</strong> Best for chatbots, maintains conversation context</li>
                  <li><strong>KV-aware:</strong> Most advanced, requires HuggingFace models</li>
                </ul>
              </Card>
            )}
          </Panel>
        </Collapse>
          </>
        )}

        <Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            icon={<RocketOutlined />}
            loading={loading}
            block
            size="large"
          >
            Deploy with HyperPod Inference Operator
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default ManagedInferencePanel;
