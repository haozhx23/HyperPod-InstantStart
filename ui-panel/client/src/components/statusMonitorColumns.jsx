/**
 * Table column builders extracted from StatusMonitorRedux.js.
 *
 * Each builder receives the component-scoped callbacks/state it closes over and
 * returns the antd column array verbatim — behavior is identical to the inline
 * definitions, only the free variables are now explicit parameters. This keeps
 * the giant component focused on state/effects while the (large, static) column
 * markup lives here.
 *
 * buildDeploymentColumns carries one inference-operator release-sentinel block (a
 * single deployment-type icon/color case). That feature is public:true in both the
 * standard and .ec2 manifests, so its markers are clean-only (code always ships);
 * the sentinel lines ride along verbatim so the release tooling's bookkeeping is
 * preserved.
 *
 * Covered by StatusMonitorRedux.test.js, which seeds pod/service/rayjob/trainingjob/
 * deployment rows so these render functions actually execute under test.
 */
import React from 'react';
import { Space, Typography, Select, Tag, Badge, Tooltip, Button, Popconfirm } from 'antd';
import {
  ContainerOutlined, FileTextOutlined, InfoCircleOutlined, ApiOutlined, DeleteOutlined,
  LoadingOutlined, CheckCircleOutlined, ExclamationCircleOutlined, ClockCircleOutlined,
  ExperimentOutlined, SyncOutlined, CloseCircleOutlined,
  GlobalOutlined, LockOutlined, ThunderboltOutlined, CodeOutlined
} from '@ant-design/icons';
import { getPodStatus, getPodStatusColor, getPodStatusIcon } from './podStatusHelpers';

const { Text } = Typography;
const { Option } = Select;

/**
 * Reusable, compact "Namespace" column shared by every Monitoring table.
 *
 * Two data shapes flow through these tables:
 *   - raw k8s objects   → namespace lives at metadata.namespace  (pass raw=true)
 *   - server-processed  → namespace is a top-level `namespace`    (pass raw=false)
 *
 * Rendered as a small blue Tag matching the other tag-style columns in these tables, and
 * given a fixed width so it plays well with the table-layout:fixed mode enabled by
 * each table's scroll.x.
 */
export const buildNamespaceColumn = (raw = false) => ({
  title: 'Namespace',
  dataIndex: raw ? ['metadata', 'namespace'] : 'namespace',
  key: 'namespace',
  width: 130,
  render: (ns) => <Tag color="blue">{ns || 'default'}</Tag>,
});

