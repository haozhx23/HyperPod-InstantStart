import { useState, useCallback } from 'react';

/**
 * Hook for fetching EFA count by instance type, with loading state and caching.
 * @param {Object} form - Ant Design form instance
 * @param {string} fieldName - Form field name for EFA (e.g., 'efaPerNode' or 'efaCount')
 * @returns {{ fetchEfaCount: (instanceType: string) => void, efaLoading: boolean }}
 */
const useEfaCount = (form, fieldName = 'efaCount') => {
  const [efaLoading, setEfaLoading] = useState(false);

  const fetchEfaCount = useCallback(async (instanceType) => {
    setEfaLoading(true);
    try {
      const r = await fetch(`/api/config/instance-efa?instanceType=${encodeURIComponent(instanceType)}`);
      const d = await r.json();
      form.setFieldValue(fieldName, d.success ? d.efaCount : 0);
    } catch (e) {
      form.setFieldValue(fieldName, 0);
    } finally {
      setEfaLoading(false);
    }
  }, [form, fieldName]);

  return { fetchEfaCount, efaLoading };
};

export default useEfaCount;
