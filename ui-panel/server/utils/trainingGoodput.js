/**
 * Training Goodput（HyperPod Training Operator + HyperPod Observability）
 *
 * InstantStart 不计算任何 training_* 指标。它们由 HyperPod Observability add-on 的
 * Training Metrics Agent 从 CloudWatch Logs 中的 TrainingJobEvents 周期性算出（默认每
 * 5 分钟算一次最近 24h 窗口），并以 Prometheus 文本暴露；add-on 的 Central Collector 再把
 * 同一份数值写入 AMP。这里只读取这份已算好的结果，并按 AWS Training dashboard 的
 * Goodput 面板表达式组合，保证面板上的数字与 Grafana / AMP 一致。
 *
 * 窗口是「当前时刻往前 24h」，不跟任务对齐；agent 也不会清掉已滑出窗口的任务，旧值会
 * 一直留在 /metrics 里（通常是任务最后几分钟的片段，接近 100%）。所以已结束的任务不能
 * 直接用实时值：窗口仍覆盖整个任务时用实时值，否则从 AMP 读任务刚结束时那一轮的结果。
 * 取哪份数据由 resolveJobGoodput() 决定。
 *
 * 详细说明见 developer-docs/TRAINING_MODULE.md 的「Training Goodput」。
 */

const YAML = require('yaml');

// 与 add-on 自己的 Central Collector 抓取配置一致（kubernetes_sd role=service，
// keep __meta_kubernetes_service_name=hyperpod-training-metrics-agent，端口名 kpi-metrics）。
// 沿用同一契约，不另做服务发现。
const METRICS_SOURCE = Object.freeze({
  namespace: 'hyperpod-observability',
  service: 'hyperpod-training-metrics-agent',
  portName: 'kpi-metrics',
});

// Central Collector 抓取上面这个 Service（抓取任务名 kpi-training-metrics）并 remote write 到
// AMP；AMP workspace 和写入时附加的 cluster_id 标签都从它的配置读，不按名字猜（同一账号下
// 可能有多个 workspace）。
const COLLECTOR_CONFIG = Object.freeze({
  namespace: 'hyperpod-observability',
  configMap: 'hyperpod-observability-central-collector-config',
  key: 'collector.yaml',
  scrapeJob: 'kpi-training-metrics',
});

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// 任务结束后，agent 要再过几轮才取到全部事件（Logs Insights 可见性延迟）。2026-11-18 实测
// 结束后约 10 分钟的那一轮才收敛；20 分钟后读数视为最终值。
const SETTLE_MS = 20 * MINUTE_MS;
// 窗口起点（某一轮的整 5 分钟时刻 − 窗口时长）必须早于任务创建，留 5 分钟余量吸收时钟差。
const WINDOW_GUARD_MS = 5 * MINUTE_MS;

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

/**
 * 读取 HPTO 任务（HyperPodPyTorchJob）。不存在时返回 null。
 * 不传 namespace 时与 /api/training-jobs 的列表一致，用 context 的默认 namespace。
 */
async function fetchHptoJob({ queryKubectl, context, jobName, namespace }) {
  const args = ['get', 'hyperpodpytorchjob', jobName, '--ignore-not-found', '-o', 'json'];
  if (namespace) args.push('-n', namespace);
  const text = await queryKubectl(args, { context, timeout: 15000, trim: true, dedup: true });
  return text ? JSON.parse(text) : null;
}

/**
 * 从 HyperPodPyTorchJob 取出判断数据来源所需的字段。
 * 终态只有 Completed / Failed（CRD 的 condition 枚举里其余都可能再变化，如 Suspended）。
 */
function describeHptoJob(resource) {
  const name = resource?.metadata?.name;
  const createdAtMs = Date.parse(resource?.metadata?.creationTimestamp);
  if (!Number.isFinite(createdAtMs)) {
    throw new Error(`HyperPodPyTorchJob ${name} has no valid metadata.creationTimestamp`);
  }
  const terminal = (resource?.status?.conditions || [])
    .find(condition => ['Completed', 'Failed'].includes(condition.type) && condition.status === 'True');
  let endedAtMs = null;
  if (terminal) {
    endedAtMs = Date.parse(terminal.lastTransitionTime);
    if (!Number.isFinite(endedAtMs)) {
      throw new Error(`HyperPodPyTorchJob ${name} condition ${terminal.type} has no valid lastTransitionTime`);
    }
  }
  return {
    name,
    namespace: resource?.metadata?.namespace || null,
    uid: resource?.metadata?.uid || null,
    createdAtMs,
    endedAtMs,
    phase: terminal ? terminal.type.toLowerCase() : 'running',
  };
}

