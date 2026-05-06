import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Layout, Row, Col, Card, message, Tabs, Space, Select, Button } from 'antd';
import { useDispatch, useSelector } from 'react-redux';
import { RocketOutlined, ExperimentOutlined, DatabaseOutlined, SettingOutlined, ThunderboltOutlined, DownloadOutlined, CloudServerOutlined, FireOutlined, CodeOutlined, CloudOutlined, ReloadOutlined } from '@ant-design/icons';
import AppHeader from './AppHeader';
import { setPodsServices } from '../store/slices/appStatusSlice';
import { selectRecipeConfig, selectConnectionStatus } from '../store/selectors';
import { webSocketManager } from '../hooks/useWebSocket';
import ConfigPanel from './ConfigPanel';
import ServiceConfigPanel from './ServiceConfigPanel';
import ManagedInferencePanel from './ManagedInferencePanel';
import ManagedInferenceScalingPanel from './ManagedInferenceScalingPanel';
import TestPanel from './TestPanel';
import TrainingConfigPanel from './TrainingConfigPanel';
import MSSwiftRecipePanel from './MSSwiftRecipePanel';
import VerlRecipePanel from './VerlRecipePanel';
import TorchRecipePanel from './TorchRecipePanel';
import ScriptRecipePanel from './ScriptRecipePanel';
import SageMakerJobPanel from './SageMakerJobPanel';
import { useHyperPodInstanceTypes } from '../utils/hyperPodInstanceTypes';
import TrainingMonitorPanel from './TrainingMonitorPanelRedux';
import TrainingHistoryPanel from './TrainingHistoryPanel';
import ClusterManagement from './ClusterManagementRedux';
import EnhancedModelDownloadPanel from './EnhancedModelDownloadPanel';
import S3StorageManager from './S3StorageManager';
import FSxStorageManager from './FSxStorageManager';
import S3StoragePanel from './S3StoragePanel';
import AdvancedScalingPanelV2 from './AdvancedScalingPanelV2';
import ScalingPanel from './ScalingPanel';
import globalRefreshManager from '../hooks/useGlobalRefresh';
import operationRefreshManager from '../hooks/useOperationRefresh';
import resourceEventBus from '../utils/resourceEventBus';

const { Content } = Layout;

