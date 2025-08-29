import React, { useState, useEffect } from 'react';
import { 
  Table, 
  Button, 
  Space, 
  Tag, 
  Popconfirm,
  message,
  Card,
  Tooltip,
  Modal,
  Descriptions,
  Typography,
  Collapse,
  Empty,
  Spin,
  Form,
  Input
} from 'antd';
import operationRefreshManager from '../hooks/useOperationRefresh';
import { 
  ReloadOutlined,
  InfoCircleOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  ExperimentOutlined,
  BarChartOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  DownloadOutlined
} from '@ant-design/icons';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

const { Text, Title } = Typography;
const { Panel } = Collapse;

const TrainingHistoryPanel = () => {
  const [trainingHistory, setTrainingHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedRun, setSelectedRun] = useState(null);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [hasInitialLoad, setHasInitialLoad] = useState(false); // 添加初始加载标识
  const [configModalVisible, setConfigModalVisible] = useState(false);
  const [mlflowConfig, setMlflowConfig] = useState({});
  const [configForm] = Form.useForm();
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncForm] = Form.useForm();

  const fetchTrainingHistory = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/training-history');
      const result = await response.json();
      
      if (result.success) {
        setTrainingHistory(result.data || []);
      } else {
        message.error(`Failed to fetch training history: ${result.error}`);
        setTrainingHistory([]);
      }
    } catch (error) {
      console.error('Error fetching training history:', error);
      message.error('Failed to fetch training history');
      setTrainingHistory([]);
    } finally {
      setLoading(false);
      setHasInitialLoad(true); // 标记已经进行过初始加载
    }
  };

  // 使用自动刷新Hook，但不启用自动刷新和立即执行
  const { manualRefresh, config } = useAutoRefresh(
    'training-history',
    fetchTrainingHistory,
    { 
      enabled: false, // 禁用自动刷新
      immediate: false // 不通过hook立即执行
    }
  );

  // 组件挂载时立即加载数据和配置
  useEffect(() => {
    fetchMlflowConfig();
    fetchTrainingHistory();

    // 🚀 注册到操作刷新管理器
    const componentId = 'training-history';
    
    const refreshFunction = async () => {
      try {
        await fetchTrainingHistory();
      } catch (error) {
        console.error('Training history refresh error:', error);
        throw error;
      }
    };

    operationRefreshManager.subscribe(componentId, refreshFunction);

    return () => {
      operationRefreshManager.unsubscribe(componentId);
    };
  }, []); // 空依赖数组，只在组件挂载时执行一次

  // 获取MLflow配置
  const fetchMlflowConfig = async () => {
    try {
      const response = await fetch('/api/mlflow-metric-config');
      const result = await response.json();
      
      if (result.success) {
        setMlflowConfig(result.config);
        configForm.setFieldsValue(result.config);
      } else {
        // 如果获取失败，使用空配置
        const emptyConfig = {};
        setMlflowConfig(emptyConfig);
        configForm.setFieldsValue(emptyConfig);
      }
    } catch (error) {
      console.error('Error fetching MLflow config:', error);
      // 如果出错，使用空配置
      const emptyConfig = {};
      setMlflowConfig(emptyConfig);
      configForm.setFieldsValue(emptyConfig);
    }
  };

  // 保存MLflow配置
  const saveMlflowConfig = async (values) => {
    try {
      const response = await fetch('/api/mlflow-metric-config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });
      
      const result = await response.json();
      
      if (result.success) {
        setMlflowConfig(values);
        setConfigModalVisible(false);
        message.success('MLflow configuration saved successfully');
        // 重新获取训练历史数据
        fetchTrainingHistory();
      } else {
        message.error(`Failed to save configuration: ${result.error}`);
      }
    } catch (error) {
      console.error('Error saving MLflow config:', error);
      message.error('Failed to save MLflow configuration');
    }
  };

  // 显示配置Modal
  const showConfigModal = () => {
    // 设置MLflow URI配置表单
    configForm.setFieldsValue(mlflowConfig);
    
    // 设置跨账户同步表单
    if (mlflowConfig.sync_configs) {
      // 从sync_configs构建JSON字符串
      const syncConfigJson = JSON.stringify({
        contributor_name: mlflowConfig.sync_configs.contributor_name,
        source_mlflow_arn: mlflowConfig.sync_configs.source_mlflow_arn,
        shared_account_id: mlflowConfig.sync_configs.shared_account_id,
        shared_aws_region: mlflowConfig.sync_configs.shared_aws_region,
        cross_account_role_arn: mlflowConfig.sync_configs.cross_account_role_arn,
        shared_mlflow_arn: mlflowConfig.sync_configs.shared_mlflow_arn,
        setup_date: mlflowConfig.sync_configs.setup_date
      }, null, 2); // 格式化JSON，缩进2个空格
      
      syncForm.setFieldsValue({
        sync_config: syncConfigJson,
        experiment_name: mlflowConfig.experiment_name || mlflowConfig.experiment_id  // 兼容旧配置
      });
    }
    
    setConfigModalVisible(true);
  };

  // 同步到共享MLflow服务器
  const syncToSharedMLflow = async (values) => {
    console.log('Sync function called with values:', values);
    setSyncLoading(true);
    
    try {
      console.log('Sending sync request...');
      const response = await fetch('/api/mlflow-sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sync_config: values.sync_config,
          experiment_name: values.experiment_name
        }),
      });
      
      const result = await response.json();
      console.log('Sync response:', result);
      
      if (result.success) {
        message.success('Successfully synced to shared MLflow server');
        console.log('Sync successful:', result);
        syncForm.resetFields();
      } else {
        message.error(`Sync failed: ${result.error}`);
        console.error('Sync failed:', result);
      }
    } catch (error) {
      console.error('Error syncing to shared MLflow:', error);
      message.error('Failed to sync to shared MLflow server');
    } finally {
      setSyncLoading(false);
    }
  };

  // 测试MLflow连接
  const testMlflowConnection = async () => {
    const values = configForm.getFieldsValue();
    
    try {
      const response = await fetch('/api/mlflow-metric-config/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });
      
      const result = await response.json();
      
      if (result.success) {
        message.success(`Connection successful! Found ${result.experiments_count} experiments.`);
      } else {
        message.error(`Connection failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Error testing MLflow connection:', error);
      message.error('Failed to test MLflow connection');
    }
  };

  // CSV下载功能
  const downloadCSV = () => {
    if (!trainingHistory || trainingHistory.length === 0) {
      message.warning('No data to download');
      return;
    }

    // 构建CSV头部 - 与表格显示的列完全一致
    const headers = [
      'Experiment',
      'Run Name', 
      'Status'
    ];

    // 添加动态tag列的标题
    const tagColumns = generateTagColumns();
    tagColumns.forEach(col => {
      // 从key中提取tag名称，转换为可读格式
      const tagKey = col.key.replace('tag_', '');
      
      // 使用与getFormattedTitle相同的映射逻辑
      const titleMap = {
        'instance_type': 'Instance Type',
        'replica_count': 'Replica Count', 
        'proc_per_node': 'Proc Per Node',
        'batch_size': 'Batch Size',
        'cutoff_len': 'Cutoff Len',
        'deepspeed_conf': 'Zero Conf'
      };
      
      const title = titleMap[tagKey] || tagKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      headers.push(title);
    });

    // 添加其他固定列
    headers.push('Samples/s', 'Steps/s', 'Start Time', 'Duration');

    // 构建CSV数据行
    const csvData = trainingHistory.map(record => {
      const row = [
        record.experiment_name || '',
        record.run_name || '',
        record.status || ''
      ];

      // 添加tag列的数据
      tagColumns.forEach(col => {
        const tagKey = col.key.replace('tag_', '');
        const tagValue = record.tags?.[tagKey] || '';
        row.push(tagValue);
      });

      // 添加其他固定列的数据
      row.push(
        formatMetricValue(record.metrics?.train_samples_per_second) || '',
        formatMetricValue(record.metrics?.train_steps_per_second) || '',
        formatDateTime(record.start_time) || '',
        formatDuration(record.duration) || ''
      );

      return row;
    });

    // 转换为CSV格式
    const csvContent = [
      headers.join(','),
      ...csvData.map(row => 
        row.map(cell => {
          // 处理包含逗号、引号或换行符的单元格
          const cellStr = String(cell);
          if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
            return `"${cellStr.replace(/"/g, '""')}"`;
          }
          return cellStr;
        }).join(',')
      )
    ].join('\n');

    // 创建下载链接
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    
    // 生成文件名，包含时间戳
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    link.setAttribute('download', `hyperpod_instantstart_${timestamp}.csv`);
    
    // 触发下载
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    message.success(`Downloaded ${trainingHistory.length} training records to CSV`);
  };

  const showRunDetails = (record) => {
    setSelectedRun(record);
    setDetailModalVisible(true);
  };

  const getStatusTag = (status) => {
    const statusConfig = {
      'FINISHED': { color: 'success', icon: <CheckCircleOutlined /> },
      'RUNNING': { color: 'processing', icon: <ClockCircleOutlined /> },
      'FAILED': { color: 'error', icon: <CloseOutlined /> },
      'KILLED': { color: 'error', icon: <CloseOutlined /> },
      'SCHEDULED': { color: 'default', icon: <ClockCircleOutlined /> }
    };
    
    const config = statusConfig[status] || { color: 'default', icon: <InfoCircleOutlined /> };
    
    return (
      <Tag color={config.color} icon={config.icon}>
        {status}
      </Tag>
    );
  };

  const formatDuration = (duration) => {
    if (!duration) return 'N/A';
    
    // 解析duration字符串，例如 "0:45:30.123456"
    const parts = duration.split(':');
    if (parts.length >= 3) {
      const hours = parseInt(parts[0]);
      const minutes = parseInt(parts[1]);
      const seconds = parseFloat(parts[2]);
      
      if (hours > 0) {
        return `${hours}h ${minutes}m ${Math.floor(seconds)}s`;
      } else if (minutes > 0) {
        return `${minutes}m ${Math.floor(seconds)}s`;
      } else {
        return `${Math.floor(seconds)}s`;
      }
    }
    
    return duration;
  };

  const formatDateTime = (dateTimeStr) => {
    if (!dateTimeStr) return 'N/A';
    
    try {
      const date = new Date(dateTimeStr);
      return date.toLocaleString();
    } catch (e) {
      return dateTimeStr;
    }
  };

  const formatMetricValue = (value) => {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'number') {
      // 对于很小的数值使用科学计数法
      if (value < 0.001 && value > 0) {
        return value.toExponential(3);
      }
      // 对于正常数值保留4位小数
      return value.toFixed(4);
    }
    return value.toString();
  };

  // 格式化标题，为长标题添加换行
  const getFormattedTitle = (tagKey) => {
    const titleMap = {
      'instance_type': 'Instance\nType',
      'replica_count': 'Replica\nCount', 
      'proc_per_node': 'Proc Per\nNode',
      'batch_size': 'Batch\nSize',
      'cutoff_len': 'Cutoff\nLen',
      'deepspeed_conf': 'Zero\nConf'
    };
    
    if (titleMap[tagKey]) {
      return titleMap[tagKey].split('\n').map((line, index) => (
        <div key={index}>{line}</div>
      ));
    }
    
    // 默认格式化：下划线转空格，首字母大写
    return tagKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  // 定义我们关心的tag列（基于实际数据）
  const importantTags = [
    'model',
    'dataset', 
    'instance_type',
    'replica_count',
    'proc_per_node',
    'batch_size',
    'cutoff_len',
    'deepspeed_conf'
  ];

  // 动态生成tag列，优先显示重要的tags
  const generateTagColumns = () => {
    if (!trainingHistory || trainingHistory.length === 0) return [];
    
    // 定义要过滤掉的tags（不在表格中显示）
    const hiddenTags = [
      'source_run_id',           // 用于重复检测，用户不需要看到
      'source_experiment_name'   // 冗余信息，实验名称已经保持原样
    ];
    
    // 收集所有可能的tag键
    const allTagKeys = new Set();
    trainingHistory.forEach(record => {
      if (record.tags) {
        Object.keys(record.tags).forEach(key => {
          // 过滤掉系统内部的tags和我们不想显示的tags
          if (!key.startsWith('mlflow.') && 
              key !== 'mlflow.runName' && 
              !hiddenTags.includes(key)) {
            allTagKeys.add(key);
          }
        });
      }
    });
    
    // 按重要性排序：重要的tags在前，其他的按字母顺序
    const sortedTagKeys = [];
    
    // 先添加重要的tags（如果存在）
    importantTags.forEach(tag => {
      if (allTagKeys.has(tag)) {
        sortedTagKeys.push(tag);
        allTagKeys.delete(tag);
      }
    });
    
    // 再添加其他tags（按字母顺序）
    const remainingTags = Array.from(allTagKeys).sort();
    sortedTagKeys.push(...remainingTags);
    
    // 为每个tag创建一列
    return sortedTagKeys.map(tagKey => {
      // 根据tag类型设置不同的列宽
      let width = 100;
      if (tagKey === 'model') width = 140;
      else if (tagKey === 'dataset') width = 120;
      else if (tagKey === 'instance_type') width = 130;
      else if (tagKey === 'deepspeed_conf') width = 120;
      
      return {
        title: (
          <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
            {getFormattedTitle(tagKey)}
          </div>
        ),
        key: `tag_${tagKey}`,
        width: width,
        ellipsis: true,
        render: (_, record) => {
          const tagValue = record.tags?.[tagKey];
          if (!tagValue) {
            return <Text type="secondary">-</Text>;
          }
          
          // 移除instance_type和replica_count的颜色标识，正常显示
          return (
            <Tooltip title={`${tagKey}: ${tagValue}`}>
              <Text>{tagValue}</Text>
            </Tooltip>
          );
        },
      };
    });
  };

  const tagColumns = generateTagColumns();

  const columns = [
    {
      title: 'Experiment',
      dataIndex: 'experiment_name',
      key: 'experiment_name',
      width: 120,
      ellipsis: true,
      render: (text) => (
        <Tooltip title={text}>
          <Text strong>{text}</Text>
        </Tooltip>
      ),
    },
    {
      title: (
        <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
          Run<br/>Name
        </div>
      ),
      dataIndex: 'run_name',
      key: 'run_name',
      width: 150,
      ellipsis: true,
      render: (text) => (
        <Tooltip title={text}>
          <Text>{text}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 80,
      render: (status) => getStatusTag(status),
    },
    // 动态插入所有tag列
    ...tagColumns,
    {
      title: (
        <Space>
          <ThunderboltOutlined style={{ color: '#faad14' }} />
          Samples/s
        </Space>
      ),
      key: 'train_samples_per_second',
      width: 90,
      render: (_, record) => {
        const value = record.metrics?.train_samples_per_second;
        if (value === null || value === undefined) {
          return <Text type="secondary">-</Text>;
        }
        
        // 根据样本处理速度设置不同的颜色和样式
        let textColor = '#1890ff'; // 默认蓝色
        let backgroundColor = '#e6f7ff';
        let borderColor = '#91d5ff';
        
        if (value >= 2.0) {
          textColor = '#389e0d'; // 深绿色 - 高效
          backgroundColor = '#f6ffed';
          borderColor = '#b7eb8f';
        } else if (value >= 1.0) {
          textColor = '#d48806'; // 深橙色 - 中等
          backgroundColor = '#fffbe6';
          borderColor = '#ffd666';
        } else if (value < 0.5) {
          textColor = '#cf1322'; // 深红色 - 较慢
          backgroundColor = '#fff2f0';
          borderColor = '#ffadd2';
        }
        
        return (
          <div style={{
            padding: '3px 8px',
            borderRadius: '6px',
            backgroundColor: backgroundColor,
            border: `1px solid ${borderColor}`,
            display: 'inline-block',
            minWidth: '55px',
            textAlign: 'center'
          }}>
            <Text strong style={{ color: textColor, fontSize: '13px' }}>
              {formatMetricValue(value)}
            </Text>
          </div>
        );
      },
    },
    {
      title: 'Steps/s',
      key: 'train_steps_per_second',
      width: 70,
      render: (_, record) => (
        <Text>{formatMetricValue(record.metrics?.train_steps_per_second)}</Text>
      ),
    },
    {
      title: (
        <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
          Start<br/>Time
        </div>
      ),
      dataIndex: 'start_time',
      key: 'start_time',
      width: 130,
      render: (time) => (
        <Text style={{ fontSize: '12px' }}>
          {formatDateTime(time)}
        </Text>
      ),
    },
    {
      title: 'Duration',
      dataIndex: 'duration',
      key: 'duration',
      width: 80,
      render: (duration) => (
        <Text>{formatDuration(duration)}</Text>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      fixed: 'right',
      render: (_, record) => (
        <Button
          icon={<InfoCircleOutlined />}
          onClick={() => showRunDetails(record)}
          size="small"
        >
          Details
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Card
        title={
          <Space>
            <ExperimentOutlined />
            Training History
            {loading && <Spin size="small" />}
          </Space>
        }
        extra={
          <Space>
            <Button
              icon={<SettingOutlined />}
              onClick={showConfigModal}
              title="Configure MLflow Settings"
            >
              Config
            </Button>
            <Button
              icon={<DownloadOutlined />}
              onClick={downloadCSV}
              title="Download training history as CSV"
              disabled={!trainingHistory || trainingHistory.length === 0}
            >
              CSV
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={manualRefresh}
              loading={loading}
            >
              Refresh
            </Button>
          </Space>
        }
      >
        <Table
          columns={columns}
          dataSource={trainingHistory}
          rowKey="run_id"
          loading={loading && hasInitialLoad} // 只有在已经加载过的情况下才显示表格loading
          pagination={{
            pageSize: 10,
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total, range) => 
              `${range[0]}-${range[1]} of ${total} training runs`,
          }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  loading && !hasInitialLoad ? 
                    "Loading training history from MLflow..." : 
                    (hasInitialLoad ? 
                      "No training history found" : 
                      "Loading training history from MLflow..."
                    )
                }
              />
            ),
          }}
          scroll={{ 
            x: Math.max(1400, 600 + tagColumns.length * 110) // 基础宽度 + 动态tag列宽度
          }}
          components={{
            header: {
              cell: (props) => (
                <th 
                  {...props} 
                  style={{
                    ...props.style,
                    whiteSpace: 'normal',
                    wordBreak: 'break-word',
                    lineHeight: '1.2',
                    padding: '8px 16px',
                    minHeight: '44px'
                  }}
                />
              ),
            },
          }}
        />
      </Card>

      {/* 详情Modal */}
      <Modal
        title={
          <Space>
            <ExperimentOutlined />
            Training Run Details
          </Space>
        }
        open={detailModalVisible}
        onCancel={() => setDetailModalVisible(false)}
        footer={[
          <Button key="close" onClick={() => setDetailModalVisible(false)}>
            Close
          </Button>
        ]}
        width={800}
      >
        {selectedRun && (
          <div>
            <Descriptions bordered column={2} size="small">
              <Descriptions.Item label="Experiment" span={2}>
                {selectedRun.experiment_name}
              </Descriptions.Item>
              <Descriptions.Item label="Run Name" span={2}>
                {selectedRun.run_name}
              </Descriptions.Item>
              <Descriptions.Item label="Run ID" span={2}>
                <Text code>{selectedRun.run_id}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="Status">
                {getStatusTag(selectedRun.status)}
              </Descriptions.Item>
              <Descriptions.Item label="Duration">
                {formatDuration(selectedRun.duration)}
              </Descriptions.Item>
              <Descriptions.Item label="Start Time">
                {formatDateTime(selectedRun.start_time)}
              </Descriptions.Item>
              <Descriptions.Item label="End Time">
                {formatDateTime(selectedRun.end_time)}
              </Descriptions.Item>
            </Descriptions>

            <div style={{ marginTop: 16 }}>
              <Collapse>
                <Panel 
                  header={
                    <Space>
                      <BarChartOutlined />
                      Metrics ({Object.keys(selectedRun.metrics || {}).length})
                    </Space>
                  } 
                  key="metrics"
                >
                  {selectedRun.metrics && Object.keys(selectedRun.metrics).length > 0 ? (
                    <div>
                      {Object.entries(selectedRun.metrics).map(([key, value]) => (
                        <div key={key} style={{ marginBottom: 8 }}>
                          <Text strong>{key}:</Text> {typeof value === 'number' ? value.toFixed(6) : value}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Text type="secondary">No metrics recorded</Text>
                  )}
                </Panel>
                
                <Panel 
                  header={
                    <Space>
                      <SettingOutlined />
                      Parameters ({Object.keys(selectedRun.params || {}).length})
                    </Space>
                  } 
                  key="params"
                >
                  {selectedRun.params && Object.keys(selectedRun.params).length > 0 ? (
                    <div>
                      {Object.entries(selectedRun.params).map(([key, value]) => (
                        <div key={key} style={{ marginBottom: 8 }}>
                          <Text strong>{key}:</Text> <Text code>{value}</Text>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Text type="secondary">No parameters recorded</Text>
                  )}
                </Panel>
                
                {selectedRun.tags && Object.keys(selectedRun.tags).length > 0 && (
                  <Panel 
                    header={
                      <Space>
                        <InfoCircleOutlined />
                        Tags ({Object.keys(selectedRun.tags).length})
                      </Space>
                    } 
                    key="tags"
                  >
                    <div>
                      {Object.entries(selectedRun.tags).map(([key, value]) => (
                        <div key={key} style={{ marginBottom: 8 }}>
                          <Text strong>{key}:</Text> {value}
                        </div>
                      ))}
                    </div>
                  </Panel>
                )}
              </Collapse>
            </div>
          </div>
        )}
      </Modal>

      {/* MLflow配置Modal */}
      <Modal
        title={
          <Space>
            <SettingOutlined />
            MLflow Configuration
          </Space>
        }
        open={configModalVisible}
        onCancel={() => setConfigModalVisible(false)}
        footer={[
          <Button key="cancel" onClick={() => setConfigModalVisible(false)}>
            Cancel
          </Button>
        ]}
        width={800}
      >
        <Form
          form={configForm}
          layout="vertical"
          onFinish={saveMlflowConfig}
          initialValues={mlflowConfig}
        >
          <Form.Item
            label="MLflow Tracking Server URI for Display"
            name="tracking_uri"
            rules={[
              { required: true, message: 'Please enter the MLflow tracking server URI' },
              { 
                pattern: /^(https?:\/\/|arn:aws:)/,
                message: 'URI must start with http://, https://, or arn:aws:'
              }
            ]}
            extra="Enter the MLflow tracking server URI. For AWS SageMaker, use ARN format."
          >
            <Input
              placeholder=""
            />
          </Form.Item>
          
          <div style={{ 
            backgroundColor: '#f6ffed', 
            border: '1px solid #b7eb8f', 
            borderRadius: '6px', 
            padding: '12px',
            marginTop: '16px'
          }}>
            <Typography.Text strong style={{ color: '#389e0d' }}>
              💡 Configuration Tips:
            </Typography.Text>
            <ul style={{ marginTop: '8px', marginBottom: '0', color: '#52c41a' }}>
              <li><strong>AWS SageMaker MLFlow Tracking Server ARN:</strong> ARN format starting with "arn:aws:sagemaker:"</li>
              <li><strong>Your own SageMaker MLFlow Arn or Shared Arn for Display.</strong></li>
            </ul>
          </div>

          {/* 第一个区块的按钮 */}
          <div style={{ marginTop: '16px', textAlign: 'right' }}>
            <Space>
              <Button onClick={testMlflowConnection}>
                Test Connection
              </Button>
              <Button type="primary" onClick={() => configForm.submit()}>
                Save
              </Button>
            </Space>
          </div>

          {/* 跨账户同步功能区域 */}
          <div style={{ 
            marginTop: '24px',
            padding: '16px',
            backgroundColor: '#f0f8ff',
            border: '1px solid #d6e4ff',
            borderRadius: '8px'
          }}>
            <Typography.Title level={5} style={{ color: '#1890ff', marginBottom: '16px' }}>
              <Space>
                <ThunderboltOutlined style={{ color: '#1890ff' }} />
                Cross-Account MLflow Sync
              </Space>
            </Typography.Title>
            
            <Form
              form={syncForm}
              layout="vertical"
              onFinish={syncToSharedMLflow}
              onFinishFailed={(errorInfo) => {
                console.log('Sync form validation failed:', errorInfo);
              }}
            >
              <Form.Item
                label="Sync Configuration JSON"
                name="sync_config"
                rules={[
                  { required: true, message: 'Please enter the sync configuration JSON' },
                  {
                    validator: (_, value) => {
                      if (!value) return Promise.resolve();
                      try {
                        const parsed = JSON.parse(value);
                        const requiredFields = ['contributor_name', 'source_mlflow_arn', 'shared_account_id', 'shared_aws_region', 'cross_account_role_arn', 'shared_mlflow_arn'];
                        const missingFields = requiredFields.filter(field => !parsed[field]);
                        if (missingFields.length > 0) {
                          return Promise.reject(new Error(`Missing required fields: ${missingFields.join(', ')}`));
                        }
                        
                        // 验证source和destination ARN不能相同
                        if (parsed.source_mlflow_arn === parsed.shared_mlflow_arn) {
                          return Promise.reject(new Error('Source MLflow ARN and Shared MLflow ARN cannot be the same. Please ensure you are syncing to a different MLflow server.'));
                        }
                        
                        return Promise.resolve();
                      } catch (e) {
                        return Promise.reject(new Error('Invalid JSON format'));
                      }
                    }
                  }
                ]}
                extra="JSON configuration for cross-account sync"
              >
                <Input.TextArea
                  rows={8}
                  placeholder={`{
  "contributor_name": "john",
  "source_mlflow_arn": "arn:aws:sagemaker:us-west-2:123456789012:mlflow-tracking-server/john-research-mlflow",
  "shared_account_id": "987654321098",
  "shared_aws_region": "us-west-2",
  "cross_account_role_arn": "arn:aws:iam::987654321098:role/MLflowSync-CrossAccount-john",
  "shared_mlflow_arn": "arn:aws:sagemaker:us-west-2:987654321098:mlflow-tracking-server/shared-mlflow-server",
  "setup_date": "2024-08-24T05:46:00Z"
}`}
                />
              </Form.Item>

              <Form.Item
                label="Experiment Name"
                name="experiment_name"
                rules={[
                  { required: true, message: 'Please enter the experiment name to sync' }
                ]}
                extra="The experiment name from your MLflow server to sync (e.g., hz-lmf-ds3-bs, torchrecipe-4)"
              >
                <Input placeholder="hz-lmf-ds3-bs" />
              </Form.Item>

              <Form.Item style={{ marginBottom: 0 }}>
                <Button 
                  type="primary" 
                  loading={syncLoading}
                  onClick={() => {
                    syncForm.validateFields().then(values => {
                      syncToSharedMLflow(values);
                    }).catch(errorInfo => {
                      console.log('Sync form validation failed:', errorInfo);
                    });
                  }}
                  style={{ 
                    backgroundColor: '#1890ff',
                    borderColor: '#1890ff'
                  }}
                >
                  <Space>
                    <ThunderboltOutlined />
                    Sync to Shared MLFlow Server
                  </Space>
                </Button>
              </Form.Item>
            </Form>
          </div>
        </Form>
      </Modal>
    </div>
  );
};

export default TrainingHistoryPanel;
