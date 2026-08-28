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

// Injected from index.js.
let broadcast = null;
let s3StorageManager = null;

function initialize(deps) {
  broadcast = deps.broadcast;
  s3StorageManager = deps.s3StorageManager;
}

// S3存储管理API
router.get('/s3-storages', async (req, res) => {
  const result = await s3StorageManager.getStorages();
  res.json(result);
});

// 获取S3存储默认值
router.get('/s3-storage-defaults', (req, res) => {
  const result = s3StorageManager.getStorageDefaults();
  res.json(result);
});

router.post('/s3-storages', async (req, res) => {
  const result = await s3StorageManager.createStorage(req.body);
  if (result.success) {
    broadcast({
      type: 's3_storage_created',
      status: 'success',
      message: `S3 storage ${req.body.name} created successfully`
    });
  }
  res.json(result);
});

router.delete('/s3-storages/:name', async (req, res) => {
  const result = await s3StorageManager.deleteStorage(req.params.name);
  if (result.success) {
    broadcast({
      type: 's3_storage_deleted',
      status: 'success',
      message: `S3 storage ${req.params.name} deleted successfully`
    });
  }
  res.json(result);
});

// 增强的模型/数据集下载API
router.post('/download-model-enhanced', async (req, res) => {
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
});

// S3存储信息API - 从s3-pv PersistentVolume获取桶信息
router.get('/s3-storage', async (req, res) => {
  const { storage } = req.query;
  const result = await s3StorageManager.listStorageContent(storage);
  res.json(result);
});

module.exports = { router, initialize };