function LegacyRoot() {
  const dispatch = useDispatch();

  const recipeConfig = useSelector(selectRecipeConfig);

  // connectionStatus 由 App.js 顶层的 useWebSocket() 写入 Redux，这里直接订阅。
  // fetchAppStatusConfig 已在 App.js 顶层 AppBootstrap 里 dispatch，这里不重复。
  const connectionStatus = useSelector(selectConnectionStatus);

  const isRecipeVisible = (recipeKey) => recipeConfig[recipeKey] !== 'off';

  const [activeMainTab, setActiveMainTab] = useState('model-management'); // 新增主标签状态
  const [configTab, setConfigTab] = useState('model-config'); // 配置标签页状态
  const [selectedStorage, setSelectedStorage] = useState('s3-claim'); // Storage页面选中的存储
  const [availableStorages, setAvailableStorages] = useState([]); // 可用存储列表
  const [s3PanelLoading, setS3PanelLoading] = useState(false); // S3StoragePanel 刷新 loading
  const s3PanelRef = useRef(null); // S3StoragePanel ref，用于触发刷新
  const [recipeTab, setRecipeTab] = useState('torch'); // Training Recipes标签页状态

  // Training Recipes: 预加载实例类型
  const { instanceTypes: hyperPodInstanceTypes, loading: instanceTypesLoading, refresh: refreshInstanceTypes } = useHyperPodInstanceTypes();

  useEffect(() => {
    // 注册App级别的刷新函数到全局刷新管理器
    const appRefreshFunction = async () => {
      // 🔄 优先通过WebSocket请求更新（更快）
      webSocketManager.requestStatusUpdate();

      // 🔄 同时执行API调用作为备用
      await Promise.all([
        fetchClusterStatus(),
        fetchPodsAndServices()
      ]);
    };

    globalRefreshManager.subscribe('app-status', appRefreshFunction, {
      priority: 9 // 高优先级，与cluster-status同级
    });

    // 🚀 注册到操作刷新管理器
    operationRefreshManager.subscribe('app-status', appRefreshFunction);

    // 🚀 注册pods和services刷新到全局刷新管理器
    const podsServicesRefreshFunction = async () => {
      try {
        await fetchPodsAndServices();
      } catch (error) {
        console.error('Pods and services refresh error:', error);
        throw error;
      }
    };

    globalRefreshManager.subscribe('pods-services', podsServicesRefreshFunction, {
      priority: 8 // 高优先级，与status-monitor相同
    });

    // 🚀 注册到操作刷新管理器
    operationRefreshManager.subscribe('pods-services', podsServicesRefreshFunction);

    // 初始加载集群状态
    fetchClusterStatus();

    // 初始加载pods和services（作为备用）
    fetchPodsAndServices();

    // 初始加载业务Service列表
    fetchBusinessServices();

    return () => {
      globalRefreshManager.unsubscribe('app-status');
      globalRefreshManager.unsubscribe('pods-services');
      operationRefreshManager.unsubscribe('app-status');
      operationRefreshManager.unsubscribe('pods-services');
    };
  }, []);

  const fetchClusterStatus = useCallback(async () => {
    try {
      console.log('Fetching cluster status...');
      await fetch('/api/cluster-status');
      // 数据由 clusterStatusSlice 通过独立的 fetchClusterStatus thunk 消费；
      // 此处仅作 HTTP cache primer，不写本地 state。
    } catch (error) {
      console.error('Error fetching cluster status:', error);
      message.error('Failed to fetch cluster status');
    }
  }, []);

  const fetchBusinessServices = async () => {
    try {
      // 业务 Service 列表由 appStatusSlice.bindingServices 承载；
      // 此处仅作 HTTP cache primer（保持原有调用链，避免少一个上游刷新）。
      await fetch('/api/binding-services');
    } catch (error) {
      console.error('Error fetching business services:', error);
    }
  };

  // 获取可用的存储配置
  const fetchAvailableStorages = async () => {
    try {
      const response = await fetch('/api/s3-storages');
      const result = await response.json();
      if (result.success) {
        setAvailableStorages(result.storages || []);
        if (result.storages.length > 0 && !result.storages.find(s => s.pvcName === selectedStorage)) {
          setSelectedStorage(result.storages[0].pvcName);
        }
      }
    } catch (error) {
      console.error('Error fetching storages:', error);
    }
  };

  const fetchPodsAndServices = useCallback(async () => {
    try {
      console.log('Fetching pods and services using V2 API...');

      // 使用 V2 优化 API
      const response = await fetch('/api/v2/app-status');
      const data = await response.json();

      console.log('App Status V2 response:', {
        pods: data.pods?.length || 0,
        services: data.services?.length || 0,
        fetchTime: data.fetchTime,
        cached: data.cached,
      });

      // V2 API 返回处理过的数据，需要提取原始数据给现有组件使用
      dispatch(setPodsServices({
        pods: data.rawPods || data.pods || [],
        services: data.rawServices || data.services || [],
      }));

      if (data.fetchTime && !data.cached) {
        console.log(`Fresh data fetched in ${data.fetchTime}ms`);
      } else if (data.cached) {
        console.log('Using cached data');
      }

      await fetchBusinessServices();
    } catch (error) {
      console.error('Error fetching pods and services:', error);
      message.error('Failed to fetch pods and services');
    }
  }, [dispatch]);

  const handleServiceDeploy = async (config) => {
    console.log('🚀 handleServiceDeploy called with config:', config);
    try {
      const response = await fetch('/api/deploy-service', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });
      
      const result = await response.json();
      
      if (result.success) {
        message.success('Business service deployed successfully!');
        // 触发操作刷新（旧机制，保留兼容）
        operationRefreshManager.triggerOperationRefresh('service-deploy', {
          serviceName: config.serviceName,
          timestamp: new Date().toISOString(),
          source: 'service-config-panel'
        });

        // 触发新的事件总线（新机制）
        // Service Binding 不需要 GPU，只刷新 App Status
        resourceEventBus.emit('app-status-only', {
          serviceName: config.serviceName
        });
      } else {
        message.error(`Service deployment failed: ${result.error}`);
      }
    } catch (error) {
      console.error('❌ Error deploying service:', error);
      message.error('Failed to deploy service');
    }
  };

  const handleAdvancedScalingDeploy = async (config) => {
    try {
      console.log('Deploying advanced scaling configuration:', config);

      const response = await fetch('/api/deploy-advanced-scaling', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });

      const result = await response.json();

      if (result.success) {
        message.success('Advanced scaling stack deployed successfully!');
        // 触发操作刷新（旧机制）
        operationRefreshManager.triggerOperationRefresh('advanced-scaling-deploy', {
          timestamp: new Date().toISOString(),
          source: 'advanced-scaling-panel'
        });
        
        // 触发新的事件总线（新机制）
        // Advanced Routing 不使用 GPU，只刷新 App Status
        resourceEventBus.emit('app-status-only');
      } else {
        message.error(`Advanced scaling deployment failed: ${result.error}`);
      }
    } catch (error) {
      console.error('❌ Error deploying advanced scaling:', error);
      message.error('Failed to deploy advanced scaling stack');
    }
  };

  const handleScalingDeploy = async (config) => {
    try {
      console.log('Deploying KEDA scaling configuration:', config);

      // 根据配置类型选择不同的API端点
      let apiEndpoint = '/api/deploy-keda-scaling'; // 默认旧版本

      if (config.type === 'keda-scaling-unified') {
        apiEndpoint = '/api/deploy-keda-scaling-unified';
      }

      console.log(`Using API endpoint: ${apiEndpoint} for config type: ${config.type}`);

      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });

      const result = await response.json();

      if (result.success) {
        if (config.type === 'keda-scaling-unified') {
          message.success(`Unified KEDA scaling deployed for service: ${config.serviceName}`);
        } else {
          message.success('KEDA scaling configuration deployed successfully!');
        }

        // 触发操作刷新（旧机制）
        operationRefreshManager.triggerOperationRefresh('keda-scaling-deploy', {
          timestamp: new Date().toISOString(),
          source: 'scaling-panel',
          configType: config.type
        });
        
        // 触发新的事件总线（新机制）
        // Unified Scaling 不使用 GPU，只刷新 App Status
        resourceEventBus.emit('app-status-only', {
          serviceName: config.serviceName,
          configType: config.type
        });
      } else {
        message.error(`KEDA scaling deployment failed: ${result.error}`);
        if (result.errors && result.errors.length > 0) {
          result.errors.forEach(error => {
            message.error(error);
          });
        }
      }
    } catch (error) {
      console.error('❌ Error deploying KEDA scaling:', error);
      message.error('Failed to deploy KEDA scaling configuration');
    }
  };

  const handleTrainingLaunch = async (config) => {
    try {
      // Append timestamp to job name: -MMdd-HHmm
      const now = new Date();
      const ts = `-${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
      if (config.jobName) {
        config.jobName = config.jobName + ts;
      } else if (config.trainingJobName) {
        config.trainingJobName = config.trainingJobName + ts;
      }

      console.log('Launching training job with config:', config);
      
      // 根据recipeType选择不同的API端点
      let apiEndpoint = '/api/launch-training'; // 默认LlamaFactory

      if (config.recipeType === 'torch') {
        apiEndpoint = '/api/launch-torch-training';
      } else if (config.recipeType === 'script') {
        apiEndpoint = '/api/launch-script-training';
      } else if (config.recipeType === 'msswift') {
        apiEndpoint = '/api/launch-msswift-training';
      }
      if (config.recipeType === 'verl') {
        apiEndpoint = '/api/launch-verl-training';
      }
      
      console.log(`Using API endpoint: ${apiEndpoint} for recipe type: ${config.recipeType}`);
      
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });
      
      const result = await response.json();
      
      if (result.success) {
        // 移除重复的message.success，让WebSocket处理通知
        // message.success('Training job deployed successfully');
        // 刷新集群状态
        fetchClusterStatus();
        // 刷新pods和services
        fetchPodsAndServices();
        
        // 显示成功通知
        message.success(result.message || 'Training job launched successfully');
        
        // 触发新的事件总线（新机制）
        // Training 需要 GPU，触发 Cluster Status 和 App Status 刷新
        resourceEventBus.emit('training-launch', {
          recipeType: config.recipeType
        });
      } else {
        message.error(`Training launch failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Error launching training job:', error);
      message.error('Failed to launch training job');
    }
  };

  const getConnectionStatusIndicator = () => {
    switch (connectionStatus) {
      case 'connected':
        return '🟢';
      case 'connecting':
        return '🟡';
      case 'disconnected':
        return '🟠';
      case 'error':
        return '🔴';
      default:
        return '🔴';
    }
  };

  return (
      <Layout className="app-layout">
        <AppHeader
          connectionStatus={connectionStatus}
          getConnectionStatusIndicator={getConnectionStatusIndicator}
        />
      
      <Content className="app-content">
        {/* 主标签切换区域 */}
        <div style={{ marginBottom: '8px' }}>
          <Tabs
            activeKey={activeMainTab}
            onChange={setActiveMainTab}
            size="middle"
            items={[
              {
                key: 'cluster-management',
                label: (
                  <Space>
                    <SettingOutlined />
                    Cluster Management
                  </Space>
                ),
              },
              {
                key: 'model-management',
                label: (
                  <Space>
                    <DatabaseOutlined />
                    Storage
                  </Space>
                ),
              },
              {
                key: 'inference',
                label: (
                  <Space>
                    <RocketOutlined />
                    Inference
                  </Space>
                ),
              },
              {
                key: 'training',
                label: (
                  <Space>
                    <ExperimentOutlined />
                    Training
                  </Space>
                ),
              },
              {
                key: 'training-history',
                label: (
                  <Space>
                    <DatabaseOutlined />
                    Training History
                  </Space>
                ),
              }
            ]}
          />
        </div>
        
        {/* 中间动态内容区域 */}
        <div style={{ marginBottom: '16px' }}>
          {/* Cluster Management */}
          <div style={{ display: activeMainTab === 'cluster-management' ? 'block' : 'none' }}>
            <ClusterManagement />
          </div>

          <div style={{ display: activeMainTab === 'inference' ? 'block' : 'none' }}>
            <Row gutter={[16, 16]}>
              <Col xs={24} lg={12}>
                <Card
                  title="Inference Configuration"
                  className="theme-card compute"
                  style={{ height: '60vh', overflow: 'auto' }}
                >
                  <Tabs 
                    activeKey={configTab} 
                    onChange={setConfigTab}
                    size="small"
                    items={[
                      {
                        key: 'model-config',
                        label: 'Model Deployment',
                        children: (
                          <ConfigPanel
                          />
                        )
                      },
                      {
                        key: 'service-config',
                        label: 'Service Binding',
                        children: (
                          <ServiceConfigPanel
                            onDeploy={handleServiceDeploy}
                          />
                        )
                      },
                      {
                        key: 'advanced-scaling-preview',
                        label: 'SGL Routing',
                        children: (
                          <AdvancedScalingPanelV2
                            onDeploy={handleAdvancedScalingDeploy}
                          />
                        )
                      },
                      // Unified Scaling tab
                      {
                        key: 'keda-scaling-preview',
                        label: 'Unified Scaling',
                        children: (
                          <ScalingPanel
                            onDeploy={handleScalingDeploy}
                          />
                        )
                      },
                      // Visual divider (non-clickable separator between basic and managed features)
                      {
                        key: 'divider-managed',
                        label: '|',
                        disabled: true,
                        className: 'tab-divider',
                        children: <div />
                      },
                      // Managed Inference tab
                      {
                        key: 'managed-inference',
                        label: 'Managed Inference',
                        children: (
                          <ManagedInferencePanel
                          />
                        )
                      },
                      // Managed Inference Auto-Scaling tab
                      {
                        key: 'managed-inference-scaling',
                        label: 'Managed Scaling',
                        children: (
                          <ManagedInferenceScalingPanel />
                        )
                      }
                    ]}
                  />
                </Card>
              </Col>
              <Col xs={24} lg={12}>
                <Card
                  title="Model Testing"
                  className="theme-card ml"
                  style={{ height: '60vh', overflow: 'auto' }}
                >
                  <TestPanel
                    onRefresh={fetchPodsAndServices}
                  />
                </Card>
              </Col>
            </Row>
          </div>
          
          <Row gutter={[16, 16]} style={{ display: activeMainTab === 'training' ? 'flex' : 'none' }}>
            {/* Training - 左侧：训练配置 */}
            <Col xs={24} lg={12}>
              <Card
                title="Training Recipes"
                className="theme-card compute"
                style={{ height: '60vh', overflow: 'auto' }}
              >
                <Tabs
                  activeKey={recipeTab}
                  onChange={setRecipeTab}
                  size="small"
                  items={[
                    ...(isRecipeVisible('script') ? [{
                      key: 'script',
                      label: <Space><CodeOutlined />Script Recipe</Space>,
                      children: (
                        <ScriptRecipePanel
                          onLaunch={handleTrainingLaunch}
                          hyperPodInstanceTypes={hyperPodInstanceTypes}
                          instanceTypesLoading={instanceTypesLoading}
                          refreshInstanceTypes={refreshInstanceTypes}
                        />
                      )
                    }] : []),
                    ...(isRecipeVisible('torch') ? [{
                      key: 'torch',
                      label: <Space><FireOutlined />Torch Recipe</Space>,
                      children: (
                        <TorchRecipePanel
                          onLaunch={handleTrainingLaunch}
                          hyperPodInstanceTypes={hyperPodInstanceTypes}
                          instanceTypesLoading={instanceTypesLoading}
                          refreshInstanceTypes={refreshInstanceTypes}
                        />
                      )
                    }] : []),
                    ...(isRecipeVisible('llamafactory') ? [{
                      key: 'llamafactory',
                      label: <Space><ExperimentOutlined />LlamaFactory Recipe</Space>,
                      children: (
                        <TrainingConfigPanel
                          onLaunch={handleTrainingLaunch}
                          hyperPodInstanceTypes={hyperPodInstanceTypes}
                          instanceTypesLoading={instanceTypesLoading}
                          refreshInstanceTypes={refreshInstanceTypes}
                        />
                      )
                    }] : []),
                    ...(isRecipeVisible('msswift') ? [{
                      key: 'msswift',
                      label: <Space><ThunderboltOutlined />MS-Swift Recipe</Space>,
                      children: (
                        <MSSwiftRecipePanel
                          onLaunch={handleTrainingLaunch}
                          hyperPodInstanceTypes={hyperPodInstanceTypes}
                          instanceTypesLoading={instanceTypesLoading}
                          refreshInstanceTypes={refreshInstanceTypes}
                        />
                      )
                    }] : []),
                    ...(isRecipeVisible('verl') ? [{
                      key: 'verl',
                      label: <Space><RocketOutlined />Verl Recipe</Space>,
                      children: (
                        <VerlRecipePanel
                          onLaunch={handleTrainingLaunch}
                          hyperPodInstanceTypes={hyperPodInstanceTypes}
                          instanceTypesLoading={instanceTypesLoading}
                          refreshInstanceTypes={refreshInstanceTypes}
                        />
                      )
                    }] : []),
                    ...(isRecipeVisible('sagemaker') ? [{
                      key: 'sagemaker',
                      label: <Space><CloudOutlined />SageMakerJob</Space>,
                      children: (
                        <SageMakerJobPanel
                          onLaunch={handleTrainingLaunch}
                        />
                      )
                    }] : []),
                  ]}
                />
              </Card>
            </Col>
            
            {/* Training - 右侧：训练监控 */}
            <Col xs={24} lg={12}>
              <Card
                title="Training Job Monitor"
                className="theme-card analytics"
                style={{ height: '60vh', overflow: 'auto' }}
              >
                <TrainingMonitorPanel />
              </Card>
            </Col>
          </Row>
          
          <div style={{
            display: activeMainTab === 'training-history' ? 'block' : 'none'
          }}>
            <TrainingHistoryPanel />
          </div>
          
          <div style={{ display: activeMainTab === 'model-management' ? 'block' : 'none' }}>
            <Row gutter={[16, 16]}>
              <Col xs={24} lg={12}>
                <Card
                  title="Storage Configuration"
                  className="theme-card storage"
                  style={{ height: '60vh', overflow: 'auto' }}
                >
                  <Tabs
                    defaultActiveKey="enhanced-download"
                    size="small"
                    items={[
                      {
                        key: 'enhanced-download',
                        label: (
                          <Space>
                            <DownloadOutlined />
                            HuggingFace Download
                          </Space>
                        ),
                        children: (
                          <EnhancedModelDownloadPanel
                            onStorageChange={setSelectedStorage}
                            onStorageRefresh={fetchAvailableStorages}
                          />
                        )
                      },
                      {
                        key: 'storage-config',
                        label: (
                          <Space>
                            <SettingOutlined />
                            S3 Mount Config
                          </Space>
                        ),
                        children: (
                          <S3StorageManager onStorageChange={fetchAvailableStorages} />
                        )
                      },
                      {
                        key: 'fsx-config',
                        label: (
                          <Space>
                            <CloudServerOutlined />
                            FSx Lustre Config
                          </Space>
                        ),
                        children: (
                          <FSxStorageManager onStorageChange={fetchAvailableStorages} />
                        )
                      }
                    ]}
                  />
                </Card>
              </Col>
              <Col xs={24} lg={12}>
                <Card
                  title={
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                      <Space>
                        <DatabaseOutlined />
                        S3 Storage Contents
                        <Select
                          size="small"
                          value={selectedStorage}
                          onChange={setSelectedStorage}
                          style={{ minWidth: 150 }}
                        >
                          {availableStorages.map(storage => (
                            <Select.Option key={storage.pvcName} value={storage.pvcName}>
                              {storage.name} ({storage.bucketName})
                            </Select.Option>
                          ))}
                        </Select>
                      </Space>
                      <Button
                        icon={<ReloadOutlined />}
                        onClick={() => s3PanelRef.current?.refresh()}
                        loading={s3PanelLoading}
                        size="small"
                      >
                        Refresh
                      </Button>
                    </div>
                  }
                  className="theme-card storage"
                  style={{ height: '60vh', overflow: 'auto' }}
                >
                  <S3StoragePanel
                    ref={s3PanelRef}
                    selectedStorage={selectedStorage}
                    onLoadingChange={setS3PanelLoading}
                  />
                </Card>
              </Col>
            </Row>
          </div>
        </div>
        
      </Content>
    </Layout>
  );
}

export default LegacyRoot;
