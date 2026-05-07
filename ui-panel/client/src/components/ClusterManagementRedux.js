import React, { useState, useEffect, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  Card,
  Form,
  Input,
  Button,
  Space,
  Tag,
  Spin,
  message,
  Select,
  Modal,
  Drawer,
  Tabs,
  Row,
  Col,
  Typography,
  Alert,
  Divider,
  InputNumber,
  Tooltip,
  Collapse,
  Checkbox,
  Radio
} from 'antd';
import {
  CloudServerOutlined,
  SettingOutlined,
  ReloadOutlined,
  PlayCircleOutlined,
  CheckCircleOutlined,
  ImportOutlined,
  InfoCircleOutlined,
  AppstoreOutlined
} from '@ant-design/icons';
import NodeGroupManager from './NodeGroupManagerRedux';
import EksClusterCreationPanel from './EksClusterCreationPanel';
import {
  fetchClusters,
  switchCluster as switchClusterAction,
  checkDependenciesStatus,
  configureDependencies
} from '../store/slices/clustersSlice';
import {
  fetchAdvancedFeatures,
  updateAdvancedFeatures,
  fetchNodeGroups
} from '../store/slices/nodeGroupsSlice';
import {
  selectActiveCluster,
  selectClustersList,
  selectDependenciesStatus,
  selectClusterLoading,
  selectClusterError,
  selectEffectiveDependenciesStatus,
  selectHyperPodGroups
} from '../store/selectors';
import globalRefreshManager from '../hooks/useGlobalRefresh';

const { Title, Text } = Typography;
const { Option } = Select;

/**
 * Advanced Features 字段声明表
 *
 * 设计意图：
 *   Submit 时只把"用户亲手动过的"字段发给后端，避免 stale form 值导致后端误操作
 *   （典型场景：某 feature 被另一个 feature 自动补装后，form 里残留的 unchecked 状态
 *    会触发 `_updateCertManager({enabled: false})` 把刚装好的 cert-manager 又卸载）。
 *
 * 每行含义：
 *   - touchKeys: form 字段名数组。只要其中任一字段被用户动过（antd isFieldTouched=true），
 *                就认为这个 feature 需要更新。聚合字段（如 Karpenter 的 disruption）会有多项。
 *   - updateKey: 后端 updates 对象里对应的 key（见 managedFeaturesManager.updateAdvancedFeatures）。
 *   - build(values): 从 form values 组装成后端期望的对象结构。
 *   - hyperPodOnly: true 表示该 feature 仅在当前集群有 HyperPod 时才提交。
 *
 * 新增 feature 时：
 *   1. 在 handleOpenAddons 的 setFieldsValue 里加一行，把 addon 状态映射到 form 字段
 *   2. 在这里加一行，描述它的 touch 字段集、updateKey、build 函数
 *   （不用改 handleSubmitAddons 的循环逻辑）
 *
 * HAMi 不在此表：它走独立 API (/api/cluster/hami/install|uninstall)，由 handleSubmitAddons 单独处理。
 */
const ADDON_FIELD_MAP = [
  // 通用功能（不依赖 HyperPod）
  {
    touchKeys: ['kuberayOperatorEnabled'],
    updateKey: 'kuberayOperator',
    build: (v) => ({ enabled: v.kuberayOperatorEnabled }),
  },
  {
    touchKeys: ['certManagerEnabled'],
    updateKey: 'certManager',
    build: (v) => ({ enabled: v.certManagerEnabled }),
  },
  {
    touchKeys: ['fsxCsiDriverEnabled'],
    updateKey: 'fsxCsiDriver',
    build: (v) => ({ enabled: v.fsxCsiDriverEnabled }),
  },
  // HyperPod 专属
  {
    touchKeys: ['inferenceOperatorEnabled'],
    updateKey: 'inferenceOperator',
    build: (v) => ({ enabled: v.inferenceOperatorEnabled }),
    hyperPodOnly: true,
  },
  {
    touchKeys: ['trainingOperatorEnabled'],
    updateKey: 'trainingOperator',
    build: (v) => ({ enabled: v.trainingOperatorEnabled }),
    hyperPodOnly: true,
  },
  {
    touchKeys: ['tieredStorageEnabled', 'tieredStorageMode', 'tieredStoragePercentage'],
    updateKey: 'tieredStorage',
    build: (v) => ({
      enabled: v.tieredStorageEnabled,
      configMode: v.tieredStorageMode,
      percentage: v.tieredStorageMode === 'custom' ? v.tieredStoragePercentage : null,
    }),
    hyperPodOnly: true,
  },
  {
    touchKeys: [
      'karpenterEnabled',
      'karpenterConsolidationPolicy',
      'karpenterConsolidateAfter',
      'karpenterBudgetNodes',
    ],
    updateKey: 'karpenter',
    build: (v) => ({
      enabled: v.karpenterEnabled,
      disruption: {
        consolidationPolicy: v.karpenterConsolidationPolicy,
        consolidateAfter: v.karpenterConsolidateAfter,
        budgetNodes: v.karpenterBudgetNodes,
      },
    }),
    hyperPodOnly: true,
  },
];

