import React, { useState } from 'react';
import { Button, Space, Tooltip } from 'antd';
import { SaveOutlined, ReloadOutlined } from '@ant-design/icons';

/**
 * Top-right action bar for a recipe panel: Save + Reload.
 *
 * `onSave` typically wires to `saveConfig` from useRecipeConfig.
 * `onReload` should compose loadConfig() with any panel-specific refresh
 * tasks (instance types, command lists, runtimes). A single async handler
 * keeps the reload button's loading state accurate.
 */
const RecipeConfigActions = ({
  saving,
  onSave,
  onReload,
  saveTooltip = 'Save Configuration',
  reloadTooltip = 'Reload Configuration and Refresh Resources',
}) => {
  const [reloading, setReloading] = useState(false);

  const handleReload = async () => {
    if (!onReload) return;
    setReloading(true);
    try {
      await onReload();
    } finally {
      setReloading(false);
    }
  };

  const handleSave = async () => {
    if (!onSave) return;
    try {
      await onSave();
    } catch {
      // toasts are emitted inside onSave; nothing to do here
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
      <Space>
        <Tooltip title={saveTooltip}>
          <Button icon={<SaveOutlined />} onClick={handleSave} loading={saving} size="small" />
        </Tooltip>
        <Tooltip title={reloadTooltip}>
          <Button icon={<ReloadOutlined />} onClick={handleReload} loading={reloading} size="small" />
        </Tooltip>
      </Space>
    </div>
  );
};

export default RecipeConfigActions;