export const buildPodColumns = ({
  isPoolPod,
  assigningPods,
  handlePodAssign,
  businessServices,
  setLogModalPod,
  setDescribeModalPod,
}) => [
  {
    title: 'Pod Name',
    dataIndex: ['metadata', 'name'],
    key: 'name',
    render: (text) => (
      <Space>
        <ContainerOutlined />
        <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{text}</span>
      </Space>
    ),
    width: 300, // 设置固定宽度替代ellipsis
  },
  buildNamespaceColumn(true),
  {
    title: 'Status',
    key: 'status',
    width: 120,
    render: (_, pod) => {
      const status = getPodStatus(pod);
      return (
        <Tag
          color={getPodStatusColor(status)}
          icon={getPodStatusIcon(status)}
        >
          {status}
        </Tag>
      );
    },
  },
  {
    title: 'Business',
    key: 'business',
    width: 170,
    render: (_, pod) => {
      if (!isPoolPod(pod)) {
        return <Text type="secondary">N/A</Text>;
      }

      const currentBusiness = pod.metadata.labels?.business || 'unassigned';
      const podName = pod.metadata.name;
      const isAssigning = assigningPods.has(podName);

      return (
        <Select
          value={currentBusiness}
          onChange={(value) => handlePodAssign(podName, value)}
          style={{ width: 140 }}
          size="small"
          loading={isAssigning}
          disabled={isAssigning}
        >
          <Option value="unassigned">
            <Text type="secondary">Unassigned</Text>
          </Option>
          {businessServices.map(service => (
            <Option key={service.businessTag} value={service.businessTag}>
              <Text>{service.displayName}</Text>
            </Option>
          ))}
        </Select>
      );
    },
  },
  {
    title: 'Ready',
    key: 'ready',
    width: 80,
    render: (_, pod) => {
      const containerStatuses = pod.status?.containerStatuses || [];
      const readyCount = containerStatuses.filter(c => c.ready).length;
      const totalCount = containerStatuses.length;

      return (
        <Badge
          count={`${readyCount}/${totalCount}`}
          style={{
            backgroundColor: readyCount === totalCount ? '#52c41a' : '#faad14'
          }}
        />
      );
    },
  },
  {
    title: 'Restarts',
    key: 'restarts',
    width: 80,
    render: (_, pod) => {
      const containerStatuses = pod.status?.containerStatuses || [];
      const totalRestarts = containerStatuses.reduce((sum, c) => sum + (c.restartCount || 0), 0);

      return (
        <Badge
          count={totalRestarts}
          showZero={true}
          style={{
            backgroundColor: totalRestarts === 0 ? '#52c41a' : '#ff4d4f'
          }}
        />
      );
    },
  },
  {
    title: 'Age',
    key: 'age',
    width: 80,
    render: (_, pod) => {
      const creationTime = new Date(pod.metadata.creationTimestamp);
      const now = new Date();
      const ageMs = now - creationTime;
      const ageMinutes = Math.floor(ageMs / 60000);

      if (ageMinutes < 60) {
        return `${ageMinutes}m`;
      } else if (ageMinutes < 1440) {
        return `${Math.floor(ageMinutes / 60)}h`;
      } else {
        return `${Math.floor(ageMinutes / 1440)}d`;
      }
    },
  },
  {
    title: 'Actions',
    key: 'actions',
    width: 220,
    render: (_, pod) => {
      const podName = pod.metadata?.name;
      const namespace = pod.metadata?.namespace;
      const phase = pod.status?.phase;
      return (
        <Space size={0}>
          <Tooltip title="View pod logs">
            <Button
              size="small"
              type="link"
              icon={<FileTextOutlined />}
              disabled={!phase || phase === 'Pending'}
              onClick={() => setLogModalPod({ name: podName, namespace })}
            >
              Logs
            </Button>
          </Tooltip>
          <Tooltip title="Run kubectl describe (useful for Pending/Failed pods)">
            <Button
              size="small"
              type="link"
              icon={<InfoCircleOutlined />}
              onClick={() => setDescribeModalPod({ name: podName, namespace })}
            >
              Describe
            </Button>
          </Tooltip>
        </Space>
      );
    },
  },
];

