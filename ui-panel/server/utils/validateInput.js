/**
 * 路由边界的输入校验（S1）
 *
 * 本项目几乎所有 kubectl / aws 调用都是模板字符串过 `sh -c`，用户输入直接拼进命令。
 * 把 182 处调用全改成 argv 数组是另一件事（见重构计划 P1），而**在边界卡住名字**
 * 能用一处改动同时封住下游所有用法：shell 命令、临时文件路径、kubectl 参数。
 *
 * 设计取舍：这里不做 RFC 1123 合法性校验，只做**注入安全性**校验。
 *
 * 原因是本项目里流经这些参数的值不全是严格的 K8s 资源名——有 storage name、
 * modelTag、资源类型等，其中存在大写和下划线。若在这里强制 RFC 1123 的小写规则，
 * 会拒掉现在能正常工作的输入。所以采用字符白名单：凡是 shell 元字符、路径分隔符、
 * 空白和换行一律拒绝，名字本身是否符合 K8s 规范交给 kubectl 自己报错（它的报错更准确）。
 *
 * 与 `logStreamManager.js` 里那个 `isSafeName` 的区别：那一个服务于日志文件路径，
 * 允许首字符为 `.`（配合目录包含性校验处理 `..`）；这里禁止首字符为 `.` 和 `-`。
 * 两者规则不同是有意的，不要合并。
 */

// 首字符必须是字母或数字，其余允许字母数字与 . _ -
// 显式排除：; | & $ ` ' " \ / 空白 换行 () <> * ? [] {} ~ ! # % ^ = + , :
const SAFE_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const DEFAULT_MAX_LENGTH = 253;   // K8s 资源名上限

/**
 * @param {*} value
 * @param {{maxLength?: number}} [options]
 * @returns {boolean}
 */
function isSafeToken(value, { maxLength = DEFAULT_MAX_LENGTH } = {}) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && SAFE_TOKEN.test(value);
}

/**
 * 非负整数校验。用于 minSize/maxSize/desiredSize 这类会被拼进命令的数值。
 *
 * 必须显式做类型校验：`desiredSize: "1 --profile other-account"` 在模板字符串里
 * 会原样展开，附加的 flag 会被 aws CLI 当成真参数。
 *
 * 接受 number 或十进制数字字符串；拒绝小数、负数、科学计数法、前后空白。
 */
function isNonNegativeInt(value, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= max;
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return false;
    const n = Number(value);
    return Number.isSafeInteger(n) && n <= max;
  }
  return false;
}

/**
 * 非负数校验（允许小数）。用于 KEDA 阈值这类会被拼进 YAML 的数值。
 *
 * 和 `isNonNegativeInt` 分开的理由是具体的：`kedaTrig1ValueThreshold` 在前端是
 * `<InputNumber step={0.1}>`（`ScalingPanel.js:472`），小数是合法输入。用 int 规则
 * 去卡它会把正常的 `2.5` 拒掉——那是把加固做成了功能回退。
 *
 * 拒绝科学计数法、前后空白、Infinity、NaN：这些在 YAML 里的含义与用户意图不一致。
 */
function isNonNegativeNumber(value, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= max;
  }
  if (typeof value === 'string') {
    if (!/^\d+(\.\d+)?$/.test(value)) return false;
    const n = Number(value);
    return Number.isFinite(n) && n <= max;
  }
  return false;
}

// ARN 里有 `:` 和 `/`，过不了 SAFE_TOKEN，但它同样会被拼进命令，需要单独一条规则。
// 例如 `aws sagemaker update-cluster-software --cluster-name "${clusterArn}"`：值在双引号里，
// `;` 确实进不来，但 `$( )` 和反引号**在双引号内照样展开**，所以双引号不是防护。
const SAFE_ARN = /^arn:[a-zA-Z0-9][a-zA-Z0-9:/._-]*$/;
const ARN_MAX_LENGTH = 2048;

function isSafeArn(value, { maxLength = ARN_MAX_LENGTH } = {}) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && SAFE_ARN.test(value);
}

// CIDR：`10.0.0.0/16`。只做形状校验（四段 0-255 + /0-32），不判断是否私有网段——
// 那是业务规则，由 CidrGenerator 判断。这里只保证它不能携带 shell 元字符。
const SAFE_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

