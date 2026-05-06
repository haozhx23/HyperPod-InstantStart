import React, { useEffect, useCallback, useState, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  Table,
  Progress,
  Tag,
  Button,
  Space,
  Statistic,
  Row,
  Col,
  Card,
  message,
  Tooltip,
  Spin,
  Alert,
  Modal,
  Form,
  Select,
  Typography
} from 'antd';
import {
  ReloadOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  ClusterOutlined,
  WarningOutlined,
  PartitionOutlined,
  RollbackOutlined
} from '@ant-design/icons';

// Redux imports
import { refreshClusterData } from '../store/slices/clusterStatusSlice';
import {
  selectClusterNodes,
  selectPendingGPUs,
  selectClusterStatusLoading,
  selectClusterStatusError,
  selectCalculatedClusterStats
} from '../store/selectors';

// 新的事件总线
import resourceEventBus from '../utils/resourceEventBus';

const { Text } = Typography;

const ClusterStatusV2Redux = () => {
  const dispatch = useDispatch();

  // Redux 状态
  const clusterNodes = useSelector(selectClusterNodes);
  const pendingGPUs = useSelector(selectPendingGPUs);
  const loading = useSelector(selectClusterStatusLoading);
  const error = useSelector(selectClusterStatusError);
  const clusterStats = useSelector(selectCalculatedClusterStats);

  // HAMi 节点控制状态
  const [partitionModalVisible, setPartitionModalVisible] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);

  // 节点操作状态
  const [nodeActionModalVisible, setNodeActionModalVisible] = useState(false);
  const [nodeActionLoading, setNodeActionLoading] = useState(false);

  // 过滤器状态
  const [filterNodeType, setFilterNodeType] = useState('__all__');
  const [filterCapacityType, setFilterCapacityType] = useState('__all__');
  const [filterGpuAvail, setFilterGpuAvail] = useState('__all__');

  // 初始化时获取数据（只执行一次）
  useEffect(() => {
    dispatch(refreshClusterData());

    // 订阅资源变化事件
    const refreshCallback = (eventType) => {
      // 只响应需要 GPU 的操作，忽略 'app-status-only' 事件
      if (eventType === 'app-status-only') {
        console.log('[ClusterStatus] Ignoring app-status-only event');
        return;
      }
      
      console.log('[ClusterStatus] Refreshing for event:', eventType);
      dispatch(refreshClusterData());
    };
    
    resourceEventBus.subscribe('cluster-status', refreshCallback);

    // 清理订阅
    return () => {
      resourceEventBus.unsubscribe('cluster-status');
    };
  }, [dispatch]); // 只依赖dispatch，避免无限循环


  // 手动刷新
  const handleRefresh = useCallback(async () => {
    try {
      await dispatch(refreshClusterData()).unwrap();
      message.success('Cluster status refreshed successfully');
    } catch (error) {
      console.error('Error refreshing cluster status:', error);
      message.error('Failed to refresh cluster status: ' + (error.message || error));
    }
  }, [dispatch]);

  // HAMi 节点操作
  const handlePartitionClick = (node) => {
    setSelectedNode(node);
    setPartitionModalVisible(true);
  }

  // 节点操作
  const handleNodeActionClick = (node) => {
    setSelectedNode(node);
    setNodeActionModalVisible(true);
  };

  const handleNodeReboot = async () => {
    if (!selectedNode) return;
    
    try {
      setNodeActionLoading(true);
      
      const response = await fetch('/api/cluster/hyperpod/node/reboot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: selectedNode.nodeName
        })
      });
      
      const result = await response.json();
      if (result.success) {
        message.success(`Node ${selectedNode.nodeName} reboot initiated`);
        setNodeActionModalVisible(false);
        setSelectedNode(null);
      } else {
        message.error(result.message || 'Failed to reboot node');
      }
    } catch (error) {
      console.error('Node reboot error:', error);
      message.error('Failed to reboot node');
    } finally {
      setNodeActionLoading(false);
    }
  };

  const handleNodeReplace = async () => {
    if (!selectedNode) return;
    
    try {
      setNodeActionLoading(true);
      
      const response = await fetch('/api/cluster/hyperpod/node/replace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: selectedNode.nodeName
        })
      });
      
      const result = await response.json();
      if (result.success) {
        message.success(`Node ${selectedNode.nodeName} replacement initiated`);
        setNodeActionModalVisible(false);
        setSelectedNode(null);
      } else {
        message.error(result.message || 'Failed to replace node');
      }
    } catch (error) {
      console.error('Node replace error:', error);
      message.error('Failed to replace node');
    } finally {
      setNodeActionLoading(false);
    }
  };

  const handleNodeDelete = async () => {
    if (!selectedNode) return;
    
    try {
      setNodeActionLoading(true);
      
      const response = await fetch('/api/cluster/hyperpod/node/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: selectedNode.nodeName
        })
      });
      
      const result = await response.json();
      if (result.success) {
        message.success(`Node ${selectedNode.nodeName} deletion initiated`);
        setNodeActionModalVisible(false);
        setSelectedNode(null);
      } else {
        message.error(result.message || 'Failed to delete node');
      }
    } catch (error) {
      console.error('Node delete error:', error);
      message.error('Failed to delete node');
    } finally {
      setNodeActionLoading(false);
    }
  };

  const handleEnableNode = async () => {
    try {
      setApplyLoading(true);
      
      const response = await fetch('/api/cluster/hami/node/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeName: selectedNode?.nodeName
        })
      });
      
      const result = await response.json();
      if (result.success) {
        message.success(`Node ${selectedNode.nodeName} enabled for HAMi`);
        setPartitionModalVisible(false);
        setSelectedNode(null);
      } else {
        message.error(result.message || 'Failed to enable node');
      }
    } catch (error) {
      console.error('HAMi node enable error:', error);
      message.error('Failed to enable node');
    } finally {
      setApplyLoading(false);
    }
  };

  const handleDisableNode = async () => {
    if (!selectedNode) return;
    
    try {
      setResetLoading(true);
      
      const response = await fetch('/api/cluster/hami/node/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeName: selectedNode.nodeName
        })
      });
      
      const result = await response.json();
      if (result.success) {
        message.success(`Node ${selectedNode.nodeName} disabled for HAMi`);
        setPartitionModalVisible(false);
        setSelectedNode(null);
      } else {
        message.error(result.message || 'Failed to disable node');
      }
    } catch (error) {
      console.error('HAMi node disable error:', error);
      message.error('Failed to disable node');
    } finally {
      setResetLoading(false);
    }
  };

  // 从节点 labels/字段派生出过滤分桶
  const deriveNodeType = (record) => {
    const labels = record.labels || {};
    const isKarpenter = labels['karpenter.sh/nodepool'] != null || labels['karpenter.sh/nodeclaim'] != null;
    if (labels['sagemaker.amazonaws.com/compute-type'] === 'hyperpod' && isKarpenter) return 'hyperpod-karpenter';
    if (labels['sagemaker.amazonaws.com/compute-type'] === 'hyperpod') return 'hyperpod';
    if (labels['eks.amazonaws.com/nodegroup']) return 'eks-nodegroup';
    return 'unknown';
  };

  const deriveCapacityType = (record, nodeType) => {
    const labels = record.labels || {};
    const isHyperPodCapacity =
      nodeType === 'hyperpod' ||
      nodeType === 'hyperpod-karpenter' ||
      false;
    if (isHyperPodCapacity) {
      if (record.capacityType === 'spot') return 'spot';
      if (record.capacityType === 'training-plan') return 'ftp';
      return 'on-demand';
    }
    if (nodeType === 'eks-nodegroup') {
      return (labels['eks.amazonaws.com/capacityType'] || '').toUpperCase() === 'SPOT' ? 'spot' : 'on-demand';
    }
    return null;
  };

  const deriveGpuBucket = (record) => {
    const total = record.totalGPU || 0;
    const avail = record.availableGPU || 0;
    if (total === 0) return 'cpu-only';
    if (avail > 0) return 'has-available';
    return 'no-available';
  };

  const filteredNodes = useMemo(() => {
    return clusterNodes.filter((record) => {
      const nodeType = deriveNodeType(record);
      if (filterNodeType !== '__all__' && nodeType !== filterNodeType) return false;
      if (filterCapacityType !== '__all__') {
        const cap = deriveCapacityType(record, nodeType);
        if (cap !== filterCapacityType) return false;
      }
      if (filterGpuAvail !== '__all__') {
        if (deriveGpuBucket(record) !== filterGpuAvail) return false;
      }
      return true;
    });
  }, [clusterNodes, filterNodeType, filterCapacityType, filterGpuAvail]);

  const isFiltered = filterNodeType !== '__all__' || filterCapacityType !== '__all__' || filterGpuAvail !== '__all__';

  // 表格列定义 - 与原版相同
  const columns = [
    {
      title: 'Node Name',
      dataIndex: 'nodeName',
      key: 'nodeName',
      width: '22%',
      render: (text, record) => (
        <div>
          <Space>
            <ClusterOutlined />
            <span style={{ fontFamily: 'monospace' }}>{text}</span>
            {!record.nodeReady && (
              <Tooltip title="Node not ready">
                <WarningOutlined style={{ color: '#faad14' }} />
              </Tooltip>
            )}
          </Space>
        </div>
      ),
    },
    {
      title: 'Instance Type',
      dataIndex: 'instanceType',
      key: 'instanceType',
      width: '13%',
      render: (text) => (
        <span style={{ fontFamily: 'monospace', fontSize: '13px' }}>
          {text && text !== 'Unknown' ? text : '-'}
        </span>
      ),
    },
    {
      title: 'Capacity Type',
      key: 'capacityType',
      width: '12%',
      render: (_, record) => {
        const labels = record.labels || {};
        
        // 判断是否为 Karpenter 管理的节点（任一标签不为 null）
        const isKarpenter = labels['karpenter.sh/nodepool'] != null || labels['karpenter.sh/nodeclaim'] != null;

        // HyperPod Karpenter节点 (优先判断)
        if (labels['sagemaker.amazonaws.com/compute-type'] === 'hyperpod' && isKarpenter) {
          const capacityType = record.capacityType; // 从后端获取的 capacity type
          const typeLabel = capacityType === 'spot' ? 'Spot' : capacityType === 'training-plan' ? 'FTP' : 'On-Demand';
          return (
            <div>
              <Tag color="#fa8c16">HyperPod Karpenter</Tag>
              <div style={{ fontSize: '11px', color: '#666', marginTop: 2 }}>
                {typeLabel}
              </div>
            </div>
          );
        }

        // HyperPod节点
        if (labels['sagemaker.amazonaws.com/compute-type'] === 'hyperpod') {
          const capacityType = record.capacityType; // 从后端获取的 capacity type
          const typeLabel = capacityType === 'spot' ? 'Spot' : capacityType === 'training-plan' ? 'FTP' : 'On-Demand';
          return (
            <div>
              <Tag color="#722ed1">HyperPod</Tag>
              {capacityType && (
                <div style={{ fontSize: '11px', color: '#666', marginTop: 2 }}>
                  {typeLabel}
                </div>
              )}
            </div>
          );
        }


        // EKS NodeGroup节点
        if (labels['eks.amazonaws.com/nodegroup']) {
          const capacityType = labels['eks.amazonaws.com/capacityType'] || 'ON_DEMAND';
          return (
            <div>
              <Tag color="#1890ff">EKS NodeGroup</Tag>
              <div style={{ fontSize: '11px', color: '#666', marginTop: 2 }}>
                {capacityType === 'SPOT' ? 'Spot' : 'On-Demand'}
              </div>
            </div>
          );
        }

        // 未知类型
        return <Tag color="#8c8c8c">Unknown</Tag>;
      },
    },
    {
      title: 'Group/Pool',
      key: 'groupPool',
      width: '13%',
      render: (_, record) => {
        const labels = record.labels || {};

        // HyperPod节点
        if (labels['sagemaker.amazonaws.com/compute-type'] === 'hyperpod') {
          const instanceGroup = labels['sagemaker.amazonaws.com/instance-group-name'] || 'unknown';
          return <span style={{ fontSize: '12px' }}>Group: {instanceGroup}</span>;
        }


        // EKS NodeGroup节点
        if (labels['eks.amazonaws.com/nodegroup']) {
          const nodegroup = labels['eks.amazonaws.com/nodegroup'];
          return <span style={{ fontSize: '12px' }}>Group: {nodegroup}</span>;
        }

        return <span style={{ color: '#8c8c8c' }}>-</span>;
      },
    },
    {
      title: 'GPU Usage',
      key: 'gpuUsage',
      width: '20%',
      render: (_, record) => {
        const { totalGPU = 0, usedGPU = 0, availableGPU = 0, allocatableGPU = 0, pendingGPU = 0 } = record;
        const percentage = totalGPU > 0 ? (usedGPU / totalGPU) * 100 : 0;

        return (
          <div>
            <Progress
              percent={Math.round(percentage)}
              size="small"
              status={percentage > 80 ? 'exception' : percentage > 60 ? 'active' : 'success'}
              format={() => `${usedGPU}/${totalGPU}`}
            />
            <div style={{ fontSize: '12px', color: '#666', marginTop: 4 }}>
              <Space size="small">
                <span>Available: {availableGPU}</span>
                {allocatableGPU !== totalGPU && (
                  <Tooltip title={`Total capacity: ${totalGPU}, Allocatable: ${allocatableGPU}`}>
                    <span style={{ color: '#1890ff' }}>
                      (Alloc: {allocatableGPU})
                    </span>
                  </Tooltip>
                )}
                {pendingGPU > 0 && (
                  <Tooltip title={`GPU requests from Pending pods (not counted in usage)`}>
                    <span style={{ color: '#faad14' }}>
                      Pending: {pendingGPU}
                    </span>
                  </Tooltip>
                )}
              </Space>
            </div>
          </div>
        );
      },
    },
    {
      title: 'Status',
      key: 'status',
      width: '10%',
      render: (_, record) => {
        const { totalGPU = 0, availableGPU = 0, error, nodeReady } = record;

        if (error) {
          return (
            <Tooltip title={error}>
              <Tag color="red" icon={<ExclamationCircleOutlined />}>
                Error
              </Tag>
            </Tooltip>
          );
        }

        if (!nodeReady) {
          return (
            <Tag color="orange" icon={<WarningOutlined />}>
              Not Ready
            </Tag>
          );
        }

        if (availableGPU === 0 && totalGPU > 0) {
          return (
            <Tag color="orange" icon={<ExclamationCircleOutlined />}>
              Full
            </Tag>
          );
        }

        return (
          <Tag color="green" icon={<CheckCircleOutlined />}>
            Available
          </Tag>
        );
      },
    },
    {
      title: 'HAMi',
      key: 'hami',
      align: 'center',
      width: '6%',
      render: (_, record) => {
        const labels = record.labels || {};
        const totalGPU = record.totalGPU || 0;
        
        // 只对 GPU 节点显示（排除 CPU 节点和 Karpenter 控制节点）
        const isGPUNode = totalGPU > 0 && 
                          !record.nodeName.includes('karpenter-controller');
        
        if (!isGPUNode) return <span style={{ color: '#d9d9d9' }}>-</span>;
        
        return (
          <Tooltip title="Configure GPU Partition">
            <Button 
              type="text"
              size="small" 
              icon={<PartitionOutlined />}
              onClick={() => handlePartitionClick(record)}
            />
          </Tooltip>
        );
      },
    },
    {
      title: 'Action',
      key: 'action',
      align: 'center',
      width: '8%',
      render: (_, record) => {
        const labels = record.labels || {};
        const isHyperPod = labels['sagemaker.amazonaws.com/compute-type'] === 'hyperpod';
        
        // 只对 HyperPod 节点显示
        if (!isHyperPod) return <span style={{ color: '#d9d9d9' }}>-</span>;
        
        return (
          <Tooltip title="Node Operations">
            <Button 
              type="text"
              size="small" 
              icon={<RollbackOutlined />}
              onClick={() => handleNodeActionClick(record)}
            />
          </Tooltip>
        );
      },
    },
  ];

  return (
    <Spin spinning={loading} tip="Refreshing cluster status...">
      <div>
        {/* 简单错误提示 - 可选显示 */}
        {error && (
          <Alert
            message="Unable to fetch cluster status"
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            closable
          />
        )}

        {/* 总体统计 */}
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="Nodes"
                value={clusterStats.readyNodes}
                suffix={`/ ${clusterStats.totalNodes}`}
                prefix={<ClusterOutlined />}
                valueStyle={{
                  color: clusterStats.readyNodes === clusterStats.totalNodes ? '#52c41a' : '#faad14'
                }}
              />
              {clusterStats.errorNodes > 0 && (
                <div style={{ fontSize: '12px', color: '#cf1322', marginTop: 4 }}>
                  {clusterStats.errorNodes} error(s)
                </div>
              )}
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="Total GPUs"
                value={clusterStats.totalGPUs}
                valueStyle={{ color: '#1890ff' }}
              />
              {clusterStats.allocatableGPUs !== clusterStats.totalGPUs && (
                <div style={{ fontSize: '12px', color: '#666', marginTop: 4 }}>
                  Allocatable: {clusterStats.allocatableGPUs}
                </div>
              )}
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="Requested GPUs"
                value={clusterStats.usedGPUs + clusterStats.pendingGPUs}
                valueStyle={{
                  color: (clusterStats.usedGPUs + clusterStats.pendingGPUs) > clusterStats.totalGPUs
                    ? '#cf1322' : '#666'
                }}
              />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="Used GPUs"
                value={clusterStats.usedGPUs}
                valueStyle={{ color: '#cf1322' }}
              />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="Available GPUs"
                value={clusterStats.availableGPUs}
                valueStyle={{ color: '#52c41a' }}
              />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="Pending GPUs"
                value={clusterStats.pendingGPUs}
                valueStyle={{ color: '#faad14' }}
              />
            </Card>
          </Col>
        </Row>

        {/* 过滤器 + 刷新按钮 */}
        <div style={{
          marginBottom: 16,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8
        }}>
          <Space size={8} wrap>
            <Select
              size="small"
              value={filterNodeType}
              onChange={setFilterNodeType}
              style={{ minWidth: 180 }}
              options={[
                { value: '__all__', label: 'All node types' },
                { value: 'hyperpod', label: 'HyperPod' },
                { value: 'hyperpod-karpenter', label: 'HyperPod Karpenter' },
                { value: 'eks-nodegroup', label: 'EKS NodeGroup' },
                { value: 'unknown', label: 'Unknown' },
              ]}
            />
            <Select
              size="small"
              value={filterCapacityType}
              onChange={setFilterCapacityType}
              style={{ minWidth: 160 }}
              options={[
                { value: '__all__', label: 'All capacity types' },
                { value: 'on-demand', label: 'On-Demand' },
                { value: 'spot', label: 'Spot' },
                { value: 'ftp', label: 'FTP (training-plan)' },
              ]}
            />
            <Select
              size="small"
              value={filterGpuAvail}
              onChange={setFilterGpuAvail}
              style={{ minWidth: 180 }}
              options={[
                { value: '__all__', label: 'All GPU availability' },
                { value: 'has-available', label: 'Has available GPU' },
                { value: 'no-available', label: 'No available GPU' },
                { value: 'cpu-only', label: 'CPU-only nodes' },
              ]}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {isFiltered && filteredNodes.length !== clusterNodes.length ? (
                <>
                  <Tag color="blue" style={{ marginInlineEnd: 4 }}>{filteredNodes.length}</Tag>
                  of {clusterNodes.length}
                </>
              ) : (
                <>Total {clusterNodes.length}</>
              )}
            </Text>
          </Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={handleRefresh}
            loading={loading}
            size="small"
          >
            Refresh
          </Button>
        </div>

        {/* 节点详情表格 */}
        <Table
          columns={columns}
          dataSource={filteredNodes}
          rowKey="nodeName"
          size="small"
          sticky
          pagination={false}
          locale={{
            emptyText: loading
              ? 'Refreshing cluster data...'
              : (isFiltered ? 'No nodes match the current filter' : 'No cluster data available')
          }}
          rowClassName={(record) => {
            if (record.error) return 'cluster-row-error';
            if (!record.nodeReady) return 'cluster-row-warning';
            return '';
          }}
        />

        {/* HAMi Node Control Modal */}
        <Modal
          title="HAMi GPU Node Control"
          open={partitionModalVisible}
          centered
          onCancel={() => {
            setPartitionModalVisible(false);
            setSelectedNode(null);
          }}
          footer={
            (() => {
              const isEnabled = selectedNode?.labels?.gpu === 'on';
              return [
                <Button 
                  key="cancel" 
                  onClick={() => {
                    setPartitionModalVisible(false);
                    setSelectedNode(null);
                  }}
                >
                  Cancel
                </Button>,
                isEnabled ? (
                  <Button 
                    key="disable" 
                    danger
                    onClick={handleDisableNode}
                    loading={resetLoading}
                  >
                    Disable HAMi
                  </Button>
                ) : (
                  <Button 
                    key="enable" 
                    type="primary" 
                    onClick={handleEnableNode}
                    loading={applyLoading}
                  >
                    Enable HAMi
                  </Button>
                )
              ];
            })()
          }
          width={500}
        >
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8 }}>
              <Text strong>Node Name:</Text>
            </div>
            <Text code style={{ fontSize: '13px' }}>
              {selectedNode?.nodeName || '-'}
            </Text>
          </div>

          {/* 当前状态显示 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8 }}>
              <Text strong>Current Status:</Text>
            </div>
            {selectedNode?.labels?.gpu === 'on' ? (
              <Tag color="success" icon={<CheckCircleOutlined />}>
                HAMi Enabled (gpu=on)
              </Tag>
            ) : (
              <Tag color="default" icon={<CloseCircleOutlined />}>
                HAMi Disabled
              </Tag>
            )}
          </div>

          <Alert
            message="Node Control"
            description={
              <div>
                <p><strong>Enable:</strong> Add label <code>gpu=on</code> to enable HAMi GPU virtualization on this node.</p>
                <p><strong>Disable:</strong> Remove label and clean up device plugin pods.</p>
                <p style={{ marginTop: 8, marginBottom: 0 }}>
                  <Text type="secondary">Note: HAMi must be installed globally first (via Advanced Features).</Text>
                </p>
              </div>
            }
            type="info"
            showIcon
          />
        </Modal>

        {/* Node Action Modal */}
        <Modal
          title="HyperPod Node Operations"
          open={nodeActionModalVisible}
          centered
          onCancel={() => {
            setNodeActionModalVisible(false);
            setSelectedNode(null);
          }}
          footer={[
            <Button 
              key="cancel" 
              onClick={() => {
                setNodeActionModalVisible(false);
                setSelectedNode(null);
              }}
            >
              Cancel
            </Button>,
            <Button 
              key="reboot" 
              type="primary"
              onClick={handleNodeReboot}
              loading={nodeActionLoading}
            >
              Reboot
            </Button>,
            <Button 
              key="replace" 
              onClick={handleNodeReplace}
              loading={nodeActionLoading}
            >
              Replace
            </Button>,
            <Button 
              key="delete" 
              danger
              onClick={handleNodeDelete}
              loading={nodeActionLoading}
            >
              Delete
            </Button>
          ]}
          width={600}
        >
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8 }}>
              <Text strong>Node Name (Instance ID):</Text>
            </div>
            <Text code style={{ fontSize: '13px' }}>
              {selectedNode?.nodeName || '-'}
            </Text>
          </div>

          <Alert
            message="Node Operations"
            description={
              <div>
                <p><strong>Reboot:</strong> Soft restart the node. The node will be temporarily unavailable during reboot.</p>
                <p><strong>Replace:</strong> Terminate and replace with a new instance. Requires spare capacity in the instance group.</p>
                <p><strong>Delete:</strong> Permanently remove the node from the cluster. The node will NOT be replaced automatically.</p>
                <p style={{ marginTop: 8, marginBottom: 0 }}>
                  <Text type="danger">⚠️ Warning: All operations will affect running workloads. Delete is irreversible - backup data to S3/FSx first!</Text>
                </p>
              </div>
            }
            type="warning"
            showIcon
          />
        </Modal>

        <style jsx>{`
          .cluster-row-error {
            background-color: #fff2f0;
          }
          .cluster-row-warning {
            background-color: #fffbe6;
          }
        `}</style>
      </div>
    </Spin>
  );
};

export default ClusterStatusV2Redux;