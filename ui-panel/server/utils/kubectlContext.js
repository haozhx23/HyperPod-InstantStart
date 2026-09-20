/**
 * 集群上下文解析与注入：kubectl 的 `--context`（R1）+ helm 的 `--kube-context`（7.18）。
 *
 * **问题**：`multiClusterApis.js` 的 `switchKubectlConfig()` 切集群的做法是跑
 * `aws eks update-kubeconfig` 去改全局 `~/.kube/config` 的 current-context。
 * 于是「当前打哪个集群」是一份进程外的全局可变状态，后果：
 *   1. 切集群那一刻，正在进行的多步操作的后续 kubectl 会打到新集群；
 *   2. 面板之外任何人（另一个终端、另一个工具）改过 current-context，面板整体错位；
 *   3. 命令失败时，日志里看不出这条命令到底打的是哪个集群。
 *
 * helm 有完全相同的问题（它也只读 current-context），见下面「helm」一节。
 *
 * **做法**：每条 kubectl 命令显式带 `--context <name>`。context 名取自活跃集群
 * metadata 的 `eksCluster.arn`（回退 `cloudFormation.outputs.OutputEKSClusterArn`）
 * ——那正是 `aws eks update-kubeconfig` 默认生成的 context 名，形如
 * `arn:aws:eks:<region>:<account>:cluster/<name>`，因此不需要额外记录映射。
 *
 * **边界（务必先读）**：本模块在 **exec 时刻** 解析活跃集群。它消除的是「命令不带
 * context、完全听凭全局 current-context」这一层，也让日志能看出目标集群；它**不能**
 * 把一个多步操作钉在操作开始时的那个集群上——那需要把 context 一路透传到调用点。
 * `utils/kubectl.js` 的 `runKubectl(cmd, { context })` 已经预留了这个入口，但目前没有
 * 任何调用点在用。所以：**不要以为引入本模块后跨集群切换的竞态就全好了。**
 *
 * 解析失败（没有活跃集群、metadata 缺 ARN、ARN 形状不合法）时**不注入**并告警一次，
 * 行为退回改动前——即沿用全局 current-context。这是刻意的：exec 层抛错会让一个
 * metadata 问题变成整个面板不可用，而这里的退化是「回到旧行为」而非「静默走错集群」。
 * 告警文本里带了集群 tag 和原因，便于定位。
 */
const fs = require('fs');
const path = require('path');

// 与 clusterManager.js 的 baseDir 指向同一目录（那边是 server/ 下的 __dirname）
const BASE_DIR = path.join(__dirname, '..', '..', 'managed_clusters_info');
const ACTIVE_CLUSTER_FILE = path.join(BASE_DIR, 'active_cluster.json');

// context 名会原样拼进 shell 命令行。EKS 的 context 名是 ARN 或用户用 --alias 起的别名，
// 两者都落在这个字符集里；出现集合外的字符（空格、引号、`$`、`;` 等）一律拒绝注入，
// 而不是想办法转义——宁可退回旧行为，也不要构造出可疑的命令行。
const CONTEXT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9:._/@-]*$/;

function isValidContextName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && CONTEXT_NAME_RE.test(value);
}

/** 注入开关：出问题时可以用环境变量整体关掉，退回全局 current-context 行为。 */
function isInjectionEnabled() {
  return String(process.env.DISABLE_KUBECTL_CONTEXT || '').toLowerCase() !== 'true';
}

// ==================== metadata → context 名 ====================

/**
 * 从某个集群的 metadata 里读出该用的 context 名。
 * @param {string} baseDir managed_clusters_info 所在目录（测试用临时目录）
 * @param {string} clusterTag 集群 tag（目录名）
 * @returns {string|null} 合法的 context 名，或 null（读不到/不合法）
 */
function readContextFromMetadata(baseDir, clusterTag) {
  if (!clusterTag || typeof clusterTag !== 'string') return null;
  // clusterTag 来自 active_cluster.json，是目录名；仍然挡一下路径穿越
  if (clusterTag.includes('/') || clusterTag.includes('\\') || clusterTag.startsWith('.')) return null;

  const infoPath = path.join(baseDir, clusterTag, 'metadata', 'cluster_info.json');
  let info;
  try {
    info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  } catch {
    return null;
  }

  const arn = info?.eksCluster?.arn || info?.cloudFormation?.outputs?.OutputEKSClusterArn;
  return isValidContextName(arn) ? arn : null;
}

function readActiveClusterTag(baseDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(baseDir, 'active_cluster.json'), 'utf8'));
    return data?.activeCluster || null;
  } catch {
    return null;
  }
}

