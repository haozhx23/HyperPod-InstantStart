const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../../config/cluster-dependencies-config.json');

// DEFAULTS contain STRUCTURAL defaults only — no version fallbacks. If a
// feature is enabled but its required version is empty/missing, the install
// site MUST throw (see requireVersion below) instead of silently picking a
// stale hardcoded release. Rationale: chart versions move; a fallback here
// means a user who forgot to set a version silently gets an old release.
// `kubernetesVersion` is the only exception — it's a K8s platform baseline,
// needed just to create the cluster, and '1.34' is a sane safety net.
const DEFAULTS = {
  eks: {
    kubernetesVersion: '1.34',
  },
  hyperpodHelmChart: {
    enabled: true,
    cliVersion: '',
    efaDevicePluginImageTag: ''
  },
  kuberayOperatorChartVersion: '',
};

/**
 * 每次调用都重新读取配置文件（不缓存），方便用户改完立即生效
 * 缺失的字段用 DEFAULTS 补齐
 */
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      eks: {
        kubernetesVersion: raw.eks?.kubernetesVersion || DEFAULTS.eks.kubernetesVersion,
      },
      hyperpodHelmChart: {
        enabled: raw.hyperpodHelmChart?.enabled ?? DEFAULTS.hyperpodHelmChart.enabled,
        cliVersion: raw.hyperpodHelmChart?.cliVersion || '',
        efaDevicePluginImageTag: raw.hyperpodHelmChart?.efaDevicePluginImageTag || ''
      },
      kuberayOperatorChartVersion: raw.kuberayOperatorChartVersion || DEFAULTS.kuberayOperatorChartVersion,
    };
  } catch (err) {
    console.warn(`[DependencyConfig] Failed to load ${CONFIG_PATH}, using defaults: ${err.message}`);
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

/**
 * Throws if the given version value is empty/missing. Call this at install
 * sites BEFORE invoking helm/kubectl/etc., so a missing-version misconfig
 * surfaces with a clear error instead of a broken helm command.
 *
 * Usage:
 *   const v = dependencyConfig.load().kuberayOperatorChartVersion;
 *   requireVersion(v, 'kuberayOperatorChartVersion');
 */
function requireVersion(value, keyPath) {
  if (value === undefined || value === null || value === '') {
    throw new Error(
      `[DependencyConfig] Missing required version "${keyPath}" in ` +
      `cluster-dependencies-config.json. Set the value explicitly — ` +
      `this version is required by an enabled feature and has no fallback.`
    );
  }
  return value;
}

module.exports = { load, requireVersion };