function isSafeCidr(value) {
  if (typeof value !== 'string') return false;
  const m = SAFE_CIDR.exec(value);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some(o => o > 255)) return false;
  return Number(m[5]) <= 32;
}

// Karpenter 的 `amiSelectorTerms[].alias` 形态是 `family@version`（如 `al2023@latest`），
// `@` 过不了 SAFE_TOKEN。加这条规则时它会被拼进字符串式 YAML，一个带换行的值能给
// EC2NodeClass **加出**一个 `userData` 键（= 节点启动脚本，模板里本没有这个键）。
// 生成器已于 2026-09-20 改成 `YAML.stringify`（见 7.16），那条路径不再成立，但这里仍然要校验：
// 值同样会进 kubectl 命令与日志，且边界校验是独立于生成器实现的一层。
// 规则按 Karpenter 自己的格式收紧成两段式，不要因为「过不了 token」就放过。
const SAFE_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isSafeAlias(value, { maxLength = 128 } = {}) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && SAFE_ALIAS.test(value);
}

// K8s 限定名（qualified name）：`name` 或 `dns.subdomain/name`。taint key、label key、
// nodeSelector key 都是这个形态，`nvidia.com/gpu` 里的 `/` 和 `.` 过不了 SAFE_TOKEN。
// 当前落点是 `karpenterManager.generateNodePoolYaml()` 的 taints（已走 `YAML.stringify`）。
const SAFE_QNAME = /^(?:[a-z0-9]([a-z0-9.-]*[a-z0-9])?\/)?[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

function isSafeQualifiedName(value, { maxLength = 317 } = {}) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && SAFE_QNAME.test(value);
}