/**
 * 某个窗口时长下，「窗口覆盖整个任务」的时间段：从结束后读数收敛（from）到窗口起点
 * 仍早于任务创建（to）。from > to 表示任务比窗口长，任何一轮都装不下整个任务。
 */
function wholeJobSpan({ createdAtMs, endedAtMs }, windowHours) {
  const from = endedAtMs + SETTLE_MS;
  const to = createdAtMs + windowHours * HOUR_MS - WINDOW_GUARD_MS;
  return { from, to, covers: from <= to };
}

const AMP_REMOTE_WRITE = /^https:\/\/aps-workspaces\.([a-z0-9-]+)\.amazonaws\.com\/workspaces\/(ws-[a-z0-9-]+)\/api\/v1\/remote_write\/?$/;

/**
 * 解析 Central Collector 的 collector.yaml：沿「抓取任务 → receiver → pipeline → exporter」
 * 找到 training_* 实际写入的 AMP workspace，以及抓取任务给样本加的 cluster_id 标签。
 *
 * @returns {{remoteWrite: {region: string, workspaceId: string}|null, clusterId: string|null}}
 */
function parseCollectorConfig(text) {
  const config = YAML.parse(String(text || '')) || {};
  const receiverNames = Object.entries(config.receivers || {})
    .filter(([, receiver]) => (receiver?.config?.scrape_configs || [])
      .some(scrape => scrape?.job_name === COLLECTOR_CONFIG.scrapeJob))
    .map(([name]) => name);
  const scrape = Object.values(config.receivers || {})
    .flatMap(receiver => receiver?.config?.scrape_configs || [])
    .find(item => item?.job_name === COLLECTOR_CONFIG.scrapeJob);
  const clusterRelabel = (scrape?.relabel_configs || [])
    .find(rule => rule?.target_label === 'cluster_id' && !rule.source_labels && rule.replacement);

  const exporterNames = new Set(Object.values(config.service?.pipelines || {})
    .filter(pipeline => (pipeline?.receivers || []).some(name => receiverNames.includes(name)))
    .flatMap(pipeline => pipeline?.exporters || [])
    .filter(name => String(name).split('/')[0] === 'prometheusremotewrite'));
  const workspaces = new Map();
  for (const name of exporterNames) {
    const match = AMP_REMOTE_WRITE.exec(String(config.exporters?.[name]?.endpoint || ''));
    if (match) workspaces.set(`${match[1]}/${match[2]}`, { region: match[1], workspaceId: match[2] });
  }
  if (workspaces.size > 1) {
    throw new Error(`${COLLECTOR_CONFIG.configMap} writes ${COLLECTOR_CONFIG.scrapeJob} to more than one AMP workspace: ${[...workspaces.keys()].join(', ')}`);
  }
  return {
    remoteWrite: workspaces.size ? [...workspaces.values()][0] : null,
    clusterId: clusterRelabel ? String(clusterRelabel.replacement) : null,
  };
}

/** 读取 Central Collector 配置；ConfigMap 不存在时返回 null。 */
async function fetchHistorySource({ queryKubectl, context }) {
  const { namespace, configMap, key } = COLLECTOR_CONFIG;
  const text = await queryKubectl(
    ['get', 'configmap', configMap, '-n', namespace, '--ignore-not-found', '-o', 'json'],
    { context, timeout: 15000, trim: true, dedup: true }
  );
  if (!text) return null;
  return parseCollectorConfig(JSON.parse(text)?.data?.[key]);
}

const promqlString = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** 一个任务在 AMP 中的全部 training_* 序列（所有窗口）。 */
function historySelector(jobName, clusterId) {
  return `{__name__=~"training_.+",job_name=${promqlString(jobName)},cluster_id=${promqlString(clusterId)}}`;
}

/** PromQL instant vector → 与 parsePrometheusText 相同的样本格式，便于复用 summarizeJobGoodput。 */
function samplesFromPromVector(result) {
  return (result || [])
    .filter(series => String(series?.metric?.__name__ || '').startsWith('training_'))
    .map(series => ({
      name: series.metric.__name__,
      labels: series.metric,
      value: parseSampleValue(String(series.value?.[1])),
    }));
}

const toIso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

function jobInfo(job) {
  return { phase: job.phase, createdAt: toIso(job.createdAtMs), endedAt: toIso(job.endedAtMs) };
}

function unavailable(job, reason, extra = {}) {
  return { status: 'unavailable', unavailableReason: reason, jobName: job.name, job: jobInfo(job), ...extra };
}

