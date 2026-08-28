import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { Card, Table, Button, message, Tag, Space, Modal, InputNumber, Form, Select, Input, Typography, AutoComplete, Checkbox, Row, Col, Alert, Spin, Tooltip, Switch, Divider } from 'antd';
import { ReloadOutlined, EditOutlined, ToolOutlined, PlusOutlined, DeleteOutlined, InfoCircleOutlined, CloudServerOutlined, SettingOutlined, RightOutlined, DownOutlined } from '@ant-design/icons';
import EksNodeGroupCreationPanel from './EksNodeGroupCreationPanel';
import { buildEksColumns, buildHyperPodColumns } from './nodeGroupColumns';
import {
  fetchNodeGroups,
  createHyperPod,
  // deleteHyperPod, // 已隐藏 Delete HyperPod 功能 (2025-12-03)
  addInstanceGroup,
  scaleNodeGroup,
  deleteNodeGroup,
  checkHyperPodCreationStatus,
  clearHyperPodCreationStatus,
  clearNodeGroupOperationStatus,
} from '../store/slices/nodeGroupsSlice';
import {
  selectHyperPodGroups,
  selectNodeGroupsLoading,
  selectNodeGroupsError,
  selectHyperPodCreationStatus,
  selectHyperPodDeletionStatus,
  selectEffectiveDependenciesStatus,
  selectClusterConfig
} from '../store/selectors';
import globalRefreshManager from '../hooks/useGlobalRefresh';
import operationRefreshManager from '../hooks/useOperationRefresh';

const { Text } = Typography;

export const getInstanceGroupSubnetSelection = (privateSubnets, availabilityZone) => {
  const matchingSubnets = availabilityZone
    ? (privateSubnets || []).filter(subnet => subnet.availabilityZone === availabilityZone)
    : [];

  return {
    matchingSubnets,
    autoSelectedSubnetId: matchingSubnets.length === 1 ? matchingSubnets[0].subnetId : undefined,
    requiresSelection: matchingSubnets.length > 1
  };
};

