import React, { useState, useEffect, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { getAuthToken } from './AuthGate';
import {
  Card,
  Select,
  Button,
  Space,
  Alert,
  Typography,
  Spin,
  Empty,
  Row,
  Col,
  Tag,
  Popconfirm,
  message,
  Divider,
  Modal,
  Switch
} from 'antd';
import {
  LineChartOutlined,
  ReloadOutlined,
  PlayCircleOutlined,
  StopOutlined,
  ClearOutlined,
  DownloadOutlined,
  EyeOutlined,
  InfoCircleOutlined
} from '@ant-design/icons';
import {
  fetchTrainingJobs,
  setActiveJob,
  updateJobLogs
} from '../store/slices/trainingSlice';
import {
  selectTrainingJobs,
  selectTrainingLoading,
  selectActiveJob,
  selectJobLogs
} from '../store/selectors';

const { Option } = Select;
const { Text, Title } = Typography;

// Log display configuration
const MAX_DISPLAY_LINES = 1000; // Maximum lines to display in frontend

// Define colors for different pods
const POD_COLORS = [
  '#1890ff', // blue
  '#52c41a', // green
  '#fa8c16', // orange
  '#eb2f96', // pink
  '#722ed1', // purple
  '#13c2c2', // cyan
  '#faad14', // gold
  '#f5222d', // red
];

const TrainingMonitorPanelRedux = () => {
  // Redux state
  const dispatch = useDispatch();
  const trainingJobsFromStore = useSelector(selectTrainingJobs);
  const trainingJobs = Array.isArray(trainingJobsFromStore) ? trainingJobsFromStore : [];
  const loading = useSelector(selectTrainingLoading);
  const activeJob = useSelector(selectActiveJob);
  const jobLogs = useSelector(state => selectJobLogs(state));

  // Local state for UI
  const [selectedJob, setSelectedJob] = useState(null);
  const [jobPods, setJobPods] = useState([]);
  const [podsLoading, setPodsLoading] = useState(false);
  const [logs, setLogs] = useState({});
  const [logStreaming, setLogStreaming] = useState({});
  const [websocket, setWebsocket] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [autoScroll, setAutoScroll] = useState(true); // Auto-scroll toggle
  const logContainerRef = useRef(null);

  // Create WebSocket connection
  useEffect(() => {
    console.log('Creating WebSocket connection for training monitor');
    setConnectionStatus('connecting');

    const connectWebSocket = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = getAuthToken();
      const wsUrl = `${protocol}//${window.location.host}/ws${token ? `?token=${token}` : ''}`;

      console.log(`Training Monitor connecting to WebSocket: ${wsUrl}`);
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('WebSocket connected for training monitor');
        setWebsocket(ws);
        setConnectionStatus('connected');
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
      };

      ws.onclose = (event) => {
        console.log('WebSocket disconnected for training monitor, code:', event.code);
        setWebsocket(null);
        setConnectionStatus('disconnected');

        // Auto reconnect (if not normal close)
        if (event.code !== 1000) {
          console.log('Attempting to reconnect WebSocket in 3 seconds...');
          setTimeout(() => {
            setConnectionStatus('connecting');
            connectWebSocket();
          }, 3000);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error for training monitor:', error);
        setConnectionStatus('error');
      };

      return ws;
    };

    const ws = connectWebSocket();

    return () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop_all_log_streams' }));
        ws.close(1000, 'Component unmounting');
      }
    };
  }, []);

  // Auto scroll to bottom
  const scrollToBottom = () => {
    if (autoScroll && logContainerRef.current) {
      const container = logContainerRef.current;
      container.scrollTop = container.scrollHeight;
    }
  };

  // Check if user manually scrolled the log container
  const handleLogScroll = () => {
    if (logContainerRef.current) {
      const container = logContainerRef.current;
      const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50; // 50px tolerance

      // Enable auto-scroll if user scrolls near bottom; otherwise disable
      if (isAtBottom !== autoScroll) {
        setAutoScroll(isAtBottom);
      }
    }
  };

  // Auto scroll when logs update
  useEffect(() => {
    scrollToBottom();
  }, [logs, autoScroll]);

  // Handle WebSocket messages
  const handleWebSocketMessage = (data) => {
    switch (data.type) {
      case 'log_data':
        handleLogData(data);
        break;
      case 'log_error':
        handleLogError(data);
        break;
      case 'log_stream_closed':
        handleLogStreamClosed(data);
        break;
      case 'log_stream_error':
        handleLogStreamError(data);
        break;
      case 'log_stream_stopped':
        handleLogStreamStopped(data);
        break;
      case 'training_job_deleted':
        if (data.status === 'success') {
          // Don't show notification, handled by StatusMonitorRedux (delete button is there)
          dispatch(fetchTrainingJobs());
          if (selectedJob === data.jobName) {
            dispatch(setActiveJob(null));
            setSelectedJob(null);
            setJobPods([]);
            setLogs({});
          }
        } else {
          message.error(data.message);
        }
        break;
      case 'training_launch':
        if (data.jobName && data.logs) {
          // Update job logs using Redux
          dispatch(updateJobLogs({
            jobName: data.jobName,
            logs: data.logs
          }));
        }
        break;
      case 'training_log_update':
        if (data.jobName && data.logs) {
          // Update job logs using Redux
          dispatch(updateJobLogs({
            jobName: data.jobName,
            logs: data.logs
          }));
        }
        break;
      default:
        break;
    }
  };

  // 处理日志数据
  const handleLogData = (data) => {
    const { podName, data: logData, timestamp } = data;
    setLogs(prevLogs => {
      const podLogs = prevLogs[podName] || [];
      const newLog = {
        timestamp,
        data: logData.split('\r').pop(),
        type: 'log'
      };

      const updatedLogs = [...podLogs, newLog];

      // 限制显示行数，保持最新的日志
      if (updatedLogs.length > MAX_DISPLAY_LINES) {
        return {
          ...prevLogs,
          [podName]: updatedLogs.slice(-MAX_DISPLAY_LINES)
        };
      }

      return {
        ...prevLogs,
        [podName]: updatedLogs
      };
    });
  };

  // 处理日志错误
  const handleLogError = (data) => {
    const { podName, error, timestamp } = data;
    setLogs(prevLogs => {
      const podLogs = prevLogs[podName] || [];
      const newLog = {
        timestamp,
        data: `Error: ${error}`,
        type: 'error'
      };
      return {
        ...prevLogs,
        [podName]: [...podLogs, newLog]
      };
    });
  };

  // 处理日志流关闭
  const handleLogStreamClosed = (data) => {
    const { podName } = data;
    setLogStreaming(prev => ({
      ...prev,
      [podName]: false
    }));
    console.log(`Log stream closed for pod: ${podName}`);
  };

  // 处理日志流错误
  const handleLogStreamError = (data) => {
    const { podName, error } = data;
    setLogStreaming(prev => ({
      ...prev,
      [podName]: false
    }));
    message.error(`Log stream error for ${podName}: ${error}`);
  };

  // 处理日志流停止
  const handleLogStreamStopped = (data) => {
    const { podName } = data;
    setLogStreaming(prev => ({
      ...prev,
      [podName]: false
    }));
    console.log(`Log stream stopped for pod: ${podName}`);
  };

  // 获取训练任务的pods - 根据作业类型调用不同API
  const fetchJobPods = async (jobName) => {
    setPodsLoading(true);
    try {
      // 找到对应的作业信息以确定类型
      const job = trainingJobs.find(j => j.name === jobName);
      if (!job) {
        throw new Error(`Job ${jobName} not found`);
      }

      // 根据作业类型调用不同的API
      let apiUrl;
      if (job.type === 'rayjob') {
        apiUrl = `/api/rayjobs/${jobName}/pods`;
      } else {
        apiUrl = `/api/hyperpod-jobs/${jobName}/pods`;
      }

      const response = await fetch(apiUrl);
      const result = await response.json();

      if (result.success) {
        setJobPods(result.pods);
        // 清空之前的日志
        setLogs({});
        setLogStreaming({});
      } else {
        // 如果是资源未找到，显示为 info 而不是 error
        if (result.error && result.error.includes('Resource not found')) {
          message.info('Selected resource not found');
        } else {
          message.error(`Failed to fetch pods: ${result.error}`);
        }
        setJobPods([]);
      }
    } catch (error) {
      console.error('Error fetching job pods:', error);
      message.error('Failed to fetch job pods');
      setJobPods([]);
    } finally {
      setPodsLoading(false);
    }
  };

  // 开始日志流
  const startLogStream = (podName) => {
    if (connectionStatus === 'connecting') {
      message.warning('WebSocket is connecting, please wait a moment...');
      return;
    }

    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({
        type: 'start_log_stream',
        jobName: selectedJob,
        podName: podName
      }));

      setLogStreaming(prev => ({
        ...prev,
        [podName]: true
      }));

      message.success(`Started log streaming for ${podName}`);
    } else {
      message.error(`WebSocket connection not available (${connectionStatus}). Please wait for connection.`);
    }
  };

  // 停止日志流
  const stopLogStream = (podName) => {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({
        type: 'stop_log_stream',
        jobName: selectedJob,
        podName: podName
      }));
    }

    setLogStreaming(prev => ({
      ...prev,
      [podName]: false
    }));
  };

  // 清空日志
  const clearLogs = () => {
    setLogs({});
  };

  // 获取完整日志
  const fetchFullLogs = async (jobName, podName) => {
    try {
      const response = await fetch(`/api/logs/${jobName}/${podName}`);
      if (response.ok) {
        const fullLogs = await response.text();
        return fullLogs;
      } else {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch logs');
      }
    } catch (error) {
      console.error('Failed to fetch full logs:', error);
      message.error(`Failed to fetch full logs: ${error.message}`);
      return null;
    }
  };

  // 下载完整日志
  const downloadFullLogs = async (jobName, podName) => {
    try {
      const response = await fetch(`/api/logs/${jobName}/${podName}/download`);
      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `${podName}.log`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        message.success('Log file downloaded successfully');
      } else {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to download logs');
      }
    } catch (error) {
      console.error('Failed to download logs:', error);
      message.error(`Failed to download logs: ${error.message}`);
    }
  };

  // 查看完整日志（在模态框中显示）
  const viewFullLogs = async (jobName, podName) => {
    const fullLogs = await fetchFullLogs(jobName, podName);
    if (fullLogs) {
      Modal.info({
        title: `Full Logs - ${podName}`,
        content: (
          <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
            <pre style={{ fontSize: '12px', lineHeight: '1.4', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
              {fullLogs}
            </pre>
          </div>
        ),
        width: '80%',
        okText: 'Close'
      });
    }
  };

  // 处理训练任务选择
  const handleJobSelect = (jobName) => {
    // 停止之前的所有日志流
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: 'stop_all_log_streams' }));
    }

    dispatch(setActiveJob(jobName));
    setSelectedJob(jobName);
    setLogs({});
    setLogStreaming({});

    if (jobName) {
      fetchJobPods(jobName);
    } else {
      setJobPods([]);
    }
  };

  // Initial loading
  useEffect(() => {
    dispatch(fetchTrainingJobs());
  }, [dispatch]);

  // Effect to clear selected job when training jobs list becomes empty
  useEffect(() => {
    if (trainingJobs.length === 0 && selectedJob) {
      console.log('Training jobs list is empty, clearing selected job');
      dispatch(setActiveJob(null));
      setSelectedJob(null);
      setJobPods([]);
      setLogs({});
      setLogStreaming({});
      
      // Stop all log streams
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ type: 'stop_all_log_streams' }));
      }
    }
  }, [trainingJobs.length, selectedJob, dispatch, websocket]);

  // 渲染日志内容
  const renderLogs = () => {
    if (jobPods.length === 0) {
      return (
        <Empty
          description="No pods found for selected training job"
          style={{ padding: '40px 0' }}
        />
      );
    }

    const allLogs = [];

    // 合并所有pod的日志并按时间排序
    jobPods.forEach((pod, index) => {
      const podLogs = logs[pod.name] || [];
      const color = POD_COLORS[index % POD_COLORS.length];

      podLogs.forEach(log => {
        allLogs.push({
          ...log,
          podName: pod.name,
          color: color
        });
      });
    });

    // 按时间戳排序
    allLogs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return (
      <div
        ref={logContainerRef}
        onScroll={handleLogScroll}
        style={{
          height: '400px',
          overflow: 'auto',
          backgroundColor: '#fafafa',
          color: '#333',
          padding: '12px',
          fontFamily: 'Monaco, Consolas, "Courier New", monospace',
          fontSize: '12px',
          lineHeight: '1.4',
          border: '1px solid #e8e8e8',
          borderRadius: '4px'
        }}
      >
        {allLogs.length === 0 ? (
          <div style={{ color: '#999', textAlign: 'center', padding: '20px' }}>
            No logs available. Click "Start Streaming" to begin monitoring logs.
          </div>
        ) : (
          allLogs.map((log, index) => (
            <div key={index} style={{ marginBottom: '2px' }}>
              <span style={{ color: '#999', fontSize: '10px' }}>
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <span
                style={{
                  color: log.color,
                  fontWeight: 'bold',
                  marginLeft: '8px',
                  marginRight: '8px'
                }}
              >
                [{log.podName}]
              </span>
              <span style={{ color: log.type === 'error' ? '#ff4d4f' : '#333', whiteSpace: 'pre-wrap' }}>
                {log.data}
              </span>
            </div>
          ))
        )}
        {/* 自动滚动状态指示器 */}
        {allLogs.length > 0 && (
          <div style={{
            position: 'sticky',
            bottom: 0,
            right: 0,
            textAlign: 'right',
            padding: '4px 8px',
            backgroundColor: 'rgba(250, 250, 250, 0.9)',
            fontSize: '10px',
            color: autoScroll ? '#52c41a' : '#faad14',
            borderTop: '1px solid #e8e8e8'
          }}>
            {autoScroll ? 'Auto-scrolling enabled' : 'Manual scroll mode'}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ height: '100%' }}>
      {/* 训练任务选择 + 状态 + 刷新 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Select
          style={{ flex: 1 }}
          placeholder="Select a training job to monitor"
          value={selectedJob}
          onChange={handleJobSelect}
          loading={loading}
          allowClear
        >
          {trainingJobs.map(job => (
            <Option key={job.name} value={job.name}>
              <Space>
                <Text strong>{job.name}</Text>
                <Tag color={
                  job.type === 'rayjob' ? 'purple' :
                  'orange'
                }>
                  {
                    job.type === 'rayjob' ? 'RayJob' :
                    'HyperPod'
                  }
                </Tag>
                <Tag color="blue">
                  {job.spec.replicas} replicas
                </Tag>
                <Text type="secondary" style={{ fontSize: '12px' }}>
                  Created: {new Date(job.creationTimestamp).toLocaleString()}
                </Text>
              </Space>
            </Option>
          ))}
        </Select>
        {connectionStatus === 'connected' && (
          <Tag color="green" style={{ margin: 0 }}>Ready</Tag>
        )}
        {connectionStatus === 'connecting' && (
          <Tag color="orange" style={{ margin: 0 }}>Connecting...</Tag>
        )}
        {connectionStatus === 'disconnected' && (
          <Tag color="red" style={{ margin: 0 }}>Disconnected</Tag>
        )}
        {connectionStatus === 'error' && (
          <Tag color="red" style={{ margin: 0 }}>Error</Tag>
        )}
        <Button
          icon={<ReloadOutlined />}
          onClick={() => {
            dispatch(fetchTrainingJobs());
            if (selectedJob) {
              if (websocket && websocket.readyState === WebSocket.OPEN) {
                websocket.send(JSON.stringify({ type: 'stop_all_log_streams' }));
              }
              setLogs({});
              setLogStreaming({});
              fetchJobPods(selectedJob);
            }
          }}
          loading={loading || podsLoading}
          size="small"
        >
          Refresh
        </Button>
      </div>

      {selectedJob && (
        <>
          <Divider style={{ margin: '12px 0' }} />
          <Row gutter={[16, 8]} align="middle" style={{ marginBottom: 12 }}>
            <Col>
              <Text strong>Pods ({jobPods.length}):</Text>
            </Col>
            {jobPods.map((pod, index) => {
              const color = POD_COLORS[index % POD_COLORS.length];
              const isStreaming = logStreaming[pod.name];

              return (
                <Col key={pod.name}>
                  <Space>
                    <Tag color={color} style={{ margin: 0 }}>
                      {pod.name}
                    </Tag>
                    <Tag color={pod.status === 'Running' ? 'green' : 'orange'}>
                      {pod.status}
                    </Tag>
                    <Button
                      size="small"
                      type={isStreaming ? "primary" : "default"}
                      icon={isStreaming ? <StopOutlined /> : <PlayCircleOutlined />}
                      onClick={() => isStreaming ? stopLogStream(pod.name) : startLogStream(pod.name)}
                      loading={podsLoading}
                      disabled={!isStreaming && connectionStatus !== 'connected'}
                    >
                      {isStreaming ? 'Stop' : 'Start'} Streaming
                    </Button>
                  </Space>
                </Col>
              );
            })}
          </Row>

          {/* 日志显示部分 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Space>
              <Text strong>Training Logs - {selectedJob}</Text>
              {Object.values(logStreaming).some(streaming => streaming) && (
                <Tag color="green">Live Streaming</Tag>
              )}
              <Text type="secondary" style={{ fontSize: '12px' }}>
                Showing last {MAX_DISPLAY_LINES} lines (live)
              </Text>
            </Space>
            <Space>
              {/* 自动滚动开关 */}
              <Space align="center">
                <span style={{ fontSize: '12px', color: '#666' }}>Auto-scroll:</span>
                <Switch
                  size="small"
                  checked={autoScroll}
                  onChange={(checked) => {
                    setAutoScroll(checked);
                    if (checked) {
                      scrollToBottom();
                    }
                  }}
                  checkedChildren="ON"
                  unCheckedChildren="OFF"
                />
              </Space>
              <Button
                size="small"
                icon={<ClearOutlined />}
                onClick={clearLogs}
              >
                Clear Logs
              </Button>
              {/* 完整日志操作按钮 */}
              {jobPods.length > 0 && (
                <>
                  <Button
                    size="small"
                    icon={<EyeOutlined />}
                    onClick={() => {
                      if (jobPods.length === 1) {
                        viewFullLogs(selectedJob, jobPods[0].name);
                      } else {
                        // 多个pod时显示选择菜单
                        Modal.confirm({
                          title: 'Select Pod to View Full Logs',
                          content: (
                            <div>
                              {jobPods.map(pod => (
                                <Button
                                  key={pod.name}
                                  block
                                  style={{ marginBottom: '8px' }}
                                  onClick={() => {
                                    Modal.destroyAll();
                                    viewFullLogs(selectedJob, pod.name);
                                  }}
                                >
                                  {pod.name} ({pod.status})
                                </Button>
                              ))}
                            </div>
                          ),
                          footer: null,
                          width: 400
                        });
                      }
                    }}
                  >
                    View Full Logs
                  </Button>
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    onClick={() => {
                      if (jobPods.length === 1) {
                        downloadFullLogs(selectedJob, jobPods[0].name);
                      } else {
                        // 多个pod时显示选择菜单
                        Modal.confirm({
                          title: 'Select Pod to Download Full Logs',
                          content: (
                            <div>
                              {jobPods.map(pod => (
                                <Button
                                  key={pod.name}
                                  block
                                  style={{ marginBottom: '8px' }}
                                  onClick={() => {
                                    Modal.destroyAll();
                                    downloadFullLogs(selectedJob, pod.name);
                                  }}
                                >
                                  {pod.name} ({pod.status})
                                </Button>
                              ))}
                            </div>
                          ),
                          footer: null,
                          width: 400
                        });
                      }
                    }}
                  >
                    Download Full Logs
                  </Button>
                </>
              )}
            </Space>
          </div>
          {renderLogs()}
        </>
      )}

      {!selectedJob && (
        <Empty
          image={<LineChartOutlined style={{ fontSize: '64px', color: '#d9d9d9' }} />}
          description={
            <div>
              <Title level={4} style={{ color: '#999', marginBottom: '8px' }}>
                Select a Training Job
              </Title>
              <Text type="secondary">
                Choose a training job from the dropdown above to monitor its logs and manage pods.
              </Text>
            </div>
          }
        />
      )}
    </div>
  );
};

export default TrainingMonitorPanelRedux;