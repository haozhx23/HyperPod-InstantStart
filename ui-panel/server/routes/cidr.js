/**
 * CIDR Routes
 *
 * Extracted from index.js (Phase 3, wave 5).
 * Provides CIDR generation, full CIDR config generation, and CIDR validation.
 * Depends on NetworkManager (self-required). Zero-injection module: no
 * dependency injection and no initialize step required.
 */

const express = require('express');
const router = express.Router();
const NetworkManager = require('../utils/networkManager');

// CIDR生成相关API
router.get('/cluster/generate-cidr', async (req, res) => {
  const { region, excludeCidr } = req.query;
  const result = await NetworkManager.generateUniqueCidr(region, excludeCidr);

  if (result.success) {
    res.json(result);
  } else {
    res.status(result.error === 'AWS region is required' ? 400 : 500).json({ error: result.error });
  }
});

// 生成完整CIDR配置
router.post('/cluster/generate-cidr-config', async (req, res) => {
  const { region, customVpcCidr } = req.body;
  const result = await NetworkManager.generateCidrConfig(region, customVpcCidr);

  if (result.success) {
    res.json(result);
  } else {
    res.status(result.error === 'AWS region is required' ? 400 : 500).json({ error: result.error });
  }
});

// 验证CIDR格式和冲突
router.post('/cluster/validate-cidr', async (req, res) => {
  const { cidr, region } = req.body;
  const result = await NetworkManager.validateCidr(cidr, region);

  if (result.error === 'CIDR and region are required') {
    res.status(400).json({ error: result.error });
  } else if (result.success || result.valid === false) {
    // Both success=true and format validation failure (valid=false) return normally
    res.json(result);
  } else {
    res.status(500).json({ error: result.error });
  }
});

module.exports = { router };
