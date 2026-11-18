import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Popover, Spin, Tag, Tooltip, Typography } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  InfoCircleOutlined,
  WarningOutlined
} from '@ant-design/icons';
import useAutoRefresh from '../hooks/useAutoRefresh';

const { Text } = Typography;

// Goodput 由 HyperPod Observability add-on 计算；本组件只展示 GET /api/training-jobs/:jobName/goodput
// 的结果。显示口径（阈值、分段、文案）集中在下面几个常量里，客户定制时只改这里。

// 状态阈值（Goodput %，从高到低匹配）
export const GOODPUT_LEVELS = [
  { min: 90, label: 'Good', color: 'success', icon: <CheckCircleFilled /> },
  { min: 70, label: 'Fair', color: 'warning', icon: <ExclamationCircleFilled /> },
  { min: 0, label: 'Low', color: 'error', icon: <CloseCircleFilled /> }
];

// 分段顺序固定，颜色取分类色板的前四个槽位（已对白色背景跑过 CVD / 对比度校验）
export const GOODPUT_SEGMENTS = [
  { key: 'training', label: 'Training', color: '#2a78d6', ms: t => t.trainingMs },
  { key: 'downtime', label: 'Fault downtime', color: '#eb6834', ms: t => t.autoRestartDowntimeMs + t.manualDowntimeMs },
  { key: 'detection', label: 'Fault detection', color: '#1baf7a', ms: t => t.faultDetectionMs },
  { key: 'recovery', label: 'Restart & recompute', color: '#eda100', ms: t => t.systemRestartMs + t.reprocessingMs }
];

const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781' };

