import React, { useEffect, useCallback, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import ResourceListToolbar from './common/ResourceListToolbar';
import useResourceFilter from '../hooks/useResourceFilter';
import {
  Tabs,
  Table,
  Tag,
  Space,
  Badge,
  Button,
  Typography,
  message,
  Popconfirm,
  Tooltip,
  Alert,
  Input,
  Modal,
  Divider
} from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
  ApiOutlined,
  ContainerOutlined,
  DeleteOutlined,
  ThunderboltOutlined,      // 新增：用于VLLM部署类型
  ExperimentOutlined,       // 新增：用于训练任务
  SyncOutlined,             // 新增：用于Running状态图标（匹配原始HyperPodJobManager）
  CloseCircleOutlined       // 新增：用于Failed状态图标（匹配原始HyperPodJobManager）
} from '@ant-design/icons';
import PodLogModal from './PodLogModal';
import PodDescribeModal from './PodDescribeModal';
import {
  getServiceType,
  getDeploymentStatus,
  getJobStatusFromCondition,
  getK8sJobSummary,
  MONITORING_TABLE_SCROLL_Y,
  MONITORING_TABLE_SCROLL_X
} from './statusMonitorHelpers';
import { getPodStatus } from './podStatusHelpers';
import {
  buildPodColumns,
  buildServiceColumns,
  buildIngressColumns,
  buildRayJobColumns,
  buildTrainingJobColumns,
  buildDeploymentColumns,
  buildNamespaceColumn
} from './statusMonitorColumns';

// Redux imports
import { refreshAllAppStatus } from '../store/slices/appStatusSlice';
import {
  selectAppPods,
  selectAppServices,
  selectAppIngresses,
  selectAppRayJobs,
  selectAppBindingServices,
  selectAppDeployments,        // 新增
  selectAppTrainingJobs,       // 新增
  selectAppInferenceEndpoints,
  selectAppK8sJobs,
  selectAppStatusLoading,
  selectAppStatusError,
  selectAppStats
} from '../store/selectors';
import { CONFIG } from '../config/constants';

// 新的事件总线
import resourceEventBus from '../utils/resourceEventBus';

const { TabPane } = Tabs;
const { Text } = Typography;

// Resource-status extractor used only by managed-inference rendering; kept local
// so its @release marker is not relocated. Sibling sentinel-free extractors and
// the table scroll constant live in ./statusMonitorHelpers.
const getInferenceEndpointStatus = (e) => e?.deploymentStatus;

