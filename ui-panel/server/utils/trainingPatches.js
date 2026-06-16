/**
 * Shared helpers for HyperPod training handlers.
 *
 * The 4 HyperPodPyTorchJob-style templates (torch/lmf/msswift/script) all
 * share the same pod structure and therefore the same conditional patches:
 *   - serviceAccountName: mlflow-service-account   (when MLflow enabled)
 *   - runPolicy.logMonitoringConfiguration         (when user supplied YAML)
 *
 * Python script parameters are flattened the same way across torch/sagemaker.
 */

const YAML = require('yaml');
const { patches: P } = require('./renderTemplate');

// Paths into the HyperPodPyTorchJob structure (stable across the 4 templates)
const POD_SPEC_PATH = ['spec', 'replicaSpecs', 0, 'template', 'spec'];
const RUN_POLICY_PATH = ['spec', 'runPolicy'];

/**
 * Flatten a multi-line shell-style parameter string into a single line.
 * "--foo bar \\\n    --baz qux"  →  "--foo bar --baz qux"
 *
 * Preserves original string if no backslash-continuation is present.
 */
function formatPythonParams(input) {
  if (!input) return '';
  if (!input.includes('\\')) return input;
  return input
    .replace(/\\\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * When MLflow tracking is enabled, the pod needs to impersonate the
 * mlflow-service-account so it can push experiment data.
 *
 * Returns an array of patches (possibly empty) rather than a single patch
 * so callers can spread it into a patch list.
 */
function mlflowPatches(mlflowTrackingUri) {
  if (!mlflowTrackingUri || !mlflowTrackingUri.trim()) return [];
  return [
    P.set([...POD_SPEC_PATH, 'serviceAccountName'], 'mlflow-service-account'),
  ];
}

/**
 * Inject the user-supplied logMonitoringConfiguration YAML into
 * spec.runPolicy.logMonitoringConfiguration.
 *
 * Accepts either form of user input:
 *   - just the list:            `- name: "X"\n  logPattern: ...`
 *   - wrapped with the key:     `logMonitoringConfiguration:\n  - name: "X" ...`
 *
 * Returns null when empty (caller filters nulls from patch list).
 */
function logMonitoringPatch(logMonitoringConfig) {
  if (!logMonitoringConfig || !logMonitoringConfig.trim()) return null;

  let parsed;
  try {
    parsed = YAML.parse(logMonitoringConfig);
  } catch (e) {
    throw new Error(`Invalid logMonitoringConfig YAML: ${e.message}`);
  }

  // Unwrap if user pasted the key alongside the value (matches the UI placeholder)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && 'logMonitoringConfiguration' in parsed) {
    parsed = parsed.logMonitoringConfiguration;
  }

  return P.set([...RUN_POLICY_PATH, 'logMonitoringConfiguration'], parsed);
}

/**
 * Normalize user-supplied env list into [{ name, value }] pairs.
 * Drops entries with empty name. Coerces value to string (so numbers/bools survive YAML).
 */
function normalizeEnvList(envList) {
  if (!Array.isArray(envList)) return [];
  return envList
    .filter((e) => e && typeof e.name === 'string' && e.name.trim())
    .map((e) => ({ name: e.name.trim(), value: e.value == null ? '' : String(e.value) }));
}

/**
 * Build patches that append user env vars to one or more container env lists.
 *
 * @param {Array<{name:string,value:string}>} envList
 * @param {Array<Array<string|number>>} envPaths - each path points at a container's `env` list
 * @returns {Array} patch list (possibly empty)
 */
function appendEnvPatches(envList, envPaths) {
  const normalized = normalizeEnvList(envList);
  if (normalized.length === 0) return [];
  const list = [];
  for (const p of envPaths) {
    for (const item of normalized) {
      list.push(P.append(p, item));
    }
  }
  return list;
}

// Selectable persistent-storage mounts (PVCs). hostPath mounts (shmem/local/...) stay in templates.
const STORAGE_MOUNTS = {
  s3:  { name: 'persistent-storage-s3',  mountPath: '/s3',  claimName: 's3-claim',  readOnly: false },
  fsx: { name: 'persistent-storage-fsx', mountPath: '/fsx', claimName: 'fsx-claim' },
};

/**
 * Build patches that append the selected PVC volumeMounts + volumes to a pod.
 * Falls back to ['s3'] when nothing valid is selected so a pod always has storage.
 *
 * @param {string[]} mounts - selected keys, e.g. ['s3','fsx']
 * @param {{mountPaths: Array<Array<string|number>>, volumePaths: Array<Array<string|number>>}} paths
 */
function storageMountPatches(mounts, { mountPaths = [], volumePaths = [] } = {}) {
  const selected = (Array.isArray(mounts) && mounts.length ? mounts : ['s3'])
    .filter((m) => STORAGE_MOUNTS[m]);
  const list = [];
  for (const key of selected) {
    const s = STORAGE_MOUNTS[key];
    const volumeMount = { name: s.name, mountPath: s.mountPath };
    if (s.readOnly !== undefined) volumeMount.readOnly = s.readOnly;
    const volume = { name: s.name, persistentVolumeClaim: { claimName: s.claimName } };
    for (const p of mountPaths) list.push(P.append(p, volumeMount));
    for (const p of volumePaths) list.push(P.append(p, volume));
  }
  return list;
}

module.exports = {
  formatPythonParams,
  mlflowPatches,
  logMonitoringPatch,
  normalizeEnvList,
  appendEnvPatches,
  storageMountPatches,
  POD_SPEC_PATH,
  RUN_POLICY_PATH,
};
