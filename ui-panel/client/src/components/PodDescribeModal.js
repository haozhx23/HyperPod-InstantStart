import React, { useEffect, useState } from 'react';
import { Modal, Space, Tag, Alert, Spin, Button } from 'antd';
import { ReloadOutlined, CopyOutlined } from '@ant-design/icons';
import { message } from 'antd';

// One-shot `kubectl describe pod` viewer. 不同于 PodLogModal（WS 流式），
// 这里是一次性 HTTP 拉取，适合看 Pending/Failed pod 的 Events 和资源状态。
export default function PodDescribeModal({ podName, namespace, visible, onClose }) {
  const [loading, setLoading] = useState(false);
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!visible || !podName || !namespace) return;
    let cancelled = false;
    setLoading(true);
    setOutput('');
    setError('');
    fetch(
      `/api/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(podName)}/describe`
    )
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success) setOutput(data.output || '');
        else setError(data.error || 'Unknown error');
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, podName, namespace, reloadTick]);

  const copyToClipboard = () => {
    if (!output) return;
    try {
      navigator.clipboard.writeText(output);
      message.success('Copied to clipboard');
    } catch (_) {
      message.error('Clipboard unavailable');
    }
  };

  return (
    <Modal
      title={
        <Space>
          <span>Pod Describe</span>
          <Tag color="blue" style={{ fontFamily: 'monospace' }}>{podName}</Tag>
          <Tag>{namespace}</Tag>
        </Space>
      }
      open={visible}
      onCancel={onClose}
      width="85%"
      footer={null}
      destroyOnClose
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Space>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => setReloadTick((t) => t + 1)}
            loading={loading}
          >
            Reload
          </Button>
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={copyToClipboard}
            disabled={!output}
          >
            Copy
          </Button>
        </Space>
        {output && (
          <span style={{ fontSize: 12, color: '#999' }}>
            {output.split('\n').length} lines
          </span>
        )}
      </div>

      <div
        style={{
          height: '60vh',
          overflow: 'auto',
          background: '#fafafa',
          color: '#333',
          padding: 12,
          fontFamily: 'Monaco, Consolas, "Courier New", monospace',
          fontSize: 12,
          lineHeight: 1.5,
          borderRadius: 4,
          border: '1px solid #e8e8e8',
          whiteSpace: 'pre',
        }}
      >
        {loading && (
          <div style={{ color: '#999', textAlign: 'center', padding: 40 }}>
            <Spin /> <div style={{ marginTop: 12 }}>Loading...</div>
          </div>
        )}
        {!loading && error && (
          <Alert type="error" message="Describe failed" description={error} showIcon />
        )}
        {!loading && !error && output}
      </div>
    </Modal>
  );
}