const StatusMonitorRedux = ({ activeTab }) => {
  const dispatch = useDispatch();

  // Redux 状态
  const pods = useSelector(selectAppPods);
  const services = useSelector(selectAppServices);
  const ingresses = useSelector(selectAppIngresses);
  const rayJobs = useSelector(selectAppRayJobs);
  const businessServices = useSelector(selectAppBindingServices);
  const deployments = useSelector(selectAppDeployments);          // 新增
  const trainingJobs = useSelector(selectAppTrainingJobs);        // 新增
  const inferenceEndpoints = useSelector(selectAppInferenceEndpoints);
  const k8sJobs = useSelector(selectAppK8sJobs);
  const loading = useSelector(selectAppStatusLoading);
  const error = useSelector(selectAppStatusError);
  const appStats = useSelector(selectAppStats);

  // 本地状态（操作相关）
  const [assigningPods, setAssigningPods] = useState(new Set());
  const [deletingServices, setDeletingServices] = useState(new Set());
  const [deletingRayJob, setDeletingRayJob] = useState(false);
  const [deletingDeployments, setDeletingDeployments] = useState(new Set());    // 新增
  const [scalingDeployments, setScalingDeployments] = useState(new Set());      // 新增
  const [deletingTrainingJobs, setDeletingTrainingJobs] = useState(new Set());  // 新增
  const [deletingInferenceEndpoints, setDeletingInferenceEndpoints] = useState(new Set());
  const [deletingK8sJobs, setDeletingK8sJobs] = useState(new Set());

  // 🔄 Badge同步状态 - 确保Badge数字与表格数据完全同步
  const [localRefreshTrigger, setLocalRefreshTrigger] = useState(0);
  const [badgeCounts, setBadgeCounts] = useState({ pods: 0, services: 0 });

  // Scale Modal 状态 - 继承原部署管理功能
  const [scaleModalVisible, setScaleModalVisible] = useState(false);
  const [scaleTarget, setScaleTarget] = useState(null);
  const [targetReplicas, setTargetReplicas] = useState(1);

  // Pod Log Modal 状态
  const [logModalPod, setLogModalPod] = useState(null);
  const [describeModalPod, setDescribeModalPod] = useState(null);

  // 初始化时获取数据（只执行一次）
  useEffect(() => {
    // 只在首次挂载时刷新，避免每次切换 Tab 都触发
    const hasData = pods.length > 0 || services.length > 0;
    if (!hasData) {
      dispatch(refreshAllAppStatus());
    }

    // 订阅资源变化事件
    const refreshCallback = async (eventType) => {
      console.log('[AppStatus] Refreshing for event:', eventType);
      await dispatch(refreshAllAppStatus());
      // 强制触发 Badge 更新
      setLocalRefreshTrigger(prev => prev + 1);
    };
    
    resourceEventBus.subscribe('app-status', refreshCallback);

    // 清理订阅
    return () => {
      resourceEventBus.unsubscribe('app-status');
    };
  }, [dispatch]); // 只依赖dispatch，避免无限循环

  // Badge同步监听：当数据更新时强制重新渲染
  useEffect(() => {
    console.log('[StatusMonitor] Data changed - Pods:', pods.length, 'Services:', services.length, 'Deployments:', deployments.length);
    console.log('[StatusMonitor] Pods data:', pods.map(p => p.metadata?.name || 'unknown'));
    console.log('[StatusMonitor] Services data:', services.map(s => s.metadata?.name || 'unknown'));
    console.log('[StatusMonitor] Updating badgeCounts to:', { pods: pods.length, services: services.length });
    setBadgeCounts({ pods: pods.length, services: services.length });
    setLocalRefreshTrigger(prev => prev + 1);
  }, [pods.length, services.length, deployments.length, loading]);

  // 手动刷新
  const handleRefresh = useCallback(async () => {
    try {
      console.log('[StatusMonitor] Manual refresh triggered');
      await dispatch(refreshAllAppStatus()).unwrap();
      console.log('[StatusMonitor] Refresh completed - Pods:', pods.length, 'Services:', services.length);
      // 🔄 强制Badge重新渲染，确保与表格数据同步
      setLocalRefreshTrigger(prev => prev + 1);
      message.success('App status refreshed successfully');
    } catch (error) {
      console.error('Error refreshing app status:', error);
      message.error('Failed to refresh app status: ' + (error.message || error));
    }
  }, [dispatch, pods.length, services.length]);

  // 处理Service删除
  const handleServiceDelete = async (serviceName) => {
    setDeletingServices(prev => new Set([...prev, serviceName]));

    try {
      const response = await fetch(`/api/delete-service/${serviceName}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const result = await response.json();

      if (result.success) {
        message.success(`Service ${serviceName} deleted successfully`);
        // 触发刷新
        await dispatch(refreshAllAppStatus());
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);
      } else {
        message.error(`Failed to delete service: ${result.error}`);
      }
    } catch (error) {
      console.error('Error deleting service:', error);
      message.error('Failed to delete service');
    } finally {
      setDeletingServices(prev => {
        const newSet = new Set(prev);
        newSet.delete(serviceName);
        return newSet;
      });
    }
  };

  // 检查是否为模型池Pod
  const isPoolPod = (pod) => {
    const labels = pod.metadata?.labels || {};
    return labels['model-id'] &&
      labels.business !== undefined &&
      labels['deployment-type'] === 'model-pool';
  };

  // 处理Pod分配
  const handlePodAssign = async (podName, businessTag) => {
    const pod = pods.find(p => p.metadata.name === podName);
    if (!pod) return;

    const modelId = pod.metadata.labels?.['model-id'];
    if (!modelId) {
      message.error('Pod model-id information not found');
      return;
    }

    setAssigningPods(prev => new Set([...prev, podName]));

    try {
      const response = await fetch('/api/assign-pod', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          podName,
          businessTag,
          modelId
        }),
      });

      const result = await response.json();

      if (result.success) {
        message.success(`Pod ${podName} assigned to ${businessTag}`);
        // 🚀 触发统一刷新机制更新所有数据
        await dispatch(refreshAllAppStatus());
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);
      } else {
        message.error(result.error || 'Assignment failed');
      }
    } catch (error) {
      console.error('Pod assignment error:', error);
      message.error('Failed to assign pod');
    } finally {
      setAssigningPods(prev => {
        const newSet = new Set(prev);
        newSet.delete(podName);
        return newSet;
      });
    }
  };

  // 删除RayJob
  const handleDeleteRayJob = async (jobName) => {
    try {
      setDeletingRayJob(true);
      const response = await fetch(`/api/rayjobs/${jobName}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        message.success(`RayJob ${jobName} deletion initiated`);
        // 刷新数据
        await dispatch(refreshAllAppStatus());
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);
      } else {
        const error = await response.json();
        message.error(`Failed to delete RayJob: ${error.error}`);
      }
    } catch (error) {
      console.error('Error deleting RayJob:', error);
      message.error('Failed to delete RayJob');
    } finally {
      setDeletingRayJob(false);
    }
  };

  // 统一删除部署（支持Router和模型）
  const handleDeploymentDelete = async (deploymentName, deploymentType, isRouter) => {
    setDeletingDeployments(prev => new Set([...prev, deploymentName]));

    try {
      let response;

      // 根据类型选择不同的删除API
      if (isRouter || deploymentType === 'Router') {
        // Router删除：使用Router专用API
        console.log(`Deleting Router deployment: ${deploymentName}`);
        response = await fetch(`/api/routers/${deploymentName}`, {
          method: 'DELETE'
        });
      } else {
        // 模型删除：使用原有的undeploy逻辑
        console.log(`Deleting model deployment: ${deploymentName}`);
        response = await fetch('/api/undeploy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            modelTag: deploymentName, // 后端仍期望 modelTag 字段
            deleteType: 'all'
          }),
        });
      }

      const result = await response.json();

      if (result.success) {
        message.success(`${deploymentType} deployment "${deploymentName}" deleted successfully`);
        // 刷新数据
        await dispatch(refreshAllAppStatus());
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);

        console.log(`Deployment deletion successful:`, result);
      } else {
        message.error(`Failed to delete ${deploymentType} deployment: ${result.error || result.message}`);
      }
    } catch (error) {
      console.error('Error deleting deployment:', error);
      message.error(`Failed to delete ${deploymentType || 'deployment'}: ${error.message}`);
    } finally {
      setDeletingDeployments(prev => {
        const newSet = new Set(prev);
        newSet.delete(deploymentName);
        return newSet;
      });
    }
  };

  // 扩缩容部署
  const handleDeploymentScale = async (deployment, targetReplicas) => {
    const deploymentName = deployment.deploymentName;
    setScalingDeployments(prev => new Set([...prev, deploymentName]));

    try {
      const response = await fetch('/api/scale-deployment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deploymentName: deploymentName,
          replicas: targetReplicas,
          isModelPool: deployment.deploymentType === 'model-pool'
        }),
      });

      const result = await response.json();

      if (result.success) {
        message.success(`Deployment ${deploymentName} scaled to ${targetReplicas} replicas`);
        // 刷新数据
        await dispatch(refreshAllAppStatus());
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);
      } else {
        message.error(`Scale failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Scale error:', error);
      message.error('Scale operation failed');
    } finally {
      setScalingDeployments(prev => {
        const newSet = new Set(prev);
        newSet.delete(deploymentName);
        return newSet;
      });
    }
  };

  // 删除训练任务
  const handleTrainingJobDelete = async (jobName) => {
    setDeletingTrainingJobs(prev => new Set([...prev, jobName]));

    try {
      const response = await fetch(`/api/hyperpod-jobs/${jobName}`, {
        method: 'DELETE'
      });

      const result = await response.json();

      if (result.success) {
        message.success(`Training job ${jobName} deleted successfully`);
        // 刷新数据
        await dispatch(refreshAllAppStatus());
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);
      } else {
        message.error(`Failed to delete training job: ${result.error}`);
      }
    } catch (error) {
      console.error('Error deleting training job:', error);
      message.error('Failed to delete training job');
    } finally {
      setDeletingTrainingJobs(prev => {
        const newSet = new Set(prev);
        newSet.delete(jobName);
        return newSet;
      });
    }
  };

  // 删除 InferenceEndpointConfig
  const handleInferenceEndpointDelete = async (endpointName, namespace) => {
    setDeletingInferenceEndpoints(prev => new Set([...prev, endpointName]));

    try {
      const response = await fetch(`/api/inference-endpoints/${endpointName}?namespace=${namespace}`, {
        method: 'DELETE'
      });

      const result = await response.json();

      if (result.success) {
        message.success(`Inference endpoint ${endpointName} deleted successfully`);
        // 刷新数据
        await dispatch(refreshAllAppStatus());
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);
      } else {
        message.error(`Failed to delete inference endpoint: ${result.error}`);
      }
    } catch (error) {
      console.error('Error deleting inference endpoint:', error);
      message.error('Failed to delete inference endpoint');
    } finally {
      setDeletingInferenceEndpoints(prev => {
        const newSet = new Set(prev);
        newSet.delete(endpointName);
        return newSet;
      });
    }
  };

  // 删除 K8s Job
  const handleK8sJobDelete = async (jobName) => {
    setDeletingK8sJobs(prev => new Set([...prev, jobName]));
    try {
      const response = await fetch(`/api/k8s-jobs/${jobName}`, { method: 'DELETE' });
      const result = await response.json();
      if (result.success) {
        message.success(`Job ${jobName} deleted successfully`);
        await dispatch(refreshAllAppStatus());
        setLocalRefreshTrigger(prev => prev + 1);
      } else {
        message.error(`Failed to delete job: ${result.error}`);
      }
    } catch (error) {
      console.error('Error deleting k8s job:', error);
      message.error('Failed to delete job');
    } finally {
      setDeletingK8sJobs(prev => { const s = new Set(prev); s.delete(jobName); return s; });
    }
  };


  // Scale Modal 功能 - 继承原部署管理功能
  const showScaleModal = (deployment) => {
    setScaleTarget(deployment);
    setTargetReplicas(deployment.replicas);
    setScaleModalVisible(true);
  };

  // 执行Scale操作 - 继承原部署管理功能
  const handleScale = async () => {
    if (!scaleTarget) return;

    const deploymentName = scaleTarget.deploymentName;
    setScalingDeployments(prev => new Set([...prev, deploymentName]));

    try {
      const response = await fetch('/api/scale-deployment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deploymentName,
          replicas: targetReplicas,
          isModelPool: scaleTarget.deploymentType === 'model-pool'
        }),
      });

      const result = await response.json();

      if (result.success) {
        message.success(`Deployment ${deploymentName} scaled to ${targetReplicas} replicas`);
        setScaleModalVisible(false);
        // 刷新数据
        await dispatch(refreshAllAppStatus());
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);
      } else {
        message.error(`Scale failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Scale error:', error);
      message.error('Scale operation failed');
    } finally {
      setScalingDeployments(prev => {
        const newSet = new Set(prev);
        newSet.delete(deploymentName);
        return newSet;
      });
    }
  };

  // Delete Confirmation Modal - 继承原部署管理功能
  const showDeleteConfirmation = (record) => {
    Modal.confirm({
      title: `Delete ${record.deploymentName} deployment`,
      icon: <ExclamationCircleOutlined />,
      content: (
        <div>
          <p>This will permanently delete both the deployment and service for <strong>{record.deploymentName}</strong> ({record.deploymentType}).</p>
          <p>All running pods will be terminated and GPU resources will be freed.</p>
          <div style={{ marginTop: 16, padding: 12, backgroundColor: '#fff2e8', borderRadius: 6, border: '1px solid #ffbb96' }}>
            <div style={{ fontSize: '12px', color: '#d46b08' }}>
              <strong>⚠️ This action cannot be undone</strong>
            </div>
          </div>
        </div>
      ),
      okText: 'Delete Everything',
      okType: 'danger',
      cancelText: 'Cancel',
      width: 450,
      onOk() {
        handleDeploymentDelete(record.deploymentName, record.deploymentType, record.isRouter);
      },
      onCancel() {
        console.log('Delete cancelled');
      },
    });
  };

  // Monitoring 页每个 tab 共享一套筛选/分页模式。Pods/Services/RayJobs 这些
  // k8s 原生对象默认 ns 选 'default' 避免一屏铺满；processed 形态的（deployments /
  // jobs / inference / k8sjobs / trainjobs）没可靠 namespace 字段，默认 __all__。
  const podFilter = useResourceFilter(pods, {
    getStatus: getPodStatus,
    searchPlaceholder: 'Search pods by name',
  });
  const serviceFilter = useResourceFilter(services, {
    getStatus: getServiceType,
    searchPlaceholder: 'Search services by name',
  });
  const rayJobFilter = useResourceFilter(rayJobs, {
    searchPlaceholder: 'Search ray jobs by name',
  });
  const deploymentFilter = useResourceFilter(deployments, {
    getStatus: getDeploymentStatus,
    defaultNamespace: '__all__',
    searchPlaceholder: 'Search deployments by name',
  });
  const trainingJobFilter = useResourceFilter(trainingJobs, {
    getStatus: getJobStatusFromCondition,
    defaultNamespace: '__all__',
    searchPlaceholder: 'Search jobs by name',
  });
  const inferenceEndpointFilter = useResourceFilter(inferenceEndpoints, {
    getStatus: getInferenceEndpointStatus,
    defaultNamespace: '__all__',
    searchPlaceholder: 'Search endpoints by name',
  });
  const k8sJobFilter = useResourceFilter(k8sJobs, {
    getStatus: getK8sJobSummary,
    defaultNamespace: '__all__',
    searchPlaceholder: 'Search k8s jobs by name',
  });

  // 计算Service关联的Pod数量
  const getServicePodCount = (service) => {
    const selector = service.spec?.selector || {};
    if (Object.keys(selector).length === 0) {
      return 0;
    }

    return pods.filter(pod => {
      const podLabels = pod.metadata?.labels || {};
      return Object.entries(selector).every(([key, value]) =>
        podLabels[key] === value
      );
    }).length;
  };

  // Pod表格列定义
  const podColumns = buildPodColumns({
    isPoolPod,
    assigningPods,
    handlePodAssign,
    businessServices,
    setLogModalPod,
    setDescribeModalPod,
  });

  // Service表格列定义
  const serviceColumns = buildServiceColumns({
    getServicePodCount,
    handleServiceDelete,
    deletingServices,
  });

  // Ingress (ALB) 表格列定义
  const ingressColumns = buildIngressColumns();

  // RayJob表格列定义
  const rayJobColumns = buildRayJobColumns({ handleDeleteRayJob, deletingRayJob });

  // Deployment表格列定义 - 优化后去掉重复的Model Tag列
  const deploymentColumns = buildDeploymentColumns({ scalingDeployments, showScaleModal, handleDeploymentDelete, deletingDeployments });

  // Training Jobs表格列定义
  const trainingJobColumns = buildTrainingJobColumns({ handleTrainingJobDelete, deletingTrainingJobs });

  // InferenceEndpointConfig 表格列定义
  const inferenceEndpointColumns = [
    {
      title: 'Endpoint Name',
      dataIndex: 'name',
      key: 'name',
      width: 200,
      render: (name) => (
        <Space>
          <ThunderboltOutlined style={{ color: '#1890ff' }} />
          <Text strong>{name}</Text>
        </Space>
      ),
    },
    buildNamespaceColumn(false),
    {
      title: 'Deployment Tag',
      dataIndex: 'modelName',
      key: 'modelName',
      width: 160,
    },
    {
      title: 'Instance Type',
      dataIndex: 'instanceType',
      key: 'instanceType',
      width: 130,
      render: (type) => <Tag color="green">{type}</Tag>,
    },
    {
      title: 'Replicas',
      key: 'replicas',
      width: 90,
      render: (_, record) => (
        <Text>{record.availableReplicas || 0}/{record.replicas || 0}</Text>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'deploymentStatus',
      key: 'deploymentStatus',
      width: 170,
      render: (status) => {
        const statusConfig = {
          'DeploymentComplete': { color: 'success', icon: <CheckCircleOutlined /> },
          'DeploymentInProgress': { color: 'processing', icon: <SyncOutlined /> },
          'DeploymentFailed': { color: 'error', icon: <CloseCircleOutlined /> },
          'Unknown': { color: 'default', icon: <ClockCircleOutlined /> }
        };

        const config = statusConfig[status] || statusConfig['Unknown'];

        return (
          <Tag color={config.color} icon={config.icon}>
            {status}
          </Tag>
        );
      },
    },
    {
      title: 'S3 Bucket',
      dataIndex: 's3Bucket',
      key: 's3Bucket',
      width: 170,
      render: (bucket) => (
        <Tooltip title={bucket}>
          <Text type="secondary" ellipsis style={{ maxWidth: 150 }}>
            {bucket}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'creationTimestamp',
      key: 'creationTimestamp',
      width: 200,
      render: (timestamp) => {
        if (!timestamp) return '-';
        const date = new Date(timestamp);
        return (
          <Tooltip title={date.toLocaleString()}>
            <Text type="secondary">
              {date.toLocaleDateString()} {date.toLocaleTimeString()}
            </Text>
          </Tooltip>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      render: (_, record) => (
        <Popconfirm
          title="Delete Inference Endpoint"
          description={`Are you sure you want to delete "${record.name}"?`}
          onConfirm={() => handleInferenceEndpointDelete(record.name, record.namespace)}
          okText="Yes"
          cancelText="No"
        >
          <Button
            type="primary"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deletingInferenceEndpoints.has(record.name)}
          >
            Delete
          </Button>
        </Popconfirm>
      ),
    },
  ];

  // K8s Jobs 表格列定义
  const k8sJobColumns = [
    {
      title: 'Job Name',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      render: (name) => (
        <Space>
          <ContainerOutlined style={{ color: '#1890ff' }} />
          <Text strong style={{ fontFamily: 'monospace', fontSize: '12px' }}>{name}</Text>
        </Space>
      ),
    },
    buildNamespaceColumn(false),
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, record) => {
        if (record.succeeded >= record.completions) {
          return <Tag color="success" icon={<CheckCircleOutlined />}>Complete</Tag>;
        }
        if (record.failed > 0) {
          return <Tag color="error" icon={<CloseCircleOutlined />}>Failed</Tag>;
        }
        if (record.active > 0) {
          return <Tag color="processing" icon={<SyncOutlined />}>Running</Tag>;
        }
        return <Tag color="warning" icon={<ClockCircleOutlined />}>Pending</Tag>;
      },
    },
    {
      title: 'Completions',
      key: 'completions',
      width: 110,
      render: (_, record) => (
        <Text>{record.succeeded}/{record.completions}</Text>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'creationTimestamp',
      key: 'creationTimestamp',
      width: 200,
      render: (timestamp) => {
        if (!timestamp) return '-';
        const date = new Date(timestamp);
        return (
          <Tooltip title={date.toLocaleString()}>
            <Text type="secondary">{date.toLocaleDateString()} {date.toLocaleTimeString()}</Text>
          </Tooltip>
        );
      },
    },
    {
      title: 'Duration',
      key: 'duration',
      width: 110,
      render: (_, record) => {
        if (!record.startTime) return '-';
        const start = new Date(record.startTime);
        const end = record.completionTime ? new Date(record.completionTime) : new Date();
        const diffMs = end - start;
        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        if (hours > 0) return <Text type="secondary">{hours}h {minutes}m</Text>;
        return <Text type="secondary">{minutes > 0 ? `${minutes}m` : '< 1m'}</Text>;
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      render: (_, record) => (
        <Popconfirm
          title="Delete Job"
          description={`Are you sure you want to delete "${record.name}"?`}
          onConfirm={() => handleK8sJobDelete(record.name)}
          okText="Yes"
          cancelText="No"
        >
          <Button
            type="primary"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deletingK8sJobs.has(record.name)}
          >
            Delete
          </Button>
        </Popconfirm>
      ),
    },
  ];


  // 统计信息
  const podStats = {
    total: pods.length,
    running: pods.filter(p => getPodStatus(p) === 'running').length,
    pending: pods.filter(p => getPodStatus(p) === 'pending').length,
    failed: pods.filter(p => getPodStatus(p) === 'failed').length,
  };

  const serviceStats = {
    total: services.length,
    loadBalancer: services.filter(s => s.spec.type === 'LoadBalancer').length,
    ready: services.filter(s => s.status?.loadBalancer?.ingress?.length > 0).length,
  };

  // 渲染统计卡片
  const renderStatsCard = (stats, type) => {
    if (type === 'pods') {
      return (
        <div style={{
          marginBottom: 16,
          padding: 12,
          backgroundColor: '#f5f5f5',
          borderRadius: 6,
          display: 'flex',
          justifyContent: 'space-around'
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#1890ff' }}>
              {stats.total}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>Total</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#52c41a' }}>
              {stats.running}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>Running</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#faad14' }}>
              {stats.pending}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>Pending</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ff4d4f' }}>
              {stats.failed}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>Failed</div>
          </div>
        </div>
      );
    }

    if (type === 'services') {
      return (
        <div style={{
          marginBottom: 16,
          padding: 12,
          backgroundColor: '#f5f5f5',
          borderRadius: 6,
          display: 'flex',
          justifyContent: 'space-around'
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#1890ff' }}>
              {stats.total}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>Total</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#722ed1' }}>
              {stats.loadBalancer}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>LoadBalancer</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#52c41a' }}>
              {stats.ready}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>Ready</div>
          </div>
        </div>
      );
    }

    return null;
  };

  // 🔄 Refresh button that lives at the far-right of each tab's filter toolbar
  const refreshExtra = (
    <Button
      size="small"
      icon={<ReloadOutlined />}
      loading={loading}
      onClick={handleRefresh}
      title="Refresh App Status Data"
    >
      Refresh
    </Button>
  );

  const refreshButton = activeTab ? null : (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '16px'
    }}>
      <div></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={handleRefresh}
        >
          Refresh
        </Button>
      </div>
    </div>
  );

  // 如果指定了activeTab，只显示对应的内容
  if (activeTab) {
    if (activeTab === 'pods') {
      return (
        <div>
          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              action={
                <Button size="small" type="primary" onClick={handleRefresh}>
                  Retry
                </Button>
              }
            />
          )}
          {refreshButton}
          {renderStatsCard(podStats, 'pods')}
          <ResourceListToolbar {...podFilter.toolbarProps} extra={refreshExtra} />
          <Table
            columns={podColumns}
            dataSource={podFilter.filtered}
            rowKey={(pod) => pod.metadata.uid}
            size="small"
            sticky
            scroll={{ x: MONITORING_TABLE_SCROLL_X.pods, y: MONITORING_TABLE_SCROLL_Y }}
            pagination={podFilter.paginationProps}
            loading={loading}
            locale={{
              emptyText: podFilter.isFiltered ? 'No pods match the current filter' : 'No pods found',
            }}
          />
          <PodLogModal
            podName={logModalPod?.name || null}
            namespace={logModalPod?.namespace}
            visible={!!logModalPod}
            onClose={() => setLogModalPod(null)}
          />
          <PodDescribeModal
            podName={describeModalPod?.name || null}
            namespace={describeModalPod?.namespace}
            visible={!!describeModalPod}
            onClose={() => setDescribeModalPod(null)}
          />
        </div>
      );
    }

    if (activeTab === 'services') {
      return (
        <div>
          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          {refreshButton}
          {renderStatsCard(serviceStats, 'services')}
          <ResourceListToolbar {...serviceFilter.toolbarProps} extra={refreshExtra} />
          <Table
            columns={serviceColumns}
            dataSource={serviceFilter.filtered}
            rowKey={(service) => service.metadata.uid}
            size="small"
            sticky
            scroll={{ x: MONITORING_TABLE_SCROLL_X.services, y: MONITORING_TABLE_SCROLL_Y }}
            pagination={serviceFilter.paginationProps}
            loading={loading}
            locale={{
              emptyText: serviceFilter.isFiltered ? 'No services match the current filter' : 'No services found',
            }}
          />
        </div>
      );
    }

    if (activeTab === 'rayjobs') {
      return (
        <div>
          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          {refreshButton}
          <ResourceListToolbar {...rayJobFilter.toolbarProps} extra={refreshExtra} />
          <Table
            columns={rayJobColumns}
            dataSource={rayJobFilter.filtered}
            rowKey={(job) => job.metadata.uid}
            size="small"
            sticky
            scroll={{ x: MONITORING_TABLE_SCROLL_X.rayjobs, y: MONITORING_TABLE_SCROLL_Y }}
            pagination={rayJobFilter.paginationProps}
            loading={loading}
            locale={{
              emptyText: rayJobFilter.isFiltered ? 'No ray jobs match the current filter' : 'No ray jobs found',
            }}
          />
        </div>
      );
    }

    if (activeTab === 'deployments') {
      return (
        <div>
          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          {refreshButton}
          <ResourceListToolbar {...deploymentFilter.toolbarProps} extra={refreshExtra} />
          <Table
            columns={deploymentColumns}
            dataSource={deploymentFilter.filtered}
            rowKey="deploymentName"
            size="small"
            sticky
            scroll={{ x: MONITORING_TABLE_SCROLL_X.deployments, y: MONITORING_TABLE_SCROLL_Y }}
            pagination={deploymentFilter.paginationProps}
            loading={loading}
            locale={{
              emptyText: deploymentFilter.isFiltered ? 'No deployments match the current filter' : 'No deployments found',
            }}
          />

          {/* Scale Modal - 继承原部署管理功能 */}
          <Modal
            title={`Scale Deployment: ${scaleTarget?.deploymentName}`}
            open={scaleModalVisible}
            onOk={handleScale}
            onCancel={() => setScaleModalVisible(false)}
            confirmLoading={scaleTarget && scalingDeployments.has(scaleTarget.deploymentName)}
            okText="Scale"
          >
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 8 }}>
                <strong>Current Replicas:</strong> {scaleTarget?.replicas}
              </div>
              <div style={{ marginBottom: 8 }}>
                <strong>Deployment Type:</strong> {scaleTarget?.deploymentType}
              </div>
              {scaleTarget?.deploymentType === 'model-pool' && (
                <div style={{ marginBottom: 16, padding: 12, backgroundColor: '#f6f8fa', borderRadius: 4 }}>
                  <div style={{ fontSize: '12px', color: '#666' }}>
                    <strong>Model Pool Scale Rules:</strong><br/>
                    • Scale Up: New pods will be <code>unassigned</code><br/>
                    • Scale Down: Only <code>unassigned</code> pods will be removed
                  </div>
                </div>
              )}
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 8 }}>
                <strong>Target Replicas:</strong>
              </label>
              <Input
                type="number"
                min={0}
                max={20}
                value={targetReplicas}
                onChange={(e) => setTargetReplicas(parseInt(e.target.value) || 0)}
                style={{ width: '100%' }}
              />
            </div>
          </Modal>
        </div>
      );
    }

    if (activeTab === 'jobs') {
      return (
        <div>

          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}

          <ResourceListToolbar {...trainingJobFilter.toolbarProps} extra={refreshExtra} />
          <Table
            columns={trainingJobColumns}
            dataSource={trainingJobFilter.filtered}
            rowKey="name"
            loading={loading}
            size="small"
            sticky
            scroll={{ x: MONITORING_TABLE_SCROLL_X.jobs, y: MONITORING_TABLE_SCROLL_Y }}
            pagination={trainingJobFilter.paginationProps}
            locale={{
              emptyText: trainingJobFilter.isFiltered ? 'No jobs match the current filter' : 'No HyperPod jobs found',
            }}
          />
        </div>
      );
    }

    if (activeTab === 'inference') {
      return (
        <div>

          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}

          {/* InferenceEndpointConfig 表格 */}
          <ResourceListToolbar {...inferenceEndpointFilter.toolbarProps} extra={refreshExtra} />
          <Table
            columns={inferenceEndpointColumns}
            dataSource={inferenceEndpointFilter.filtered}
            rowKey="name"
            loading={loading}
            size="small"
            sticky
            scroll={{ x: MONITORING_TABLE_SCROLL_X.inference, y: MONITORING_TABLE_SCROLL_Y }}
            pagination={inferenceEndpointFilter.paginationProps}
            locale={{
              emptyText: inferenceEndpointFilter.isFiltered ? 'No endpoints match the current filter' : 'No inference endpoints found',
            }}
          />
        </div>
      );
    }

    if (activeTab === 'k8sjobs') {
      return (
        <div>
          {error && (
            <Alert message="App Status Error" description={error} type="error" showIcon style={{ marginBottom: 16 }} />
          )}
          <ResourceListToolbar {...k8sJobFilter.toolbarProps} extra={refreshExtra} />
          <Table
            columns={k8sJobColumns}
            dataSource={k8sJobFilter.filtered}
            rowKey="name"
            loading={loading}
            size="small"
            sticky
            scroll={{ x: MONITORING_TABLE_SCROLL_X.k8sjobs, y: MONITORING_TABLE_SCROLL_Y }}
            pagination={k8sJobFilter.paginationProps}
            locale={{
              emptyText: k8sJobFilter.isFiltered ? 'No jobs match the current filter' : 'No k8s jobs found',
            }}
          />
        </div>
      );
    }


    return <div>Unsupported tab: {activeTab}</div>;
  }

  // 完整的Tabs视图（当没有指定activeTab时）

  return (
    <div style={{ padding: '0 16px' }}>
      <Tabs defaultActiveKey="pods" size="small">
        <TabPane
          tab={
            <Space>
              <ContainerOutlined />
              Pods
              <Badge
                count={badgeCounts.pods}
                style={{ backgroundColor: '#1890ff' }}
                showZero
              />
            </Space>
          }
          key="pods"
        >
          <div style={{ paddingTop: '16px' }}>
          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          {refreshButton}
          <Table
            columns={podColumns}
            dataSource={pods}
            rowKey={(pod) => pod.metadata.uid}
            size="small"
            pagination={{ pageSize: 10 }}
            loading={loading}
          />
          <PodLogModal
            podName={logModalPod?.name || null}
            namespace={logModalPod?.namespace}
            visible={!!logModalPod}
            onClose={() => setLogModalPod(null)}
          />
          <PodDescribeModal
            podName={describeModalPod?.name || null}
            namespace={describeModalPod?.namespace}
            visible={!!describeModalPod}
            onClose={() => setDescribeModalPod(null)}
          />
        </div>
      </TabPane>

      <TabPane
        tab={
          <Space>
            <ApiOutlined />
            Services
            <Badge
              count={badgeCounts.services}
              style={{ backgroundColor: '#52c41a' }}
              showZero
            />
          </Space>
        }
        key="services"
      >
        <div style={{ padding: '16px' }}>
          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          {refreshButton}
          <Table
            columns={serviceColumns}
            dataSource={services}
            rowKey={(service) => service.metadata.uid}
            size="small"
            pagination={{ pageSize: 10 }}
            loading={loading}
          />
          {ingresses.length > 0 && (
            <>
              <Divider orientation="left" style={{ marginTop: 24 }}>
                <Space>
                  <ThunderboltOutlined />
                  Inference Endpoints (ALB)
                </Space>
              </Divider>
              <Table
                columns={ingressColumns}
                dataSource={ingresses}
                rowKey={(ing) => ing.uid || `${ing.namespace}/${ing.name}`}
                size="small"
                pagination={false}
                loading={loading}
              />
            </>
          )}
        </div>
      </TabPane>

      <TabPane
        tab={
          <Space>
            <ApiOutlined />
            RayJobs
          </Space>
        }
        key="rayjobs"
      >
        <div style={{ padding: '16px' }}>
          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          {refreshButton}
          <Table
            columns={rayJobColumns}
            dataSource={rayJobs}
            rowKey={(job) => job.metadata.uid}
            size="small"
            pagination={{ pageSize: 10 }}
            loading={loading}
          />
        </div>
      </TabPane>
    </Tabs>
    </div>
  );
};

export default StatusMonitorRedux;