// 依赖配置状态显示组件（增强版）
const DependencyStatus = ({ cluster, dependenciesStatus }) => {
  // 获取状态显示
  const getDependencyStatusDisplay = () => {
    if (!dependenciesStatus) {
      return <Text type="secondary">Loading...</Text>;
    }

    // 检查是否是导入的集群类型
    const isImported = cluster?.type === 'imported';

    if (isImported) {
      // 导入的集群：显示实际配置状态（不再区分有无HyperPod）
      if (dependenciesStatus?.configured) {
        return <Tag color="green">Configured</Tag>;
      } else {
        return <Tag color="warning">Not Configured</Tag>;
      }
    } else {
      // 创建的集群：显示配置状态
      if (dependenciesStatus?.configured) {
        return <Tag color="green">Configured</Tag>;
      } else if (dependenciesStatus?.detected && dependenciesStatus?.effectiveStatus) {
        return <Tag color="blue">Detected</Tag>;
      } else {
        return <Tag color="warning">Not Configured</Tag>;
      }
    }
  };

  return getDependencyStatusDisplay();
};

// 依赖配置按钮组件 - Redux版本
const DependencyConfigButton = ({ clusterTag, currentCluster }) => {
  const dispatch = useDispatch();
  const dependenciesStatus = useSelector(selectDependenciesStatus);
  const isConfiguring = useSelector(state => state.clusters.configuring);

  // 配置依赖
  const configureDependenciesHandler = async () => {
    try {
      await dispatch(configureDependencies(clusterTag)).unwrap();
      message.success('Dependency configuration started');
    } catch (error) {
      message.error(error || 'Failed to start dependency configuration');
    }
  };

  // 获取按钮文本和状态
  const getButtonProps = () => {
    // 导入的集群也可以配置依赖（移除了原有的禁用逻辑）
    
    if (!dependenciesStatus) {
      return {
        text: 'Configure Dependencies',
        disabled: true,
        type: 'default',
        icon: <SettingOutlined />
      };
    }

    switch (dependenciesStatus.status) {
      case 'pending':
        return {
          text: 'Configure Dependencies',
          disabled: false,
          type: 'primary',
          icon: <SettingOutlined />
        };
      case 'configuring':
        return {
          text: 'Configuring...',
          disabled: true,
          type: 'primary',
          icon: <SettingOutlined />
        };
      case 'success':
        return {
          text: 'Dependencies Configured',
          disabled: true,
          type: 'default',
          icon: <CheckCircleOutlined />
        };
      case 'failed':
        return {
          text: 'Retry Configuration',
          disabled: false,
          type: 'default',
          icon: <ReloadOutlined />
        };
      default:
        return {
          text: 'Configure Dependencies',
          disabled: true,
          type: 'default',
          icon: <SettingOutlined />
        };
    }
  };

  const buttonProps = getButtonProps();

  return (
    <Button
      type={buttonProps.type}
      loading={isConfiguring}
      disabled={buttonProps.disabled}
      onClick={configureDependenciesHandler}
      icon={buttonProps.icon}
    >
      {isConfiguring ? 'Launching...' : buttonProps.text}
    </Button>
  );
};

// 自定义滚动条样式 - 深色主题
const customScrollbarStyle = `
  .custom-scrollbar::-webkit-scrollbar {
    width: 8px;
  }

  .custom-scrollbar::-webkit-scrollbar-track {
    background: #2a2a2a;
    border-radius: 4px;
  }

  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 4px;
    border: 1px solid #333;
  }

  .custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background: #666;
  }

  .custom-scrollbar::-webkit-scrollbar-thumb:active {
    background: #777;
  }

  .custom-scrollbar::-webkit-scrollbar-corner {
    background: #2a2a2a;
  }
`;