const NodeGroupManagerRedux = ({ activeCluster, refreshTrigger, cluster }) => {
  // Redux state
  const dispatch = useDispatch();
  const hyperPodGroupsFromStore = useSelector(selectHyperPodGroups);
  const hyperPodGroups = Array.isArray(hyperPodGroupsFromStore) ? hyperPodGroupsFromStore : [];
  const loading = useSelector(selectNodeGroupsLoading);
  // const error = useSelector(selectNodeGroupsError); // Unused
  const hyperPodCreationStatus = useSelector(selectHyperPodCreationStatus);
  const hyperPodDeletionStatus = useSelector(selectHyperPodDeletionStatus);
  const effectiveDependenciesConfigured = useSelector(selectEffectiveDependenciesStatus);
  const clusterConfig = useSelector(selectClusterConfig);

  // Local state for UI
  const [scaleLoading, setScaleLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [eksDeleteLoading, setEksDeleteLoading] = useState(false);
  const [eksDeleteTarget, setEksDeleteTarget] = useState(null);
  const [addInstanceGroupLoading, setAddInstanceGroupLoading] = useState(false);
  const [clusterInfo, setClusterInfo] = useState({ eksClusterName: '', region: '', isTerraform: false });
  const [availabilityZones, setAvailabilityZones] = useState([]);
  const [scaleModalVisible, setScaleModalVisible] = useState(false);
  const [createHyperPodModalVisible, setCreateHyperPodModalVisible] = useState(false);
  const [createEksNodeGroupModalVisible, setCreateEksNodeGroupModalVisible] = useState(false);
  const [addInstanceGroupModalVisible, setAddInstanceGroupModalVisible] = useState(false);
  const [instanceTypeOptions, setInstanceTypeOptions] = useState([]);
  const [scaleTarget, setScaleTarget] = useState(null);
  const [showInactiveGroups, setShowInactiveGroups] = useState(false);
  const [form] = Form.useForm();
  const [hyperPodForm] = Form.useForm();
  const [instanceGroupForm] = Form.useForm();

  // EFA-only 支持机型白名单（来自 /api/config/efa-only-instance-types）。
  // 仅当"加节点组"所选机型在白名单内时，才渲染 efa-only 开关。
  const [efaOnlyTypes, setEfaOnlyTypes] = useState([]);
  const addIgInstanceType = Form.useWatch('instanceType', instanceGroupForm);
  const efaOnlyEligible = !!addIgInstanceType && efaOnlyTypes.includes(addIgInstanceType);
  // Add Instance Group: private subnet 下拉数据 + AZ/newSubnet 联动
  const [privateSubnets, setPrivateSubnets] = useState([]);
  const [privateSubnetsLoading, setPrivateSubnetsLoading] = useState(false);
  const [privateSubnetsError, setPrivateSubnetsError] = useState(null);
  const addIgAz = Form.useWatch('availabilityZone', instanceGroupForm);
  const addIgNewSubnet = Form.useWatch('newSubnet', instanceGroupForm);
  const addIgSubnetSelection = getInstanceGroupSubnetSelection(privateSubnets, addIgAz);




  // HyperPod Karpenter 相关状态
  const [hyperpodKarpenterResources, setHyperpodKarpenterResources] = useState({
    nodeClasses: [],
    nodePools: [],
    managedInstanceGroups: []
  });
  const [hyperpodKarpenterLoading, setHyperpodKarpenterLoading] = useState(true);
  const [hyperpodKarpenterStatus, setHyperpodKarpenterStatus] = useState({ installed: false });
  const [hyperpodKarpenterResourceModalVisible, setHyperpodKarpenterResourceModalVisible] = useState(false);
  const [hyperpodKarpenterResourceCreating, setHyperpodKarpenterResourceCreating] = useState(false);
  const [selectedInstanceGroups, setSelectedInstanceGroups] = useState([]);
  const [deletingNodePool, setDeletingNodePool] = useState(null);
  const [nodeClaimModalVisible, setNodeClaimModalVisible] = useState(false);
  const [nodeClaimModalGroup, setNodeClaimModalGroup] = useState(null);
  const [nodeClaims, setNodeClaims] = useState([]);
  const [nodeClaimsLoading, setNodeClaimsLoading] = useState(false);

  
  // Subnets for Add Instance Group
  const [subnets, setSubnets] = useState({ publicSubnets: [], privateSubnets: [], hyperPodSubnets: [] });


  const fetchClusterInfo = async () => {
    try {
      const response = await fetch('/api/cluster/info');
      const data = await response.json();
      if (response.ok) {
        setClusterInfo({
          eksClusterName: data.eksClusterName || '',
          region: data.region || '',
          isTerraform: data.isTerraform || false
        });

        // 获取真实的可用区列表
        if (data.region) {
          const azResponse = await fetch(`/api/cluster/availability-zones?region=${data.region}`);
          const azData = await azResponse.json();
          if (azResponse.ok) {
            setAvailabilityZones(azData.zones || []);
          }
        }
      }
    } catch (error) {
      console.error('Error fetching cluster info:', error);
    }
  };

  // Delete HyperPod 功能已隐藏 (2025-12-03)
  /* const handleDeleteHyperPod = () => {
    Modal.confirm({
      title: 'Delete HyperPod Cluster',
      content: 'Are you sure you want to delete the HyperPod cluster? This action cannot be undone.',
      okText: 'Yes, Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await dispatch(deleteHyperPod(activeCluster)).unwrap();
          message.success('HyperPod deletion initiated successfully');
        } catch (error) {
          message.error(`Failed to delete HyperPod: ${error}`);
        }
      }
    });
  }; */


  // 获取所有子网（用于 Add Instance Group）
  const fetchSubnets = useCallback(async () => {
    try {
      const response = await fetch('/api/cluster/subnets');
      const result = await response.json();
      
      if (result.success) {
        setSubnets({
          publicSubnets: result.data.publicSubnets || [],
          privateSubnets: result.data.privateSubnets || [],
          hyperPodSubnets: result.data.hyperPodSubnets || []
        });
      }
    } catch (error) {
      console.error('Error fetching subnets:', error);
    }
  }, []);

  // 获取当前 VPC 的 private subnet（用于 Add Instance Group 按 AZ 自动选择）
  const fetchPrivateSubnets = useCallback(async () => {
    setPrivateSubnetsLoading(true);
    setPrivateSubnetsError(null);
    setPrivateSubnets([]);
    try {
      const response = await fetch('/api/cluster/compute-subnets');
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Failed to fetch private subnets');
      }
      setPrivateSubnets(result.data.privateSubnets || result.data.computeSubnets || []);
    } catch (error) {
      console.error('Error fetching private subnets:', error);
      setPrivateSubnetsError(error.message || 'Failed to fetch private subnets');
    } finally {
      setPrivateSubnetsLoading(false);
    }
  }, []);

  // 获取 HyperPod Karpenter 资源
  const fetchHyperPodKarpenterResources = useCallback(async () => {
    setHyperpodKarpenterLoading(true);
    try {
      const response = await fetch('/api/cluster/hyperpod-karpenter/resources');
      const data = await response.json();
      if (response.ok) {
        setHyperpodKarpenterResources(data.data);
      } else {
        console.error('Failed to fetch HyperPod Karpenter resources:', data.error);
        setHyperpodKarpenterResources({
          nodeClasses: [],
          nodePools: []
        });
      }
    } catch (error) {
      console.error('Error fetching HyperPod Karpenter resources:', error);
      setHyperpodKarpenterResources({
        nodeClasses: [],
        nodePools: []
      });
    } finally {
      setHyperpodKarpenterLoading(false);
    }
  }, []);

  // 获取 HyperPod Karpenter 安装状态
  const fetchHyperPodKarpenterStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/cluster/hyperpod-karpenter/status');
      const data = await response.json();
      if (response.ok) {
        setHyperpodKarpenterStatus(data.data);
      }
    } catch (error) {
      console.error('Error fetching HyperPod Karpenter status:', error);
      setHyperpodKarpenterStatus({ installed: false });
    }
  }, []);

  // 创建 HyperPod Karpenter 资源
  const handleCreateHyperPodKarpenterResource = async () => {
    if (selectedInstanceGroups.length === 0) {
      message.error('Please select at least one instance group');
      return;
    }

    setHyperpodKarpenterResourceCreating(true);
    try {
      const response = await fetch('/api/cluster/hyperpod-karpenter/create-resource', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceGroups: selectedInstanceGroups
        })
      });

      const result = await response.json();

      if (result.success) {
        message.success('HyperPod Karpenter resource created successfully');
        setHyperpodKarpenterResourceModalVisible(false);
        setSelectedInstanceGroups([]);
        await fetchHyperPodKarpenterResources();
      } else {
        message.error(`Creation failed: ${result.error}`);
      }
    } catch (error) {
      message.error('Failed to create HyperPod Karpenter resource');
      console.error('Creation error:', error);
    } finally {
      setHyperpodKarpenterResourceCreating(false);
    }
  };

  // NodeClaim Modal handlers
  const handleOpenNodeClaimModal = async (instanceGroupName) => {
    setNodeClaimModalGroup(instanceGroupName);
    setNodeClaimModalVisible(true);
    setNodeClaimsLoading(true);
    try {
      const response = await fetch(`/api/cluster/hyperpod-karpenter/nodeclaims/${instanceGroupName}`);
      const data = await response.json();
      setNodeClaims(data.success ? data.data : []);
    } catch (error) {
      console.error('Failed to fetch NodeClaims:', error);
      setNodeClaims([]);
    } finally {
      setNodeClaimsLoading(false);
    }
  };

  const handleDeleteNodeClaim = (nodeClaimName) => {
    Modal.confirm({
      title: 'Drain & Remove Node',
      content: `This will drain all pods from the node and remove it. Pods will be rescheduled to other available nodes. Continue?`,
      okText: 'Drain & Remove',
      okType: 'danger',
      onOk: async () => {
        try {
          const response = await fetch(`/api/cluster/hyperpod-karpenter/nodeclaim/${nodeClaimName}`, { method: 'DELETE' });
          const result = await response.json();
          if (result.success) {
            message.success(result.message);
            handleOpenNodeClaimModal(nodeClaimModalGroup); // refresh
          } else {
            message.error(result.error);
          }
        } catch (error) {
          message.error('Failed to delete NodeClaim');
        }
      }
    });
  };

  const handleAddInstanceGroup = async () => {
    try {
      setAddInstanceGroupLoading(true);
      const values = await instanceGroupForm.validateFields();

      await dispatch(addInstanceGroup(values)).unwrap();

      message.success('Instance group addition initiated successfully');
      // 成功后关闭Modal并重置表单
      setAddInstanceGroupModalVisible(false);
      instanceGroupForm.resetFields();

    } catch (error) {
      console.error('Error adding instance group:', error);
      message.error(`Error adding instance group: ${error}`);
    } finally {
      setAddInstanceGroupLoading(false);
    }
  };

  const handleCreateHyperPod = async () => {
    try {
      const values = await hyperPodForm.validateFields();

      // 立即关闭Modal
      setCreateHyperPodModalVisible(false);
      hyperPodForm.resetFields();

      await dispatch(createHyperPod({ userConfig: values })).unwrap();
      
      // 立即获取完整的创建状态，避免显示空字段
      await dispatch(checkHyperPodCreationStatus());
      
      message.info('HyperPod creation initiated successfully');
    } catch (error) {
      message.error(`Error creating HyperPod cluster: ${error}`);
    }
  };

  const handleScale = (record, type) => {
    setScaleTarget({ ...record, type });

    if (type === 'eks') {
      form.setFieldsValue({
        minSize: record.scalingConfig.minSize,
        maxSize: record.scalingConfig.maxSize,
        desiredSize: record.scalingConfig.desiredSize
      });
    } else {
      form.setFieldsValue({
        targetCount: record.targetCount
      });
    }

    setScaleModalVisible(true);
  };

  const handleScaleSubmit = async () => {
    if (scaleLoading) return; // 防止重复点击

    try {
      setScaleLoading(true);
      const values = await form.validateFields();

      if (scaleTarget.type === 'eks') {
        await dispatch(scaleNodeGroup({
          name: scaleTarget.name,
          count: values.desiredSize,
          minSize: values.minSize,
          maxSize: values.maxSize
        })).unwrap();
      } else {
        const response = await fetch(`/api/cluster/hyperpod/instances/${scaleTarget.name}/scale`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values)
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || error.message || 'Unknown error');
        }
      }

      message.success(`${scaleTarget.type === 'eks' ? 'Node group' : 'Instance group'} scaling updated successfully`);
      setScaleModalVisible(false);
      form.resetFields();
      dispatch(fetchNodeGroups());

    } catch (error) {
      console.error('Error updating scaling:', error);
      message.error(`Error updating scaling: ${error.message || 'Unknown error'}`);
    } finally {
      setScaleLoading(false);
    }
  };

  const handleDeleteInstanceGroup = async (record) => {
    Modal.confirm({
      title: 'Delete Instance Group',
      content: `Are you sure you want to delete instance group "${record.name}"? This action cannot be undone.`,
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          setDeleteLoading(true);
          setDeleteTarget(record.name);

          const response = await fetch('/api/cluster/hyperpod/delete-instance-group', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instanceGroupName: record.name })
          });

          if (response.ok) {
            message.success(`Instance group "${record.name}" deletion initiated successfully`);
            dispatch(fetchNodeGroups());
          } else {
            const error = await response.json();
            message.error(`Failed to delete instance group: ${error.error || error.message || 'Unknown error'}`);
          }
        } catch (error) {
          console.error('Error deleting instance group:', error);
          message.error(`Error deleting instance group: ${error.message || 'Unknown error'}`);
        } finally {
          setDeleteLoading(false);
          setDeleteTarget(null);
        }
      }
    });
  };

  const handleUpdateSoftware = async (record) => {
    try {
      const response = await fetch('/api/cluster/hyperpod/update-software', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterArn: record.clusterArn })
      });

      if (response.ok) {
        message.success('HyperPod cluster software update initiated successfully');
        dispatch(fetchNodeGroups());
      } else {
        const error = await response.json();
        message.error(`Failed to update cluster software: ${error.error || error.message || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error in handleUpdateSoftware:', error);
      message.error(`Error updating cluster software: ${error.message || 'Unknown error'}`);
    }
  };

  const handleDeleteEksNodeGroup = async (nodeGroupName) => {
    Modal.confirm({
      title: 'Delete EKS Node Group',
      content: `Are you sure you want to delete the node group "${nodeGroupName}"? This action cannot be undone.`,
      okText: 'Yes, Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          setEksDeleteLoading(true);
          setEksDeleteTarget(nodeGroupName);

          await dispatch(deleteNodeGroup(nodeGroupName)).unwrap();
          message.success(`NodeGroup ${nodeGroupName} deletion started`);

        } catch (error) {
          message.error(`Error deleting nodegroup: ${error}`);
        } finally {
          setEksDeleteLoading(false);
          setEksDeleteTarget(null);
        }
      }
    });
  };

  // 统一的完整刷新函数（包含必需的创建状态恢复） - fixed useCallback import
  const handleCompleteRefresh = useCallback(async () => {
    try {
      // 并行执行节点组刷新、创建状态恢复和Karpenter状态刷新
      await Promise.all([
        dispatch(fetchNodeGroups()),
        dispatch(checkHyperPodCreationStatus()), // 必需：恢复创建状态显示
        fetchHyperPodKarpenterStatus(),
        fetchHyperPodKarpenterResources(),
        // fetchSubnets() // 注释：加载所有子网 - 数据未被使用，节省 ~4.6s (2026-02-26)
        fetch('/api/config/instance-type-options').then(r => r.json()).then(d => { if (d.success) setInstanceTypeOptions(d.instanceTypes); }),
      ]);
    } catch (error) {
      console.error('Error in complete refresh:', error);
    }
  }, [
    dispatch,
    fetchHyperPodKarpenterStatus,
    fetchHyperPodKarpenterResources,
  ]);

  // 注册到全局刷新管理器
  useEffect(() => {
    const componentId = 'node-group-manager-redux';

    globalRefreshManager.subscribe(componentId, handleCompleteRefresh, {
      priority: 6
    });

    return () => {
      globalRefreshManager.unsubscribe(componentId);
    };
  }, [handleCompleteRefresh]);

  // 注册到操作刷新管理器（响应 WebSocket 广播）
  useEffect(() => {
    const componentId = 'nodegroup-manager';
    
    operationRefreshManager.subscribe(componentId, handleCompleteRefresh);
    
    return () => {
      operationRefreshManager.unsubscribe(componentId);
    };
  }, [handleCompleteRefresh]);

  // 移除错误的 globalRefreshManager 订阅
  // Karpenter 状态应该通过用户主动刷新来获取，而不是 WebSocket 推送
  // globalRefreshManager 只用于管理前端组件的刷新，不用于集群资源状态订阅

  // Initial data loading
  // 使用 ref 来跟踪是否已经执行过初始加载
  const hasInitiallyLoaded = useRef(false);

  // 初始加载 - 只在组件挂载时执行一次
  useEffect(() => {
    if (!hasInitiallyLoaded.current) {
      hasInitiallyLoaded.current = true;
      handleCompleteRefresh();
    }
  }, []); // 完全空的依赖数组

  // 加载 EFA-only 支持机型白名单（静态 config，加载一次即可）
  useEffect(() => {
    fetch('/api/config/efa-only-instance-types')
      .then(r => r.json())
      .then(d => {
        if (d && d.success && Array.isArray(d.instanceTypes)) {
          setEfaOnlyTypes(d.instanceTypes);
        }
      })
      .catch(err => console.warn('Failed to load efa-only instance types:', err));
  }, []);

  // 机型变为不支持时，清掉残留的 efaOnly 值，避免提交时把 efa-only 发给非法机型
  useEffect(() => {
    if (!efaOnlyEligible && instanceGroupForm.getFieldValue('efaOnly')) {
      instanceGroupForm.setFieldsValue({ efaOnly: false });
    }
  }, [efaOnlyEligible, instanceGroupForm]);

  // 打开 Add Instance Group 弹窗时拉取当前 VPC 的 private subnet
  useEffect(() => {
    if (addInstanceGroupModalVisible) {
      fetchPrivateSubnets();
    }
  }, [addInstanceGroupModalVisible, fetchPrivateSubnets]);

  // 0 个 private subnet 时留空走自动创建；1 个时自动选中；多个时保留用户的有效选择。
  useEffect(() => {
    const currentSubnetId = instanceGroupForm.getFieldValue('subnetId');

    if (!addIgAz || addIgNewSubnet) {
      if (currentSubnetId) {
        instanceGroupForm.setFieldsValue({ subnetId: undefined });
      }
      return;
    }

    const selection = getInstanceGroupSubnetSelection(privateSubnets, addIgAz);
    if (selection.autoSelectedSubnetId) {
      if (currentSubnetId !== selection.autoSelectedSubnetId) {
        instanceGroupForm.setFieldsValue({ subnetId: selection.autoSelectedSubnetId });
      }
    } else if (currentSubnetId && !selection.matchingSubnets.some(subnet => subnet.subnetId === currentSubnetId)) {
      instanceGroupForm.setFieldsValue({ subnetId: undefined });
    }
  }, [addIgAz, addIgNewSubnet, privateSubnets, instanceGroupForm]);

  // Response to external triggers
  useEffect(() => {
    if (refreshTrigger > 0) {
      handleCompleteRefresh(); // 使用完整刷新链路
    }
  }, [refreshTrigger, handleCompleteRefresh]);

  // Response to activeCluster changes
  useEffect(() => {
    if (activeCluster) {
      handleCompleteRefresh(); // 使用完整刷新链路

      // Reset operation statuses
      dispatch(clearHyperPodCreationStatus());
      dispatch(clearNodeGroupOperationStatus());
    }
  }, [activeCluster, handleCompleteRefresh, dispatch]);


  const renderEKSActions = (record) => (
    <Space>
      <Button
        size="small"
        icon={<EditOutlined />}
        onClick={() => handleScale(record, 'eks')}
      >
        Scale
      </Button>
      <Button
        size="small"
        danger
        icon={<DeleteOutlined />}
        loading={eksDeleteLoading && eksDeleteTarget === record.name}
        onClick={() => handleDeleteEksNodeGroup(record.name)}
      >
        Delete
      </Button>
    </Space>
  );

  const renderHyperPodActions = (record) => (
    <Space>
      <Button
        size="small"
        icon={<EditOutlined />}
        onClick={() => handleScale(record, 'hyperpod')}
        disabled={clusterInfo.isTerraform}
        title={clusterInfo.isTerraform ? "Instance groups are managed by Terraform" : ""}
      >
        Scale
      </Button>
      <Button
        size="small"
        icon={<DeleteOutlined />}
        danger
        loading={deleteLoading && deleteTarget === record.name}
        onClick={() => handleDeleteInstanceGroup(record)}
        disabled={clusterInfo.isTerraform}
        title={clusterInfo.isTerraform ? "Instance groups are managed by Terraform" : ""}
      >
        Delete
      </Button>
    </Space>
  );

  // 渲染HyperPod集群级操作按钮
  const renderHyperPodClusterActions = () => {
    // 只有当HyperPod存在且没有创建状态时才显示集群级操作
    if (hyperPodGroups.length === 0 || hyperPodCreationStatus) return null;

    // 获取第一个Instance Group的集群信息（所有Instance Group属于同一个集群）
    const clusterInfo = hyperPodGroups[0];

    return (
      <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#fafafa', border: '1px solid #d9d9d9', borderRadius: '6px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Text strong>HyperPod Cluster: {clusterInfo.clusterName}</Text>
          </div>
          <Space>
            <Button
              icon={<ToolOutlined />}
              onClick={() => handleUpdateSoftware(clusterInfo)}
            >
              Update Cluster Software
            </Button>
          </Space>
        </div>
      </div>
    );
  };

  const eksColumns = buildEksColumns({ renderEKSActions });

  const hyperPodColumns = buildHyperPodColumns({
    renderHyperPodActions,
    hyperpodKarpenterResources,
  });

  return (
    <div style={{ height: '100%' }}>
      {/* Refresh按钮已移除：Cluster Information的刷新按钮通过refreshTrigger已覆盖此功能
      <div style={{ marginBottom: '16px', textAlign: 'right' }}>
        <Button
          icon={<ReloadOutlined />}
          onClick={handleCompleteRefresh}
          loading={loading}
          size="small"
        >
          Refresh Node Groups
        </Button>
      </div>
      */}

      {/* HyperPod Instance Groups - 通过配置控制显示 */}
      {clusterConfig.hyperpodInstanceGroups !== 'off' && (
      <Card
        title="HyperPod Instance Groups"
        style={{ marginBottom: '16px' }}
        size="small"
        extra={
          <Space>
            <Button
              type="default"
              icon={<PlusOutlined />}
              size="small"
              onClick={() => {
                setAddInstanceGroupModalVisible(true);
                fetchClusterInfo(); // 确保获取最新信息
              }}
              disabled={
                !!hyperPodCreationStatus ||  // 创建中时禁用
                !!hyperPodDeletionStatus ||  // 删除中时禁用
                hyperPodGroups.length === 0 ||   // 没有HyperPod时禁用
                clusterInfo.isTerraform ||   // Terraform 管理时禁用
                addInstanceGroupLoading      // 添加中时禁用
              }
              loading={addInstanceGroupLoading}
              title={
                clusterInfo.isTerraform
                  ? "Instance groups are managed by Terraform"
                  : hyperPodCreationStatus
                  ? "HyperPod creation in progress"
                  : hyperPodDeletionStatus
                    ? "HyperPod deletion in progress"
                    : hyperPodGroups.length === 0
                      ? "No HyperPod cluster exists"
                      : addInstanceGroupLoading
                        ? "Adding instance group..."
                        : "Add instance group to existing HyperPod cluster"
              }
            >
              Add Instance Group
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              size="small"
              onClick={() => {
                setCreateHyperPodModalVisible(true);
                fetchClusterInfo(); // 确保获取最新信息
              }}
              disabled={
                !effectiveDependenciesConfigured ||   // 依赖未配置时禁用
                !!hyperPodCreationStatus ||  // 创建中时禁用
                !!hyperPodDeletionStatus ||  // 删除中时禁用
                hyperPodGroups.length > 0    // 已存在HyperPod时禁用
              }
              loading={hyperPodCreationStatus === 'creating'}
              title={
                !effectiveDependenciesConfigured
                  ? "Dependencies must be configured first"
                  : hyperPodCreationStatus
                    ? "HyperPod creation in progress"
                    : hyperPodDeletionStatus
                      ? "HyperPod deletion in progress"
                      : hyperPodGroups.length > 0
                        ? "HyperPod cluster already exists in this EKS cluster"
                        : "Create HyperPod cluster"
              }
            >
              Create HyperPod
            </Button>
            {/* Delete HyperPod 按钮已隐藏 (2025-12-03) - 后端 API 仍保留: DELETE /api/cluster/:clusterTag/hyperpod */}
            {/* {hyperPodGroups.length > 0 && (() => {
              const isImportedWithHyperPod = cluster?.type === 'imported' && cluster?.hasHyperPod;
              return (
                <Button
                  type="default"
                  danger
                  size="small"
                  loading={hyperPodDeletionStatus === 'deleting'}
                  onClick={handleDeleteHyperPod}
                  disabled={
                    !!hyperPodCreationStatus ||
                    !!hyperPodDeletionStatus ||
                    isImportedWithHyperPod
                  }
                  title={
                    isImportedWithHyperPod
                      ? "Cannot delete HyperPod cluster from imported EKS+HyperPod setup"
                      : "Delete HyperPod cluster and all instance groups"
                  }
                >
                  Delete HyperPod
                </Button>
              );
            })()} */}
          </Space>
        }
      >
        {hyperPodCreationStatus && typeof hyperPodCreationStatus === 'object' && hyperPodCreationStatus.stackName && (
          <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: '6px' }}>
            <Space>
              <Tag color="processing">Creating</Tag>
              <span>HyperPod Cluster: {hyperPodCreationStatus.stackName}</span>
              <span>Phase: {hyperPodCreationStatus.phase}</span>
              <span>Status: {hyperPodCreationStatus.cfStatus || hyperPodCreationStatus.status}</span>
            </Space>
          </div>
        )}

        {/* HyperPod集群级操作 */}
        {renderHyperPodClusterActions()}

        {hyperPodGroups.length === 0 && !hyperPodCreationStatus && (
          <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#fff7e6', border: '1px solid #ffd591', borderRadius: '6px' }}>
            <Space>
              <Tag color="orange">Not Found</Tag>
              <span>No HyperPod cluster exists in this EKS cluster</span>
            </Space>
          </div>
        )}
        {(() => {
          const activeGroups = hyperPodGroups.filter(g => Number(g.currentCount) > 0 || Number(g.targetCount) > 0);
          const emptyGroups = hyperPodGroups.filter(g => !Number(g.currentCount) && !Number(g.targetCount));
          return (
            <>
              {(activeGroups.length > 0 || emptyGroups.length === 0) && (
                <Table
                  columns={hyperPodColumns}
                  dataSource={activeGroups}
                  rowKey="name"
                  loading={loading}
                  size="small"
                  pagination={false}
                  locale={{ emptyText: 'No HyperPod and Instance groups' }}
                  style={{ minHeight: activeGroups.length === 0 ? '60px' : 'auto' }}
                />
              )}
              {emptyGroups.length > 0 && (
                <>
                  <div
                    style={{ padding: '6px 8px', cursor: 'pointer', fontSize: 12, color: '#888', userSelect: 'none' }}
                    onClick={() => setShowInactiveGroups(v => !v)}
                  >
                    {showInactiveGroups ? <DownOutlined style={{ fontSize: 10, marginRight: 6 }} /> : <RightOutlined style={{ fontSize: 10, marginRight: 6 }} />}
                    Inactive Instance Groups (0/0) — {emptyGroups.length} groups
                  </div>
                  {showInactiveGroups && (
                    <Table
                      columns={hyperPodColumns}
                      dataSource={emptyGroups}
                      rowKey="name"
                      size="small"
                      pagination={false}
                      showHeader={false}
                    />
                  )}
                </>
              )}
            </>
          );
        })()}
      </Card>
      )}

      {/* HyperPod Karpenter Resources - 通过配置控制显示 */}
      {clusterConfig.hyperpodKarpenter !== 'off' && (
      <Card
        title="HyperPod Karpenter Resources"
        size="small"
        style={{ marginTop: 16, marginBottom: 16 }}
        extra={
          <Space>
            <Button
              type="default"
              size="small"
              icon={<PlusOutlined />}
              disabled={!hyperpodKarpenterStatus.installed || hyperPodGroups.length === 0}
              onClick={() => setHyperpodKarpenterResourceModalVisible(true)}
              title={!hyperpodKarpenterStatus.installed ? "Enable Karpenter in Advanced Features first" : "Add HyperPod Karpenter Resource"}
            >
              Add Resource
            </Button>
          </Space>
        }
      >
        <Table
          dataSource={hyperpodKarpenterResources.nodePools}
          columns={[
            {
              title: 'NodePool',
              dataIndex: 'name',
              key: 'name',
              render: (text) => <Text strong>{text}</Text>
            },
            {
              title: 'HyperpodNodeClass',
              dataIndex: 'nodeClassRef',
              key: 'nodeClassRef',
              render: (text) => <Text>{text}</Text>
            },
            {
              title: 'Status',
              dataIndex: 'status',
              key: 'status',
              render: (status) => (
                <Tag color={status === 'Ready' ? 'success' : 'default'}>
                  {status}
                </Tag>
              )
            },
            {
              title: 'Instance Group',
              dataIndex: 'nodeClassRef',
              key: 'instanceGroup',
              render: (nodeClassRef) => {
                const nodeClass = hyperpodKarpenterResources.nodeClasses.find(nc => nc.name === nodeClassRef);
                return nodeClass && nodeClass.instanceGroups.length > 0 ? (
                  <Text>{nodeClass.instanceGroups.join(', ')}</Text>
                ) : '-';
              }
            },
            {
              title: 'Instance Types',
              dataIndex: 'nodeClassRef',
              key: 'instanceTypes',
              render: (nodeClassRef) => {
                const nodeClass = hyperpodKarpenterResources.nodeClasses.find(nc => nc.name === nodeClassRef);
                if (!nodeClass || nodeClass.instanceTypes.length === 0) return '-';
                return <Text>{nodeClass.instanceTypes.join(', ')}</Text>;
              }
            },
            {
              title: 'Capacity Type',
              dataIndex: 'nodeClassRef',
              key: 'capacityType',
              render: (nodeClassRef) => {
                const nodeClass = hyperpodKarpenterResources.nodeClasses.find(nc => nc.name === nodeClassRef);
                if (!nodeClass) return '-';
                const capacityType = nodeClass.capacityType;
                return (
                  <Tag color={capacityType === 'on-demand' ? 'green' : 'orange'}>
                    {capacityType === 'on-demand' ? 'OD' : 'Spot'}
                  </Tag>
                );
              }
            },
            {
              title: 'Actions',
              key: 'actions',
              width: 160,
              render: (_, record) => {
                const nodeClass = hyperpodKarpenterResources.nodeClasses.find(nc => nc.name === record.nodeClassRef);
                const igName = nodeClass?.instanceGroups?.[0];
                return (
                <Space>
                  {igName && (
                    <Button size="small" icon={<SettingOutlined />} onClick={() => handleOpenNodeClaimModal(igName)}>
                      Manage
                    </Button>
                  )}
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    loading={deletingNodePool === record.name}
                    disabled={deletingNodePool !== null}
                  onClick={async () => {
                    setDeletingNodePool(record.name);
                    try {
                      const response = await fetch(`/api/cluster/hyperpod-karpenter/nodepool/${record.name}`, {
                        method: 'DELETE'
                      });
                      const data = await response.json();
                      
                      if (response.ok) {
                        message.success(`NodePool ${record.name} deleted`);
                        await fetchHyperPodKarpenterResources();
                      } else {
                        message.error(`Failed to delete: ${data.error || 'Unknown error'}`);
                      }
                    } catch (error) {
                      console.error('Error deleting NodePool:', error);
                      message.error(`Error: ${error.message}`);
                    } finally {
                      setDeletingNodePool(null);
                    }
                  }}
                >
                  Delete
                </Button>
                </Space>
                );
              }
            }
          ]}
          rowKey="name"
          size="small"
          pagination={false}
          loading={hyperpodKarpenterLoading}
          locale={{ emptyText: 'No HyperPod Karpenter Resources' }}
          style={{ minHeight: hyperpodKarpenterResources.nodePools.length === 0 ? '60px' : 'auto' }}
        />
      </Card>
      )}




      <Modal
        title={`Scale ${scaleTarget?.type === 'eks' ? 'EKS Node Group' : 'HyperPod Instance Group'}: ${scaleTarget?.name}`}
        open={scaleModalVisible}
        onOk={handleScaleSubmit}
        onCancel={() => {
          if (scaleLoading) return; // 防止loading时关闭
          setScaleModalVisible(false);
          form.resetFields();
        }}
        okText="Update"
        confirmLoading={scaleLoading}
        cancelButtonProps={{ disabled: scaleLoading }}
      >
        <Form form={form} layout="vertical">
          {scaleTarget?.type === 'eks' ? (
            <>
              <Form.Item
                name="minSize"
                label="Minimum Size"
                rules={[{ required: true, message: 'Please input minimum size' }]}
              >
                <InputNumber min={0} max={100} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="maxSize"
                label="Maximum Size"
                rules={[{ required: true, message: 'Please input maximum size' }]}
              >
                <InputNumber min={1} max={100} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="desiredSize"
                label="Desired Size"
                rules={[{ required: true, message: 'Please input desired size' }]}
              >
                <InputNumber min={0} max={100} style={{ width: '100%' }} />
              </Form.Item>
            </>
          ) : (
            <Form.Item
              name="targetCount"
              label="Target Count"
              rules={[{ required: true, message: 'Please input target count' }]}
            >
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        title="Create HyperPod Cluster"
        open={createHyperPodModalVisible}
        onOk={handleCreateHyperPod}
        onCancel={() => {
          setCreateHyperPodModalVisible(false);
          hyperPodForm.resetFields();
        }}
        okText="Create"
        width={700}
      >
        <Form form={hyperPodForm} layout="vertical">
          <div style={{ display: 'flex', gap: '16px' }}>
            <Form.Item
              label="EKS Cluster Name"
              style={{ flex: 1 }}
            >
              <Input value={clusterInfo.eksClusterName} disabled />
            </Form.Item>

            <Form.Item
              label="Region"
              style={{ flex: 1 }}
            >
              <Input value={clusterInfo.region} disabled />
            </Form.Item>
          </div>

          <Form.Item
            name="initInstanceGroupTag"
            label="Instance Group Tag"
            rules={[{ required: true, message: 'Please input instance group tag' }]}
            extra="Used as the instance group name prefix (e.g. my-ig → my-ig-ig)"
          >
            <Input placeholder="my-ig" />
          </Form.Item>

          <Form.Item
            name="AcceleratedInstanceType"
            label="Instance Type"
            initialValue="ml.g5.8xlarge"
            rules={[{ required: true, message: 'Please select or input instance type' }]}
          >
            <AutoComplete
              placeholder="Select or type instance type"
              options={instanceTypeOptions.map(t => ({ value: t, label: t }))}
              filterOption={(inputValue, option) =>
                option.value.toLowerCase().indexOf(inputValue.toLowerCase()) !== -1
              }
            />
          </Form.Item>

          <div style={{ display: 'flex', gap: '16px' }}>
            <Form.Item
              name="AcceleratedInstanceCount"
              label="Instance Count"
              initialValue={1}
              rules={[{ required: true, message: 'Please input instance count' }]}
              style={{ flex: 1 }}
            >
              <InputNumber min={1} max={100} style={{ width: '100%' }} />
            </Form.Item>

            <Form.Item
              name="AcceleratedEBSVolumeSize"
              label="EBS Volume Size (GB)"
              initialValue={500}
              rules={[{ required: true, message: 'Please input EBS volume size' }]}
              style={{ flex: 1 }}
            >
              <InputNumber min={100} max={10000} style={{ width: '100%' }} />
            </Form.Item>
          </div>

          <Form.Item
            name="availabilityZone"
            label="Availability Zone"
            rules={[{ required: true, message: 'Please select availability zone' }]}
          >
            <Select placeholder="Select availability zone">
              {availabilityZones.map(zone => (
                <Select.Option key={zone.ZoneName} value={zone.ZoneName}>
                  {zone.ZoneName} ({zone.ZoneId})
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            name="AcceleratedTrainingPlanArn"
            label="Flexible Training Plan ARN (Optional)"
            extra="Leave empty if not using flexible training plan"
          >
            <Input placeholder="arn:aws:sagemaker:region:account:training-plan/..." />
          </Form.Item>

          <Divider style={{ margin: '16px 0 8px 0' }} />
          
          <details style={{ marginBottom: 8 }}>
            <summary style={{ cursor: 'pointer', color: '#888', marginBottom: 8 }}>
              (Optional) Compute Subnet ID
            </summary>
            <Form.Item
              name="computeSubnetId"
              style={{ marginTop: 8, marginBottom: 0 }}
            >
              <Input placeholder="subnet-0123456789abcdef0" />
            </Form.Item>
          </details>
        </Form>
      </Modal>

      <Modal
        title="Add Instance Group"
        open={addInstanceGroupModalVisible}
        onOk={handleAddInstanceGroup}
        onCancel={() => {
          if (addInstanceGroupLoading) return; // 防止loading时关闭
          setAddInstanceGroupModalVisible(false);
          instanceGroupForm.resetFields();
        }}
        okText="Add Instance Group"
        confirmLoading={addInstanceGroupLoading}
        cancelButtonProps={{ disabled: addInstanceGroupLoading }}
        okButtonProps={{
          disabled: !addIgNewSubnet && (privateSubnetsLoading || !!privateSubnetsError)
        }}
        width={700}
      >
        <Form form={instanceGroupForm} layout="vertical">
          <Form.Item
            name="instanceGroupName"
            label="Instance Group Name"
            rules={[{ required: true, message: 'Please input instance group name' }]}
            extra="Name for the new instance group"
          >
            <Input placeholder="compute-group-new" />
          </Form.Item>

          <div style={{ display: 'flex', gap: '16px' }}>
            <Form.Item
              name="instanceType"
              label="Instance Type"
              rules={[{ required: true, message: 'Please select or input instance type' }]}
              style={{ flex: 1 }}
            >
              <AutoComplete
                placeholder="Select or type instance type"
                options={instanceTypeOptions.map(t => ({ value: t, label: t }))}
                filterOption={(inputValue, option) =>
                  option.value.toLowerCase().indexOf(inputValue.toLowerCase()) !== -1
                }
              />
            </Form.Item>

            <Form.Item
              name="instanceCount"
              label="Instance Count"
              initialValue={1}
              rules={[{ required: true, message: 'Please input instance count' }]}
              style={{ flex: 1 }}
            >
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </div>

          <Form.Item
            name="availabilityZone"
            label="Availability Zone"
            rules={[{ required: true, message: 'Please select availability zone' }]}
          >
            <Select placeholder="Select availability zone" loading={!availabilityZones.length}>
              {availabilityZones.map(az => (
                <Select.Option key={az.ZoneName} value={az.ZoneName}>
                  {az.ZoneName} ({az.ZoneId})
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            name="volumeSize"
            label="EBS Volume Size (GB)"
            initialValue={300}
            rules={[{ required: true, message: 'Please input volume size' }]}
            extra="EBS volume size in GB"
          >
            <InputNumber min={100} max={16000} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="isSpot"
            label="Use HyperPod Spot Instances"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="trainingPlanArn"
            label="Training Plan ARN (Optional)"
            extra="Provide Training Plan ARN if already in valid state."
          >
            <Input placeholder="arn:aws:sagemaker:region:account:training-plan/..." />
          </Form.Item>

          {/* EFA-only：仅当所选机型支持（多网卡 EFA 机型）时才显示。创建时定死、不可变。 */}
          {efaOnlyEligible && (
            <details style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', color: '#888', marginBottom: 8 }}>
                (Optional) Advanced network
              </summary>
              <Form.Item
                name="efaOnly"
                label="EFA-only network interface"
                valuePropName="checked"
                style={{ marginTop: 8, marginBottom: 0 }}
                extra="Use EFA-only interfaces (EFA device without ENA IP networking) to avoid subnet IP exhaustion in large clusters. Fixed at creation time and cannot be changed afterwards."
              >
                <Switch />
              </Form.Item>
            </details>
          )}

          <details style={{ marginBottom: 8 }}>
            <summary style={{ cursor: 'pointer', color: '#888', marginBottom: 8 }}>
              (Optional) Create new subnet
            </summary>
            <Form.Item
              name="newSubnet"
              label="Create a new subnet for this instance group"
              valuePropName="checked"
              style={{ marginTop: 8, marginBottom: 0 }}
              extra="Creates a new subnet (hp-compute-{yymmdd}-{az}-{hash}) to avoid IP exhaustion. You maintain it yourself — it's not deleted with the instance group. Enabling this clears any existing subnet selection."
            >
              <Switch />
            </Form.Item>
          </details>

          {!addIgNewSubnet && (
            <div style={{ marginBottom: 8 }}>
              {!addIgAz ? (
                <Alert
                  type="info"
                  showIcon
                  message="Select an availability zone to determine the compute subnet."
                />
              ) : privateSubnetsLoading ? (
                <div style={{ padding: '8px 0' }}>
                  <Spin size="small" /> <Text type="secondary">Loading private subnets...</Text>
                </div>
              ) : privateSubnetsError ? (
                <Alert
                  type="error"
                  showIcon
                  message="Unable to load private subnets"
                  description={privateSubnetsError}
                />
              ) : addIgSubnetSelection.matchingSubnets.length === 0 ? (
                <Alert
                  type="info"
                  showIcon
                  message={`No private subnet exists in ${addIgAz}`}
                  description={`A shared compute subnet (hp-compute-${addIgAz}) will be created automatically.`}
                />
              ) : (
                <Form.Item
                  name="subnetId"
                  label="Compute Subnet"
                  rules={addIgSubnetSelection.requiresSelection
                    ? [{ required: true, message: 'Please select a private subnet' }]
                    : []}
                  extra={addIgSubnetSelection.requiresSelection
                    ? 'Multiple private subnets exist in this availability zone. Select one for the new instance group.'
                    : 'The only private subnet in this availability zone is selected automatically.'}
                >
                  <Select
                    disabled={!addIgSubnetSelection.requiresSelection}
                    showSearch
                    optionFilterProp="label"
                    placeholder="Select a private subnet"
                    options={addIgSubnetSelection.matchingSubnets.map(subnet => ({
                      value: subnet.subnetId,
                      label: `${subnet.name} — ${subnet.subnetId} (${subnet.cidrBlock})`
                    }))}
                  />
                </Form.Item>
              )}
            </div>
          )}
        </Form>
      </Modal>

      <Modal
        title="Create EKS Node Group"
        open={createEksNodeGroupModalVisible}
        onCancel={() => setCreateEksNodeGroupModalVisible(false)}
        footer={null}
        width={600}
      >
        <EksNodeGroupCreationPanel
          onCreated={() => {
            setCreateEksNodeGroupModalVisible(false);
            dispatch(fetchNodeGroups());
          }}
        />
      </Modal>

      {/* HyperPod Karpenter Resource Modal */}
      <Modal
        title="Add HyperPod Karpenter Resource"
        open={hyperpodKarpenterResourceModalVisible}
        onOk={handleCreateHyperPodKarpenterResource}
        onCancel={() => {
          setHyperpodKarpenterResourceModalVisible(false);
          setSelectedInstanceGroups([]);
        }}
        confirmLoading={hyperpodKarpenterResourceCreating}
        width={600}
      >
        <div style={{ marginBottom: 16 }}>
          <Text>Select HyperPod Instance Groups (multi-select for cross-AZ scheduling):</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 12 }}>Up to 10 instance groups per NodeClass. Already managed groups are disabled.</Text>
        </div>
        <Checkbox.Group
          value={selectedInstanceGroups}
          onChange={values => setSelectedInstanceGroups(values)}
          style={{ width: '100%' }}
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            {hyperPodGroups.map(group => {
              const isManaged = hyperpodKarpenterResources.managedInstanceGroups?.includes(group.name);
              return (
                <Checkbox key={group.name} value={group.name} disabled={isManaged}>
                  <Space>
                    <Text strong>{group.name}</Text>
                    <Tag>{group.instanceType}</Tag>
                    <Tag color={group.capacityType === 'on-demand' ? 'green' : 'orange'}>
                      {group.capacityType === 'on-demand' ? 'OD' : 'Spot'}
                    </Tag>
                    <Text type="secondary">({group.currentCount} nodes)</Text>
                    {isManaged && <Tag color="blue">Managed</Tag>}
                  </Space>
                </Checkbox>
              );
            })}
          </Space>
        </Checkbox.Group>
        {hyperPodGroups.length === 0 && (
          <Text type="secondary">No instance groups available</Text>
        )}
      </Modal>

      {/* NodeClaim Modal */}
      <Modal
        title={`NodeClaims — ${nodeClaimModalGroup || ''}`}
        open={nodeClaimModalVisible}
        onCancel={() => setNodeClaimModalVisible(false)}
        footer={null}
        width={900}
      >
        <Table
          dataSource={nodeClaims}
          loading={nodeClaimsLoading}
          rowKey="name"
          size="small"
          pagination={false}
          locale={{ emptyText: 'No NodeClaims' }}
          columns={[
            { title: 'NodeClaim', dataIndex: 'name', key: 'name', render: t => <Text strong>{t}</Text> },
            { title: 'Node', dataIndex: 'nodeName', key: 'nodeName' },
            { title: 'Type', dataIndex: 'instanceType', key: 'instanceType' },
            { title: 'AZ', dataIndex: 'zone', key: 'zone' },
            { title: 'Status', key: 'status', render: (_, r) => (
              <Space>
                <Tag color={r.ready ? 'success' : 'warning'}>{r.ready ? 'Ready' : 'Pending'}</Tag>
                {r.drifted && <Tag color="orange">Drifted</Tag>}
              </Space>
            )},
            { title: 'Actions', key: 'actions', width: 140, render: (_, r) => (
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDeleteNodeClaim(r.name)}>
                Drain & Remove
              </Button>
            )}
          ]}
        />
      </Modal>

    </div>
  );
};

export default NodeGroupManagerRedux;
