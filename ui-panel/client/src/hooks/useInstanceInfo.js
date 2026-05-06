import { useState, useCallback } from 'react';

/**
 * Hook for auto-filling GPU and EFA fields when user selects an instance type.
 * @param {Object} form - Ant Design form instance
 * @param {Object} [fieldNames] - Form field names to auto-fill
 * @param {string} [fieldNames.gpu] - GPU field name (e.g., 'gpuPerNode' or 'gpuCount'), null to skip
 * @param {string} [fieldNames.efa] - EFA field name (e.g., 'efaPerNode' or 'efaCount')
 */
const useInstanceInfo = (form, { gpu = null, efa = 'efaCount' } = {}) => {
  const [loading, setLoading] = useState(false);

  const fetchInstanceInfo = useCallback(async (instanceType) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/config/instance-info?instanceType=${encodeURIComponent(instanceType)}`);
      const d = await r.json();
      if (d.success) {
        if (gpu) form.setFieldValue(gpu, d.gpuCount || 0);
        if (efa) form.setFieldValue(efa, d.efaInterfaces || 0);
      }
    } catch (e) {
      if (gpu) form.setFieldValue(gpu, 0);
      if (efa) form.setFieldValue(efa, 0);
    } finally {
      setLoading(false);
    }
  }, [form, gpu, efa]);

  return { fetchInstanceInfo, infoLoading: loading };
};

export default useInstanceInfo;
