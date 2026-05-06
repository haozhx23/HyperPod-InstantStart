import React, { useState, useEffect } from 'react';
import {
  Card,
  Form,
  Row,
  Col,
  Input,
  InputNumber,
  Select,
  Button,
  Space,
  Alert,
  Radio,
  Tooltip,
  Collapse,
  message,
  Spin
} from 'antd';
import {
  ShareAltOutlined,
  RocketOutlined,
  GlobalOutlined,
  LinkOutlined,
  InfoCircleOutlined,
  SettingOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import './AdvancedScalingPanelV2.css';

const { Option } = Select;
const { Panel } = Collapse;

const AdvancedScalingPanelV2 = ({ onDeploy }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [routingPolicy, setRoutingPolicy] = useState('cache_aware');
  const [selectedDeployment, setSelectedDeployment] = useState('');
  const [availableDeployments, setAvailableDeployments] = useState([]);

  // 根据选择的部署获取端口 (从API数据中获取)
  const getDeploymentPort = (deploymentTag) => {
    const deployment = availableDeployments.find(d => d.deploymentTag === deploymentTag);
    return deployment ? deployment.port : 8000;
  };

  // 获取SGLang部署列表
  const fetchDeployments = async () => {
    setRefreshing(true);
    try {
      const response = await fetch('/api/sglang-deployments');
      const data = await response.json();

      if (data.success) {
        setAvailableDeployments(data.deployments);

        // 如果当前没有选择或选择的部署不在列表中，自动选择第一个
        if (!selectedDeployment || !data.deployments.find(d => d.deploymentTag === selectedDeployment)) {
          if (data.deployments.length > 0) {
            const firstDeployment = data.deployments[0].deploymentTag;
            setSelectedDeployment(firstDeployment);
            form.setFieldsValue({ targetDeployment: firstDeployment });
          }
        }

        message.success(`Found ${data.deployments.length} available SGLang deployment(s)`);
      } else {
        message.error('Failed to fetch SGLang deployments: ' + data.error);
        setAvailableDeployments([]);
      }
    } catch (error) {
      console.error('Error fetching deployments:', error);
      message.error('Failed to fetch SGLang deployments');
      setAvailableDeployments([]);
    } finally {
      setRefreshing(false);
    }
  };

  // 组件加载时获取部署列表
  useEffect(() => {
    fetchDeployments();
  }, []);



  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      console.log('Routing Config:', values);

      // 自动生成 router deployment 名称：{targetDeployment}-sglgw
      const routerDeploymentName = `${values.targetDeployment}-sglgw`;

      // 构建配置对象
      const config = {
        type: 'advanced-scaling',
        sglangRouter: {
          deploymentName: routerDeploymentName,
          routingPolicy: values.routingPolicy || 'cache_aware',
          routerPort: values.routerPort || 30000,
          metricsPort: values.metricsPort || 29000,

          // 使用用户选择的serviceType
          serviceType: values.serviceType,

          // 服务发现配置 - 固定针对sglang类型的deployment
          targetDeployment: values.targetDeployment,
          discoveryPort: getDeploymentPort(values.targetDeployment), // 使用自动检测的端口
          checkInterval: 120, // 固定默认值，不再从表单获取

          // Cache-Aware策略参数
          cacheThreshold: values.cacheThreshold,
          balanceAbsThreshold: values.balanceAbsThreshold,
          balanceRelThreshold: values.balanceRelThreshold,
          evictionIntervalSecs: values.evictionIntervalSecs,
          maxTreeSize: values.maxTreeSize
        }
      };

      if (onDeploy) {
        await onDeploy(config);
      }
    } catch (error) {
      console.error('Error deploying routing:', error);
    } finally {
      setLoading(false);
    }
  };


  return (
    <div className="advanced-scaling-v2">
      <Alert
        type="info"
        message="Routing with SGLang Router"
        description="Configure intelligent request routing with SGLang Router. Model deployments are managed in the Model Deployment tab."
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          routingPolicy: 'cache_aware',
          routerPort: 30000,
          metricsPort: 29000,
          serviceType: 'clusterip', // 默认为Cluster IP
          targetDeployment: '', // 将通过fetchDeployments动态设置
          cacheThreshold: 0.5,
          balanceAbsThreshold: 32,
          balanceRelThreshold: 1.1,
          evictionIntervalSecs: 30,
          maxTreeSize: 10000
        }}
      >
        {/* SGLang Router Basic Configuration */}
        <Card
          title={
            <Space>
              <ShareAltOutlined />
              <span>SGLang Router Configuration</span>
            </Space>
          }
          className="section-card"
          style={{ marginBottom: 24 }}
        >
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item
                label={
                  <Space>
                    Target SGLang Deployment
                    <Tooltip title="Select SGLang deployment to route requests to (only ClusterIP services are supported)">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                required
              >
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item
                    name="targetDeployment"
                    noStyle
                    rules={[{ required: true, message: 'Please select target deployment!' }]}
                  >
                    <Select
                      placeholder={refreshing ? "Loading deployments..." : "Select SGLang deployment"}
                      onChange={(value) => setSelectedDeployment(value)}
                      loading={refreshing}
                      notFoundContent={refreshing ? <Spin size="small" /> : "No SGLang deployments found"}
                      style={{ flex: 1 }}
                    >
                      {availableDeployments.map(deployment => (
                        <Option key={deployment.deploymentTag} value={deployment.deploymentTag}>
                          <Space>
                            <span>{deployment.deploymentTag}</span>
                            <span style={{ color: '#666' }}>
                              (Port: {deployment.port}, {deployment.status})
                            </span>
                          </Space>
                        </Option>
                      ))}
                    </Select>
                  </Form.Item>
                  <Button
                    icon={<ReloadOutlined />}
                    loading={refreshing}
                    onClick={fetchDeployments}
                    title="Refresh deployments"
                  />
                </Space.Compact>
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                label="Routing Policy"
                name="routingPolicy"
                rules={[{ required: true, message: 'Please select routing policy' }]}
              >
                <Select onChange={setRoutingPolicy}>
                  <Option value="cache_aware">Cache Aware</Option>
                  <Option value="round_robin">Round Robin</Option>
                  <Option value="random">Random</Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="Router Port"
                name="routerPort"
                rules={[{ required: true, message: 'Please enter router port' }]}
              >
                <InputNumber
                  min={8000}
                  max={65535}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="Metrics Port"
                name="metricsPort"
                rules={[{ required: true, message: 'Please enter metrics port' }]}
              >
                <InputNumber
                  min={8000}
                  max={65535}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
          </Row>

          {/* Service Type配置 */}
          <Row gutter={16}>
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
                </Radio.Group>
              </Form.Item>
            </Col>
            <Col span={12}>
              {/* 预留空间用于将来的配置选项 */}
            </Col>
          </Row>


          <Alert
            type="info"
            message="Router Service Configuration"
            description="Choose External Access for LoadBalancer service or Cluster IP for internal access only."
            style={{ marginTop: 16 }}
          />
        </Card>


        {/* Advanced Configuration - Only show for cache_aware policy */}
        {routingPolicy === 'cache_aware' && (
          <Collapse style={{ marginBottom: 24 }}>
            <Panel
              header={
                <Space>
                  <SettingOutlined />
                  <span>Cache-Aware Policy Settings</span>
                </Space>
              }
              key="cache-aware-settings"
            >
              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item
                    label={
                      <Space>
                        Cache Threshold
                        <Tooltip title="Cache matching threshold (0.0-1.0)">
                          <InfoCircleOutlined />
                        </Tooltip>
                      </Space>
                    }
                    name="cacheThreshold"
                  >
                    <InputNumber
                      min={0}
                      max={1}
                      step={0.1}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item
                    label={
                      <Space>
                        Balance Abs Threshold
                        <Tooltip title="Load imbalance absolute threshold">
                          <InfoCircleOutlined />
                        </Tooltip>
                      </Space>
                    }
                    name="balanceAbsThreshold"
                  >
                    <InputNumber
                      min={1}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item
                    label={
                      <Space>
                        Balance Rel Threshold
                        <Tooltip title="Load imbalance relative threshold">
                          <InfoCircleOutlined />
                        </Tooltip>
                      </Space>
                    }
                    name="balanceRelThreshold"
                  >
                    <InputNumber
                      min={1}
                      step={0.1}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item
                    label={
                      <Space>
                        Eviction Interval (secs)
                        <Tooltip title="Cache cleanup interval in seconds">
                          <InfoCircleOutlined />
                        </Tooltip>
                      </Space>
                    }
                    name="evictionIntervalSecs"
                  >
                    <InputNumber
                      min={10}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    label={
                      <Space>
                        Max Tree Size
                        <Tooltip title="Maximum nodes per radix tree">
                          <InfoCircleOutlined />
                        </Tooltip>
                      </Space>
                    }
                    name="maxTreeSize"
                  >
                    <InputNumber
                      min={1000}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
              </Row>
            </Panel>
          </Collapse>
        )}

        <Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            icon={<RocketOutlined />}
            size="large"
            block
          >
            {loading ? 'Deploying Router...' : 'Deploy SGLang Router'}
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default AdvancedScalingPanelV2;