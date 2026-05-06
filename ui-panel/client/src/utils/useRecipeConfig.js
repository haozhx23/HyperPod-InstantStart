import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';

/**
 * Unified recipe/training config save+load hook.
 *
 * Talks to a pair of REST endpoints:
 *   GET  `${endpoint}/load`  → { success, config, isDefault }
 *   POST `${endpoint}/save`  ← JSON form values → { success, error? }
 *
 * Handles HTTP status checks, JSON success flag, toasts, and once-only auto-load.
 *
 * @param {Object}   opts
 * @param {string}   opts.endpoint     Base API path (no trailing slash), e.g. '/api/torch-config'
 * @param {Object}   opts.form         antd Form instance
 * @param {Function} [opts.onLoaded]   (config, { isDefault }) → void. Derive extra state from loaded config.
 * @param {boolean}  [opts.autoLoad=true]
 *
 * @returns {{
 *   saving: boolean,
 *   loading: boolean,
 *   loadConfig: (opts?: { silent?: boolean }) => Promise<object>,
 *   saveConfig: (opts?: { silent?: boolean, values?: object }) => Promise<object>
 * }}
 */
export const useRecipeConfig = ({ endpoint, form, onLoaded, autoLoad = true }) => {
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const hasLoadedRef = useRef(false);

  const onLoadedRef = useRef(onLoaded);
  useEffect(() => { onLoadedRef.current = onLoaded; }, [onLoaded]);

  const loadConfig = useCallback(async ({ silent = false } = {}) => {
    setLoading(true);
    try {
      const response = await fetch(`${endpoint}/load`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (!result.success) throw new Error(result.error || 'Load failed');

      form.setFieldsValue(result.config);
      onLoadedRef.current?.(result.config, { isDefault: !!result.isDefault });

      if (!silent && !result.isDefault) {
        message.success('Previous configuration loaded');
      }
      return result.config;
    } catch (err) {
      console.error(`[${endpoint}] load error:`, err);
      if (!silent) message.error(`Failed to load configuration: ${err.message || err}`);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [endpoint, form]);

  const saveConfig = useCallback(async ({ silent = false, values } = {}) => {
    setSaving(true);
    try {
      const payload = values ?? (await form.validateFields());
      const response = await fetch(`${endpoint}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (!result.success) throw new Error(result.error || 'Save failed');

      if (!silent) message.success('Configuration saved successfully');
      return payload;
    } catch (err) {
      console.error(`[${endpoint}] save error:`, err);
      if (!silent) message.error(`Failed to save configuration: ${err.message || err}`);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [endpoint, form]);

  useEffect(() => {
    if (!autoLoad) return;
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    loadConfig({ silent: false }).catch(() => {});
  }, [autoLoad, loadConfig]);

  return { saving, loading, loadConfig, saveConfig };
};

export default useRecipeConfig;
