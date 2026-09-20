/**
 * 唯一的 kubectl 执行层（R1 / D3 / D5）。
 *
 * 在此之前有三份近似实现，行为各不相同：
 *
 * | 位置 | maxBuffer | 在飞去重 | 超时 | reject 的形状 |
 * |---|---|---|---|---|
 * | `index.js` `executeKubectl` | 64 MiB | 无 | Node exec timeout | `Error`（消息被「优化」过） |
 * | `appStatusV2.js` `executeKubectlWithDedup` | 64 MiB | **有** | 手写定时器 | `{error, stderr, command}` |
 * | `clusterStatusV2.js` `executeKubectlWithTimeout` | **10 MiB** | 无 | 手写定时器 | `{error, stderr, command}` |
 *
 * 由此产生两个已记录的缺陷：
 * - **D3**：同一份 `get pods -A -o json` 在 clusterStatusV2 这条路径上 10 MiB 就
 *   ENOBUFS，在另两条路径上不会；且 clusterStatusV2 没有在飞去重，缓存过期瞬间
 *   多个标签页会各跑一次 kubectl。
 * - **D5**：reject 一个**普通对象**而不是 `Error`，上层 `catch` 里 `error.message`
 *   是 undefined，于是真实 stderr 被兜底字符串覆盖，排障时看不到原因。
 *
 * 本模块把三者收敛成一份：maxBuffer 统一 64 MiB、去重可选但共享同一张表、
 * 失败一律 reject `Error` 并把 stderr/命令/目标集群挂在错误对象上。
 *
 * 同时这里是 R1 注入 `--context` 的地方。注意 `opts.context` 是给「调用点已经知道
 * 自己在操作哪个集群」的场景预留的显式入口；不传就按 exec 时刻的活跃集群解析，
 * 那**不能**把多步操作钉在操作开始时的集群上，边界见 `utils/kubectlContext.js` 头注释。
 */
// 刻意直接用 child_process 而不是 ./exec：`./exec` 也会给 kubectl 命令注入 --context，
// 两层叠加会让本模块的 `opts.context`（含显式传 null 表示「就是不要注入」）被接缝覆盖。
// 规则是**一条调用路径上只有一层注入**：走 runKubectl 的由本模块负责，其余由 ./exec 负责。
const { exec } = require('child_process');
const kubectlContext = require('./kubectlContext');

// 大集群 `get pods -A -o json` 实测 4-10 MiB，Node 默认 1 MiB 必然截断。
// 这个值是三条路径的统一口径，不要再在调用点各写一份。
const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30000;

// 在飞去重表：key 含 context，避免切集群后复用上一个集群的在飞结果。
const inFlight = new Map();

/**
 * 执行一条 kubectl 命令。
 *
 * @param {string} command kubectl 之后的部分，例如 `get pods -A -o json`
 * @param {object} [opts]
 * @param {number} [opts.timeout=30000]
 * @param {boolean} [opts.dedup=false] 相同 (context, command) 在飞时复用同一个 Promise
 * @param {boolean} [opts.trim=false] resolve 前 trim（两个状态服务的既有行为）
 * @param {boolean} [opts.optimizeError=false] 把常见错误换成对用户更友好的说法
 * @param {boolean} [opts.logSuccess=false] 成功时打印摘要（index.js 的既有行为）
 * @param {string}  [opts.context] 显式指定目标集群 context，覆盖活跃集群解析
 * @param {object}  [opts.env] 透传给 child_process.exec 的环境变量（不传则继承本进程）
 * @returns {Promise<string>} stdout
 */
function runKubectl(command, opts = {}) {
  const {
    timeout = DEFAULT_TIMEOUT,
    dedup = false,
    trim = false,
    optimizeError = false,
    logSuccess = false,
    context: explicitContext,
    env,
  } = opts;

  const context = explicitContext !== undefined ? explicitContext : kubectlContext.resolveActiveContext();
  const fullCommand = kubectlContext.injectContextIntoCommand(`kubectl ${command}`, context);
  const dedupKey = `${context || '-'}::${command}`;

  if (dedup && inFlight.has(dedupKey)) {
    console.log(`Reusing active query: ${fullCommand}`);
    return inFlight.get(dedupKey);
  }

  const promise = new Promise((resolve, reject) => {
    console.log(`Executing kubectl command: ${fullCommand}`);

    const execOptions = { timeout, maxBuffer: MAX_BUFFER };
    if (env) execOptions.env = env;

    exec(fullCommand, execOptions, (error, stdout, stderr) => {
      if (error) {
        reject(buildKubectlError({ error, stderr, command, fullCommand, context, timeout, optimizeError }));
        return;
      }

      if (logSuccess) logSuccessSummary(fullCommand, stdout);
      resolve(trim ? stdout.trim() : stdout);
    });
  });

  if (dedup) {
    inFlight.set(dedupKey, promise);
    // 无论成败都要摘掉，否则一次失败会把后续请求永久钉在这个失败结果上
    promise.catch(() => {}).then(() => inFlight.delete(dedupKey));
  }

  return promise;
}

