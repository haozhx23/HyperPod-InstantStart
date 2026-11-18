/**
 * Training Goodput（HyperPod Training Operator + HyperPod Observability）
 *
 * InstantStart 不计算任何 training_* 指标。它们由 HyperPod Observability add-on 的
 * Training Metrics Agent 从 CloudWatch Logs 中的 TrainingJobEvents 周期性算出（默认每
 * 5 分钟算一次最近 24h 窗口），并以 Prometheus 文本暴露；add-on 的 Central Collector 再把
 * 同一份数值写入 AMP。这里只读取这份已算好的结果，并按 AWS Training dashboard 的
 * Goodput 面板表达式组合，保证面板上的数字与 Grafana / AMP 一致。
 *
 * 详细说明见 developer-docs/TRAINING_MODULE.md 的「Training Goodput」。
 */

// 与 add-on 自己的 Central Collector 抓取配置一致（kubernetes_sd role=service，
// keep __meta_kubernetes_service_name=hyperpod-training-metrics-agent，端口名 kpi-metrics）。
// 沿用同一契约，不另做服务发现。
const METRICS_SOURCE = Object.freeze({
  namespace: 'hyperpod-observability',
  service: 'hyperpod-training-metrics-agent',
  portName: 'kpi-metrics',
});

// Goodput = T / (T + A + M + D + S + R) × 100，结果限制在 0–100。
// 与 AWS Training dashboard 的 Goodput 面板表达式逐项对应；不要在这里加入
// checkpoint / evaluation 时间——它们已在 training_time_ms 中扣除。
const GOODPUT_TERMS = Object.freeze({
  trainingMs: 'training_time_ms',
  autoRestartDowntimeMs: 'training_auto_restart_downtime_ms',
  manualDowntimeMs: 'training_manual_downtime_ms',
  faultDetectionMs: 'training_fault_detection_time_ms',
  systemRestartMs: 'training_system_restart_time_ms',
  reprocessingMs: 'training_reprocessing_time_ms',
});

const METRIC_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+-?\d+)?$/;
const LABEL_PAIR = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

function unescapeLabelValue(value) {
  return value.replace(/\\(.)/g, (_, ch) => (ch === 'n' ? '\n' : ch));
}

function parseSampleValue(raw) {
  if (raw === '+Inf') return Infinity;
  if (raw === '-Inf') return -Infinity;
  return Number(raw);
}

/**
 * 解析 Prometheus 文本格式中的样本行（只保留 `training_` 前缀的指标）。
 * 只覆盖 Training Metrics Agent 实际输出的子集：`name{labels} value [timestamp]`。
 *
 * @param {string} text
 * @returns {{name: string, labels: Record<string,string>, value: number}[]}
 */
function parsePrometheusText(text) {
  const samples = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.startsWith('training_')) continue;
    const match = METRIC_LINE.exec(line);
    if (!match) continue;
    const [, name, labelText = '', rawValue] = match;
    const labels = {};
    for (const [, key, value] of labelText.matchAll(LABEL_PAIR)) {
      labels[key] = unescapeLabelValue(value);
    }
    samples.push({ name, labels, value: parseSampleValue(rawValue) });
  }
  return samples;
}

/**
 * 解析 window_size 标签（Training Metrics Agent 接受 `1h`、`24h`、`1d` 这类写法）。
 * @returns {number|null} 小时数
 */
function parseWindowHours(label) {
  const match = /^(\d+)([hd])$/.exec(String(label || ''));
  if (!match) return null;
  return Number(match[1]) * (match[2] === 'd' ? 24 : 1);
}

/** 同一任务可能有多个窗口（add-on 配了多个 TIME_WINDOWS 时）；取最长的那个。 */
function pickWindow(jobSamples) {
  let best = null;
  for (const sample of jobSamples) {
    const label = sample.labels.window_size;
    const hours = parseWindowHours(label);
    if (hours === null) continue;
    if (!best || hours > best.hours) best = { label, hours };
  }
  return best;
}

function sumOf(samples, name) {
  const matched = samples.filter(sample => sample.name === name);
  if (!matched.length) return null;
  return matched.reduce((total, sample) => total + sample.value, 0);
}

