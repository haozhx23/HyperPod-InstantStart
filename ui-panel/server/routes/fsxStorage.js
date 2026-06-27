/**
 * FSx Lustre storage routes (withheld feature).
 *
 * Extracted from index.js (Phase 3 wave N — sentinel-aware).
 * Whole file is part of the fsx-lustre-config feature: it is added to the
 * manifest `paths` so it is deleted wholesale wherever that feature is
 * withheld (public:false), and index.js's require + mount are wrapped in a
 * release sentinel so they vanish together. Where the feature ships
 * (public:true), both the file and the mount remain.
 *
 * fsxStorageManager.js is itself a withheld file (same feature paths), so this
 * module self-requires it directly; inject broadcast for WS notifications.
 */

const express = require('express');
const router = express.Router();
const FSxStorageManager = require('../fsxStorageManager');
const fsxStorageManager = new FSxStorageManager();

let broadcast = null;

function initialize(deps) {
  broadcast = deps.broadcast;
}

// FSx存储管理API
router.get('/fsx-storages', async (req, res) => {
  const result = await fsxStorageManager.getStorages();
  res.json(result);
});

router.post('/fsx-storages', async (req, res) => {
  const result = await fsxStorageManager.createStorage(req.body);
  if (result.success) {
    broadcast({
      type: 'fsx_storage_created',
      status: 'success',
      message: `FSx storage ${req.body.name} created successfully`
    });
  }
  res.json(result);
});

router.delete('/fsx-storages/:name', async (req, res) => {
  const result = await fsxStorageManager.deleteStorage(req.params.name);
  if (result.success) {
    broadcast({
      type: 'fsx_storage_deleted',
      status: 'success',
      message: `FSx storage ${req.params.name} deleted successfully`
    });
  }
  res.json(result);
});

// 获取FSx文件系统信息
router.post('/fsx-info', async (req, res) => {
  const { fileSystemId, region } = req.body;
  const result = await fsxStorageManager.getFSxInfo(fileSystemId, region);
  res.json(result);
});

module.exports = { router, initialize };
