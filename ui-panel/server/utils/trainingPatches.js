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

module.exports = {
  formatPythonParams,
  mlflowPatches,
  logMonitoringPatch,
  normalizeEnvList,
  appendEnvPatches,
  POD_SPEC_PATH,
  RUN_POLICY_PATH,
};
