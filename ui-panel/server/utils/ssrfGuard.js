/**
 * SSRF Guard — /api/proxy-request* 的目标校验
 *
 * 背景：这两个路由把请求体里的 `url` 原样交给 `makeHttpRequest`，响应体原样回传。
 * 容器是 `--network host` 且挂了 `~/.aws:ro`，所以一个认证后的调用方原本可以拿它
 * 探测 VPC 内部、K8s API、本机其它监听端口，以及 IMDSv1。
 *
 * 为什么不是「拒绝私有网段」：本项目的**合法**目标本身就在私有网段里——
 * LoadBalancer 拿不到外部地址时会回退到 ClusterIP（`10.x`/`172.20.x`），
 * port-forward 模式的目标是 `127.0.0.1:<localPort>`。按网段拉黑会直接打断模型测试功能。
 *
 * 所以改成两层：
 *   1. 无条件硬拦：非 http(s) 协议、链路本地段（含 IMDS 169.254.169.254）。
 *      主机名会先做 DNS 解析再复查，避免一个指向 IMDS 的域名绕过检查。
 *   2. 目标白名单：host:port 必须对得上本集群里一个真实存在的 Service
 *      （ClusterIP 或 LoadBalancer ingress + 该 Service 声明的端口）。
 *      白名单的数据源与前端挑选可测服务的数据源是同一个，所以 UI 能发起的请求必然在名单内。
 *
 * 已知边界：DNS 解析与真正建连之间存在 TOCTOU 窗口（DNS rebinding）。彻底消除需要把
 * 校验过的 IP 固定到 socket 上（自定义 agent/lookup）。当前实现挡住了误配置和一次性
 * 重定向到 IMDS 的情形，但不声称能挡住主动的 rebinding 攻击。
 */

const dnsPromises = require('dns').promises;
const net = require('net');

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 链路本地：IPv4 169.254.0.0/16（含 IMDS 169.254.169.254）与 IPv6 fe80::/10。
 * 这里没有任何合法用途，两个路由都拦。
 */
function isLinkLocal(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 169 && b === 254;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    // fe80::/10 → fe80 ~ febf
    return /^fe[89ab][0-9a-f]:/.test(lower) || lower.startsWith('fe80:');
  }
  return false;
}

function isLoopback(ip) {
  if (net.isIPv4(ip)) return ip.split('.')[0] === '127';
  if (net.isIPv6(ip)) return ip === '::1' || ip === '::ffff:127.0.0.1';
  return false;
}

/**
 * 解析目标地址。主机名会走 DNS，字面量 IP 直接返回自身。
 * @returns {Promise<string[]>} 解析出的 IP 列表
 */
async function resolveHost(hostname) {
  if (net.isIP(hostname)) return [hostname];
  const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return records.map(r => r.address);
}

/**
 * 第一层：与具体目标无关的硬性检查。
 *
 * @param {string} rawUrl
 * @param {{allowLoopback?: boolean}} options
 * @returns {Promise<{ok: true, urlObj: URL, addresses: string[]} | {ok: false, reason: string}>}
 */
async function inspectTarget(rawUrl, { allowLoopback = false } = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return { ok: false, reason: 'url 必须是非空字符串' };
  }

  let urlObj;
  try {
    urlObj = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `url 无法解析: ${rawUrl}` };
  }

  if (!ALLOWED_PROTOCOLS.has(urlObj.protocol)) {
    return { ok: false, reason: `只允许 http/https，收到 ${urlObj.protocol}` };
  }
  if (!urlObj.hostname) {
    return { ok: false, reason: 'url 缺少 hostname' };
  }

  let addresses;
  try {
    addresses = await resolveHost(urlObj.hostname);
  } catch (err) {
    return { ok: false, reason: `无法解析主机 ${urlObj.hostname}: ${err.code || err.message}` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: `主机 ${urlObj.hostname} 没有解析出地址` };
  }

  // 任一解析结果落在禁区就整体拒绝，不做「挑一个能用的」
  for (const ip of addresses) {
    if (isLinkLocal(ip)) {
      return { ok: false, reason: `目标解析到链路本地地址 ${ip}（含实例元数据服务），已拒绝` };
    }
    if (!allowLoopback && isLoopback(ip)) {
      return { ok: false, reason: `目标解析到回环地址 ${ip}，该路由不允许访问本机端口` };
    }
  }

  return { ok: true, urlObj, addresses };
}

