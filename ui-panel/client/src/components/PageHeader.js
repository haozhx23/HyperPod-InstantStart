import React from 'react';
import { Breadcrumb, Typography } from 'antd';

// Minimal page header shown at the top of every new-router page.
// Step 3 may extend this to include a primary-action area / refresh pill.
export default function PageHeader({ title, breadcrumb = [], actions }) {
  const crumbItems = breadcrumb.map((label) => ({ title: label }));

  return (
    <div
      style={{
        padding: '16px 24px 12px',
        borderBottom: '1px solid #f0f0f0',
        background: '#fff',
      }}
    >
      {crumbItems.length > 0 && (
        <Breadcrumb items={crumbItems} style={{ marginBottom: 8, fontSize: 12 }} />
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 16,
        }}
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {actions ? <div>{actions}</div> : null}
      </div>
    </div>
  );
}
