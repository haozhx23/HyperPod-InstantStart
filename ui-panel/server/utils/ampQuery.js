/**
 * Amazon Managed Service for Prometheus（AMP）只读 PromQL 查询。
 *
 * 面板调用 AWS 一律经 AWS CLI，但 CLI 没有 PromQL 查询命令。这里只借 CLI 取凭证
 * （`aws configure export-credentials`，与面板其他 aws 调用同一条凭证链：容器挂载的
 * ~/.aws 或实例角色），请求用 Node 自带的 crypto 做 SigV4 签名，不引入 AWS SDK。
 *
 * IAM：调用方需要 `aps:QueryMetrics`（cli-min/pre-requisites/eks-hypd-workspace.yaml 的
 * EKSPlusHYPDAdminRole 已含 `aps:*`）。
 */

const crypto = require('crypto');
const { execFile } = require('child_process');
const { isAwsRegion } = require('./validateInput');

const SERVICE = 'aps';
const WORKSPACE_ID = /^ws-[a-z0-9-]+$/;
// 临时凭证在过期前这么久就换新，避免签名后、请求到达前过期
const CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const EXPORT_CREDENTIALS_TIMEOUT_MS = 15000;
const QUERY_TIMEOUT_MS = 20000;
const ERROR_BODY_LIMIT = 300;

const sha256Hex = data => crypto.createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/** 2026-11-19T06:00:00.000Z → 20261119T060000Z */
function amzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * SigV4 签名。只覆盖本模块用到的形状：不带查询串的请求、路径只含 unreserved 字符
 * （AMP 的 `/workspaces/<ws-id>/api/v1/query`），所以 canonical URI 无需再编码。
 * 与 botocore `SigV4Auth` 的输出逐字一致，见 __tests__/utils/ampQuery.test.js。
 *
 * @returns {Record<string,string>} 需要随请求发送的头（不含 host，由 fetch 按 URL 生成）
 */
function signRequest({ method, url, headers = {}, body = '', credentials, region, service = SERVICE, now = new Date() }) {
  const { host, pathname, search } = new URL(url);
  if (search) throw new Error('signRequest: query strings are not supported; send parameters in the form body.');
  if (!/^[A-Za-z0-9/._~-]+$/.test(pathname)) throw new Error(`signRequest: unsupported characters in path ${pathname}`);

  const timestamp = amzDate(now);
  const day = timestamp.slice(0, 8);
  const extra = { 'X-Amz-Date': timestamp };
  if (credentials.sessionToken) extra['X-Amz-Security-Token'] = credentials.sessionToken;

  const toSign = {};
  for (const [name, value] of Object.entries({ ...headers, ...extra, host })) {
    toSign[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  }
  const names = Object.keys(toSign).sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    method,
    pathname,
    '',
    names.map(name => `${name}:${toSign[name]}\n`).join(''),
    signedHeaders,
    sha256Hex(body),
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    ...extra,
    Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function runAwsCli(args) {
  return new Promise((resolve, reject) => {
    execFile('aws', args, { timeout: EXPORT_CREDENTIALS_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const reason = (stderr || '').trim() || error.message;
        reject(Object.assign(new Error(`aws ${args.slice(0, 2).join(' ')} failed: ${reason}`), { stderr }));
        return;
      }
      resolve(stdout);
    });
  });
}

/** 解析 `aws configure export-credentials --format process` 的输出；报错信息不带任何凭证内容。 */
function parseExportedCredentials(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('aws configure export-credentials did not return JSON.');
  }
  if (!parsed.AccessKeyId || !parsed.SecretAccessKey) {
    throw new Error('aws configure export-credentials returned no AccessKeyId/SecretAccessKey.');
  }
  const expiresAt = parsed.Expiration ? Date.parse(parsed.Expiration) : null;
  return {
    accessKeyId: parsed.AccessKeyId,
    secretAccessKey: parsed.SecretAccessKey,
    sessionToken: parsed.SessionToken || null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
  };
}

/**
 * 凭证提供者：缓存到过期前 5 分钟；并发请求共用同一次 CLI 调用；失败不缓存。
 */
function createCredentialProvider({ runAws = runAwsCli, now = () => Date.now() } = {}) {
  let cached = null;
  let pending = null;
  return function getCredentials() {
    if (cached && (cached.expiresAt === null || cached.expiresAt - now() > CREDENTIAL_REFRESH_MARGIN_MS)) {
      return Promise.resolve(cached);
    }
    if (!pending) {
      pending = runAws(['configure', 'export-credentials', '--format', 'process'])
        .then(parseExportedCredentials)
        .then(credentials => { cached = credentials; return credentials; })
        .finally(() => { pending = null; });
    }
    return pending;
  };
}

/**
 * PromQL instant query（POST /api/v1/query）。
 *
 * @param {object} params
 * @param {string} params.region       AMP workspace 所在 region
 * @param {string} params.workspaceId  `ws-...`
 * @param {string} params.query        PromQL
 * @param {number} params.time         求值时刻（毫秒）
 * @returns {Promise<{resultType: string, result: Array}>} Prometheus 响应的 `data`
 */
async function queryInstant({ region, workspaceId, query, time, getCredentials, fetchImpl = fetch, now = () => new Date() }) {
  if (!isAwsRegion(region)) throw new Error(`Invalid AMP region: ${region}`);
  if (!WORKSPACE_ID.test(String(workspaceId))) throw new Error(`Invalid AMP workspace id: ${workspaceId}`);
  if (!Number.isFinite(time)) throw new Error('AMP query time must be a finite millisecond timestamp.');

  const url = `https://aps-workspaces.${region}.amazonaws.com/workspaces/${workspaceId}/api/v1/query`;
  const body = new URLSearchParams({ query, time: (time / 1000).toFixed(3) }).toString();
  const credentials = await getCredentials();
  const headers = signRequest({
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    credentials,
    region,
    now: now(),
  });

  const response = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AMP query to ${workspaceId} failed (HTTP ${response.status}): ${text.slice(0, ERROR_BODY_LIMIT)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`AMP query to ${workspaceId} returned non-JSON: ${text.slice(0, ERROR_BODY_LIMIT)}`);
  }
  if (parsed.status !== 'success' || !parsed.data) {
    throw new Error(`AMP query to ${workspaceId} failed: ${parsed.errorType || 'error'} ${parsed.error || ''}`.trim());
  }
  return parsed.data;
}

const defaultGetCredentials = createCredentialProvider();

/** 面板默认使用的客户端；测试通过依赖注入替换。 */
const ampClient = Object.freeze({
  query: params => queryInstant({ ...params, getCredentials: defaultGetCredentials }),
});

module.exports = {
  signRequest,
  parseExportedCredentials,
  createCredentialProvider,
  queryInstant,
  ampClient,
};
