const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const AUTH_CONFIG_PATH = path.join(__dirname, '../../config/auth.json');

/**
 * 定长时间比较，避免用 === 逐字符短路泄漏前缀正确性。
 * 长度本身不算秘密（hash 固定 64 个十六进制字符），所以长度不等直接返回 false；
 * timingSafeEqual 对长度不等的 Buffer 会抛异常，必须先挡掉。
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getAuthConfig() {
  try {
    const config = fs.readJsonSync(AUTH_CONFIG_PATH);
    return {
      enabled: config.enabled !== false,
      hash: config.hash || '',
    };
  } catch { return { enabled: false, hash: '' }; }
}

function isAuthActive() {
  const { enabled, hash } = getAuthConfig();
  return enabled && !!hash;
}

function authMiddleware(req, res, next) {
  if (!isAuthActive()) return next();
  const { hash } = getAuthConfig();
  const token = req.headers['x-auth-token'];
  if (safeCompare(token, hash)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function verifyHandler(req, res) {
  if (!isAuthActive()) return res.json({ valid: true, authDisabled: true });
  const { hash } = getAuthConfig();
  const { token } = req.body || {};
  res.json({ valid: safeCompare(token, hash) });
}

module.exports = { authMiddleware, verifyHandler, getAuthConfig, isAuthActive, safeCompare };
