/**
 * Log Stream Manager
 *
 * Pod 日志管理 API 模块，从 index.js 提取
 *
 * 包含的 API:
 * - GET /:jobName/:podName - 获取完整日志文件
 * - GET /:jobName/:podName/download - 下载日志文件
 * - GET /:jobName/:podName/info - 获取日志文件信息
 *
 * 注意: 集群创建日志 (/api/cluster/logs/*) 由 multiClusterAPIs 模块处理
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// 日志存储目录
const LOGS_BASE_DIR = path.join(__dirname, '..', 'logs');
const LOGS_BASE_RESOLVED = path.resolve(LOGS_BASE_DIR);

/**
 * K8s 资源名遵循 RFC 1123（小写字母数字与 `.`、`-`），这里的白名单是它的超集。
 * 目的不是校验名字是否合法，而是让参数不可能构成路径分隔符。
 * 额外禁止以 `-` 开头：这些值还会作为参数传给 `spawn('kubectl', [...])`，
 * 以 `-` 开头会被 kubectl 当成 flag（数组形式没有 shell，但仍有参数注入）。
 */
const SAFE_NAME = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;

function isSafeName(value) {
  return typeof value === 'string' && value.length <= 253 && SAFE_NAME.test(value);
}

/**
 * 校验并解析日志文件的绝对路径。
 *
 * 白名单已经排除了 `/` 和 `\`，但 `..` 整体是合法名字，所以必须再做一次包含性校验
 * ——两层都要有，缺哪一层都能被绕过。
 *
 * @returns {string|null} 绝对路径；参数非法或结果越出 LOGS_BASE_DIR 时返回 null
 */
function resolveLogFilePath(jobName, podName) {
  if (!isSafeName(jobName) || !isSafeName(podName)) return null;

  const resolved = path.resolve(LOGS_BASE_RESOLVED, jobName, `${podName}.log`);
  if (!resolved.startsWith(LOGS_BASE_RESOLVED + path.sep)) return null;
  return resolved;
}

/**
 * 确保日志目录存在，返回日志文件路径。
 *
 * 这是**写**路径：调用方把 WebSocket 消息里的 jobName/podName 直接传进来，
 * 校验不通过必须抛错而不是退化成某个默认路径——否则会在 logs/ 之外建目录、写文件。
 *
 * @throws {Error} 名称非法时
 * @returns {string} 日志文件完整路径
 */
function ensureLogDirectory(jobName, podName) {
  const logFilePath = resolveLogFilePath(jobName, podName);
  if (!logFilePath) {
    throw new Error(
      `非法的日志路径参数: jobName=${JSON.stringify(jobName)} podName=${JSON.stringify(podName)}；` +
      `只接受 [a-zA-Z0-9_.-]、不以 - 开头、且解析后必须位于 ${LOGS_BASE_RESOLVED} 之内`
    );
  }

  const jobLogDir = path.dirname(logFilePath);
  if (!fs.existsSync(jobLogDir)) {
    fs.mkdirSync(jobLogDir, { recursive: true });
  }
  return logFilePath;
}

/**
 * 参数非法时的统一响应。用 400 而不是 404：区分「名字不合法」和「文件不存在」，
 * 否则遍历尝试和正常的缺文件长得一样，日志里看不出有人在探路。
 */
function rejectInvalidName(res, jobName, podName) {
  console.warn(`[logs] 拒绝非法日志路径参数: jobName=${JSON.stringify(jobName)} podName=${JSON.stringify(podName)}`);
  return res.status(400).json({
    success: false,
    error: 'Invalid jobName or podName'
  });
}

// ==================== 获取完整日志文件 API ====================

/**
 * GET /:jobName/:podName
 * 获取完整日志文件内容
 */
router.get('/:jobName/:podName', (req, res) => {
  try {
    const { jobName, podName } = req.params;
    const logFilePath = resolveLogFilePath(jobName, podName);
    if (!logFilePath) return rejectInvalidName(res, jobName, podName);

    if (fs.existsSync(logFilePath)) {
      res.sendFile(path.resolve(logFilePath));
    } else {
      res.status(404).json({
        success: false,
        error: 'Log file not found',
        path: logFilePath
      });
    }
  } catch (error) {
    console.error('Error serving log file:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== 下载日志文件 API ====================

/**
 * GET /:jobName/:podName/download
 * 下载完整日志文件
 */
router.get('/:jobName/:podName/download', (req, res) => {
  try {
    const { jobName, podName } = req.params;
    const logFilePath = resolveLogFilePath(jobName, podName);
    if (!logFilePath) return rejectInvalidName(res, jobName, podName);

    if (fs.existsSync(logFilePath)) {
      res.download(logFilePath, `${podName}.log`, (err) => {
        if (err) {
          console.error('Error downloading log file:', err);
          res.status(500).json({
            success: false,
            error: 'Failed to download log file'
          });
        }
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Log file not found',
        path: logFilePath
      });
    }
  } catch (error) {
    console.error('Error downloading log file:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== 获取日志文件信息 API ====================

/**
 * GET /:jobName/:podName/info
 * 获取日志文件的元信息（大小、创建时间等）
 */
router.get('/:jobName/:podName/info', (req, res) => {
  try {
    const { jobName, podName } = req.params;
    const logFilePath = resolveLogFilePath(jobName, podName);
    if (!logFilePath) return rejectInvalidName(res, jobName, podName);

    if (fs.existsSync(logFilePath)) {
      const stats = fs.statSync(logFilePath);
      res.json({
        success: true,
        info: {
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime,
          path: logFilePath
        }
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Log file not found'
      });
    }
  } catch (error) {
    console.error('Error getting log file info:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== 模块导出 ====================

module.exports = {
  router,
  LOGS_BASE_DIR,
  ensureLogDirectory,
  resolveLogFilePath,
  isSafeName
};