export const buildServiceColumns = ({
  getServicePodCount,
  handleServiceDelete,
  deletingServices,
}) => [
  {
    title: 'Service Name',
    dataIndex: ['metadata', 'name'],
    key: 'name',
    render: (text) => (
      <Space>
        <ApiOutlined />
        <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{text}</span>
      </Space>
    ),
    width: 300, // 设置固定宽度替代ellipsis
  },
  buildNamespaceColumn(true),
  {
    title: 'Type',
    dataIndex: ['spec', 'type'],
    key: 'type',
    width: 130,
    render: (type) => (
      <Tag color={type === 'LoadBalancer' ? 'blue' : 'default'}>
        {type}
      </Tag>
    ),
  },
  {
    title: 'Pods',
    key: 'pods',
    width: 80,
    render: (_, service) => {
      const podCount = getServicePodCount(service);
      return (
        <Badge
          count={podCount}
          style={{
            backgroundColor: podCount > 0 ? '#52c41a' : '#d9d9d9',
            color: podCount > 0 ? 'white' : '#666'
          }}
        />
      );
    },
  },
  {
    title: 'Cluster IP',
    dataIndex: ['spec', 'clusterIP'],
    key: 'clusterIP',
    width: 140,
    render: (ip) => <Text code>{ip}</Text>,
  },
  {
    title: 'External IP',
    key: 'externalIP',
    width: 160,
    render: (_, service) => {
      const ingress = service.status?.loadBalancer?.ingress;
      if (ingress && ingress.length > 0) {
        const externalIP = ingress[0].hostname || ingress[0].ip;
        return <Text code>{externalIP}</Text>;
      }

      if (service.spec.type === 'LoadBalancer') {
        return <Text type="secondary">Pending...</Text>;
      }

      return <Text type="secondary">-</Text>;
    },
  },
  {
    title: 'Ports',
    key: 'ports',
    width: 180,
    render: (_, service) => {
      const ports = service.spec?.ports || [];
      return (
        <Space wrap>
          {ports.map((port, index) => (
            <Tag key={index} color="geekblue">
              {port.port}:{port.targetPort}
            </Tag>
          ))}
        </Space>
      );
    },
  },
  {
    title: 'Actions',
    key: 'actions',
    width: 80,
    render: (_, service) => {
      // 系统Service不显示删除按钮
      const isSystemService = service.metadata.name === 'kubernetes' ||
        service.metadata.namespace === 'kube-system' ||
        service.metadata.labels?.['kubernetes.io/managed-by'];

      if (isSystemService) {
        return <Text type="secondary">System Service</Text>;
      }

      return (
        <Popconfirm
          title="Delete Service"
          description={`Are you sure you want to delete service ${service.metadata.name}?`}
          onConfirm={() => handleServiceDelete(service.metadata.name)}
          okText="Yes"
          cancelText="No"
          placement="left"
        >
          <Button
            type="primary"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deletingServices.has(service.metadata.name)}
          >
            Delete
          </Button>
        </Popconfirm>
      );
    }
  },
];

/**
 * Columns for the "Inference Endpoints (ALB)" table.
 *
 * Rows are the lightweight ingress objects assembled server-side in
 * appStatusV2.getIngresses() — top-level { name, namespace, scheme, host, url, ... },
 * NOT raw k8s objects. The Access URL is copyable so users can paste straight into curl.
 */
export const buildIngressColumns = () => [
  {
    title: 'Name',
    dataIndex: 'name',
    key: 'name',
    width: 280,
    render: (text) => (
      <Space>
        <ThunderboltOutlined />
        <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{text}</span>
      </Space>
    ),
  },
  {
    title: 'Namespace',
    dataIndex: 'namespace',
    key: 'namespace',
    width: 160,
    render: (ns) => <Tag color="blue">{ns}</Tag>,
  },
  {
    title: 'Scheme',
    dataIndex: 'scheme',
    key: 'scheme',
    width: 180,
    render: (scheme) =>
      scheme === 'internet-facing' ? (
        <Tag icon={<GlobalOutlined />} color="green">internet-facing</Tag>
      ) : (
        <Tooltip title="Internal ALB — accessible only from within the VPC">
          <Tag icon={<LockOutlined />} color="orange">internal (VPC only)</Tag>
        </Tooltip>
      ),
  },
  {
    title: 'Access URL (curl)',
    dataIndex: 'url',
    key: 'url',
    render: (url) =>
      url ? (
        <Text code copyable={{ text: url }} style={{ fontSize: '12px' }}>{url}</Text>
      ) : (
        <Text type="secondary">Pending...</Text>
      ),
  },
];

