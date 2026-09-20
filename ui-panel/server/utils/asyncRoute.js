/**
 * async 路由处理器的错误通道（E8）
 *
 * express 4 不认 handler 返回的 Promise：async handler 一旦拒绝，异常既不会进
 * `next(err)`，也不会被框架捕获，而是变成进程级 unhandledRejection。而
 * `index.js` 的 `process.on('unhandledRejection')` 走的是 `gracefulShutdown()`
 * → `process.exit(1)`，**一个请求的异常会关掉整个面板**，并且客户端连响应都收不到
 * （socket 直接断）。2026-09-20 的边界校验轮里就撞上过一次：一个会抛的测试桩
 * 经 `routes/fsxStorage.js` 把 jest 进程带走，测试摘要都没打出来。
 *
 * 所以这里提供两件配套的东西，必须成对使用：
 *
 * - `asyncHandler(fn)`：把拒绝转成 `next(err)`。**没有它，下面那个中间件永远收不到
 *   async handler 的异常**——这是 express 4 与 5 的关键差异，别只加中间件就以为修好了。
 * - `routeErrorHandler`：唯一的兜底响应点，在 `index.js` 里挂在所有路由之后。
 *
 * 为什么不逐个 handler 包 try/catch：那四个文件共 28 个 handler，其中
 * `routes/clusterLifecycle.js` 是 15 行一对一委托（`(req, res) => api.handleX(req, res)`），
 * 包成 try/catch 会变成 75 行样板；而包装器是结构性的——新加的 handler 只要包上就不可能
 * 再漏，漏了也有 `__tests__/routes/asyncRoute.test.js` 的守卫测试拦住。
 */

/**
 * 包住 async 路由处理器，让拒绝走 Express 的错误通道。
 *
 * 同步抛出也一并接住（`Promise.resolve()` 之前就抛的情况由 try 兜住），
 * 这样调用方不需要区分 handler 是不是 async。
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: Function) => any} fn
 * @returns {(req: any, res: any, next: Function) => void}
 */
function asyncHandler(fn) {
  return function asyncHandlerWrapped(req, res, next) {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * 集中的错误响应中间件。必须挂在所有路由之后（包括 SPA fallback）。
 *
 * 几个取舍：
 * - 状态码优先用 `err.status` / `err.statusCode`：`express.json()` 遇到非法 JSON 抛的是
 *   带 `status: 400` 的 SyntaxError，不该被一律报成 500。
 * - 响应体沿用本项目既有形状 `{ success: false, error }`，前端的错误处理已经按这个形状写。
 *   带上 `err.message`（不带 stack）：本项目的路由本来就会把 kubectl/aws 的 stderr 回给
 *   前端，排障需要这一行；stack 只进服务端日志。
 * - `res.headersSent` 时不能再写响应（已经发出去的部分无法撤回），交回 Express 默认处理器，
 *   由它断开连接；这里只保证日志里有记录。
 */
function routeErrorHandler(err, req, res, next) {
  const status = err?.status || err?.statusCode || 500;
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

module.exports = { asyncHandler, routeErrorHandler };