function computeGoodput(terms) {
  const missingTerms = Object.entries(GOODPUT_TERMS)
    .filter(([key]) => terms[key] === null)
    .map(([, metricName]) => metricName);
  // 与 dashboard 的 PromQL 语义一致：缺任一序列，表达式没有结果（面板显示 N/A），
  // 不把缺失项当 0 补齐。
  if (missingTerms.length) {
    return { goodputPercent: null, goodputUnavailableReason: 'missing_terms', missingTerms };
  }
  const denominator = Object.keys(GOODPUT_TERMS).reduce((total, key) => total + terms[key], 0);
  if (!(denominator > 0) || !Number.isFinite(denominator)) {
    return { goodputPercent: null, goodputUnavailableReason: 'zero_denominator', missingTerms };
  }
  const percent = (terms.trainingMs / denominator) * 100;
  return {
    goodputPercent: Math.min(100, Math.max(0, percent)),
    goodputUnavailableReason: null,
    missingTerms,
  };
}

/**
 * 从全部样本中取出一个任务的 Goodput 摘要。
 *
 * Training Metrics Agent 只用 `job_name` 标识任务（不带 namespace），这里按同样的键过滤。
 *
 * @param {ReturnType<typeof parsePrometheusText>} samples
 * @param {string} jobName
 */
function summarizeJobGoodput(samples, jobName) {
  const jobSamples = samples.filter(sample => sample.labels.job_name === jobName);
  const window = pickWindow(jobSamples);
  if (!jobSamples.length || !window) {
    return { status: 'no_data', jobName };
  }
  const inWindow = jobSamples.filter(sample => sample.labels.window_size === window.label);
  const value = name => sumOf(inWindow, name);

  const terms = {};
  for (const [key, metricName] of Object.entries(GOODPUT_TERMS)) {
    terms[key] = value(metricName);
  }

  const faultTypes = new Map();
  for (const sample of inWindow) {
    if (sample.name !== 'training_fault_type_count' && sample.name !== 'training_fault_recovery_time_ms') continue;
    const faultType = sample.labels.fault_type || 'unknown';
    const entry = faultTypes.get(faultType) || { faultType, count: 0, recoveryMs: null };
    if (sample.name === 'training_fault_type_count') entry.count += sample.value;
    else entry.recoveryMs = (entry.recoveryMs || 0) + sample.value;
    faultTypes.set(faultType, entry);
  }

  const batchCount = value('training_batch_count');

  return {
    status: 'ok',
    jobName,
    window,
    ...computeGoodput(terms),
    // 训练侧 OpenTelemetry 事件（BATCH_* 等）是否已进入计算。没有时 D/S/R 无法被测量，
    // 只能按 0 参与计算，Goodput 会偏高。
    trainingEventsReceived: batchCount !== null && batchCount > 0,
    terms,
    faults: {
      faultCount: value('training_fault_count'),
      autoRestartCount: value('training_auto_restart_count'),
      manualRestartCount: value('training_manual_restart_count'),
      lostStepCount: value('training_lost_step_count'),
      byType: [...faultTypes.values()].sort((a, b) => b.count - a.count),
    },
    activity: {
      batchCount,
      batchTimeMs: value('training_batch_time_ms'),
      checkpointCount: value('training_checkpoint_count'),
      checkpointTimeMs: value('training_checkpoint_time_ms'),
      checkpointSyncTimeMs: value('training_checkpoint_sync_time_ms'),
      checkpointAsyncTimeMs: value('training_checkpoint_async_time_ms'),
      evaluationPasses: value('training_evaluation_passes'),
      evaluationTimeMs: value('training_evaluation_time_ms'),
    },
  };
}

/**
 * 通过 kube-apiserver 的 service proxy 读取 Training Metrics Agent 的 /metrics。
 *
 * 先用 `--ignore-not-found` 判断 add-on 是否安装：未安装是预期状态，不应每次轮询都在
 * 服务端日志里留下 kubectl 失败。Service 存在但读取失败（Pod 未就绪、超时等）则抛错。
 *
 * @param {{queryKubectl: Function, context: string}} deps
 * @returns {Promise<{installed: false} | {installed: true, samples: ReturnType<typeof parsePrometheusText>}>}
 */
async function fetchTrainingMetrics({ queryKubectl, context }) {
  const { namespace, service, portName } = METRICS_SOURCE;
  const found = await queryKubectl(
    ['get', 'service', service, '-n', namespace, '--ignore-not-found', '-o', 'name'],
    { context, timeout: 15000, trim: true, dedup: true }
  );
  if (!found) return { installed: false };
  const text = await queryKubectl(
    ['get', '--raw', `/api/v1/namespaces/${namespace}/services/${service}:${portName}/proxy/metrics`],
    { context, timeout: 20000, dedup: true }
  );
  return { installed: true, samples: parsePrometheusText(text) };
}

module.exports = {
  METRICS_SOURCE,
  GOODPUT_TERMS,
  parsePrometheusText,
  parseWindowHours,
  summarizeJobGoodput,
  fetchTrainingMetrics,
};
