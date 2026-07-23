import React, { useState, useEffect } from 'react';
import globalRefreshManager from '../hooks/useGlobalRefresh';
import {
  Card,
  Form,
  Input,
  Button,
  Alert,
  Space,
  Typography,
  message,
  Steps,
  Row,
  Col,
  Collapse,
  Spin
} from 'antd';
import {
  CloudServerOutlined,
  PlayCircleOutlined,
  InfoCircleOutlined,
  ReloadOutlined
} from '@ant-design/icons';

const { Text } = Typography;

const EksClusterCreationPanel = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [creationStatus, setCreationStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [cidrLoading, setCidrLoading] = useState(false);
  const [cidrConfig, setCidrConfig] = useState(null);
  const [metadataLoading, setMetadataLoading] = useState(false);

  // 恢复创建状态
  const restoreCreationStatus = async () => {
    try {
      console.log('🔄 Restoring creation status...');
      const response = await fetch('/api/cluster/creating-clusters');
      const result = await response.json();
      
      console.log('📊 Creating clusters response:', result);
      
      if (result.success && result.clusters) {
        // 查找EKS类型的创建中集群
        const creatingEksClusters = Object.entries(result.clusters).filter(
          ([tag, info]) => info.type === 'eks'
        );
        
        console.log('🔍 Found EKS clusters:', creatingEksClusters);
        
        if (creatingEksClusters.length > 0) {
          // 取第一个创建中的集群（通常只有一个）
          const [clusterTag, clusterInfo] = creatingEksClusters[0];
          
          console.log('✅ Restoring cluster:', clusterTag, clusterInfo);
          
          const restoredStatus = {
            status: clusterInfo.status || 'IN_PROGRESS', // 使用实际状态
            clusterTag: clusterTag,
            stackName: clusterInfo.stackName,
            stackId: clusterInfo.stackId,
            region: clusterInfo.region,
            currentStackStatus: clusterInfo.currentStackStatus,
            logs: 'Restored creation status...'
          };
          
          setCreationStatus(restoredStatus);
          console.log('📝 Set creation status:', restoredStatus);
          
          // 立即检查最新状态并更新metadata
          await checkCreationStatus(clusterTag);
        } else {
          console.log('ℹ️ No creating EKS clusters found');
          // 如果没有创建中的集群，清理UI状态
          if (creationStatus) {
            console.log('🧹 Clearing completed creation status');
            setCreationStatus(null);
          }
        }
      } else {
        console.log('❌ Failed to get creating clusters or no clusters');
        // 清理UI状态
        if (creationStatus) {
          console.log('🧹 Clearing creation status due to API failure');
          setCreationStatus(null);
        }
      }
    } catch (error) {
      console.error('❌ Failed to restore creation status:', error);
      // 清理UI状态
      if (creationStatus) {
        console.log('🧹 Clearing creation status due to error');
        setCreationStatus(null);
      }
    }
  };

  // 检查创建状态
  const checkCreationStatus = async (clusterTag) => {
    if (!clusterTag) return;

    console.log('🔍 Checking creation status for:', clusterTag);
    setStatusLoading(true);

    try {
      // 检查creating-clusters状态（这是权威状态源）
      const creatingResponse = await fetch('/api/cluster/creating-clusters');
      const creatingResult = await creatingResponse.json();
      console.log('📊 Creating clusters check result:', creatingResult);

      if (creatingResult.success && creatingResult.clusters[clusterTag]) {
        // 仍在创建中
        const clusterInfo = creatingResult.clusters[clusterTag];
        console.log('📊 Cluster info from creating-clusters:', clusterInfo);

        // 更新UI状态显示当前阶段
        setCreationStatus(prev => ({
          ...prev,
          phase: clusterInfo.phase || clusterInfo.currentStackStatus,
          currentStackStatus: clusterInfo.currentStackStatus,
          lastChecked: new Date().toISOString()
        }));

        console.log('🔄 Still creating, current phase:', clusterInfo.phase);

      } else {
        // 不在creating-clusters中 = 真正完成
        console.log('✅ Cluster not in creating-clusters, fully completed');
        setCreationStatus(prev => ({ ...prev, status: 'COMPLETED' }));
        message.success(`Cluster ${clusterTag} created successfully! Configure dependencies in Cluster Information.`);
      }

    } catch (error) {
      console.error('❌ Failed to check creation status:', error);
    } finally {
      setStatusLoading(false);
    }
  };

  // 手动刷新逻辑（与手动刷新按钮保持一致）
  const handleManualRefresh = async () => {
    console.log('🔄 Manual refresh triggered', {
      hasCreationStatus: !!creationStatus,
      clusterTag: creationStatus?.clusterTag
    });

    if (creationStatus?.clusterTag) {
      await checkCreationStatus(creationStatus.clusterTag);
    } else {
      // 没有创建中的集群时，检查是否有遗留的创建状态
      await restoreCreationStatus();
    }
  };

  // 取消创建
  const cancelCreation = async () => {
    if (!creationStatus?.clusterTag) return;
    
    try {
      const response = await fetch(`/api/cluster/cancel-creation/${creationStatus.clusterTag}`, {
        method: 'POST'
      });
      
      const result = await response.json();
      if (result.success) {
        message.success('Cluster creation cancelled successfully');
        setCreationStatus(null); // 清理UI状态
      } else {
        message.error(result.error || 'Failed to cancel cluster creation');
      }
    } catch (error) {
      message.error('Failed to cancel cluster creation');
    }
  };

  // 获取有效CIDR（同步调用）
  const getValidCidr = async (region) => {
    try {
      const response = await fetch(`/api/cluster/generate-cidr?region=${region}`);
      const result = await response.json();
      if (result.success) {
        return result.cidr;
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Failed to generate CIDR:', error.message);
      throw error;
    }
  };

  // 生成完整的 CIDR 配置
  const generateCidrConfig = async (region) => {
    if (!region) return;
    
    setCidrLoading(true);
    try {
      const response = await fetch('/api/cluster/generate-cidr-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region })
      });
      
      const result = await response.json();
      
      if (result.success) {
        setCidrConfig(result);
        // 自动填充表单
        form.setFieldsValue({
          vpcCidr: result.vpcCidr,
          publicSubnet1Cidr: result.publicSubnet1Cidr,
          publicSubnet2Cidr: result.publicSubnet2Cidr,
          eksPrivateSubnet1Cidr: result.eksPrivateSubnet1Cidr,
          eksPrivateSubnet2Cidr: result.eksPrivateSubnet2Cidr
        });
        message.success('CIDR configuration generated successfully');
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Failed to generate CIDR config:', error);
      message.error(`Failed to generate CIDR: ${error.message}`);
    } finally {
      setCidrLoading(false);
    }
  };

  // 创建集群
  const handleCreateCluster = async () => {
    try {
      // 验证表单
      const values = await form.validateFields();
      
      setLoading(true);
      console.log('Creating cluster with values:', values);
      
      // 构建 CIDR 配置对象（从表单获取）
      const cidrConfigPayload = {
        vpcCidr: values.vpcCidr,
        publicSubnet1Cidr: values.publicSubnet1Cidr,
        publicSubnet2Cidr: values.publicSubnet2Cidr,
        eksPrivateSubnet1Cidr: values.eksPrivateSubnet1Cidr,
        eksPrivateSubnet2Cidr: values.eksPrivateSubnet2Cidr
      };
      
      console.log('Using CIDR config:', cidrConfigPayload);
      
      const response = await fetch('/api/cluster/create-eks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clusterTag: values.clusterTag,
          awsRegion: values.awsRegion,
          cidrConfig: cidrConfigPayload  // 传递完整的 CIDR 配置
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        message.success('Cluster creation started successfully!');
        setCreationStatus({
          status: 'IN_PROGRESS',
          clusterTag: values.clusterTag,
          stackName: result.stackName,
          stackId: result.stackId,
          region: values.awsRegion,
          logs: 'CloudFormation stack creation initiated...'
        });
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Failed to create cluster:', error);
      message.error(`Failed to create cluster: ${error.message}`);
      setLoading(false);
    }
  };



  // 获取当前AWS region作为默认值
  const fetchCurrentRegion = async () => {
    setMetadataLoading(true);
    try {
      const response = await fetch('/api/aws/current-region');
      const result = await response.json();
      if (result.success && result.region) {
        form.setFieldsValue({
          awsRegion: result.region
        });
        // 自动生成 CIDR 配置
        await generateCidrConfig(result.region);
      } else {
        message.error('Failed to get AWS region: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Failed to fetch current region:', error);
      message.error('Failed to fetch AWS region. Please configure AWS CLI.');
    } finally {
      setMetadataLoading(false);
    }
  };

  // 生成默认集群标签
  const generateClusterTag = () => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    // 兼容性UUID生成 - 支持不同浏览器环境
    let uuid4;
    if (crypto && crypto.randomUUID) {
      uuid4 = crypto.randomUUID().substring(0, 4);
    } else {
      // 降级方案：生成4位随机字符串
      uuid4 = Math.random().toString(36).substring(2, 6);
    }
    
    return `hypd-${month}${day}-${uuid4}`;
  };

  // 初始化默认值并恢复创建状态
  useEffect(() => {
    // 设置默认集群标签
    form.setFieldsValue({
      clusterTag: generateClusterTag()
    });
    
    // 获取当前region作为默认值
    fetchCurrentRegion();
    
    // 恢复创建状态（如果有的话）
    restoreCreationStatus();
  }, []);

  // 集成全局刷新系统
  useEffect(() => {
    const componentId = 'eks-cluster-creation';

    // 全局刷新使用与手动刷新完全相同的逻辑
    globalRefreshManager.subscribe(componentId, handleManualRefresh, {
      priority: 7
    });

    return () => {
      globalRefreshManager.unsubscribe(componentId);
    };
  }, []);

  // 获取当前步骤（简化版）
  const getCurrentStep = () => {
    if (!creationStatus) return 0;
    if (creationStatus.status === 'IN_PROGRESS') return 1;
    if (creationStatus.status === 'COMPLETED') return 2;
    return 0;
  };

  return (
    <Row gutter={16}>
      {/* 左侧：创建表单 */}
      <Col span={10}>
        <Form
              form={form}
              layout="vertical"
              disabled={loading || creationStatus?.status === 'IN_PROGRESS'}
            >
              {/* 基本配置 */}
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item
                    name="clusterTag"
                    label="Cluster Tag"
                    rules={[{ required: true, message: 'Please enter cluster tag' }]}
                  >
                    <Input placeholder="hypd-instrt-0914" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="awsRegion"
                    label="AWS Region"
                    rules={[{ required: true, message: 'Please enter AWS region' }]}
                  >
                    <Input
                      suffix={metadataLoading ? <Spin size="small" /> : null}
                      placeholder={metadataLoading ? "Loading metadata..." : "e.g. us-west-2"}
                      onBlur={(e) => {
                        const r = e.target.value && e.target.value.trim();
                        // region 改变后需按新 region 重新生成 CIDR(避开该 region 已用网段)
                        if (r) generateCidrConfig(r);
                      }}
                    />
                  </Form.Item>
                </Col>
              </Row>

              {/* CIDR 配置面板（折叠） */}
              <Collapse
                style={{ marginTop: 16 }}
                items={[{
                  key: 'cidr',
                  label: 'CIDR Config (Optional)',
                  children: (
                    <Spin spinning={cidrLoading} tip="Generating CIDR configuration...">
                      <Space direction="vertical" style={{ width: '100%' }} size="middle">
                        <Form.Item 
                          label="VPC CIDR" 
                          name="vpcCidr"
                          rules={[{ required: true, message: 'VPC CIDR is required' }]}
                        >
                          <Input placeholder="10.90.0.0/16" />
                        </Form.Item>
                        
                        <Row gutter={16}>
                          <Col span={12}>
                            <Form.Item 
                              label="Public Subnet 1" 
                              name="publicSubnet1Cidr"
                              rules={[{ required: true, message: 'Required' }]}
                            >
                              <Input placeholder="10.90.10.0/24" />
                            </Form.Item>
                          </Col>
                          <Col span={12}>
                            <Form.Item 
                              label="Public Subnet 2" 
                              name="publicSubnet2Cidr"
                              rules={[{ required: true, message: 'Required' }]}
                            >
                              <Input placeholder="10.90.11.0/24" />
                            </Form.Item>
                          </Col>
                        </Row>
                        
                        <Row gutter={16}>
                          <Col span={12}>
                            <Form.Item 
                              label="EKS Private Subnet 1" 
                              name="eksPrivateSubnet1Cidr"
                              rules={[{ required: true, message: 'Required' }]}
                            >
                              <Input placeholder="10.90.7.0/24" />
                            </Form.Item>
                          </Col>
                          <Col span={12}>
                            <Form.Item 
                              label="EKS Private Subnet 2" 
                              name="eksPrivateSubnet2Cidr"
                              rules={[{ required: true, message: 'Required' }]}
                            >
                              <Input placeholder="10.90.8.0/24" />
                            </Form.Item>
                          </Col>
                        </Row>
                      </Space>
                    </Spin>
                  )
                }]}
              />


              {/* 创建按钮 */}
              <Form.Item style={{ marginTop: 24, marginBottom: 0 }}>
                <Row gutter={8}>
                  <Col flex="auto">
                    <Button
                      type="primary"
                      onClick={handleCreateCluster}
                      loading={loading}
                      icon={<PlayCircleOutlined />}
                      block
                    >
                      {!creationStatus ? 'Create Cluster (~15 min)' : 'Create Cluster'}
                    </Button>
                  </Col>
                  <Col>
                    <Button onClick={() => {
                      form.resetFields();
                      form.setFieldsValue({
                        clusterTag: generateClusterTag()
                      });
                      fetchCurrentRegion();
                    }}>
                      Reset
                    </Button>
                  </Col>
                </Row>
              </Form.Item>
        </Form>
      </Col>

      {/* 右侧：创建进度 */}
      <Col span={14}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Text strong>Creation Progress</Text>
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={statusLoading}
              onClick={handleManualRefresh}
              title="Refresh Status"
            >
              Refresh
            </Button>
            {creationStatus && creationStatus.status !== 'COMPLETED' && (
              <Button
                size="small"
                danger
                onClick={cancelCreation}
              >
                Cancel Creation
              </Button>
            )}
          </Space>
        </div>
            {creationStatus ? (
              // 有创建状态时显示进度
              <>
                <Steps
                  direction="vertical"
                  size="small"
                  current={getCurrentStep()}
                  items={[
                    {
                      title: 'Validating Parameters',
                      status: 'finish',
                      description: 'Cluster configuration validated'
                    },
                    {
                      title: 'Creating CloudFormation Stack',
                      status: creationStatus.status === 'IN_PROGRESS' ? 'process' : 
                             (getCurrentStep() > 1 ? 'finish' : 'wait'),
                      description: `Stack: ${creationStatus.stackName}`
                    },
                    {
                      title: 'Cluster Created',
                      status: creationStatus.status === 'COMPLETED' ? 'finish' : 'wait',
                      description: 'EKS cluster ready. Configure dependencies in Cluster Information.'
                    }
                  ]}
                />

                {creationStatus.logs && (
                  <div style={{ marginTop: 16 }}>
                    <Text strong>CloudFormation Events:</Text>
                    <div style={{ 
                      background: '#f5f5f5', 
                      padding: 12, 
                      marginTop: 8, 
                      borderRadius: 4,
                      maxHeight: 200,
                      overflowY: 'auto',
                      fontFamily: 'monospace',
                      fontSize: '12px'
                    }}>
                      {creationStatus.logs.split('\n').map((line, index) => (
                        <div key={index}>{line}</div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              // 没有创建状态时显示灰色步骤
              <>
                <Steps
                  direction="vertical"
                  size="small"
                  current={-1}
                  status="wait"
                  items={[
                    {
                      title: 'Validating Parameters',
                      status: 'wait',
                      description: 'Ready to validate cluster configuration'
                    },
                    {
                      title: 'Creating CloudFormation Stack',
                      status: 'wait',
                      description: 'Ready to create infrastructure'
                    },
                    {
                      title: 'Cluster Created',
                      status: 'wait',
                      description: 'Ready to register cluster'
                    }
                  ]}
                />
                
                <div style={{ marginTop: 24, textAlign: 'center', color: '#999' }}>
                  <Text type="secondary">Ready to create cluster</Text>
                </div>
              </>
            )}
      </Col>
    </Row>
  );
};

export default EksClusterCreationPanel;