const ClusterManagementRedux = () => {
  // Redux hooks
  const dispatch = useDispatch();
  const clustersFromStore = useSelector(selectClustersList);
  const clusters = Array.isArray(clustersFromStore) ? clustersFromStore : [];
  const activeCluster = useSelector(selectActiveCluster);
  const dependenciesStatus = useSelector(selectDependenciesStatus);
  const effectiveDependenciesStatus = useSelector(selectEffectiveDependenciesStatus);
  const loading = useSelector(selectClusterLoading);
  // const error = useSelector(selectClusterError); // Unused

  const hyperPodGroups = useSelector(selectHyperPodGroups);

  // 本地状态管理
  const [showImportModal, setShowImportModal] = useState(false);
  const [importForm] = Form.useForm();
  const [importLoading, setImportLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('manage');
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Advanced Features (Advanced Features) 状态
  const [addonsModalVisible, setAddonsModalVisible] = useState(false);
  const [addonsForm] = Form.useForm();
  const [addonsData, setAddonsData] = useState(null);
  const [addonsLoading, setAddonsLoading] = useState(false);
  const [addonsUpdating, setAddonsUpdating] = useState(false);
  const [hamiStatus, setHamiStatus] = useState(null);

  // 默认配置值
  const defaultConfig = {
    clusterTag: 'hypd-instrt-0801',
    awsRegion: 'us-west-2',
    ftpName: '',
    gpuCapacityAz: 'us-west-2c',
    gpuInstanceType: 'ml.g6.12xlarge',
    gpuInstanceCount: 2
  };

  const [form] = Form.useForm();
  const [currentStep, setCurrentStep] = useState(0);

  // 导入现有集群
  const importExistingCluster = async (values) => {
    setImportLoading(true);
    try {
      const response = await fetch('/api/cluster/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });

      const result = await response.json();
      if (result.success) {
        message.success(`Successfully imported cluster: ${values.eksClusterName}. Please select it in Cluster Information to use.`);
        setShowImportModal(false);
        importForm.resetFields();

        // 刷新集群列表
        await dispatch(fetchClusters()).unwrap();

        // 不自动切换，让用户手动选择（与创建集群流程一致）
        // await dispatch(switchClusterAction(values.eksClusterName)).unwrap();

        // setTimeout(() => {
        //   dispatch(checkDependenciesStatus(values.eksClusterName));
        // }, 2000);

      } else {
        message.error(`Failed to import cluster: ${result.error}`);
      }
    } catch (error) {
      console.error('Error importing cluster:', error);
      message.error(`Error importing cluster: ${error.message}`);
    } finally {
      setImportLoading(false);
    }
  };

  // 测试集群连接
  const testClusterConnection = async () => {
    const values = importForm.getFieldsValue();
    if (!values.eksClusterName || !values.awsRegion) {
      message.warning('Please fill in EKS Cluster Name and AWS Region first');
      return;
    }

    setImportLoading(true);
    try {
      const response = await fetch('/api/cluster/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });

      const result = await response.json();
      if (result.success) {
        message.success(`Connection successful! Found ${result.nodeCount || 0} nodes`);
      } else {
        message.error(`Connection failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Error testing connection:', error);
      message.error(`Error testing connection: ${error.message}`);
    } finally {
      setImportLoading(false);
    }
  };

  // 切换集群
  const handleSwitchCluster = async (clusterTag) => {
    if (clusterTag === activeCluster) return;

    try {
      await dispatch(switchClusterAction(clusterTag)).unwrap();

      // 集群切换时刷新页面以清除缓存
      window.location.reload();

      message.success(`Successfully switched to cluster: ${clusterTag}`);

      // 延迟5秒刷新状态，给kubectl配置切换足够时间
      message.info('Updating kubectl configuration and refreshing cluster status...', 3);
      setTimeout(() => {
        dispatch(checkDependenciesStatus(clusterTag));
      }, 5000);

    } catch (error) {
      message.error(`Failed to switch cluster: ${error}`);
    }
  };

  // 统一的全局刷新函数
  const refreshAllStatus = async () => {
    try {
      // 并行执行所有刷新操作
      await Promise.all([
        dispatch(fetchClusters()),
        activeCluster ? dispatch(checkDependenciesStatus(activeCluster)) : Promise.resolve(),
      ]);

      // 触发NodeGroupManager刷新
      setRefreshTrigger(prev => prev + 1);

      message.success('Status refreshed successfully');
    } catch (error) {
      console.error('Error refreshing status:', error);
      message.error(`Error refreshing status: ${error.message}`);
    }
  };

  // 初始加载
  useEffect(() => {
    dispatch(fetchClusters());
  }, [dispatch]);

  // 注册到全局刷新管理器
  useEffect(() => {
    const componentId = 'cluster-management-redux';

    globalRefreshManager.subscribe(componentId, refreshAllStatus, {
      priority: 5
    });

    return () => {
      globalRefreshManager.unsubscribe(componentId);
    };
  }, []);

  // 监听活跃集群变化
  useEffect(() => {
    if (activeCluster) {
      dispatch(checkDependenciesStatus(activeCluster));
    }
  }, [activeCluster, dispatch]);

  // Advanced Features: 判断当前集群是否有 HyperPod
  const currentCluster = clusters.find(c => c.clusterTag === activeCluster);
  const hasHyperPod = !!(
    currentCluster?.hyperPodCluster ||
    (Array.isArray(hyperPodGroups) && hyperPodGroups.length > 0)
  );

  // Advanced Features: 打开 Modal
  const handleOpenAddons = async () => {
    setAddonsModalVisible(true);
    setAddonsLoading(true);

    try {
      const [result, hamiResponse] = await Promise.all([
        dispatch(fetchAdvancedFeatures()).unwrap(),
        fetch('/api/cluster/hami/status')
      ]);
      setAddonsData(result.advancedFeatures);

      const hamiData = await hamiResponse.json();
      setHamiStatus(hamiData);

      addonsForm.setFieldsValue({
        hamiEnabled: hamiData.installed || false,
        hamiSplitCount: hamiData.config?.splitCount || 10,
        hamiNodePolicy: hamiData.config?.nodePolicy || 'binpack',
        hamiGpuPolicy: hamiData.config?.gpuPolicy || 'spread',
        tieredStorageEnabled: result.advancedFeatures.tieredStorage.enabled,
        tieredStorageMode: result.advancedFeatures.tieredStorage.configMode,
        tieredStoragePercentage: result.advancedFeatures.tieredStorage.percentage || 50,
        inferenceOperatorEnabled: result.advancedFeatures.inferenceOperator.enabled,
        trainingOperatorEnabled: result.advancedFeatures.trainingOperator?.enabled || false,
        kuberayOperatorEnabled: result.advancedFeatures.kuberayOperator?.enabled || false,
        certManagerEnabled: result.advancedFeatures.certManager?.enabled || false,
        fsxCsiDriverEnabled: result.advancedFeatures.fsxCsiDriver?.enabled || false,
        karpenterEnabled: result.advancedFeatures.karpenter?.enabled || false,
        karpenterConsolidationPolicy: result.advancedFeatures.karpenter?.disruption?.consolidationPolicy || 'WhenEmptyOrUnderutilized',
        karpenterConsolidateAfter: result.advancedFeatures.karpenter?.disruption?.consolidateAfter || '0s',
        karpenterBudgetNodes: result.advancedFeatures.karpenter?.disruption?.budgetNodes || '90%',
      });
    } catch (error) {
      console.error('Error fetching cluster add-ons:', error);
      message.error(`Failed to load cluster add-ons: ${error}`);
      setAddonsModalVisible(false);
    } finally {
      setAddonsLoading(false);
    }
  };

  // Advanced Features: 提交更新
  //
  // 只把用户"亲手动过"的字段发给后端（antd Form isFieldTouched 语义）。
  // setFieldsValue 通过 fetchAddons 设置的初始值不算 touched，避免 stale form 状态
  // 触发后端误操作（如把 inference operator 自动补装的 cert-manager 又卸载掉）。
  //
  // 哪些字段进入 updates 对象由 ADDON_FIELD_MAP 声明，新增 feature 只需在表里加一行。
  // HAMi 走独立 API，不在 ADDON_FIELD_MAP 里，下面单独处理。
  const handleSubmitAddons = async () => {
    try {
      setAddonsUpdating(true);
      const values = await addonsForm.validateFields();

      // 按声明表 + isFieldTouched 构造只含 diff 的 updates
      const updates = {};
      for (const field of ADDON_FIELD_MAP) {
        if (field.hyperPodOnly && !hasHyperPod) continue;
        const touched = field.touchKeys.some((key) => addonsForm.isFieldTouched(key));
        if (touched) {
          updates[field.updateKey] = field.build(values);
        }
      }

      // HAMi 处理
      const currentHamiEnabled = hamiStatus?.installed || false;
      const newHamiEnabled = values.hamiEnabled || false;

      if (newHamiEnabled && !currentHamiEnabled) {
        const hamiResponse = await fetch('/api/cluster/hami/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            splitCount: values.hamiSplitCount,
            nodePolicy: values.hamiNodePolicy,
            gpuPolicy: values.hamiGpuPolicy
          })
        });
        const hamiResult = await hamiResponse.json();
        if (!hamiResult.success) throw new Error(hamiResult.message || 'Failed to install HAMi');
      } else if (newHamiEnabled && currentHamiEnabled) {
        const hamiResponse = await fetch('/api/cluster/hami/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            splitCount: values.hamiSplitCount,
            nodePolicy: values.hamiNodePolicy,
            gpuPolicy: values.hamiGpuPolicy
          })
        });
        const hamiResult = await hamiResponse.json();
        if (!hamiResult.success) throw new Error(hamiResult.message || 'Failed to update HAMi');
      } else if (!newHamiEnabled && currentHamiEnabled) {
        const hamiResponse = await fetch('/api/cluster/hami/uninstall', { method: 'DELETE' });
        const hamiResult = await hamiResponse.json();
        if (!hamiResult.success) throw new Error(hamiResult.message || 'Failed to uninstall HAMi');
      }

      // 刷新 HAMi 状态
      try {
        const statusResponse = await fetch('/api/cluster/hami/status');
        const statusData = await statusResponse.json();
        setHamiStatus(statusData);
      } catch (e) { /* ignore */ }

      // 更新其他功能（仅当有实际 diff 时才调用后端）
      if (Object.keys(updates).length > 0) {
        await dispatch(updateAdvancedFeatures(updates)).unwrap();
      }

      message.success('Cluster add-ons updated successfully');
      setAddonsModalVisible(false);
      addonsForm.resetFields();

      dispatch(fetchNodeGroups());
    } catch (error) {
      console.error('Error updating cluster add-ons:', error);
      message.error(`Failed to update: ${error.message || error}`);
    } finally {
      setAddonsUpdating(false);
    }
  };

  return (
    <>
      {/* 注入自定义滚动条样式 */}
      <style dangerouslySetInnerHTML={{ __html: customScrollbarStyle }} />

      <div>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'manage',
              label: (
                <Space>
                  <InfoCircleOutlined />
                  <span>Cluster Information</span>
                </Space>
              ),
              children: (
                <>
                  {/* 集群选择器：整行宽度 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                    <Select
                      value={activeCluster}
                      onChange={handleSwitchCluster}
                      style={{ flex: 1 }}
                      placeholder={clusters.length === 0 ? "No clusters — import or create one" : "Select a cluster"}
                      loading={loading}
                      allowClear
                      showSearch
                      optionFilterProp="children"
                    >
                      {clusters.map(cluster => (
                        <Option key={cluster.clusterTag} value={cluster.clusterTag}>
                          <Space>
                            <span>{cluster.clusterTag}</span>
                            <Tag color={cluster.type === 'imported' ? 'blue' : 'green'} size="small">
                              {cluster.type === 'imported' ? 'Imported' : 'Created'}
                            </Tag>
                            <Text type="secondary" style={{ fontSize: '12px' }}>
                              {new Date(cluster.lastModified).toLocaleDateString()}
                            </Text>
                          </Space>
                        </Option>
                      ))}
                    </Select>
                    <Tag color="blue" style={{ margin: 0, fontSize: '14px', padding: '2px 10px' }}>
                      {clusters.length}
                    </Tag>
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={refreshAllStatus}
                      loading={loading}
                    >
                      Refresh Status
                    </Button>
                  </div>

                  <Row gutter={24} style={{ height: '100%' }}>
                    {/* 左侧：集群选择和管理 */}
                    <Col xs={24} lg={10}>
                      <div>
                        {/* 集群操作按钮 */}
                        <Space style={{ marginBottom: 16 }} wrap>
                          {activeCluster && (
                            <DependencyConfigButton
                              clusterTag={activeCluster}
                              currentCluster={clusters.find(c => c.clusterTag === activeCluster)}
                            />
                          )}
                          <Button
                            icon={<ImportOutlined />}
                            onClick={() => setShowImportModal(true)}
                          >
                            Import Cluster
                          </Button>
                          {activeCluster && (
                            <Button
                              icon={<AppstoreOutlined />}
                              onClick={handleOpenAddons}
                              disabled={!effectiveDependenciesStatus}
                            >
                              Advanced Features
                            </Button>
                          )}
                        </Space>

                        {/* 集群信息显示 */}
                        {activeCluster && (() => {
                          const cluster = clusters.find(c => c.clusterTag === activeCluster);
                          if (!cluster) {
                            // 集群不存在时的处理
                            if (clusters.length === 0) {
                              return <Text type="secondary">No clusters available</Text>;
                            } else {
                              return <Text type="secondary">Cluster "{activeCluster}" not found</Text>;
                            }
                          }

                          // 统一从 cluster 对象获取所有信息
                          const clusterTag = cluster.clusterTag || 'N/A';
                          const region = cluster.region || 'N/A';
                          const eksClusterName = cluster.eksCluster?.name || 'N/A';
                          const vpcId = cluster.eksCluster?.vpcId || 'N/A';
                          const creationType = cluster.type === 'imported' ? 'Imported' : 'Created';
                          const creationColor = cluster.type === 'imported' ? 'blue' : 'green';

                          return (
                            <Card title="Cluster Details" size="small" className="theme-card analytics">
                              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                                <Row gutter={[16, 16]}>
                                  <Col span={12}>
                                    <div>
                                      <Text strong>Custom Tag:</Text>
                                      <br />
                                      <Text code>{clusterTag}</Text>
                                    </div>
                                  </Col>
                                  <Col span={12}>
                                    <div>
                                      <Text strong>AWS Region:</Text>
                                      <br />
                                      <Text code>{region}</Text>
                                    </div>
                                  </Col>
                                </Row>
                                <Row gutter={[16, 16]}>
                                  <Col span={12}>
                                    <div>
                                      <Text strong>EKS Cluster Name:</Text>
                                      <br />
                                      <Text code>{eksClusterName}</Text>
                                    </div>
                                  </Col>
                                  <Col span={12}>
                                    <div>
                                      <Text strong>Cluster VPC:</Text>
                                      <br />
                                      <Text code>{vpcId}</Text>
                                    </div>
                                  </Col>
                                </Row>
                                <Row gutter={[16, 16]}>
                                  <Col span={12}>
                                    <div>
                                      <Text strong>Creation Type:</Text>
                                      <br />
                                      <Tag color={creationColor}>{creationType}</Tag>
                                    </div>
                                  </Col>
                                  <Col span={12}>
                                    <div>
                                      <Text strong>Dependencies:</Text>
                                      <br />
                                      <DependencyStatus
                                        cluster={cluster}
                                        dependenciesStatus={dependenciesStatus}
                                      />
                                    </div>
                                  </Col>
                                </Row>
                                <Row gutter={[16, 16]}>
                                  <Col span={24}>
                                    <div>
                                      <Text strong>Grafana:</Text>
                                      <br />
                                      {cluster.quickLinks?.grafana ? (
                                        <a href={cluster.quickLinks.grafana} target="_blank" rel="noopener noreferrer">
                                          {cluster.quickLinks.grafana} ↗
                                        </a>
                                      ) : (
                                        <Tag>Not Configured</Tag>
                                      )}
                                    </div>
                                  </Col>
                                </Row>
                              </Space>
                            </Card>
                          );
                        })()}
                      </div>
                    </Col>

                    {/* 右侧：Node Groups（仅在已选中集群时显示） */}
                    {activeCluster && (
                      <Col xs={24} lg={14}>
                        <NodeGroupManager
                          dependenciesConfigured={effectiveDependenciesStatus}
                          activeCluster={activeCluster}
                          refreshTrigger={refreshTrigger}
                          cluster={clusters.find(c => c.clusterTag === activeCluster)}
                        />
                      </Col>
                    )}
                  </Row>
                </>
              )
            },
            {
              key: 'create-eks',
              label: (
                <Space>
                  <CloudServerOutlined />
                  <span>Create EKS Cluster</span>
                </Space>
              ),
              children: <EksClusterCreationPanel />
            },
          ]}
        />
      </div>

      {/* 导入现有集群 Modal */}
      <Modal
        title={
          <Space>
            <ImportOutlined />
            <span>Import Existing Cluster</span>
          </Space>
        }
        open={showImportModal}
        onCancel={() => {
          setShowImportModal(false);
          importForm.resetFields();
        }}
        footer={null}
        width={600}
      >
        <Alert
          message="Import Existing EKS Cluster"
          description="Connect to your existing EKS cluster with HyperPod nodegroups. Only 3 fields required - other information will be auto-detected."
          type="info"
          showIcon
          style={{ marginBottom: 24 }}
        />

        <Form
          form={importForm}
          layout="vertical"
          onFinish={importExistingCluster}
        >
          <Form.Item
            label="EKS Cluster Name"
            name="eksClusterName"
            rules={[{ required: true, message: 'Please enter EKS cluster name' }]}
            extra="The name of your existing EKS cluster"
          >
            <Input placeholder="my-eks-cluster" />
          </Form.Item>

          <Form.Item
            label="AWS Region"
            name="awsRegion"
            rules={[{ required: true, message: 'Please enter AWS region' }]}
            extra="The AWS region where your EKS cluster is located"
          >
            <Input placeholder="us-west-2" />
          </Form.Item>

          <Collapse
            ghost
            style={{ marginBottom: 16, marginLeft: -16 }}
            items={[
              {
                key: 'optional',
                label: 'Optional Configs',
                style: { paddingLeft: 0 },
                children: (
                  <div style={{ paddingLeft: 8 }}>
                    <Form.Item
                      label="Compute Security Group"
                      name="computeSecurityGroup"
                      extra="Security group ID for compute nodes (e.g., sg-xxxxxxxx). If not provided, will auto-detect from EKS cluster."
                    >
                      <Input placeholder="sg-xxxxxxxx" />
                    </Form.Item>

                    <Form.Item
                      label="HyperPod Cluster Name"
                      name="hyperPodClusters"
                      extra="Enter the HyperPod cluster name associated with this EKS cluster"
                      style={{ marginBottom: 0 }}
                    >
                      <Input placeholder="hp-cluster-name" />
                    </Form.Item>
                  </div>
                )
              }
            ]}
          />

          <Divider />

          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button
              onClick={testClusterConnection}
              loading={importLoading}
              icon={<CheckCircleOutlined />}
            >
              Test Connection
            </Button>

            <Space>
              <Button onClick={() => {
                setShowImportModal(false);
                importForm.resetFields();
              }}>
                Cancel
              </Button>
              <Button
                type="primary"
                htmlType="submit"
                loading={importLoading}
                icon={<ImportOutlined />}
              >
                Import Cluster
              </Button>
            </Space>
          </Space>
        </Form>
      </Modal>

      {/* Advanced Features Modal */}
      <Modal
        title="Advanced Features"
        open={addonsModalVisible}
        onOk={handleSubmitAddons}
        onCancel={() => {
          if (addonsUpdating) return;
          setAddonsModalVisible(false);
          addonsForm.resetFields();
        }}
        okText="Apply Changes"
        confirmLoading={addonsUpdating}
        cancelButtonProps={{ disabled: addonsUpdating }}
        width={700}
      >
        <Spin spinning={addonsLoading}>
          <Form form={addonsForm} layout="vertical">

            {/* ── General Section ── */}
            <Divider orientation="left" style={{ marginTop: 0 }}>General</Divider>

            {/* HAMi GPU Virtualization */}
            <Card size="small" style={{ marginBottom: 16, backgroundColor: '#fafafa' }}>
              <Form.Item name="hamiEnabled" valuePropName="checked" style={{ marginBottom: 12 }}>
                <Checkbox><Text strong>HAMi GPU Virtualization</Text></Checkbox>
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(prev, curr) => prev.hamiEnabled !== curr.hamiEnabled}>
                {({ getFieldValue }) =>
                  getFieldValue('hamiEnabled') ? (
                    <>
                      <Alert
                        message="HAMi enables GPU virtualization, allowing multiple workloads to share a single physical GPU."
                        type="info" showIcon style={{ marginBottom: 12 }}
                      />
                      <Form.Item name="hamiSplitCount" label="Max Split/Process Limits"
                        rules={[{ required: true, message: 'Please select split count' }]}
                        tooltip="Only limits the Max number of GPU processes on one physical GPU">
                        <Select>
                          {[2,3,4,5,6,7,8,9,10].map(n => (
                            <Select.Option key={n} value={n}>{n}</Select.Option>
                          ))}
                        </Select>
                      </Form.Item>
                      <Row gutter={16}>
                        <Col span={12}>
                          <Form.Item name="hamiNodePolicy" label="Node Scheduler Policy"
                            rules={[{ required: true, message: 'Please select node policy' }]}
                            tooltip="How to distribute pods across nodes">
                            <Select>
                              <Select.Option value="binpack">binpack (Consolidate)</Select.Option>
                              <Select.Option value="spread">spread (Distribute)</Select.Option>
                            </Select>
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item name="hamiGpuPolicy" label="GPU Scheduler Policy"
                            rules={[{ required: true, message: 'Please select GPU policy' }]}
                            tooltip="How to allocate GPUs within a node">
                            <Select>
                              <Select.Option value="binpack">binpack (Consolidate)</Select.Option>
                              <Select.Option value="spread">spread (Distribute)</Select.Option>
                            </Select>
                          </Form.Item>
                        </Col>
                      </Row>
                    </>
                  ) : null
                }
              </Form.Item>
            </Card>

            {/* KubeRay Operator */}
            <Card size="small" style={{ marginBottom: 16, backgroundColor: '#fafafa' }}>
              <Form.Item name="kuberayOperatorEnabled" valuePropName="checked" style={{ marginBottom: 12 }}>
                <Checkbox><Text strong>KubeRay Operator</Text></Checkbox>
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(prev, curr) => prev.kuberayOperatorEnabled !== curr.kuberayOperatorEnabled}>
                {({ getFieldValue }) =>
                  getFieldValue('kuberayOperatorEnabled') ? (
                    <Alert
                      message="KubeRay Operator enables running Ray workloads (RayCluster, RayJob, RayService) on your cluster."
                      type="info" showIcon style={{ marginBottom: 12 }}
                    />
                  ) : null
                }
              </Form.Item>
            </Card>

            {/* Infrastructure Add-ons (Collapsible) */}
            <Collapse
              size="small"
              style={{ marginBottom: 16 }}
              items={[{
                key: 'infra',
                label: <Text strong>Add-ons</Text>,
                children: (
                  <>
                    {/* cert-manager */}
                    <Card size="small" style={{ marginBottom: 16, backgroundColor: '#fafafa' }}>
                      <Form.Item name="certManagerEnabled" valuePropName="checked" style={{ marginBottom: 12 }}>
                        <Checkbox><Text strong>cert-manager</Text></Checkbox>
                      </Form.Item>
                      <Form.Item noStyle shouldUpdate={(prev, curr) => prev.certManagerEnabled !== curr.certManagerEnabled}>
                        {({ getFieldValue }) =>
                          getFieldValue('certManagerEnabled') ? (
                            <Alert message="cert-manager is required by Training Operator. Install it before enabling Training Operator."
                              type="info" showIcon style={{ marginBottom: 12 }} />
                          ) : null
                        }
                      </Form.Item>
                      {addonsData?.certManager?.status === 'CREATING' && (
                        <Alert message="cert-manager is currently being installed..." type="warning" showIcon style={{ marginBottom: 12 }} />
                      )}
                    </Card>


                    {/* FSx CSI Driver */}
                    <Card size="small" style={{ backgroundColor: '#fafafa' }}>
                      <Form.Item name="fsxCsiDriverEnabled" valuePropName="checked" style={{ marginBottom: 12 }}>
                        <Checkbox><Text strong>FSx Lustre CSI Driver</Text></Checkbox>
                      </Form.Item>
                      <Form.Item noStyle shouldUpdate={(prev, curr) => prev.fsxCsiDriverEnabled !== curr.fsxCsiDriverEnabled}>
                        {({ getFieldValue }) =>
                          getFieldValue('fsxCsiDriverEnabled') ? (
                            <Alert message="FSx CSI Driver enables mounting FSx for Lustre file systems as persistent volumes."
                              type="info" showIcon style={{ marginBottom: 12 }} />
                          ) : null
                        }
                      </Form.Item>
                      {addonsData?.fsxCsiDriver?.status === 'CREATING' && (
                        <Alert message="FSx CSI Driver is currently being installed..." type="warning" showIcon style={{ marginBottom: 12 }} />
                      )}
                    </Card>
                  </>
                )
              }]}
            />

            {/* ── HyperPod Section ── */}
            {hasHyperPod && (
              <>
                <Divider orientation="left">HyperPod</Divider>

                {/* Tiered Storage */}
                <Card size="small" style={{ marginBottom: 16, backgroundColor: '#fafafa' }}>
                  <Form.Item name="tieredStorageEnabled" valuePropName="checked" style={{ marginBottom: 12 }}>
                    <Checkbox><Text strong>Tiered Storage (Managed Checkpointing)</Text></Checkbox>
                  </Form.Item>
                  <Form.Item noStyle shouldUpdate={(prev, curr) => prev.tieredStorageEnabled !== curr.tieredStorageEnabled}>
                    {({ getFieldValue }) =>
                      getFieldValue('tieredStorageEnabled') ? (
                        <>
                          <Alert
                            message={`Tiered Storage uses cluster CPU memory for faster checkpoint operations. ServiceAccount: ${addonsData?.tieredStorage?.irsa?.saName || 'tiered-storage-sa'}`}
                            type="info" showIcon style={{ marginBottom: 12 }}
                          />
                          <Form.Item name="tieredStorageMode" label="Configuration Mode"
                            rules={[{ required: true, message: 'Please select a mode' }]}>
                            <Radio.Group>
                              <Space direction="vertical">
                                <Radio value="default">
                                  <Text>Use Default (Enable only)</Text>
                                  <br />
                                  <Text type="secondary" style={{ fontSize: 12 }}>System automatically manages memory allocation</Text>
                                </Radio>
                                <Radio value="custom">
                                  <Text>Custom Configuration</Text>
                                  <br />
                                  <Text type="secondary" style={{ fontSize: 12 }}>Specify memory allocation percentage</Text>
                                </Radio>
                              </Space>
                            </Radio.Group>
                          </Form.Item>
                          <Form.Item noStyle shouldUpdate={(prev, curr) => prev.tieredStorageMode !== curr.tieredStorageMode}>
                            {({ getFieldValue }) =>
                              getFieldValue('tieredStorageMode') === 'custom' ? (
                                <Form.Item name="tieredStoragePercentage" label="Memory Allocation Percentage"
                                  rules={[
                                    { required: true, message: 'Please specify percentage' },
                                    { type: 'number', min: 20, max: 80, message: 'Must be between 20-80' }
                                  ]}>
                                  <InputNumber min={20} max={80} style={{ width: '100%' }} addonAfter="%" placeholder="50" />
                                </Form.Item>
                              ) : null
                            }
                          </Form.Item>
                        </>
                      ) : null
                    }
                  </Form.Item>
                </Card>

                {/* HyperPod Karpenter */}
                <Card size="small" style={{ marginBottom: 16, backgroundColor: '#fafafa' }}>
                  <Form.Item name="karpenterEnabled" valuePropName="checked" style={{ marginBottom: 12 }}>
                    <Checkbox><Text strong>HyperPod Karpenter (Managed Autoscaling)</Text></Checkbox>
                  </Form.Item>
                  <Form.Item noStyle shouldUpdate={(prev, curr) => prev.karpenterEnabled !== curr.karpenterEnabled}>
                    {({ getFieldValue }) =>
                      getFieldValue('karpenterEnabled') ? (
                        <>
                          <Alert
                            message="Karpenter enables just-in-time node provisioning, scale-to-zero, and automatic consolidation for HyperPod instance groups."
                            type="info" showIcon style={{ marginBottom: 12 }}
                          />
                          {addonsData?.karpenter?.status === 'Updating' && (
                            <Alert message="Karpenter is currently being configured..." type="warning" showIcon style={{ marginBottom: 12 }} />
                          )}
                          <Form.Item name="karpenterConsolidationPolicy" label="Consolidation Policy"
                            tooltip="When to reclaim idle nodes: WhenEmpty (only empty nodes) or WhenEmptyOrUnderutilized (empty or underused)">
                            <Select>
                              <Select.Option value="WhenEmptyOrUnderutilized">WhenEmptyOrUnderutilized (Aggressive)</Select.Option>
                              <Select.Option value="WhenEmpty">WhenEmpty (Conservative)</Select.Option>
                            </Select>
                          </Form.Item>
                          <Row gutter={16}>
                            <Col span={12}>
                              <Form.Item name="karpenterConsolidateAfter" label="Consolidate After"
                                tooltip="How long to wait after condition is met before reclaiming">
                                <Select>
                                  <Select.Option value="0s">0s (Immediate)</Select.Option>
                                  <Select.Option value="30s">30s</Select.Option>
                                  <Select.Option value="60s">60s</Select.Option>
                                  <Select.Option value="300s">5 min</Select.Option>
                                  <Select.Option value="600s">10 min</Select.Option>
                                </Select>
                              </Form.Item>
                            </Col>
                            <Col span={12}>
                              <Form.Item name="karpenterBudgetNodes" label="Disruption Budget"
                                tooltip="Max percentage of nodes that can be disrupted simultaneously">
                                <Select>
                                  <Select.Option value="10%">10% (Very Safe)</Select.Option>
                                  <Select.Option value="50%">50%</Select.Option>
                                  <Select.Option value="90%">90% (Default)</Select.Option>
                                  <Select.Option value="100%">100%</Select.Option>
                                </Select>
                              </Form.Item>
                            </Col>
                          </Row>
                        </>
                      ) : null
                    }
                  </Form.Item>
                </Card>

                {/* Inference Operator */}
                <Card size="small" style={{ marginBottom: 16, backgroundColor: '#fafafa' }}>
                  <Form.Item name="inferenceOperatorEnabled" valuePropName="checked" style={{ marginBottom: 12 }}>
                    <Checkbox><Text strong>HyperPod Inference Operator</Text></Checkbox>
                  </Form.Item>
                  <Form.Item noStyle shouldUpdate={(prev, curr) => prev.inferenceOperatorEnabled !== curr.inferenceOperatorEnabled}>
                    {({ getFieldValue }) =>
                      getFieldValue('inferenceOperatorEnabled') ? (
                        <Alert
                          message="Inference Operator enables deployment and management of ML inference endpoints on your EKS cluster."
                          type="info" showIcon style={{ marginBottom: 12 }}
                        />
                      ) : null
                    }
                  </Form.Item>
                </Card>

                {/* Training Operator */}
                <Card size="small" style={{ marginBottom: 16, backgroundColor: '#fafafa' }}>
                  <Form.Item name="trainingOperatorEnabled" valuePropName="checked" style={{ marginBottom: 12 }}>
                    <Checkbox><Text strong>HyperPod Training Operator</Text></Checkbox>
                  </Form.Item>
                  <Form.Item noStyle shouldUpdate={(prev, curr) => prev.trainingOperatorEnabled !== curr.trainingOperatorEnabled}>
                    {({ getFieldValue }) =>
                      getFieldValue('trainingOperatorEnabled') ? (
                        <Alert
                          message="Training Operator enables auto-recovery of distributed training jobs (PyTorchJob, etc.) on your HyperPod cluster."
                          type="info" showIcon style={{ marginBottom: 12 }}
                        />
                      ) : null
                    }
                  </Form.Item>
                  {addonsData?.trainingOperator?.status === 'CREATING' && (
                    <Alert message="Training Operator is currently being installed..." type="warning" showIcon style={{ marginBottom: 12 }} />
                  )}
                </Card>
              </>
            )}

          </Form>
        </Spin>
      </Modal>
    </>
  );
};

export default ClusterManagementRedux;