export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms === 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(secs).padStart(2, '0')}s`;
}

function formatCount(value) {
  return value === null || value === undefined ? '—' : Math.round(value).toLocaleString();
}

function formatShare(part, total) {
  if (!(total > 0)) return '';
  const share = (part / total) * 100;
  return share > 0 && share < 0.1 ? '<0.1%' : `${share.toFixed(1)}%`;
}

export function goodputLevel(percent) {
  return GOODPUT_LEVELS.find(level => percent >= level.min) || GOODPUT_LEVELS[GOODPUT_LEVELS.length - 1];
}

/** 任务创建时间晚于窗口起点时，窗口覆盖整个任务。 */
export function windowCaption(window, jobCreatedAt, now = Date.now()) {
  const created = Date.parse(jobCreatedAt);
  if (window?.hours && Number.isFinite(created) && now - created < window.hours * 3600 * 1000) {
    return 'Since job start';
  }
  return `Last ${window?.label || '24h'}`;
}

const lineStyle = { fontSize: 12, color: INK.secondary };

function StatusLine({ icon, children }) {
  return (
    <div style={{ ...lineStyle, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
      {icon}
      <span>{children}</span>
    </div>
  );
}

function SegmentBar({ segments, total }) {
  const visible = segments.filter(segment => segment.ms > 0);
  const summary = segments
    .map(segment => `${segment.label} ${formatDuration(segment.ms)} (${formatShare(segment.ms, total) || '0%'})`)
    .join(', ');
  return (
    <div
      role="img"
      aria-label={`Where the job time went: ${summary}`}
      style={{ display: 'flex', gap: 2, height: 8, borderRadius: 4, overflow: 'hidden', background: '#ffffff' }}
    >
      {visible.map(segment => (
        <Tooltip key={segment.key} title={`${segment.label}: ${formatDuration(segment.ms)} (${formatShare(segment.ms, total)})`}>
          <div style={{ flex: `${segment.ms} 0 0`, minWidth: 3, background: segment.color }} />
        </Tooltip>
      ))}
    </div>
  );
}

function DetailsTable({ rows }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 8 }}>
      <tbody>
        {rows.map(([name, value]) => (
          <tr key={name} style={{ borderBottom: '1px solid #f0f0f0' }}>
            <td style={{ padding: '3px 12px 3px 0', color: INK.secondary }}>{name}</td>
            <td style={{ padding: '3px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: INK.primary }}>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GoodputDetails({ data }) {
  const { terms, faults, activity } = data;
  const sectionTitle = title => <Text strong style={{ display: 'block', fontSize: 12, margin: '4px 0' }}>{title}</Text>;
  return (
    <div style={{ width: 360, maxHeight: '60vh', overflow: 'auto' }}>
      {sectionTitle('Goodput terms')}
      <DetailsTable rows={[
        ['Training time (T)', formatDuration(terms.trainingMs)],
        ['Auto-restart downtime (A)', formatDuration(terms.autoRestartDowntimeMs)],
        ['Manual downtime (M)', formatDuration(terms.manualDowntimeMs)],
        ['Fault detection (D)', formatDuration(terms.faultDetectionMs)],
        ['System restart (S)', formatDuration(terms.systemRestartMs)],
        ['Reprocessing (R)', formatDuration(terms.reprocessingMs)]
      ]} />
      {faults.byType.length > 0 && (
        <>
          {sectionTitle('Faults by type')}
          <DetailsTable rows={faults.byType.map(item => [
            item.faultType,
            `${formatCount(item.count)}× · recovery ${formatDuration(item.recoveryMs)}`
          ])} />
        </>
      )}
      {sectionTitle('Training activity')}
      <DetailsTable rows={[
        ['Batches', `${formatCount(activity.batchCount)} · ${formatDuration(activity.batchTimeMs)}`],
        ['Checkpoints', `${formatCount(activity.checkpointCount)} · ${formatDuration(activity.checkpointTimeMs)}`],
        ['Checkpoint sync / async', `${formatDuration(activity.checkpointSyncTimeMs)} / ${formatDuration(activity.checkpointAsyncTimeMs)}`],
        ['Evaluations', `${formatCount(activity.evaluationPasses)} · ${formatDuration(activity.evaluationTimeMs)}`],
        ['Lost steps', formatCount(faults.lostStepCount)]
      ]} />
      <div style={{ fontSize: 11, color: INK.secondary, lineHeight: 1.5 }}>
        <div>Goodput = T / (T + A + M + D + S + R), the same expression as the HyperPod Observability training dashboard.</div>
        <div>Checkpoint and evaluation time is already excluded from T and is not counted as lost time. Goodput is not GPU utilization.</div>
        <div>Computed by HyperPod Observability over a rolling {data.window.label} window (recomputed every 5 minutes by default). Values can still change for about 10 minutes after the job ends.</div>
        <div style={{ color: INK.muted, marginTop: 4 }}>Fetched {new Date(data.fetchedAt).toLocaleTimeString()}</div>
      </div>
    </div>
  );
}

/**
 * HPTO 任务的 Goodput 条：数值来自 HyperPod Observability 的 Training Metrics Agent。
 * 周期刷新挂在全局 refreshManager 上（useAutoRefresh），不自建定时器。
 */
const TrainingGoodputStrip = ({ jobName, jobCreatedAt }) => {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!jobName) return;
    const seq = ++requestSeq.current;
    try {
      const response = await fetch(`/api/training-jobs/${encodeURIComponent(jobName)}/goodput`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success === false) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      if (seq === requestSeq.current) setState({ loading: false, data: body, error: null });
    } catch (error) {
      if (seq === requestSeq.current) setState(prev => ({ loading: false, data: prev.data, error: error.message }));
    }
  }, [jobName]);

  useEffect(() => {
    setState({ loading: true, data: null, error: null });
    load();
  }, [load]);

  useAutoRefresh('training-goodput', load, { immediate: false });

  const { loading, data, error } = state;

  if (loading && !data) {
    return <StatusLine icon={<Spin size="small" />}>Loading goodput…</StatusLine>;
  }
  if (error && !data) {
    return <StatusLine icon={<WarningOutlined style={{ color: '#d03b3b' }} />}>Goodput unavailable: {error}</StatusLine>;
  }
  if (!data) return null;
  if (data.status === 'not_installed') {
    return (
      <StatusLine icon={<InfoCircleOutlined />}>
        Goodput needs the HyperPod Observability add-on with training metrics enabled.
      </StatusLine>
    );
  }
  if (data.status === 'no_data') {
    return (
      <StatusLine icon={<InfoCircleOutlined />}>
        Goodput: waiting for HyperPod Observability to compute this job (every 5 minutes by default).
      </StatusLine>
    );
  }

  const segments = GOODPUT_SEGMENTS.map(segment => ({ ...segment, ms: segment.ms(data.terms) || 0 }));
  const total = segments.reduce((sum, segment) => sum + segment.ms, 0);
  const hasGoodput = data.goodputPercent !== null && data.goodputPercent !== undefined;
  // 只有生命周期事件时 D/S/R 未被测量，不给出等级，避免给偏高的值背书
  const level = hasGoodput && data.trainingEventsReceived ? goodputLevel(data.goodputPercent) : null;
  const unavailableReason = data.goodputUnavailableReason === 'missing_terms'
    ? `Missing metric series: ${data.missingTerms.join(', ')}`
    : 'No training time has been recorded in this window yet.';

  return (
    <div
      data-testid="training-goodput-strip"
      style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: '8px 12px', marginBottom: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <Text style={{ fontSize: 12, color: INK.secondary }}>Goodput</Text>
        {hasGoodput ? (
          <Text strong style={{ fontSize: 22, lineHeight: '28px', color: INK.primary }}>
            {data.goodputPercent.toFixed(1)}%
          </Text>
        ) : (
          <Tooltip title={unavailableReason}>
            <Text strong style={{ fontSize: 22, lineHeight: '28px', color: INK.muted }}>N/A</Text>
          </Tooltip>
        )}
        {level && <Tag color={level.color} icon={level.icon} style={{ margin: 0 }}>{level.label}</Tag>}
        <Tooltip title={`Rolling ${data.window.label} window computed by HyperPod Observability; matches the training dashboard in Grafana.`}>
          <Text style={{ fontSize: 12, color: INK.muted }}>{windowCaption(data.window, jobCreatedAt)}</Text>
        </Tooltip>
        {!data.trainingEventsReceived && (
          <Tooltip title="No training-side events (BATCH_*, TRAINING_START) have been received for this job. Fault detection, restart and recompute time cannot be measured, so Goodput may be overstated. Emit HyperPod training events from the training code to measure them.">
            <Tag style={{ margin: 0 }}>Lifecycle events only</Tag>
          </Tooltip>
        )}
        {error && (
          <Tooltip title={`Last refresh failed: ${error}. Showing the previous value.`}>
            <WarningOutlined style={{ color: '#d03b3b' }} />
          </Tooltip>
        )}
        <div style={{ flex: 1 }} />
        <Popover content={<GoodputDetails data={data} />} title={`Goodput details - ${jobName}`} trigger="click" placement="bottomRight">
          <Button size="small" type="text" icon={<InfoCircleOutlined />} aria-label="Goodput details">Details</Button>
        </Popover>
      </div>

      {total > 0 && <SegmentBar segments={segments} total={total} />}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 16, rowGap: 2, marginTop: 6, fontSize: 12 }}>
        {segments.map(segment => (
          <span key={segment.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: segment.color, display: 'inline-block' }} />
            <span style={{ color: INK.secondary }}>{segment.label}</span>
            <span style={{ color: INK.primary }}>{formatDuration(segment.ms)}</span>
          </span>
        ))}
        <span style={{ color: INK.secondary, marginLeft: 'auto' }}>
          Faults {formatCount(data.faults.faultCount)} · Auto-recovered {formatCount(data.faults.autoRestartCount)} · Lost steps {formatCount(data.faults.lostStepCount)}
        </span>
      </div>
    </div>
  );
};

export default TrainingGoodputStrip;
