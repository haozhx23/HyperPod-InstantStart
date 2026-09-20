/**
 * Shared child_process helpers —— 也是 kubectl 注入 `--context` 的接缝（R1）。
 *
 * Before this module, ~7 files each independently wrote:
 *     const { exec } = require('child_process');
 *     const { promisify } = require('util');
 *     const execAsync = promisify(exec);
 * which is identical boilerplate. This module is the single seam for that
 * setup so cross-cutting concerns (timeout defaults, logging, error
 * normalization) have one place to live.
 *
 * **2026-09-20 起这里不再是纯再导出。** 导出的 exec/execSync/execAsync/spawn 会给
 * 处于**命令位置**的 kubectl 插入 `--context <活跃集群>`、给 helm 插入
 * `--kube-context <活跃集群>`，理由见 `utils/kubectlContext.js` 头注释（切集群是全局
 * 可变状态突变，在飞的调用会打错集群）。
 *
 * 行为契约：
 * - **kubectl 和 helm 两类命令都处理**。helm 起初被划在「原样透传」里，直到实测发现
 *   `_installKuberayOperator()` 用 `&&` 串起来的一条命令会分裂：两段 kubectl 打活跃
 *   集群、`helm upgrade --install` 打 current-context（见 260920-refactor.md 的 7.18）。
 * - 既不含 kubectl 也不含 helm 的命令（`aws ...`、`eksctl ...`）**原样透传**，与改动前
 *   逐字节一致。eksctl 不在注入范围内是因为它的调用点都显式带 `--cluster`/`--region`。
 * - 处于命令位置的 kubectl/helm 都会被处理，包括 `a | kubectl ...`、`a && helm ...`、
 *   多行脚本里换行之后的；引号里嵌套的（`sh -c "kubectl ..."`）不动。
 * - 已经带 `--context` / `--kube-context` / `--kubeconfig` 的命令不被覆盖。
 * - `kubectl config ...` 不注入（它操作的是 kubeconfig 本身）。
 * - 解析不出 context 时不注入，退回旧行为并告警。
 * - 选项对象（encoding/timeout/env/maxBuffer/shell/cwd）一律原样传给 child_process。
 *
 * 因此把某个文件里的 `require('child_process')` 换成本模块，**语义上不再是 no-op**：
 * 它的 kubectl 调用会开始显式带 context。这正是我们要的；不想要的调用点请自己带
 * `--context`，或改用 `utils/kubectl.js` 的 `runKubectl(cmd, { context })`。
 *
 * **只有一层注入**：`utils/kubectl.js` 自己注入并直接用 child_process，不经过本模块。
 * 两层叠加会让 `runKubectl(cmd, { context: null })`（显式要求不注入）被这里悄悄覆盖。
 */
const childProcess = require('child_process');
const { promisify } = require('util');
const kubectlContext = require('./kubectlContext');

const rawExecAsync = promisify(childProcess.exec);

/**
 * 只改含 kubectl / helm 调用的命令；其余原样返回（含非字符串入参）。
 *
 * 名字保留为 `applyKubectlContext`（已是对外导出契约，测试和文档都引用它），但它
 * 现在同时处理 helm 的 `--kube-context`。两次改写互不影响：kubectl 那一遍只匹配命令
 * 位置的 `kubectl`，helm 那一遍只匹配命令位置的 `helm`。
 */
function applyKubectlContext(command) {
  const hasKubectl = kubectlContext.hasKubectlInvocation(command);
  const hasHelm = kubectlContext.hasHelmInvocation(command);
  if (!hasKubectl && !hasHelm) return command;

  // 一条命令解析一次活跃集群，避免两遍改写之间出现不一致的目标
  const context = kubectlContext.resolveActiveContext();
  let out = command;
  if (hasKubectl) out = kubectlContext.injectContextIntoCommand(out, context);
  if (hasHelm) out = kubectlContext.injectHelmContextIntoCommand(out, context);
  return out;
}

function exec(command, ...rest) {
  return childProcess.exec(applyKubectlContext(command), ...rest);
}

function execSync(command, ...rest) {
  return childProcess.execSync(applyKubectlContext(command), ...rest);
}

function execAsync(command, ...rest) {
  return rawExecAsync(applyKubectlContext(command), ...rest);
}

// `spawn('bash', ['-c', script])` 里的 script 是一整段 shell 文本，需要和 exec 的命令
// 一样处理。整条依赖配置流程（建 namespace、装 helm chart、装 CSI driver）都走这条路径
// ——它们是最不能打错集群的一批写操作。
const SHELL_FILES = new Set(['sh', 'bash', '/bin/sh', '/bin/bash', '/usr/bin/bash']);

/**
 * argv 形式的注入，两种情形：
 * 1. `spawn('kubectl', [...])`：长驻进程（`logs -f`、`port-forward`）。它们尤其需要
 *    显式 context——进程起来之后 kubeconfig 怎么改都与它无关，目标必须在启动时钉死。
 * 2. `spawn('bash', ['-c', script])`：把 script 当命令字符串处理。
 */
function patchSpawnArgs(file, args) {
  if (!Array.isArray(args)) return args;

  if (file === 'kubectl') {
    return kubectlContext.injectContextIntoArgs(args, kubectlContext.resolveActiveContext());
  }

  if (SHELL_FILES.has(file)) {
    const i = args.indexOf('-c');
    if (i >= 0 && typeof args[i + 1] === 'string') {
      const patched = applyKubectlContext(args[i + 1]);
      if (patched !== args[i + 1]) {
        const copy = args.slice();
        copy[i + 1] = patched;
        return copy;
      }
    }
  }

  return args;
}

function spawn(file, args, options) {
  const patched = patchSpawnArgs(file, args);
  if (options === undefined) {
    return patched === undefined ? childProcess.spawn(file) : childProcess.spawn(file, patched);
  }
  return childProcess.spawn(file, patched, options);
}

module.exports = { exec, execSync, spawn, execAsync, applyKubectlContext, patchSpawnArgs };
