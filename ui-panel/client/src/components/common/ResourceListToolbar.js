import React from 'react';
import { Input, Select, Space, Tag, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

const { Text } = Typography;

// Reusable filter / search bar rendered above resource tables.
// Client-side only (Phase S1). Consuming component owns filter state.
//
// Props:
//   search            — current search value (string)
//   onSearch          — (value) => void
//   searchPlaceholder — optional placeholder (default "Search by name")
//   namespaces        — array of distinct namespace strings (optional)
//   namespace         — selected namespace (string | '__all__')
//   onNamespaceChange — (ns) => void
//   statuses          — array of status strings (optional)
//   status            — selected status (string | '__all__')
//   onStatusChange    — (status) => void
//   pageSize          — current pageSize
//   onPageSizeChange  — (n) => void
//   totalCount        — number before filter
//   filteredCount     — number after filter
//   extra             — ReactNode placed at the far right (refresh, actions...)
export default function ResourceListToolbar({
  search = '',
  onSearch,
  searchPlaceholder = 'Search by name',
  namespaces,
  namespace = '__all__',
  onNamespaceChange,
  statuses,
  status = '__all__',
  onStatusChange,
  pageSize = 20,
  onPageSizeChange,
  totalCount,
  filteredCount,
  extra,
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '8px 0 12px',
      }}
    >
      <Space size={8} wrap>
        <Input
          allowClear
          size="small"
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          placeholder={searchPlaceholder}
          value={search}
          onChange={(e) => onSearch && onSearch(e.target.value)}
          style={{ width: 240 }}
        />
        {Array.isArray(namespaces) && namespaces.length > 0 && (
          <Select
            size="small"
            value={namespace}
            onChange={(v) => onNamespaceChange && onNamespaceChange(v)}
            style={{ minWidth: 160 }}
            options={[
              { value: '__all__', label: 'All namespaces' },
              ...namespaces.map((ns) => ({ value: ns, label: ns })),
            ]}
          />
        )}
        {Array.isArray(statuses) && statuses.length > 0 && (
          <Select
            size="small"
            value={status}
            onChange={(v) => onStatusChange && onStatusChange(v)}
            style={{ minWidth: 140 }}
            options={[
              { value: '__all__', label: 'All statuses' },
              ...statuses.map((s) => ({ value: s, label: s })),
            ]}
          />
        )}
        {onPageSizeChange && (
          <Select
            size="small"
            value={pageSize}
            onChange={(v) => onPageSizeChange(v)}
            style={{ width: 120 }}
            options={[10, 20, 50, 100, 200].map((n) => ({ value: n, label: `${n} / page` }))}
          />
        )}
        {typeof totalCount === 'number' && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {typeof filteredCount === 'number' && filteredCount !== totalCount ? (
              <>
                <Tag color="blue" style={{ marginInlineEnd: 4 }}>{filteredCount}</Tag>
                of {totalCount}
              </>
            ) : (
              <>Total {totalCount}</>
            )}
          </Text>
        )}
      </Space>
      {extra && <div>{extra}</div>}
    </div>
  );
}