// ==================== 缓存 ====================
//
// 每次 exec 都要解析一次，但这两个文件是否变化可以用 mtime 判断：切集群会重写
// active_cluster.json，导入/更新集群会重写 cluster_info.json。用 mtimeMs 当缓存键，
// 既避免每条命令两次 JSON 解析，又不会在切集群后继续用旧 context。

const cache = { key: null, context: null };
let warnedFor = null;   // 同一个 (tag, 原因) 只告警一次，避免刷日志

function mtimeKey(file) {
  try {
    return String(fs.statSync(file).mtimeMs);
  } catch {
    return 'missing';
  }
}

function invalidateCache() {
  cache.key = null;
  cache.context = null;
  warnedFor = null;
}

/**
 * 解析当前该用的 context 名。
 * @returns {string|null} context 名；null 表示不注入（退回全局 current-context）
 */
function resolveActiveContext() {
  if (!isInjectionEnabled()) return null;

  const tag = readActiveClusterTag(BASE_DIR);
  if (!tag) {
    warnOnce('no-active-cluster', '没有活跃集群，kubectl 命令将沿用 kubeconfig 的 current-context');
    return null;
  }

  const infoPath = path.join(BASE_DIR, tag, 'metadata', 'cluster_info.json');
  const key = `${tag}|${mtimeKey(ACTIVE_CLUSTER_FILE)}|${mtimeKey(infoPath)}`;
  if (cache.key === key) return cache.context;

  const context = readContextFromMetadata(BASE_DIR, tag);
  if (!context) {
    warnOnce(
      `no-arn:${tag}`,
      `集群 ${tag} 的 metadata 里没有可用的 EKS ARN（期望 eksCluster.arn 或 ` +
      `cloudFormation.outputs.OutputEKSClusterArn），kubectl 命令将沿用 current-context。` +
      `位置: ${infoPath}`
    );
  }

  cache.key = key;
  cache.context = context;
  return context;
}

function warnOnce(reason, message) {
  if (warnedFor === reason) return;
  warnedFor = reason;
  console.warn(`[kubectl-context] ${message}`);
}

// ==================== 注入 ====================

