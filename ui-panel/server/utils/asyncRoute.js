/**
 * 路由错误的统一出口（E8）
 *
 * Express 5 会把 handler 返回的 rejected Promise 和同步抛出都交给 `next(err)`，
 * 所以挂在 `index.js` 所有路由之后的 `routeErrorHandler` 能接住任何路由的异常。
 *
 * 历史：Express 4 不接管 handler 返回的 Promise，async handler 一旦拒绝就变成进程级
 * unhandledRejection，`index.js` 的兜底是 `gracefulShutdown()` → `process.exit(1)`，
 * 一个请求的异常会关掉整个面板。当时的修法是在 4 个路由文件里逐个包 `asyncHandler`。
 * 2026-11-06 升级到 Express 5 后包装已删除；`__tests__/routes/asyncRoute.test.js`
 * 钉住了"Express 必须是 5.x、未包装的 async 拒绝必须到达本中间件"，降级时会失败。
 */

/**
 * 集中的错误响应中间件。必须挂在所有路由之后（包括 SPA fallback）。
 *
 * 几个取舍：
 * - 状态码只采用 `err.status` / `err.statusCode` 里 400–599 的整数：`express.json()` 遇到
 *   非法 JSON 抛的是带 `status: 400` 的 SyntaxError，不该被一律报成 500；但 `execSync`
 *   抛出的错误也带 `status`，那是子进程退出码（1、254 …），拿去当 HTTP 状态码会让
 *   `res.status()` 抛 RangeError（Express 5 校验状态码），所以其余情况一律 500。
 * - 响应体沿用本项目既有形状 `{ success: false, error }`，前端的错误处理已经按这个形状写。
 *   带上 `err.message`（不带 stack）：本项目的路由本来就会把 kubectl/aws 的 stderr 回给
 *   前端，排障需要这一行；stack 只进服务端日志。
 * - `res.headersSent` 时不能再写响应（已经发出去的部分无法撤回），交回 Express 默认处理器，
 *   由它断开连接；这里只保证日志里有记录。
 */
function routeErrorHandler(err, req, res, next) {
  const raw = err?.status ?? err?.statusCode;
  const status = Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;
  const detail = err?.message || String(err);

  // 无条件留痕：位置（方法 + 路径）、实际情况（message）、以及完整 stack。
  console.error(`[routeError] ${req.method} ${req.originalUrl || req.url} → ${status}: ${detail}`);
  if (err?.stack) console.error(err.stack);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(status).json({
    success: false,
    error: detail,
  });
}

module.exports = { routeErrorHandler };
