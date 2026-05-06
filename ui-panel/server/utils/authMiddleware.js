const fs = require('fs-extra');
const path = require('path');

const AUTH_CONFIG_PATH = path.join(__dirname, '../../config/auth.json');

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
  if (token === hash) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function verifyHandler(req, res) {
  if (!isAuthActive()) return res.json({ valid: true, authDisabled: true });
  const { hash } = getAuthConfig();
  const { token } = req.body || {};
  res.json({ valid: token === hash });
}

module.exports = { authMiddleware, verifyHandler, getAuthConfig, isAuthActive };