export const buildRayJobColumns = ({
  handleDeleteRayJob,
  deletingRayJob,
}) => [
  {
    title: 'Job Name',
    dataIndex: ['metadata', 'name'],
    key: 'name',
    width: 200,
    render: (name) => <Text strong>{name}</Text>
  },
  buildNamespaceColumn(true),
  {
    title: 'Job Status',
    dataIndex: ['status', 'jobStatus'],
    key: 'jobStatus',
    width: 140,
    render: (status) => {
      const statusConfig = {
        'RUNNING': { color: 'processing', icon: <LoadingOutlined /> },
        'SUCCEEDED': { color: 'success', icon: <CheckCircleOutlined /> },
        'FAILED': { color: 'error', icon: <ExclamationCircleOutlined /> },
        'PENDING': { color: 'warning', icon: <ClockCircleOutlined /> }
      };
      const config = statusConfig[status] || { color: 'default', icon: null };
      return <Tag color={config.color} icon={config.icon}>{status || 'Unknown'}</Tag>;
    }
  },
  {
    title: 'Ray Cluster',
    dataIndex: ['status', 'rayClusterName'],
    key: 'rayClusterName',
    width: 160,
    render: (name) => <Text code>{name}</Text>
  },
  {
    title: 'Start Time',
    dataIndex: ['status', 'startTime'],
    key: 'startTime',
    width: 180,
    render: (time) => time ? new Date(time).toLocaleString() : 'N/A'
  },
  {
    title: 'Age',
    dataIndex: ['metadata', 'creationTimestamp'],
    key: 'age',
    width: 90,
    render: (timestamp) => {
      if (!timestamp) return 'N/A';
      const age = Date.now() - new Date(timestamp).getTime();
      const minutes = Math.floor(age / 60000);
      const hours = Math.floor(minutes / 60);
      if (hours > 0) return `${hours}h ${minutes % 60}m`;
      return `${minutes}m`;
    }
  },
  {
    title: 'Actions',
    key: 'actions',
    width: 100,
    render: (_, record) => (
      <Popconfirm
        title="Delete RayJob"
        description={`Are you sure you want to delete "${record.metadata.name}"?`}
        onConfirm={() => handleDeleteRayJob(record.metadata.name)}
        okText="Yes"
        cancelText="No"
      >
        <Button
          type="primary"
          danger
          size="small"
          icon={<DeleteOutlined />}
          loading={deletingRayJob}
        >
          Delete
        </Button>
      </Popconfirm>
    )
  }
];