// 会被拼进**生成代码**的 URI。当前唯一来源是 MLflow 的 tracking_uri，它被插进一段
// Python 脚本的字符串字面量（`mlflowApiManager.js:171` 的 `tracking_uri = "${...}"`），
// 脚本随后由 `spawn('python3', [script])` 执行——闭合引号即可执行任意 Python。
//
// 因此这里有两道独立的检查，不能只靠其中一道：
// 1. 字符黑名单：`"` `'` `\` 反引号 `$` 换行 CR。URL 解析**不会**拦掉它们
//    （`http://h/?a="b` 是能被 `new URL()` 接受的），所以必须单独查。
// 2. 结构校验：必须能被 `new URL()` 解析，且 scheme 只允许 http/https。
const URI_FORBIDDEN = /["'\\`$\n\r]/;

function isSafeUri(value, { maxLength = 2048, protocols = ['http:', 'https:'] } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return false;
  if (URI_FORBIDDEN.test(value)) return false;
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * 批量校验，返回不合法的字段说明列表（空数组表示全部通过）。
 *
 * `'tokens'` 校验数组的每个元素，报错里带下标（`instanceGroups[2] ...`）——出错时要能
 * 指出是哪一个元素，否则前端只能整个表单重填。
 *
 * @param {Array<[string, *, ('token'|'tokens'|'int'|'num'|'arn'|'cidr'|'alias'|'uri'|'qname')?, object?]>} specs [字段名, 值, 类型, 选项]
 * @returns {string[]}
 */
function collectInvalid(specs) {
  const problems = [];
  for (const [field, value, kind = 'token', options = {}] of specs) {
    if (kind === 'tokens') {
      if (!Array.isArray(value) || value.length === 0) {
        problems.push(`${field} 必须是非空数组，收到 ${JSON.stringify(value)}`);
      } else {
        value.forEach((item, i) => {
          if (!isSafeToken(item, options)) {
            problems.push(
              `${field}[${i}] 只允许字母数字与 . _ -（首字符须为字母或数字），收到 ${JSON.stringify(item)}`
            );
          }
        });
      }
    } else if (kind === 'num') {
      if (!isNonNegativeNumber(value, options)) {
        problems.push(`${field} 必须是非负数，收到 ${JSON.stringify(value)}`);
      }
    } else if (kind === 'qname') {
      if (!isSafeQualifiedName(value, options)) {
        problems.push(`${field} 必须是 K8s 限定名（name 或 dns.subdomain/name），收到 ${JSON.stringify(value)}`);
      }
    } else if (kind === 'alias') {
      if (!isSafeAlias(value, options)) {
        problems.push(`${field} 必须是 family@version 形式（只允许字母数字与 . _ -），收到 ${JSON.stringify(value)}`);
      }
    } else if (kind === 'uri') {
      if (!isSafeUri(value, options)) {
        problems.push(`${field} 必须是 http(s) URL 且不含引号、反斜杠、$、反引号或换行，收到 ${JSON.stringify(value)}`);
      }
    } else if (kind === 'int') {
      if (!isNonNegativeInt(value, options)) {
        problems.push(`${field} 必须是非负整数，收到 ${JSON.stringify(value)}`);
      }
    } else if (kind === 'arn') {
      if (!isSafeArn(value, options)) {
        problems.push(`${field} 必须是合法 ARN（arn: 开头，只允许字母数字与 : / . _ -），收到 ${JSON.stringify(value)}`);
      }
    } else if (kind === 'cidr') {
      if (!isSafeCidr(value)) {
        problems.push(`${field} 必须是 a.b.c.d/nn 形式的 CIDR，收到 ${JSON.stringify(value)}`);
      }
    } else if (!isSafeToken(value, options)) {
      problems.push(
        `${field} 只允许字母数字与 . _ -（首字符须为字母或数字，最长 ${options.maxLength || DEFAULT_MAX_LENGTH}），` +
        `收到 ${JSON.stringify(value)}`
      );
    }
  }
  return problems;
}

/**
 * 只校验**出现了的字段**，缺失（undefined / null / 空串）的直接跳过。
 *
 * 存在的理由：安全加固不应顺手改掉 API 契约。给一个可选参数加校验，如果把
 * 「缺失」也当成不合法，那这个参数就变成必填了——2026-09-20 就这么弄坏过一条
 * `POST /s3-storages` 的路由契约测试。缺字段的处理仍归下游业务逻辑。
 *
 * @param {Array<[string, *, ('token'|'tokens'|'int'|'num'|'arn'|'cidr'|'alias'|'uri'|'qname')?, object?]>} specs
 * @returns {string[]}
 */
function collectPresent(specs) {
  return collectInvalid(specs.filter(([, value]) => {
    if (value === undefined || value === null || value === '') return false;
    // 空数组同样算「没给」：没有元素可校验，是否必填仍由下游业务逻辑判断。
    // 不这么处理就会出现 2026-09-20 第三轮发现的那个回归——`instanceTypes: []`
    // （用户没选机型）在 Karpenter 侧原本是合法的（`generateNodePoolYaml` 里
    // `if (config.instanceTypes && length > 0)` 直接跳过），却被 'tokens' 判成非法。
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }));
}

/**
 * 校验失败时的统一 400 响应。
 *
 * 用 400 而不是 500：这是调用方的输入问题，且要能和下游 kubectl/aws 的失败区分开。
 * 同时无条件打一条 warn——注入尝试必须在服务端日志里留痕。
 */
function rejectInvalid(res, problems, context = '') {
  const detail = problems.join('；');
  console.warn(`[validateInput] 拒绝请求${context ? ' (' + context + ')' : ''}: ${detail}`);
  return res.status(400).json({
    success: false,
    error: `参数校验失败: ${detail}`
  });
}

/**
 * 供非路由代码使用：校验不过直接抛错，不要退化成默认值。
 * @throws {Error}
 */
function assertSafeToken(value, field, options = {}) {
  if (!isSafeToken(value, options)) {
    throw new Error(
      `${field} 非法: ${JSON.stringify(value)}；只允许字母数字与 . _ -，首字符须为字母或数字`
    );
  }
  return value;
}

module.exports = {
  isSafeToken,
  isNonNegativeInt,
  isNonNegativeNumber,
  isSafeArn,
  isSafeCidr,
  isSafeAlias,
  isSafeQualifiedName,
  isSafeUri,
  collectInvalid,
  collectPresent,
  rejectInvalid,
  assertSafeToken,
  SAFE_TOKEN,
  SAFE_ARN,
  SAFE_ALIAS,
  SAFE_QNAME,
};