/**
 * 把 exec 的错误规整成一个 Error（D5）。
 *
 * 关键点：**永远返回 Error 实例**，并保证 `message` 里有可读的原因。原来两个状态
 * 服务 reject 的是普通对象，上层读 `error.message` 得到 undefined，最终前端只看到
 * 「Failed to fetch cluster status」。
 */
function buildKubectlError({ error, stderr, command, fullCommand, context, timeout, optimizeError }) {
  const stderrText = (stderr || '').trim();
  const timedOut = error.killed === true || error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM';

  // CRD 未安装是预期情况（例如集群没装 Ray operator），不打堆栈，避免日志噪声
  const isResourceTypeNotFound =
    stderrText.includes(`doesn't have a resource type`) ||
    (error.message || '').includes(`doesn't have a resource type`);

  let message;
  if (timedOut) {
    message = `Command timed out after ${timeout / 1000} seconds. The cluster may be slow to respond.`;
  } else if (optimizeError && !isResourceTypeNotFound) {
    message = optimizeErrorMessage(error.message || stderrText || 'Unknown kubectl error');
  } else {
    // 默认把 stderr 带上——这正是 D5 里被兜底字符串吃掉的那部分信息
    const base = error.message || 'Unknown kubectl error';
    message = stderrText && !base.includes(stderrText) ? `${base}\n${stderrText}` : base;
  }

  if (isResourceTypeNotFound) {
    console.error(stderrText || error.message);
  } else if (timedOut) {
    console.error(`kubectl command timed out after ${timeout}ms: ${fullCommand}`);
  } else {
    console.error(`kubectl command failed: ${fullCommand}`);
    console.error(`  context: ${context || '(kubeconfig current-context)'}`);
    console.error(`  exit code: ${error.code ?? 'n/a'}`);
    if (stderrText) console.error(`  stderr: ${stderrText}`);
  }

  const err = new Error(message);
  err.stderr = stderrText;
  err.command = command;
  err.fullCommand = fullCommand;
  err.context = context || null;
  err.exitCode = typeof error.code === 'number' ? error.code : null;
  err.timedOut = timedOut;
  err.isResourceTypeNotFound = isResourceTypeNotFound;
  return err;
}

/**
 * 常见 kubectl 错误换成对用户更友好的说法。
 *
 * 这段逻辑原先在 `index.js` 里有两份：一个叫 `optimizeErrorMessage` 的函数（无调用方，
 * E4 记录的死代码）和 `executeKubectl` 里内联重写的一份。收敛到这里，只保留一份。
 */
function optimizeErrorMessage(errorMessage) {
  if (!errorMessage) return 'Unknown error';

  if (errorMessage.includes(`doesn't have a resource type "hyperpodpytorchjob"`)) {
    return 'No HyperPod training jobs found (HyperPod operator may not be installed)';
  }
  if (errorMessage.includes(`doesn't have a resource type "rayjob"`)) {
    return 'No RayJobs found (Ray operator may not be installed)';
  }
  if (errorMessage.includes('not found') || errorMessage.includes('NotFound')) {
    return 'Resource not found - this may be normal if no resources have been created yet';
  }
  if (errorMessage.includes('connection refused') || errorMessage.includes('unable to connect')) {
    return 'Unable to connect to Kubernetes cluster. Please check if the cluster is accessible.';
  }
  return errorMessage;
}

function logSuccessSummary(fullCommand, stdout) {
  if (fullCommand.includes('-o json') && stdout.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(stdout);
      const itemCount = parsed.items?.length ?? (parsed.metadata?.name ? 1 : 0);
      const kind = parsed.kind || 'Resource';
      console.log(`kubectl succeeded: ${fullCommand} → ${kind} (${itemCount} items)`);
      return;
    } catch {
      console.log(`kubectl succeeded: ${fullCommand}`);
      console.log(`Output (truncated): ${stdout.substring(0, 200)}...`);
      return;
    }
  }
  console.log(`kubectl succeeded: ${fullCommand}`);
  if (stdout.trim()) {
    console.log(`Output: ${stdout.trim().substring(0, 500)}${stdout.length > 500 ? '...' : ''}`);
  }
}

module.exports = {
  runKubectl,
  optimizeErrorMessage,
  MAX_BUFFER,
  DEFAULT_TIMEOUT,
  _inFlight: inFlight,   // 测试用
};