export const buildTrainingJobColumns = ({
  handleTrainingJobDelete,
  deletingTrainingJobs,
}) => [
  {
    title: 'Job Name',
    dataIndex: 'name',
    key: 'name',
    width: 220,
    render: (name) => (
      <Space>
        <ExperimentOutlined style={{ color: '#1890ff' }} />
        <Text strong>{name}</Text>
      </Space>
    ),
  },
  buildNamespaceColumn(false),
  {
    title: 'Status',
    dataIndex: 'status',
    key: 'status',
    width: 140,
    render: (statusObj) => {
      // 完全匹配原始HyperPodJobManager的状态处理逻辑
      let status = 'Unknown';

      if (typeof statusObj === 'string') {
        status = statusObj;
      } else if (statusObj && typeof statusObj === 'object') {
        // 从状态对象中提取状态信息
        if (statusObj.conditions && Array.isArray(statusObj.conditions)) {
          const lastCondition = statusObj.conditions[statusObj.conditions.length - 1];
          if (lastCondition && lastCondition.type) {
            status = lastCondition.type;
          }
        } else if (statusObj.phase) {
          status = statusObj.phase;
        } else if (statusObj.state) {
          status = statusObj.state;
        }
      }

      // 完全匹配原始HyperPodJobManager的状态配置
      const statusConfig = {
        'Running': { color: 'processing', icon: <SyncOutlined /> },
        'Succeeded': { color: 'success', icon: <CheckCircleOutlined /> },
        'Failed': { color: 'error', icon: <CloseCircleOutlined /> },
        'Pending': { color: 'warning', icon: <ClockCircleOutlined /> },
        'Unknown': { color: 'default', icon: <ClockCircleOutlined /> },
        'Created': { color: 'default', icon: <ClockCircleOutlined /> },
        'Completed': { color: 'success', icon: <CheckCircleOutlined /> }
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
    title: 'Duration',
    key: 'duration',
    width: 110,
    render: (_, record) => {
      if (!record.creationTimestamp) return '-';

      const startTime = new Date(record.creationTimestamp);
      const now = new Date();
      const diffMs = now - startTime;

      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

      if (hours > 0) {
        return <Text type="secondary">{hours}h {minutes}m</Text>;
      } else if (minutes > 0) {
        return <Text type="secondary">{minutes}m</Text>;
      } else {
        return <Text type="secondary">{'< 1m'}</Text>;
      }
    },
  },
  {
    title: 'Actions',
    key: 'actions',
    width: 100,
    render: (_, record) => (
      <Popconfirm
        title="Delete Training Job"
        description={`Are you sure you want to delete "${record.name}"?`}
        onConfirm={() => handleTrainingJobDelete(record.name)}
        okText="Yes"
        cancelText="No"
      >
        <Button
          type="primary"
          danger
          size="small"
          icon={<DeleteOutlined />}
          loading={deletingTrainingJobs.has(record.name)}
        >
          Delete
        </Button>
      </Popconfirm>
    ),
  },
];

export const buildDeploymentColumns = ({
  scalingDeployments,
  showScaleModal,
  handleDeploymentDelete,
  deletingDeployments,
}) => [
    {
      title: 'Deployment Name',
      dataIndex: 'deploymentName',
      key: 'deploymentName',
      width: 250,
      render: (text) => (
        <strong style={{ fontFamily: 'monospace', fontSize: '12px' }}>
          {text}
        </strong>
      ),
    },
    buildNamespaceColumn(false),
    {
      title: 'Type',
      dataIndex: 'deploymentType',
      key: 'deploymentType',
      width: 120,
      render: (type) => {
        // 继承原部署管理的图标和颜色
        const getTypeIcon = (type) => {
          switch (type) {
            case 'VLLM':
              return <CodeOutlined />;
            case 'SGLang':
              return <ThunderboltOutlined />;
            case 'Router':
              return <ApiOutlined />;
            case 'InferenceOperator':
              return <ContainerOutlined />;
            default:
              return <InfoCircleOutlined />;
          }
        };

        const getTypeColor = (type) => {
          switch (type) {
            case 'VLLM': return 'blue';
            case 'SGLang': return 'green';
            case 'Router': return 'purple';
            case 'InferenceOperator': return 'cyan';
            default: return 'default';
          }
        };

        return (
          <Tag color={getTypeColor(type)} icon={getTypeIcon(type)}>
            {type}
          </Tag>
        );
      }
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 160,
      render: (status, record) => {
        const getStatusColor = (status) => {
          switch (status) {
            case 'Ready': return 'success';
            case 'Pending': return 'processing';
            default: return 'error';
          }
        };

        return (
          <Tag color={getStatusColor(status)}>
            {status} ({record.readyReplicas}/{record.replicas})
          </Tag>
        );
      }
    },
    {
      title: 'Service',
      key: 'service',
      width: 150,
      render: (_, record) => (
        <div>
          <div style={{ fontFamily: 'monospace', fontSize: '12px' }}>
            {record.serviceName}
          </div>
          {record.hasService && (
            <Tag color="blue" size="small">
              {record.serviceType}
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: 'Container Port',
      key: 'containerPorts',
      width: 120,
      render: (_, record) => (
        <div>
          {record.containerPorts && record.containerPorts.length > 0 ? (
            record.containerPorts.map((port, index) => (
              <Tag key={index} color="cyan" size="small" style={{ margin: '1px' }}>
                {port.containerPort}
                {port.protocol && port.protocol !== 'TCP' && `/${port.protocol}`}
              </Tag>
            ))
          ) : (
            <Tag size="small" color="default">N/A</Tag>
          )}
        </div>
      ),
    },
    {
      title: 'Access & URL',
      dataIndex: 'externalIP',
      key: 'externalIP',
      width: 160,
      render: (ip, record) => {
        // 访问类型标签的图标和颜色函数
        const getAccessIcon = (isExternal) => {
          return isExternal ? <GlobalOutlined /> : <LockOutlined />;
        };

        const getAccessColor = (isExternal) => {
          return isExternal ? 'orange' : 'purple';
        };

        // 内部访问或无服务的情况
        if (!record.isExternal) {
          return (
            <Tag
              color={getAccessColor(false)}
              icon={getAccessIcon(false)}
            >
              Internal Only
            </Tag>
          );
        }

        // 外部访问但状态为 Pending
        if (ip === 'Pending') {
          return (
            <Space direction="vertical" size="small">
              <Tag
                color={getAccessColor(true)}
                icon={getAccessIcon(true)}
              >
                External
              </Tag>
              <Tag color="orange">Pending</Tag>
            </Space>
          );
        }

        // 外部访问但无服务
        if (ip === 'N/A' || !record.hasService) {
          return (
            <Space direction="vertical" size="small">
              <Tag
                color={getAccessColor(true)}
                icon={getAccessIcon(true)}
              >
                External
              </Tag>
              <Tag color="default">No Service</Tag>
            </Space>
          );
        }

        // 外部访问且有有效的 URL
        const port = record.port || '8000';
        const fullUrl = `http://${ip}:${port}`;

        return (
          <div style={{ width: '180px' }}>
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Tag
                color={getAccessColor(true)}
                icon={getAccessIcon(true)}
                size="small"
              >
                External
              </Tag>
              <Tooltip title={fullUrl}>
                <Text
                  copyable={{ text: fullUrl }}
                  style={{
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    wordBreak: 'break-all',
                    width: '100%'
                  }}
                >
                  {ip.length > 12 ? `${ip.substring(0, 12)}...` : ip}:{port}
                </Text>
              </Tooltip>
            </Space>
          </div>
        );
      },
    },
    {
      title: 'ScaledObject',
      dataIndex: 'scaledObject',
      key: 'scaledObject',
      width: 180,
      render: (scaledObject) => {
        if (!scaledObject) {
          return <Text type="secondary">-</Text>;
        }
        return (
          <Tooltip title={`Min: ${scaledObject.minReplicas}, Max: ${scaledObject.maxReplicas}`}>
            <Text style={{ fontFamily: 'monospace', fontSize: '12px' }}>
              {scaledObject.name}
            </Text>
          </Tooltip>
        );
      },
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 120,
      render: (timestamp) => {
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        let ageText;
        if (diffDays > 0) {
          ageText = `${diffDays}d ago`;
        } else if (diffHours > 0) {
          ageText = `${diffHours}h ago`;
        } else {
          ageText = `${diffMins}m ago`;
        }

        return (
          <Tooltip title={date.toLocaleString()}>
            <span style={{ fontSize: '12px', color: '#666' }}>
              {ageText}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      render: (_, record) => (
        <Space direction="vertical" size="small" style={{ display: 'flex' }}>
          <Button
            type="default"
            size="small"
            icon={<ThunderboltOutlined />}
            loading={scalingDeployments.has(record.deploymentName)}
            onClick={() => showScaleModal(record)}
            style={{ width: '90px' }}
          >
            Scale
          </Button>
          <Popconfirm
            title="Delete Deployment"
            description={`Are you sure you want to delete "${record.deploymentName}"?`}
            onConfirm={() => handleDeploymentDelete(record.deploymentName, record.deploymentType, record.isRouter)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
          >
            <Button
              type="primary"
              danger
              size="small"
              icon={<DeleteOutlined />}
              loading={deletingDeployments.has(record.deploymentName)}
              style={{ width: '90px' }}
            >
              Delete
            </Button>
          </Popconfirm>
        </Space>
      )
    }
];