/**
 * 构造直连代理路由（`/api/proxy-request`）的白名单：host → 允许的端口集合。
 *
 * 只收 `type === 'LoadBalancer'` 的 Service，因为前端在直连模式下只列这一类
 * （`TestPanel.js` 的 `modelServices` 过滤条件）。这条限制不是可选的加固：
 * `default` 命名空间里的 `kubernetes` Service 就是 API server（`172.20.0.1:443`），
 * 不按类型收窄的话它会进白名单，等于把 K8s API 留在射程内。
 *
 * host 的三种形态与前端 `getServiceUrl()` 一一对应：
 *   - LoadBalancer ingress 的 hostname（NLB 域名）
 *   - LoadBalancer ingress 的 ip
 *   - 该 Service 的 ClusterIP —— 外部地址还没分配下来时前端会回退到它
 *
 * @param {Array} services K8s Service 对象数组
 * @returns {Map<string, Set<number>>}
 */
function buildAllowlist(services) {
  const allowlist = new Map();

  const add = (host, port) => {
    if (!host || !port) return;
    const key = String(host).toLowerCase();
    if (!allowlist.has(key)) allowlist.set(key, new Set());
    allowlist.get(key).add(Number(port));
  };

  (services || []).forEach(svc => {
    if (svc?.spec?.type !== 'LoadBalancer') return;
    if (svc?.metadata?.name === 'kubernetes') return;   // 冗余但显式：系统服务永不入名单

    const ports = (svc?.spec?.ports || []).map(p => p.port).filter(Boolean);
    if (ports.length === 0) return;

    const hosts = [];
    // headless service 的 clusterIP 是 'None'，不是可连的地址
    if (svc.spec.clusterIP && svc.spec.clusterIP !== 'None') {
      hosts.push(svc.spec.clusterIP);
    }
    (svc?.status?.loadBalancer?.ingress || []).forEach(ing => {
      if (ing?.hostname) hosts.push(ing.hostname);
      if (ing?.ip) hosts.push(ing.ip);
    });

    hosts.forEach(h => ports.forEach(p => add(h, p)));
  });

  return allowlist;
}

/**
 * 第二层：目标必须命中白名单。
 *
 * @param {URL} urlObj
 * @param {Map<string, Set<number>>} allowlist
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function matchAllowlist(urlObj, allowlist) {
  const host = urlObj.hostname.toLowerCase();
  const port = Number(urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80));

  const ports = allowlist.get(host);
  if (!ports) {
    return {
      ok: false,
      reason: `目标主机 ${host} 不属于本集群任何已知 Service（ClusterIP / LoadBalancer 地址）`
    };
  }
  if (!ports.has(port)) {
    return {
      ok: false,
      reason: `端口 ${port} 不在主机 ${host} 对应 Service 声明的端口中（允许: ${[...ports].join(', ')}）`
    };
  }
  return { ok: true };
}

/**
 * port-forward 路由专用：目标必须是本机上服务端刚刚建立的那个端口。
 *
 * 比网段判断严格得多——端口号要等于服务端自己分配的 localPort，
 * 所以调用方没法借这个路由去扫本机其它端口。
 */
function checkPortForwardTarget(urlObj, expectedLocalPort) {
  const port = Number(urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80));
  const expected = Number(expectedLocalPort);

  if (!Number.isInteger(expected) || expected <= 0 || expected > 65535) {
    return { ok: false, reason: `portForward.localPort 非法: ${expectedLocalPort}` };
  }
  if (port !== expected) {
    return {
      ok: false,
      reason: `port-forward 模式下目标端口必须等于 portForward.localPort(${expected})，收到 ${port}`
    };
  }
  return { ok: true };
}

module.exports = {
  inspectTarget,
  buildAllowlist,
  matchAllowlist,
  checkPortForwardTarget,
  // 导出供测试使用
  isLinkLocal,
  isLoopback,
};
