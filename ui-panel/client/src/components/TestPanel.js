import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { selectAppServices } from '../store/selectors';
import {
  Form,
  Input,
  InputNumber,
  Button, 
  Select, 
  Card, 
  Typography, 
  Space,
  Divider,
  Alert,
  message,
  Spin,
  Radio
} from 'antd';
import { 
  SendOutlined, 
  CopyOutlined, 
  ApiOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  LinkOutlined,
  ReloadOutlined,
  CloudOutlined
} from '@ant-design/icons';
import { CONFIG } from '../config/constants';

const { TextArea } = Input;
const { Option } = Select;
const { Text, Paragraph } = Typography;

const TestPanel = ({ onRefresh }) => {
  const services = useSelector(selectAppServices);
  const [form] = Form.useForm();
  const [curlCommand, setCurlCommand] = useState('');
  const [response, setResponse] = useState('');
  const [loading, setLoading] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [selectedService, setSelectedService] = useState(null);
  const [modelType, setModelType] = useState('ollama'); // 'ollama' or 'vllm'
  const [fetchingModelId, setFetchingModelId] = useState(false); // 正在获取模型ID
  
  // 新增：访问模式状态
  const [accessMode, setAccessMode] = useState('loadbalancer'); // 'loadbalancer' or 'portforward'

  // 根据访问模式过滤服务
  const modelServices = services.filter(service => {
    // 排除系统服务
    if (service.metadata?.name === 'kubernetes') {
      return false;
    }
    
    const namespace = service.metadata?.namespace || 'default';
    const serviceName = service.metadata?.name || '';
    
    if (accessMode === 'loadbalancer') {
      // LoadBalancer 模式：只显示 LoadBalancer 类型的服务
      return service.spec?.type === 'LoadBalancer';
    } else {
      // Port-Forward 模式：使用黑白名单过滤 ClusterIP 服务
      if (service.spec?.type !== 'ClusterIP') {
        return false;
      }
      
      // 黑名单：排除训练相关服务
      const isTrainingService = serviceName.includes('ray') || 
                                serviceName.includes('raycluster') ||
                                serviceName.includes('head-svc');
      if (isTrainingService) {
        return false;
      }
      
      // 白名单：推理引擎关键词
      const inferenceEngines = ['vllm', 'sglang', 'sglgw', 'router', 'hypd-custom'];
      const hasInferenceEngine = inferenceEngines.some(engine =>
        serviceName.toLowerCase().includes(engine)
      );
      
      // 白名单：routing service
      const isRoutingService = serviceName.endsWith('-routing-service');
      
      return hasInferenceEngine || isRoutingService;
    }
  });

  // 通过API直接获取真实的模型ID
  const fetchRealModelIdFromAPI = async (service) => {
    if (!service) return '';
    
    console.log('fetchRealModelIdFromAPI called:', {
      serviceName: service.metadata.name,
      namespace: service.metadata.namespace,
      accessMode
    });
    
    try {
      // 统一尝试 /v1/models API（OpenAI 兼容格式）
      const apiPath = '/v1/models';
      
      let response, result;
      
      if (accessMode === 'portforward') {
        // Port-Forward 模式：使用临时 port-forward
        const servicePort = service.spec.ports?.[0]?.port || 8000;
        const namespace = service.metadata.namespace || 'default';
        const localPortValue = form.getFieldValue('localPort') || 2020;
        const fullUrl = `http://localhost:${localPortValue}${apiPath}`;
        
        console.log('Calling /v1/models through temporary port-forward:', fullUrl);
        
        response = await fetch('/api/proxy-request-portforward', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: fullUrl,
            method: 'GET',
            portForward: {
              enabled: true,
              serviceName: service.metadata.name,
              namespace: namespace,
              servicePort: servicePort,
              localPort: localPortValue
            }
          })
        });
      } else {
        // LoadBalancer 模式：直接访问
        const serviceUrl = getServiceUrl(service);
        const fullUrl = `${serviceUrl}${apiPath}`;
        
        console.log('Calling /v1/models through proxy:', fullUrl);
        
        response = await fetch('/api/proxy-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: fullUrl,
            method: 'GET'
          })
        });
      }
      
      result = await response.json();
      console.log('API response:', result);
      
      if (result.success && result.data) {
        const data = result.data;
        
        // 尝试从 OpenAI 兼容格式获取 model ID
        if (data.data && Array.isArray(data.data) && data.data.length > 0) {
          const modelId = data.data[0].id;
          console.log(`Successfully fetched model ID: ${modelId}`);
          return modelId;
        }
        
        // 如果没有找到，返回空字符串
        console.log('No model ID found in response');
        return '';
      } else {
        console.log('API request failed:', result.error || 'Unknown error');
        return '';
      }
    } catch (error) {
      console.log(`Failed to fetch model ID:`, error.message || error);
      return '';
    }
  };

  // 手动刷新服务列表
  const handleRefresh = async () => {
    try {
      setFetchingModelId(true);

      // 保存当前选中服务的名称
      const currentServiceName = selectedService?.metadata.name;

      // 如果父组件提供了刷新函数，先调用它来刷新服务列表
      if (onRefresh) {
        console.log('Calling parent refresh function...');
        await onRefresh();
      }

      // 刷新完成后，检查之前选中的服务是否还存在
      // 注意：这里的检查会在下一次render中的useEffect中进行
      // 所以我们只需要处理存在的服务的模型ID刷新

      if (currentServiceName) {
        // 等待一个tick让services更新完成
        setTimeout(() => {
          // 在modelServices中找到同名服务
          const updatedService = modelServices.find(
            service => service.metadata.name === currentServiceName
          );

          if (updatedService) {
            console.log('Refreshing model ID for existing service:', currentServiceName);
            const detectedType = detectModelType(updatedService);
            updateFormDefaults(detectedType, updatedService);
            message.success('Services and model information refreshed');
          } else {
            // 服务不存在的情况会由useEffect处理
            message.success('Services refreshed');
          }
        }, 100);
      } else {
        message.success('Services refreshed');
      }

    } catch (error) {
      console.error('Error refreshing:', error);
      message.error('Failed to refresh');
    } finally {
      setFetchingModelId(false);
    }
  };

  // 获取真实的模型ID
  const getRealModelId = async (service) => {
    if (!service) return 'N/A';
    
    console.log('Fetching model ID for:', service.metadata.name);
    return await fetchRealModelIdFromAPI(service);
  };

  // 检测模型类型
  const detectModelType = (service) => {
    if (!service) return 'other';
    
    // 只通过 model-type 标签检测
    const labels = service.metadata.labels || {};
    const modelType = labels['model-type'];
    
    if (modelType === 'sglang') {
      return 'sglang';
    } else if (modelType === 'vllm') {
      return 'vllm';
    }
    
    // 如果没有 model-type 标签，返回 other
    return 'other';
  };

  useEffect(() => {
    // 检查当前选中的服务是否还存在
    if (selectedService) {
      const serviceStillExists = modelServices.find(
        service => service.metadata.name === selectedService.metadata.name
      );

      if (!serviceStillExists) {
        console.log(`Selected service ${selectedService.metadata.name} no longer in filtered list, clearing selection`);
        setSelectedService(null);
        setModelType('ollama');
        form.resetFields();
        setCurlCommand('');
        setResponse('');
        // 不显示 message，因为可能只是切换了访问模式
        return;
      }
    }

    // 如果没有选中服务且有可用服务，选择第一个
    if (modelServices.length > 0 && !selectedService) {
      const firstService = modelServices[0];
      setSelectedService(firstService);
      const detectedType = detectModelType(firstService);
      setModelType(detectedType);

      // 根据模型类型设置默认值（异步）
      updateFormDefaults(detectedType, firstService);
    }

    // 如果没有可用服务且当前有选中服务，清空选择
    if (modelServices.length === 0 && selectedService) {
      console.log('No model services available, clearing selection');
      setSelectedService(null);
      setModelType('ollama');
      form.resetFields();
      setCurlCommand('');
      setResponse('');
    }
  }, [modelServices, selectedService, form]);

  // 更新表单默认值
  const updateFormDefaults = async (type, service) => {
    setFetchingModelId(true);
    try {
      console.log('updateFormDefaults called with:', { type, serviceName: service?.metadata?.name });
      
      // 尝试从 /v1/models API 获取模型 ID
      let realModelId = "";
      try {
        const fetchedModelId = await fetchRealModelIdFromAPI(service);
        // 如果成功获取到非空值，则使用
        if (fetchedModelId) {
          realModelId = fetchedModelId;
          console.log('Successfully fetched model ID:', realModelId);
        } else {
          console.log('API returned empty, using empty string');
        }
      } catch (error) {
        console.log('Failed to fetch model ID, using empty string:', error);
      }
      
      // 统一使用相同的payload格式，只调整model参数
      form.setFieldsValue({
        apiPath: '/v1/chat/completions',
        payload: JSON.stringify({
          model: realModelId, // 使用获取到的 model ID 或空字符串
          system: "You are an AI assistant.",
          messages: [
            {
              role: "user",
              content: "Hello, how are you today?"
            }
          ],
          max_tokens: 100,
          temperature: 0.7
        }, null, 2)
      });
      console.log('Form values updated successfully');
    } catch (error) {
      console.error('Failed to update form defaults:', error);
      message.error('Failed to fetch model information');
    } finally {
      setFetchingModelId(false);
    }
  };

  const getServiceUrl = (service) => {
    if (!service) return '';
    
    // Port-Forward 模式：只返回 localhost（不包含端口）
    if (accessMode === 'portforward') {
      return 'http://localhost';
    }
    
    // LoadBalancer 模式：原有逻辑
    // 尝试获取LoadBalancer的外部IP
    const ingress = service.status?.loadBalancer?.ingress?.[0];
    if (ingress) {
      const host = ingress.hostname || ingress.ip;
      const port = service.spec.ports?.[0]?.port || 8000;
      return `http://${host}:${port}`;
    }
    
    // 如果没有外部IP，使用ClusterIP
    const clusterIP = service.spec.clusterIP;
    const port = service.spec.ports?.[0]?.port || 8000;
    return `http://${clusterIP}:${port}`;
  };

  const handleServiceChange = async (serviceName) => {
    const service = modelServices.find(s => s.metadata.name === serviceName);
    setSelectedService(service);
    
    // 检测并设置模型类型
    const detectedType = detectModelType(service);
    setModelType(detectedType);
    
    // 更新表单默认值
    await updateFormDefaults(detectedType, service);
  };

  const generateCurlCommand = async (values) => {
    if (!selectedService) {
      message.error('Please select a service first');
      return;
    }

    setLoading(true);
    try {
      const serviceUrl = getServiceUrl(selectedService);
      const { apiPath, payload, localPort } = values;
      
      // 验证JSON payload
      let parsedPayload;
      try {
        parsedPayload = JSON.parse(payload);
      } catch (error) {
        message.error('Invalid JSON format in payload');
        setLoading(false);
        return;
      }

      let fullUrl, curlCmd;
      
      if (accessMode === 'portforward') {
        // Port-Forward 模式：拼接完整 URL（包含端口）
        fullUrl = `http://localhost:${localPort || 2020}${apiPath}`;
        const servicePort = selectedService.spec.ports?.[0]?.port || 8000;
        const namespace = selectedService.metadata.namespace || 'default';
        
        curlCmd = `# Start port-forward first:
kubectl port-forward -n ${namespace} service/${selectedService.metadata.name} ${localPort || 2020}:${servicePort}

# Then run this curl command:
curl -X POST "${fullUrl}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(parsedPayload, null, 2)}'`;
      } else {
        // LoadBalancer 模式：原有逻辑
        fullUrl = `${serviceUrl}${apiPath}`;
        curlCmd = `curl -X POST "${fullUrl}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(parsedPayload, null, 2)}'`;
      }
      
      setCurlCommand(curlCmd);
      
    } catch (error) {
      console.error('Error generating curl command:', error);
      message.error('Failed to generate curl command');
    } finally {
      setLoading(false);
    }
  };

  const testModelDirectly = async (values) => {
    if (!selectedService) {
      message.error('Please select a service first');
      return;
    }

    setTestLoading(true);
    setResponse('');
    
    try {
      const { apiPath, payload, localPort } = values;
      
      // 验证JSON payload
      let parsedPayload;
      try {
        parsedPayload = JSON.parse(payload);
      } catch (error) {
        message.error('Invalid JSON format in payload');
        setTestLoading(false);
        return;
      }

      let fullUrl;
      
      if (accessMode === 'portforward') {
        // Port-Forward 模式：使用新的 API
        fullUrl = `http://localhost:${localPort || 2020}${apiPath}`;
        const servicePort = selectedService.spec.ports?.[0]?.port || 8000;
        const namespace = selectedService.metadata.namespace || 'default';
        
        const requestBody = {
          url: fullUrl,
          payload: parsedPayload,
          portForward: {
            enabled: true,
            serviceName: selectedService.metadata.name,
            namespace: namespace,
            servicePort: servicePort,
            localPort: localPort || 2020
          }
        };
        
        const response = await fetch('/api/proxy-request-portforward', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });
        
        const result = await response.json();
        
        if (result.success) {
          setResponse(JSON.stringify(result.data, null, 2));
          message.success('Request successful');
        } else {
          setResponse(`Error: ${result.error}\n\nDetails:\n${JSON.stringify(result.data || {}, null, 2)}`);
          message.warning('Request returned an error (see response for details)');
        }
      } else {
        // LoadBalancer 模式：原有逻辑
        const serviceUrl = getServiceUrl(selectedService);
        fullUrl = `${serviceUrl}${apiPath}`;
        
        const response = await fetch('/api/proxy-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: fullUrl,
            payload: parsedPayload
          })
        });
        
        const result = await response.json();
        
        if (result.success) {
          setResponse(JSON.stringify(result.data, null, 2));
          message.success('Request successful');
        } else {
          setResponse(`Error (${result.status}): ${result.error}\n\nDetails:\n${JSON.stringify(result.data, null, 2)}`);
          message.warning('Request returned an error (see response for details)');
        }
      }
      
    } catch (error) {
      console.error('Error testing model:', error);
      setResponse(`Network Error: ${error.message}`);
      message.error('Failed to test model');
    } finally {
      setTestLoading(false);
    }
  };

  const copyToClipboard = (text) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        message.success('Copied to clipboard');
      });
    } else {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      document.body.removeChild(t);
      message.success('Copied to clipboard');
    }
  };

  const getServiceStatus = (service) => {
    if (!service) return 'N/A';
    
    const ingress = service.status?.loadBalancer?.ingress;
    if (ingress && ingress.length > 0) {
      return 'ready';
    }
    
    if (service.spec.type === 'LoadBalancer') {
      return 'pending';
    }
    
    return 'internal';
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'ready': return 'success';
      case 'pending': return 'warning';
      case 'internal': return 'processing';
      default: return 'default';
    }
  };

  return (
    <div>
      <style>{`
        .ant-form-item-tooltip {
          cursor: default !important;
        }
      `}</style>

      {/* 访问模式选择 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Text strong>Access Mode</Text>
          <Radio.Group 
            value={accessMode} 
            onChange={(e) => setAccessMode(e.target.value)}
            buttonStyle="solid"
            style={{ width: '100%' }}
          >
            <Radio.Button value="loadbalancer" style={{ width: '50%', textAlign: 'center' }}>
              <CloudOutlined /> External LoadBalancer
            </Radio.Button>
            <Radio.Button value="portforward" style={{ width: '50%', textAlign: 'center' }}>
              <ApiOutlined /> Port-Forward
            </Radio.Button>
          </Radio.Group>
          
          {accessMode === 'portforward' && (
            <Alert
              message="Port-Forward Mode: Requests will automatically start/stop kubectl port-forward via ClusterIP."
              type="info"
              showIcon
              style={{ marginTop: 8 }}
            />
          )}
        </Space>
      </Card>

      {/* 服务选择 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text strong>
              <ApiOutlined /> Select Model Service
            </Text>
            <Button 
              type="text" 
              icon={<ReloadOutlined />} 
              onClick={handleRefresh}
              loading={fetchingModelId}
              size="small"
              title="Refresh model information"
            >
              Refresh
            </Button>
          </div>
          
          {modelServices.length === 0 ? (
            <Alert
              message="No model services found"
              description={
                <div>
                  <p>Deploy a model first to see available services.</p>
                  <p style={{ marginBottom: 0, fontSize: '12px', color: '#666' }}>
                    Services will appear here automatically after deployment.
                  </p>
                </div>
              }
              type="info"
              showIcon
              style={{ textAlign: 'left' }}
            />
          ) : (
            <Select
              style={{ width: '100%' }}
              placeholder="Select a service"
              value={selectedService?.metadata.name}
              onChange={handleServiceChange}
            >
              {modelServices.map(service => {
                const status = getServiceStatus(service);
                const statusColor = getStatusColor(status);
                const namespace = service.metadata.namespace || 'default';

                return (
                  <Option key={service.metadata.name} value={service.metadata.name}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>
                        {service.metadata.name}
                        <Text type="secondary" style={{ fontSize: '12px', marginLeft: '8px' }}>
                          (ns: {namespace})
                        </Text>
                      </span>
                      <Text
                        type={statusColor}
                        style={{ fontSize: '10px' }}
                      >
                        ●
                      </Text>
                    </div>
                  </Option>
                );
              })}
            </Select>
          )}

          {/* 显示选中服务的URL */}
          {selectedService && (
            <div style={{ marginTop: 8, padding: 8, backgroundColor: '#f6f8fa', borderRadius: 4 }}>
              <Text strong>Base URL: </Text>
              <Text code>{getServiceUrl(selectedService)}</Text>
            </div>
          )}
        </Space>
      </Card>

      {/* 测试表单 */}
      <Spin spinning={fetchingModelId} tip="Fetching model ID from service...">
        <Form
          form={form}
          layout="vertical"
          onFinish={generateCurlCommand}
          initialValues={{ localPort: 2020 }}
        >
        {/* Local Port - 仅 Port-Forward 模式显示 */}
        {accessMode === 'portforward' && (
          <Form.Item
            label="Local Port"
            name="localPort"
            rules={[{ required: true, message: 'Please input local port!' }]}
            tooltip="Port on your local machine for port-forward"
          >
            <InputNumber 
              min={2000}
              max={65535}
              style={{ width: '100%' }}
              placeholder="2020"
            />
          </Form.Item>
        )}

        <Form.Item
          label={
            <Space>
              <LinkOutlined />
              API Path
            </Space>
          }
          name="apiPath"
          rules={[
            { required: true, message: 'Please input API path!' },
            { pattern: /^\//, message: 'API path must start with /' }
          ]}
        >
          <Input 
            placeholder="/api/generate"
            addonBefore="API"
          />
        </Form.Item>

        <Form.Item
          label={
            <Space>
              <CodeOutlined />
              JSON Payload
            </Space>
          }
          name="payload"
          rules={[
            { required: true, message: 'Please input JSON payload!' },
            {
              validator: (_, value) => {
                try {
                  JSON.parse(value);
                  return Promise.resolve();
                } catch (error) {
                  return Promise.reject(new Error('Invalid JSON format'));
                }
              }
            }
          ]}
        >
          <TextArea
            rows={6}
            placeholder="Enter JSON payload here..."
            style={{ fontFamily: 'monospace', fontSize: '13px' }}
          />
        </Form.Item>

        <div style={{ marginBottom: 16, padding: 12, backgroundColor: '#f6f8fa', borderRadius: 6 }}>
          <div style={{ fontSize: '12px', color: '#666', marginBottom: 8 }}>
            <strong>API Examples:</strong>
          </div>
          <div style={{ fontSize: '11px', color: '#888', fontFamily: 'monospace' }}>
            {modelType === 'vllm' ? (
              <>
                /v1/chat/completions - Chat API (OpenAI Compatible)<br/>
                /v1/completions - Text Completion API<br/>
                /v1/models - Model List (GET Request)<br/>
                /health - Health Check
              </>
            ) : modelType === 'sglang' ? (
              <>
                /v1/chat/completions - Chat API (OpenAI Compatible)<br/>
                /v1/completions - Text Completion API<br/>
                /v1/models - Model List (GET Request)<br/>
                /health - Health Check
              </>
            ) : (
              <>
                /v1/chat/completions - Chat API (OpenAI Compatible)<br/>
                /api/generate - Prompt Text Generation<br/>
                /api/chat - Chat API
              </>
            )}
          </div>
        </div>

        <Space style={{ width: '100%' }} size="middle">
          <Button 
            type="primary" 
            htmlType="submit" 
            loading={loading}
            icon={<ThunderboltOutlined />}
            style={{ flex: 1 }}
            disabled={!selectedService}
          >
            Generate cURL
          </Button>
          
          <Button 
            type="default" 
            loading={testLoading}
            icon={<SendOutlined />}
            style={{ flex: 1 }}
            disabled={!selectedService}
            onClick={() => {
              form.validateFields().then(values => {
                testModelDirectly(values);
              });
            }}
          >
            Test Directly
          </Button>
        </Space>
      </Form>
      </Spin>

      <Divider />

      {/* cURL命令展示 */}
      {curlCommand && (
        <Card 
          title={
            <Space>
              <ThunderboltOutlined />
              Generated cURL Command
            </Space>
          }
          size="small"
          extra={
            <Button 
              size="small" 
              icon={<CopyOutlined />}
              onClick={() => copyToClipboard(curlCommand)}
            >
              Copy
            </Button>
          }
          style={{ marginBottom: 16 }}
        >
          <Paragraph
            code
            copyable
            style={{ 
              backgroundColor: '#f6f8fa', 
              padding: 12, 
              borderRadius: 6,
              fontSize: '12px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all'
            }}
          >
            {curlCommand}
          </Paragraph>
        </Card>
      )}

      {/* 响应结果展示 */}
      {(response || testLoading) && (
        <Card 
          title={
            <Space>
              <SendOutlined />
              Response
            </Space>
          }
          size="small"
          extra={
            response && (
              <Button 
                size="small" 
                icon={<CopyOutlined />}
                onClick={() => copyToClipboard(response)}
              >
                Copy
              </Button>
            )
          }
        >
          {testLoading ? (
            <div style={{ textAlign: 'center', padding: '20px' }}>
              <Spin size="large" />
              <div style={{ marginTop: 16 }}>Testing model...</div>
            </div>
          ) : (
            <pre style={{ 
              backgroundColor: '#f6f8fa', 
              padding: 12, 
              borderRadius: 6,
              fontSize: '12px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: '300px',
              overflow: 'auto'
            }}>
              {response}
            </pre>
          )}
        </Card>
      )}

      {/* 服务状态信息 */}
      {selectedService && (
        <Card 
          title="Service Details" 
          size="small" 
          style={{ marginTop: 16 }}
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <Text strong>Name:</Text> {selectedService.metadata.name}
            </div>
            <div>
              <Text strong>Type:</Text> {selectedService.spec.type}
            </div>
            <div>
              <Text strong>Status:</Text>{' '}
              <Text type={getStatusColor(getServiceStatus(selectedService))}>
                {getServiceStatus(selectedService)}
              </Text>
            </div>
            {selectedService.status?.loadBalancer?.ingress?.[0] && (
              <div>
                <Text strong>External Endpoint:</Text>{' '}
                <Text code>
                  {selectedService.status.loadBalancer.ingress[0].hostname || 
                   selectedService.status.loadBalancer.ingress[0].ip}
                </Text>
              </div>
            )}
          </Space>
        </Card>
      )}
    </div>
  );
};

export default TestPanel;
