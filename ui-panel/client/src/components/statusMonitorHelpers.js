/**
 * Pure, stateless helpers extracted from StatusMonitorRedux.js.
 *
 * These are resource-status extractors used by the in-component useResourceFilter
 * calls, plus the shared monitoring-table scroll height. Extracted verbatim to
 * shrink the 2300-line component without touching behavior — no hooks, no state,
 * no JSX. Release-controlled helpers (e.g. getInferenceEndpointStatus, which
 * carries a @release marker) intentionally stay in the component file so their
 * sentinels are not relocated.
 */

// Extractors for resource-specific status strings, used by useResourceFilter.
export const getServiceType = (s) => s?.spec?.type;
export const getDeploymentStatus = (d) => (typeof d?.status === 'string' ? d.status : undefined);
export const getJobStatusFromCondition = (item) => {
  const s = item?.status;
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object' && Array.isArray(s.conditions) && s.conditions.length) {
    return s.conditions[s.conditions.length - 1]?.type;
  }
  return undefined;
};
export const getK8sJobSummary = (j) => {
  if (!j) return undefined;
  if (j.succeeded >= j.completions) return 'Complete';
  if (j.failed > 0) return 'Failed';
  if (j.active > 0) return 'Running';
  return 'Pending';
};

// Shared scroll target height for all Monitoring-page tables (divided by
// --zoom-factor to adapt to body zoom).
export const MONITORING_TABLE_SCROLL_Y = 'calc((100vh - 480px) / var(--zoom-factor))';

// Per-tab minimum table width (px) fed into <Table scroll={{ x }}>. Setting an
// explicit scroll.x switches antd to table-layout:fixed, which locks header/body
// column widths together — this is what prevents the column-content overlap seen
// under browser/body zoom (without it antd squeezes columns and the cells desync).
// Each value is ~the sum of that table's column widths plus a little slack; when
// the viewport is narrower than this the table scrolls horizontally instead of
// crushing columns. Keys match the `activeTab` strings used in StatusMonitorRedux.
export const MONITORING_TABLE_SCROLL_X = {
  pods: 1180,
  services: 1200,
  deployments: 1560,
  inference: 1350,
  jobs: 900,
  rayjobs: 1000,
  k8sjobs: 990,
  trainjob: 980,
};