/**
 * 从 AMP 读任务结束后 SETTLE_MS 那一刻的结果：此时读数已收敛，且只要任务不比窗口长，
 * 那一轮的窗口就覆盖整个任务。
 */
async function loadWholeJobFromHistory({ job, loadHistorySource, queryAmp }) {
  const source = await loadHistorySource();
  if (!source?.remoteWrite) return unavailable(job, 'history_not_configured');
  if (!source.clusterId) {
    throw new Error(`${COLLECTOR_CONFIG.configMap} has no cluster_id label on ${COLLECTOR_CONFIG.scrapeJob}; refusing to query AMP without a cluster filter.`);
  }
  const evaluatedAtMs = job.endedAtMs + SETTLE_MS;
  const data = await queryAmp({
    region: source.remoteWrite.region,
    workspaceId: source.remoteWrite.workspaceId,
    query: historySelector(job.name, source.clusterId),
    time: evaluatedAtMs,
  });
  const summary = summarizeJobGoodput(samplesFromPromVector(data?.result), job.name);
  if (summary.status !== 'ok') return unavailable(job, 'no_history');
  if (!wholeJobSpan(job, summary.window.hours).covers) {
    return unavailable(job, 'longer_than_window', { window: summary.window });
  }
  return {
    ...summary,
    job: jobInfo(job),
    source: 'amp',
    scope: 'whole_job',
    finalizing: false,
    evaluatedAt: toIso(evaluatedAtMs),
    historySource: source.remoteWrite,
  };
}

/**
 * 决定一个 HPTO 任务的 Goodput 取哪份数据。
 *
 * | 任务 | 数据 | scope |
 * |---|---|---|
 * | 运行中，创建不到一个窗口 | agent 实时值 | since_job_start |
 * | 运行中，创建超过一个窗口 | agent 实时值 | last_window |
 * | Completed，结束不到 SETTLE_MS | agent 实时值，finalizing | whole_job |
 * | Completed，窗口仍覆盖整个任务 | agent 实时值 | whole_job |
 * | Completed，窗口已滑过任务开头 | AMP 中结束后 SETTLE_MS 的值 | whole_job |
 * | Completed，任务比窗口长（约 23.5h 以上） | 不显示：longer_than_window | — |
 * | Failed | 不显示：failed_job | — |
 *
 * Failed 不显示的原因：失败任务以 TRN_STOP 结束、没有 JOB_END，agent 把训练时间一直算到
 * 窗口末尾，读数偏高且随时间上涨（2026-11-19 实测，见 TRAINING_MODULE.md）。
 *
 * @param {object} params
 * @param {ReturnType<typeof describeHptoJob>} params.job
 * @param {ReturnType<typeof parsePrometheusText>} params.samples agent 当前的 /metrics 样本
 * @param {number} params.now 毫秒
 * @param {() => Promise<object>} params.loadHistory 返回 loadWholeJobFromHistory 的结果
 */
async function resolveJobGoodput({ job, samples, now, loadHistory }) {
  if (job.phase === 'failed') return unavailable(job, 'failed_job');

  const live = summarizeJobGoodput(samples, job.name);
  if (job.phase === 'running') {
    if (live.status !== 'ok') return { ...live, job: jobInfo(job) };
    const sinceStart = now - job.createdAtMs < live.window.hours * HOUR_MS;
    return { ...live, job: jobInfo(job), source: 'live', scope: sinceStart ? 'since_job_start' : 'last_window', finalizing: false };
  }

  if (live.status === 'ok') {
    const span = wholeJobSpan(job, live.window.hours);
    if (!span.covers) return unavailable(job, 'longer_than_window', { window: live.window });
    if (now <= span.to) {
      return { ...live, job: jobInfo(job), source: 'live', scope: 'whole_job', finalizing: now < span.from };
    }
  } else if (now < job.endedAtMs + SETTLE_MS) {
    // agent 还没算到这个任务（首轮之前）；AMP 里也还没有收敛后的值
    return { ...live, job: jobInfo(job) };
  }
  return loadHistory();
}

module.exports = {
  METRICS_SOURCE,
  COLLECTOR_CONFIG,
  GOODPUT_TERMS,
  SETTLE_MS,
  WINDOW_GUARD_MS,
  parsePrometheusText,
  parseWindowHours,
  summarizeJobGoodput,
  fetchTrainingMetrics,
  fetchHptoJob,
  describeHptoJob,
  wholeJobSpan,
  parseCollectorConfig,
  fetchHistorySource,
  historySelector,
  samplesFromPromVector,
  loadWholeJobFromHistory,
  resolveJobGoodput,
};
