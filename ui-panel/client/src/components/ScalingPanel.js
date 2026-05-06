import React, { useState, useEffect } from 'react';
import {
  Card,
  Form,
  Row,
  Col,
  InputNumber,
  Input,
  Button,
  Space,
  Alert,
  Select,
  Tooltip,
  Typography,
  Divider,
  Modal,
  Checkbox
} from 'antd';
import {
  ScissorOutlined,
  RocketOutlined,
  InfoCircleOutlined,
  DatabaseOutlined,
  ClockCircleOutlined,
  LineChartOutlined,
  EyeOutlined,
  SaveOutlined,
  ReloadOutlined
} from '@ant-design/icons';

const { Option } = Select;
const { Text, Title } = Typography;
const { TextArea } = Input;

const ScalingPanel = ({ onDeploy }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [generatedYaml, setGeneratedYaml] = useState('');
  const [availableDeployments, setAvailableDeployments] = useState([]);

  // Router Services 相关状态
  const [routerServices, setRouterServices] = useState([]);
  const [routerServicesLoading, setRouterServicesLoading] = useState(false);
  const [selectedService, setSelectedService] = useState(null);

  useEffect(() => {
    fetchAvailableDeployments();
    fetchRouterServices();
  }, []);

  const fetchAvailableDeployments = async () => {
    try {
      const response = await fetch('/api/deployments');
      const data = await response.json();
      if (data.success) {
        setAvailableDeployments(data.deployments || []);
      }
    } catch (error) {
      console.error('Error fetching deployments:', error);
    }
  };

  const fetchRouterServices = async () => {
    try {
      setRouterServicesLoading(true);
      const response = await fetch('/api/router-services');
      const data = await response.json();
      if (data.success) {
        setRouterServices(data.services || []);
      }
    } catch (error) {
      console.error('Error fetching router services:', error);
    } finally {
      setRouterServicesLoading(false);
    }
  };

  // Router Service 选择处理
  const handleRouterServiceSelect = (serviceName) => {
    const service = routerServices.find(s => s.name === serviceName);
    setSelectedService(service);

    if (service) {
      // 自动填充相关字段
      form.setFieldsValue({
        serviceName: serviceName,
        routerMetricPort: service.metricPort,
        deploymentName: service.modelDeploymentName  // 使用关联的模型deployment
      });

      // 清除 serviceName 字段的验证错误
      form.setFields([
        {
          name: 'serviceName',
          errors: []
        }
      ]);
    }
  };

  const handlePreview = async () => {
    try {
      // 首先验证所有字段
      const values = await form.validateFields();

      // 检查是否选择了 Router Service
      if (!selectedService) {
        console.error('No router service selected');
        return;
      }

      // 构建配置对象（与 handleSubmit 中的逻辑相同）
      const config = {
        serviceName: values.serviceName,
        routerMetricPort: selectedService?.metricPort,
        deploymentName: selectedService?.modelDeploymentName,  // 使用关联的模型deployment
        minReplica: values.minReplica,
        maxReplica: values.maxReplica,
        kedaPollInterval: values.kedaPollInterval,
        kedaCoolDownPeriod: values.kedaCoolDownPeriod,
        scrapeInterval: values.scrapeInterval,
        enabledTriggers: values.enabledTriggers,
        // QPS Trigger 配置
        kedaTrig1ValueThreshold: values.kedaTrig1ValueThreshold,
        kedaTrig1ActThreshold: values.kedaTrig1ActThreshold,
        qpsWindow: values.qpsWindow,
        // Queue Trigger 配置
        kedaTrig2ValueThreshold: values.kedaTrig2ValueThreshold,
        kedaTrig2ActThreshold: values.kedaTrig2ActThreshold
      };

      const response = await fetch('/api/keda/unified/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });

      const result = await response.json();

      if (result.success) {
        setGeneratedYaml(result.yaml);
        setPreviewVisible(true);
      } else {
        console.error('Preview failed:', result.error, result.errors);
      }
    } catch (error) {
      // 这里捕获表单验证失败的错误，不做任何处理，让表单自己显示错误
      if (error.errorFields) {
        console.log('Form validation failed:', error.errorFields);
      } else {
        console.error('Error generating preview:', error);
      }
    }
  };

  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      console.log('KEDA Scaling Config:', values);

      // 检查是否选择了 Router Service
      if (!selectedService) {
        console.error('No router service selected');
        setLoading(false);
        return;
      }

      // 构建 trigger 配置
      const triggers = [];

      if (values.enabledTriggers?.includes('qps')) {
        triggers.push({
          type: 'qps',
          valueThreshold: values.kedaTrig1ValueThreshold,
          activationThreshold: values.kedaTrig1ActThreshold,
          window: values.qpsWindow
        });
      }

      if (values.enabledTriggers?.includes('queue')) {
        triggers.push({
          type: 'queue',
          valueThreshold: values.kedaTrig2ValueThreshold,
          activationThreshold: values.kedaTrig2ActThreshold
        });
      }

      const config = {
        type: 'keda-scaling-unified',
        serviceName: values.serviceName,
        routerMetricPort: selectedService?.metricPort,
        deploymentName: selectedService?.modelDeploymentName,  // 使用关联的模型deployment
        minReplica: values.minReplica,
        maxReplica: values.maxReplica,
        kedaPollInterval: values.kedaPollInterval,
        kedaCoolDownPeriod: values.kedaCoolDownPeriod,
        scrapeInterval: values.scrapeInterval,
        triggers: triggers,
        enabledTriggers: values.enabledTriggers,
        // QPS Trigger 配置
        kedaTrig1ValueThreshold: values.kedaTrig1ValueThreshold,
        kedaTrig1ActThreshold: values.kedaTrig1ActThreshold,
        qpsWindow: values.qpsWindow,
        // Queue Trigger 配置
        kedaTrig2ValueThreshold: values.kedaTrig2ValueThreshold,
        kedaTrig2ActThreshold: values.kedaTrig2ActThreshold
      };

      console.log('Processed config:', config);

      if (onDeploy) {
        await onDeploy(config);
      }
    } catch (error) {
      console.error('Error deploying KEDA scaling:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="scaling-panel">
      <Alert
        type="info"
        message="KEDA Auto Scaling Configuration"
        description="Configure KEDA auto-scaling based on Prometheus metrics from SGLang Router. ScaledObject associated with Router will be built or overwrite previous configuration."
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          // Router Service Configuration
          serviceName: '',

          // Scaling Configuration
          minReplica: 1,
          maxReplica: 10,
          kedaPollInterval: 30,
          kedaCoolDownPeriod: 300,
          scrapeInterval: 30,

          // Trigger Configuration
          enabledTriggers: [],

          // QPS Trigger (Trigger 1)
          kedaTrig1ValueThreshold: 2.0,
          kedaTrig1ActThreshold: 1.0,
          qpsWindow: '1m',

          // Queue Depth Trigger (Trigger 2)
          kedaTrig2ValueThreshold: 10,
          kedaTrig2ActThreshold: 5
        }}
      >
        {/* Router Service Configuration */}
        <Card
          title={
            <Space>
              <DatabaseOutlined />
              <span>Router Service Configuration</span>
            </Space>
          }
          style={{ marginBottom: 16 }}
        >
          <Form.Item
            label={
              <Space>
                Router Service
                <Tooltip title="Select the SGLang Router service for auto-scaling">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            required
          >
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                name="serviceName"
                noStyle
                rules={[{ required: true, message: 'Please select router service!' }]}
              >
                <Select
                  showSearch
                  placeholder="Select router service"
                  loading={routerServicesLoading}
                  onChange={handleRouterServiceSelect}
                  onFocus={fetchRouterServices}
                  style={{ flex: 1 }}
                >
                  {routerServices.map(service => (
                    <Option key={service.name} value={service.name}>
                      {service.name} (Metrics Port: {service.metricPort})
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Button
                icon={<ReloadOutlined />}
                loading={routerServicesLoading}
                onClick={fetchRouterServices}
                title="Refresh router services"
              />
            </Space.Compact>
          </Form.Item>

          {selectedService && (
            <Alert
              type="info"
              showIcon
              message={
                <div>
                  <p><strong>Router:</strong> {selectedService.deploymentName} | <strong>Model (Scaling Target):</strong> {selectedService.modelDeploymentName} | <strong>Metric Port:</strong> {selectedService.metricPort}</p>
                </div>
              }
              style={{ marginTop: 12 }}
            />
          )}
        </Card>

        {/* Scaling Configuration */}
        <Card
          title={
            <Space>
              <LineChartOutlined />
              <span>Scaling Configuration</span>
            </Space>
          }
          style={{ marginBottom: 16 }}
        >
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item
                label="Prometheus Scrape Interval (s)"
                name="scrapeInterval"
                rules={[
                  { required: true, message: 'Please input scrape interval!' },
                  { type: 'number', min: 5, max: 300, message: 'Must be between 5 and 300 seconds' }
                ]}
              >
                <InputNumber
                  min={5}
                  max={300}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label="KEDA Poll Interval (s)"
                name="kedaPollInterval"
                rules={[
                  { required: true, message: 'Please input polling interval!' },
                  { type: 'number', min: 5, max: 300, message: 'Must be between 5 and 300 seconds' }
                ]}
              >
                <InputNumber
                  min={5}
                  max={300}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label="Cooldown Period (s)"
                name="kedaCoolDownPeriod"
                rules={[
                  { required: true, message: 'Please input cooldown period!' },
                  { type: 'number', min: 30, max: 3600, message: 'Must be between 30 and 3600 seconds' }
                ]}
              >
                <InputNumber
                  min={30}
                  max={3600}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label="Min Replicas"
                name="minReplica"
                rules={[
                  { required: true, message: 'Please input min replicas!' },
                  { type: 'number', min: 0, max: 100, message: 'Must be between 0 and 100' }
                ]}
              >
                <InputNumber
                  min={0}
                  max={100}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            label="Max Replicas"
            name="maxReplica"
            rules={[
              { required: true, message: 'Please input max replicas!' },
              { type: 'number', min: 1, max: 100, message: 'Must be between 1 and 100' }
            ]}
          >
            <InputNumber
              min={1}
              max={100}
              style={{ width: '200px' }}
            />
          </Form.Item>
        </Card>

        {/* Scaling Triggers */}
        <Card
          title={
            <Space>
              <LineChartOutlined />
              <span>Scaling Triggers</span>
              <Tooltip title="Select one or both triggers for auto-scaling">
                <InfoCircleOutlined />
              </Tooltip>
            </Space>
          }
          style={{ marginBottom: 24 }}
        >
          {/* Trigger Selection Checkboxes */}
          <Form.Item
            label="Enable Triggers"
            name="enabledTriggers"
            rules={[{ required: true, message: 'Please select at least one trigger!' }]}
          >
            <Checkbox.Group>
              <Space direction="vertical" size="large">
                <Checkbox value="qps">QPS per Worker (Trigger 1)</Checkbox>
                <Checkbox value="queue">Queue Depth (Trigger 2)</Checkbox>
              </Space>
            </Checkbox.Group>
          </Form.Item>

          <Divider />

          {/* Trigger 1: QPS per Worker Configuration */}
          <Form.Item
            noStyle
            shouldUpdate={(prevValues, currentValues) =>
              prevValues.enabledTriggers !== currentValues.enabledTriggers
            }
          >
            {({ getFieldValue }) => {
              const enabledTriggers = getFieldValue('enabledTriggers') || [];
              return enabledTriggers.includes('qps') ? (
                <Card
                  size="small"
                  title="QPS per Worker (Trigger 1)"
                  style={{ marginBottom: 16, backgroundColor: '#f9f9f9' }}
                >
                  <Row gutter={16}>
                    <Col span={8}>
                      <Form.Item
                        label="Value Threshold"
                        name="kedaTrig1ValueThreshold"
                        rules={[{ required: true, message: 'Required for QPS trigger!' }]}
                      >
                        <InputNumber
                          min={0}
                          step={0.1}
                          placeholder={2.0}
                          addonAfter="req/s"
                          style={{ width: '100%' }}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item
                        label="Activation Threshold"
                        name="kedaTrig1ActThreshold"
                        rules={[{ required: true, message: 'Required for QPS trigger!' }]}
                      >
                        <InputNumber
                          min={0}
                          step={0.1}
                          placeholder={1.0}
                          addonAfter="req/s"
                          style={{ width: '100%' }}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item
                        label="Window Length"
                        name="qpsWindow"
                        rules={[{ required: true, message: 'Required for QPS trigger!' }]}
                      >
                        <Select>
                          <Option value="10s">10 seconds</Option>
                          <Option value="20s">20 seconds</Option>
                          <Option value="30s">30 seconds</Option>
                          <Option value="1m">1 minute</Option>
                          <Option value="2m">2 minutes</Option>
                        </Select>
                      </Form.Item>
                    </Col>
                  </Row>
                  <Alert
                    type="info"
                    message="QPS per Worker divides total requests by current replica count"
                    showIcon
                    style={{ marginTop: 8 }}
                  />
                </Card>
              ) : null;
            }}
          </Form.Item>

          {/* Trigger 2: Queue Depth Configuration */}
          <Form.Item
            noStyle
            shouldUpdate={(prevValues, currentValues) =>
              prevValues.enabledTriggers !== currentValues.enabledTriggers
            }
          >
            {({ getFieldValue }) => {
              const enabledTriggers = getFieldValue('enabledTriggers') || [];
              return enabledTriggers.includes('queue') ? (
                <Card
                  size="small"
                  title="Queue Depth (Trigger 2)"
                  style={{ backgroundColor: '#f9f9f9' }}
                >
                  <Row gutter={16}>
                    <Col span={12}>
                      <Form.Item
                        label="Value Threshold"
                        name="kedaTrig2ValueThreshold"
                        rules={[{ required: true, message: 'Required for Queue trigger!' }]}
                      >
                        <InputNumber
                          min={0}
                          placeholder={10}
                          addonAfter="jobs"
                          style={{ width: '100%' }}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item
                        label="Activation Threshold"
                        name="kedaTrig2ActThreshold"
                        rules={[{ required: true, message: 'Required for Queue trigger!' }]}
                      >
                        <InputNumber
                          min={0}
                          placeholder={5}
                          addonAfter="jobs"
                          style={{ width: '100%' }}
                        />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Alert
                    type="info"
                    message="Queue Depth monitors the number of pending jobs in the router queue"
                    showIcon
                    style={{ marginTop: 8 }}
                  />
                </Card>
              ) : null;
            }}
          </Form.Item>

          {/* Validation Message */}
          <Form.Item
            noStyle
            shouldUpdate={(prevValues, currentValues) =>
              prevValues.enabledTriggers !== currentValues.enabledTriggers
            }
          >
            {({ getFieldValue }) => {
              const enabledTriggers = getFieldValue('enabledTriggers') || [];
              return enabledTriggers.length === 0 ? (
                <Alert
                  type="warning"
                  message="Please select at least one trigger type for auto-scaling"
                  showIcon
                />
              ) : null;
            }}
          </Form.Item>
        </Card>

        {/* Action Buttons */}
        <div style={{ marginTop: '16px' }}>
          {/* Preview YAML 按钮行 */}
          <div style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginBottom: '12px',
            height: '32px'
          }}>
            <Button
              type="text"
              size="small"
              icon={<EyeOutlined />}
              onClick={handlePreview}
              style={{
                color: '#666',
                fontSize: '12px',
                height: '28px',
                padding: '0 8px'
              }}
              title="Preview YAML Configuration"
            >
              Preview YAML
            </Button>
          </div>

          {/* Deploy 按钮 - 全宽度 */}
          <Button
            type="primary"
            htmlType="submit"
            size="large"
            loading={loading}
            icon={<RocketOutlined />}
            block
          >
            {loading ? 'Deploying KEDA Scaling...' : 'Deploy KEDA Scaling'}
          </Button>
        </div>
      </Form>

      {/* YAML Preview Modal */}
      <Modal
        title={
          <Space>
            <EyeOutlined />
            KEDA Configuration Preview
          </Space>
        }
        open={previewVisible}
        onCancel={() => setPreviewVisible(false)}
        width={800}
        footer={[
          <Button key="close" onClick={() => setPreviewVisible(false)}>
            Close
          </Button>,
          <Button
            key="copy"
            type="primary"
            icon={<SaveOutlined />}
            onClick={() => {
              if (navigator.clipboard) {
                navigator.clipboard.writeText(generatedYaml);
              } else {
                const t = document.createElement('textarea');
                t.value = generatedYaml;
                document.body.appendChild(t);
                t.select();
                document.execCommand('copy');
                document.body.removeChild(t);
              }
            }}
          >
            Copy to Clipboard
          </Button>
        ]}
      >
        <TextArea
          value={generatedYaml}
          rows={20}
          style={{ fontFamily: 'monospace', fontSize: '12px' }}
          readOnly
        />
      </Modal>
    </div>
  );
};

export default ScalingPanel;