// 「命令位置」的 kubectl：行首，或紧跟 `|`、`&&`、`||`、`;`、`$(`、换行之后。
// 本项目的依赖配置脚本是多行 shell（`cd x && bash -c 'source envs && kubectl ...'`），
// 里面的 kubectl 全都出现在这些位置上，而且正是装 helm chart、给 namespace 打 label
// 这类写操作——只认行首会把它们全漏掉。
const KUBECTL_AT_CMD_POSITION = /(^|[|;&(\n])([ \t]*)kubectl([ \t]+)/g;
const SEGMENT_END = /[|;&\n]/;

/** 命令里是否存在处于命令位置的 kubectl 调用。 */
function hasKubectlInvocation(command) {
  if (typeof command !== 'string') return false;
  return new RegExp(KUBECTL_AT_CMD_POSITION.source).test(command);
}

/**
 * 给 shell 形式的 kubectl 命令插入 `--context`。
 *
 * 处理所有处于**命令位置**的 kubectl（见上面的正则），因此
 * `kubectl create ns x --dry-run -o yaml | kubectl apply -f -` 两段都会被钉住——
 * 只钉前一段的话，真正写集群的 `apply` 反而是没钉住的那一半。
 *
 * 三条例外：
 * - **heredoc**（命令里出现 `<<`）：只处理最前面那一个。heredoc 体是 YAML/脚本内容，
 *   里面行首出现 kubectl 并不是命令位置，改它会生成一条语义被悄悄改掉的命令。
 * - 该段已带 `--context` / `--kubeconfig`：不覆盖调用方的意图（判断按段进行，
 *   所以一条命令里「前一段显式指定、后一段没指定」不会互相影响）。
 * - `kubectl config ...`：它操作的是 kubeconfig 本身，加 --context 语义不对。
 *
 * 引号里的嵌套形式（`sh -c "kubectl get pods"`）不处理：那需要真正解析引号，
 * 用正则改写容易改错位置。这类调用保持旧行为（沿用 current-context）。
 */
function injectContextIntoCommand(command, context) {
  if (typeof command !== 'string' || !isValidContextName(context)) return command;
  if (!hasKubectlInvocation(command)) return command;

  const hasHeredoc = command.includes('<<');
  let injected = 0;

  return command.replace(KUBECTL_AT_CMD_POSITION, (whole, sep, pre, post, offset) => {
    if (hasHeredoc && injected > 0) return whole;

    // 取这一段（到下一个命令分隔符为止）来判断是否已显式指定目标
    const restStart = offset + whole.length;
    const rest = command.slice(restStart);
    const endMatch = SEGMENT_END.exec(rest);
    const segment = endMatch ? rest.slice(0, endMatch.index) : rest;

    if (/^config(\s|$)/.test(segment)) return whole;
    if (/(^|\s)--context([=\s]|$)/.test(segment) || /(^|\s)--kubeconfig([=\s]|$)/.test(segment)) {
      return whole;
    }

    injected++;
    return `${sep}${pre}kubectl --context ${context}${post}`;
  });
}

// ==================== helm ====================
//
// helm 和 kubectl 一样读 kubeconfig 的 current-context，但它**不认 `--context`**，
// 用的是 `--kube-context`。上面那套注入只处理 kubectl，于是同一条命令里会出现
// 目标不一致：`managedFeaturesManager._installKuberayOperator()` 把四条命令用 `&&`
// 串起来，两条 kubectl 被钉到活跃集群，`helm upgrade --install` 仍听凭 current-context
// ——namespace 建在 A 上、chart 装到 B 上（2026-09-20 实测，见 7.18）。
//
// 覆盖面：server/ 下约 47 处 helm 调用（clusterDependencyManager 17、
// managedFeaturesManager 9、karpenterManager 9、hamiManager 6、
// eksNodeGroupDependencyManager 6），全部依赖 current-context。
//
// 不按子命令区分：实测 helm 4.2.4 下 `--kube-context` 是 root 的 persistent flag，
// 每个子命令都接受；不联集群的子命令（`repo add`/`repo update`/`registry`/
// `dependency`/`version`）即使给一个不存在的 context 也照常成功，所以不需要白名单。
// 反过来，联集群的子命令在 context 不存在时会明确报
// `kubernetes cluster unreachable: context "x" does not exist`——那正是我们要的：
// 宁可响亮地失败，也不要静默打到另一个集群。
const HELM_AT_CMD_POSITION = /(^|[|;&(\n])([ \t]*)helm([ \t]+)/g;

/** 命令里是否存在处于命令位置的 helm 调用。 */
function hasHelmInvocation(command) {
  if (typeof command !== 'string') return false;
  return new RegExp(HELM_AT_CMD_POSITION.source).test(command);
}

/**
 * 给 shell 形式的 helm 命令插入 `--kube-context`。
 *
 * 规则与 `injectContextIntoCommand` 对齐（命令位置、heredoc 只处理第一个、
 * 已显式指定 `--kube-context` / `--kubeconfig` 时不覆盖），只有 flag 名不同。
 */
function injectHelmContextIntoCommand(command, context) {
  if (typeof command !== 'string' || !isValidContextName(context)) return command;
  if (!hasHelmInvocation(command)) return command;

  const hasHeredoc = command.includes('<<');
  let injected = 0;

  return command.replace(HELM_AT_CMD_POSITION, (whole, sep, pre, post, offset) => {
    if (hasHeredoc && injected > 0) return whole;

    const restStart = offset + whole.length;
    const rest = command.slice(restStart);
    const endMatch = SEGMENT_END.exec(rest);
    const segment = endMatch ? rest.slice(0, endMatch.index) : rest;

    if (/(^|\s)--kube-context([=\s]|$)/.test(segment) || /(^|\s)--kubeconfig([=\s]|$)/.test(segment)) {
      return whole;
    }

    injected++;
    return `${sep}${pre}helm --kube-context ${context}${post}`;
  });
}

/**
 * 给 argv 形式的 kubectl 调用（`spawn('kubectl', args)`）插入 `--context`。
 * 返回新数组，不改原数组——调用方常把 args 复用于日志。
 */
function injectContextIntoArgs(args, context) {
  if (!Array.isArray(args) || !isValidContextName(context)) return args;
  if (args.some(a => typeof a === 'string' && (a === '--context' || a.startsWith('--context=') ||
                                               a === '--kubeconfig' || a.startsWith('--kubeconfig=')))) {
    return args;
  }
  if (args[0] === 'config') return args;

  return ['--context', context, ...args];
}

module.exports = {
  CONTEXT_NAME_RE,
  isValidContextName,
  hasKubectlInvocation,
  hasHelmInvocation,
  isInjectionEnabled,
  readContextFromMetadata,
  readActiveClusterTag,
  resolveActiveContext,
  injectContextIntoCommand,
  injectHelmContextIntoCommand,
  injectContextIntoArgs,
  invalidateCache,
  BASE_DIR,
};
