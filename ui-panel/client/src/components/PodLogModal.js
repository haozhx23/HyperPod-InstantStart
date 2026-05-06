import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Modal, Button, Tag, Space, Switch, message } from 'antd';
import { PlayCircleOutlined, StopOutlined, ClearOutlined, DownloadOutlined } from '@ant-design/icons';
import { getAuthToken } from './AuthGate';

const MAX_LINES = 1000;
const JOB_NAME_PREFIX = 'app-status'; // pseudo job name for log stream key

const PodLogModal = ({ podName, namespace, visible, onClose }) => {
  const [ws, setWs] = useState(null);
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [logs, setLogs] = useState([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef(null);
  const wsRef = useRef(null);

  // Auto scroll
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Connect WebSocket when modal opens
  useEffect(() => {
    if (!visible || !podName) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getAuthToken();
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws${token ? `?token=${token}` : ''}`);

    socket.onopen = () => {
      setConnected(true);
      setWs(socket);
      wsRef.current = socket;
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'log_data':
            if (data.podName === podName) {
              const cleaned = data.data.split('\r').pop();
              setLogs(prev => {
                const next = [...prev, { timestamp: data.timestamp, data: cleaned, type: 'log' }];
                return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
              });
            }
            break;
          case 'log_error':
            if (data.podName === podName) {
              setLogs(prev => [...prev, { timestamp: data.timestamp, data: `Error: ${data.error}`, type: 'error' }]);
            }
            break;
          case 'log_stream_closed':
          case 'log_stream_error':
          case 'log_stream_stopped':
            if (data.podName === podName) setStreaming(false);
            break;
          default:
            break;
        }
      } catch (e) { /* ignore non-json */ }
    };

    socket.onclose = () => {
      setConnected(false);
      setStreaming(false);
    };

    return () => {
      // Stop stream and close on unmount/close
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'stop_log_stream', jobName: JOB_NAME_PREFIX, podName, namespace }));
        socket.close();
      }
      setWs(null);
      wsRef.current = null;
      setConnected(false);
      setStreaming(false);
      setLogs([]);
    };
  }, [visible, podName]);

  const startStream = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'start_log_stream', jobName: JOB_NAME_PREFIX, podName, namespace }));
      setStreaming(true);
      message.success(`Started log streaming for ${podName}`);
    }
  }, [podName, namespace]);

  const stopStream = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop_log_stream', jobName: JOB_NAME_PREFIX, podName, namespace }));
    }
    setStreaming(false);
  }, [podName, namespace]);

  // Auto-start streaming when connected
  useEffect(() => {
    if (connected && visible && podName && !streaming) {
      startStream();
    }
  }, [connected, visible, podName]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDownload = () => {
    const text = logs.map(l => `${new Date(l.timestamp).toLocaleTimeString()} ${l.data}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${podName}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleScroll = () => {
    if (containerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
    }
  };

  return (
    <Modal
      title={
        <Space>
          <span>Pod Logs</span>
          <Tag color="blue" style={{ fontFamily: 'monospace' }}>{podName}</Tag>
          {streaming && <Tag color="green">Live</Tag>}
          {!connected && <Tag color="red">Disconnected</Tag>}
        </Space>
      }
      open={visible}
      onCancel={onClose}
      width="85%"
      footer={null}
      destroyOnClose
    >
      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Space>
          <Button
            size="small"
            type={streaming ? 'primary' : 'default'}
            danger={streaming}
            icon={streaming ? <StopOutlined /> : <PlayCircleOutlined />}
            onClick={streaming ? stopStream : startStream}
            disabled={!connected}
          >
            {streaming ? 'Stop' : 'Start'}
          </Button>
          <Button size="small" icon={<ClearOutlined />} onClick={() => setLogs([])}>Clear</Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={handleDownload} disabled={logs.length === 0}>Download</Button>
        </Space>
        <Space>
          <span style={{ fontSize: 12, color: '#999' }}>{logs.length} lines</span>
          <span style={{ fontSize: 12, color: '#666' }}>Auto-scroll:</span>
          <Switch size="small" checked={autoScroll} onChange={setAutoScroll} />
        </Space>
      </div>

      {/* Log container */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          height: '55vh',
          overflow: 'auto',
          backgroundColor: '#fafafa',
          color: '#333',
          padding: '12px',
          fontFamily: 'Monaco, Consolas, "Courier New", monospace',
          fontSize: '12px',
          lineHeight: '1.5',
          borderRadius: 4,
          border: '1px solid #e8e8e8',
        }}
      >
        {logs.length === 0 ? (
          <div style={{ color: '#999', textAlign: 'center', padding: 40 }}>
            {streaming ? 'Waiting for logs...' : 'Click "Start" to begin streaming logs.'}
          </div>
        ) : (
          logs.map((log, i) => (
            <div key={i} style={{ marginBottom: 1 }}>
              <span style={{ color: '#999', fontSize: 10 }}>{new Date(log.timestamp).toLocaleTimeString()}</span>
              <span style={{ color: log.type === 'error' ? '#ff4d4f' : '#333', marginLeft: 8, whiteSpace: 'pre-wrap' }}>{log.data}</span>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
};

export default PodLogModal;
