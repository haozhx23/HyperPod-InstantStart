/**
 * routes/storage.js
 * -----------------------------------------------------------
 * S3 storage + model-download endpoints, extracted verbatim from
 * index.js (Phase 3 route-extraction, wave 3).
 *
 * Validates the `broadcast` injection path: these routes push
 * WebSocket events on success, so broadcast (defined in index.js,
 * backed by wss) is injected via initialize(). s3StorageManager is
 * the index.js-owned `new S3StorageManager()` instance — injected
 * so this module shares it (index.js still uses it elsewhere, e.g.
 * /api/cluster/s3-buckets).
 *
 * NOT moved here (stays in index.js): the FSx storage routes — they
 * live inside a withheld-feature (FSx Lustre) release sentinel block
 * and must not be relocated until the dedicated sentinel-aware wave.
 *
 * Mounted at `/api` by index.js.
 * -----------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const { collectInvalid, collectPresent, rejectInvalid } = require('../utils/validateInput');
// 每个 handler 都过 asyncHandler（E8）：express 4 不接管 async handler 返回的 Promise，
// 拒绝会成为进程级 unhandledRejection，而 index.js 的兜底是关停整个面板。
const { asyncHandler } = require('../utils/asyncRoute');

// Injected from index.js.
let broadcast = null;
let s3StorageManager = null;

function initialize(deps) {
  broadcast = deps.broadcast;
  s3StorageManager = deps.s3StorageManager;
}

// S3存储管理API
router.get('/s3-storages', asyncHandler(async (req, res) => {
  const result = await s3StorageManager.getStorages();
  res.json(result);
}));

// 获取S3存储默认值
router.get('/s3-storage-defaults', asyncHandler((req, res) => {
  const result = s3StorageManager.getStorageDefaults();
  res.json(result);
}));

router.post('/s3-storages', asyncHandler(async (req, res) => {
  // name 会原样成为 PVC 名（`s3StorageManager.js:365`「完全透传」），再拼进
  // `kubectl get pvc ${pvcName} ...` 与 `kubectl delete ${type} ${name}`。
  //
  // 只校验**已出现**的字段：这里的职责是「若有值则必须安全」，不是引入必填约束。
  // 缺字段仍由 s3StorageManager.createStorage 返回 { success:false, error } 处理——
  // 在这里顺手把它变成必填会改掉现有 API 契约（已有的路由契约测试就只送 name）。
  // 这条规则后来抽成了 `collectPresent()`，本处即它的第一个调用点。
  const problems = collectPresent([
    ['name', req.body?.name, 'token', { maxLength: 63 }],
    ['bucketName', req.body?.bucketName, 'token', {}],
    ['region', req.body?.region, 'token', { maxLength: 32 }],
  ]);
  if (problems.length > 0) return rejectInvalid(res, problems, 'POST /s3-storages');

  const result = await s3StorageManager.createStorage(req.body);
  if (result.success) {
    broadcast({
      type: 's3_storage_created',
      status: 'success',
      message: `S3 storage ${req.body.name} created successfully`
    });
  }
  res.json(result);
}));

router.delete('/s3-storages/:name', asyncHandler(async (req, res) => {
  const problems = collectInvalid([['name', req.params.name, 'token', { maxLength: 63 }]]);
  if (problems.length > 0) return rejectInvalid(res, problems, 'DELETE /s3-storages/:name');

  const result = await s3StorageManager.deleteStorage(req.params.name);
  if (result.success) {
    broadcast({
      type: 's3_storage_deleted',
      status: 'success',
      message: `S3 storage ${req.params.name} deleted successfully`
    });
  }
  res.json(result);
}));

// 增强的模型/数据集下载API
router.post('/download-model-enhanced', asyncHandler(async (req, res) => {
  const { modelId } = req.body;

  if (typeof modelId !== 'string' || !modelId.trim()) {
    return res.json({ success: false, error: 'ID is required' });
  }

  const maxWorkers = Number(req.body.maxWorkers ?? 8);
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 32) {
    return res.json({ success: false, error: 'maxWorkers must be an integer between 1 and 32' });
  }

  const downloadConfig = {
    ...req.body,
    modelId: modelId.trim(),
    maxWorkers
  };
  const result = await s3StorageManager.applyEnhancedDownloadJob(downloadConfig);

  // 广播结果
  broadcast({
    type: 'model_download',
    status: result.success ? 'success' : 'error',
    message: result.success
      ? `Download started: ${downloadConfig.modelId}`
      : `Failed to start download: ${result.error}`,
    jobName: result.jobName
  });

  res.json(result);
}));

// S3存储信息API - 从s3-pv PersistentVolume获取桶信息
router.get('/s3-storage', asyncHandler(async (req, res) => {
  const { storage } = req.query;
  // storage 可省略（走默认存储）；给了就必须是干净的名字——它会被用于查 PVC
  if (storage !== undefined) {
    const problems = collectInvalid([['storage', storage, 'token', { maxLength: 63 }]]);
    if (problems.length > 0) return rejectInvalid(res, problems, 'GET /s3-storage');
  }
  const result = await s3StorageManager.listStorageContent(storage);
  res.json(result);
}));

module.exports = { router, initialize };
