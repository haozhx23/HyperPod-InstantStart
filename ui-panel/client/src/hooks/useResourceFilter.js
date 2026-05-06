import { useMemo, useState } from 'react';

// Client-side search / namespace / status filter + pagination state.
// Used by StatusMonitorRedux's per-tab tables to share the same UX.
//
// Accessors default to the two shapes we see in this codebase:
//   - k8s raw objects: { metadata: { name, namespace } }
//   - server-processed: { name, deploymentName, namespace }
//
// Options:
//   getName          (it) => string      default: metadata.name ?? name ?? deploymentName
//   getNamespace     (it) => string      default: metadata.namespace ?? namespace
//   getStatus        (it) => string      if provided, adds status filter
//   defaultNamespace string              default: 'default'
//   defaultPageSize  number              default: 20
//   searchPlaceholder string             default: 'Search by name'
//
// Returns:
//   filtered         — items after filtering
//   isFiltered      — any filter active
//   toolbarProps    — spread into <ResourceListToolbar />
//   paginationProps — spread into <Table pagination={...} />
export default function useResourceFilter(items, opts = {}) {
  const {
    getName = defaultGetName,
    getNamespace = defaultGetNamespace,
    getStatus,
    defaultNamespace = 'default',
    defaultPageSize = 20,
    searchPlaceholder = 'Search by name',
  } = opts;

  const [search, setSearch] = useState('');
  const [namespace, setNamespace] = useState(defaultNamespace);
  const [status, setStatus] = useState('__all__');
  const [pageSize, setPageSize] = useState(defaultPageSize);

  const list = Array.isArray(items) ? items : [];

  const namespaces = useMemo(() => {
    const set = new Set(list.map((it) => getNamespace(it)).filter(Boolean));
    set.add('default');
    return Array.from(set).sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  const statuses = useMemo(() => {
    if (!getStatus) return undefined;
    return Array.from(new Set(list.map((it) => getStatus(it)).filter(Boolean))).sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return list.filter((it) => {
      if (q && !(getName(it) || '').toLowerCase().includes(q)) return false;
      if (namespace !== '__all__' && getNamespace(it) !== namespace) return false;
      if (getStatus && status !== '__all__' && getStatus(it) !== status) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, search, namespace, status]);

  const isFiltered =
    !!search.trim() ||
    namespace !== '__all__' ||
    (!!getStatus && status !== '__all__');

  return {
    filtered,
    isFiltered,
    toolbarProps: {
      search,
      onSearch: setSearch,
      searchPlaceholder,
      namespaces,
      namespace,
      onNamespaceChange: setNamespace,
      statuses,
      status,
      onStatusChange: setStatus,
      pageSize,
      onPageSizeChange: setPageSize,
      totalCount: list.length,
      filteredCount: filtered.length,
    },
    paginationProps: {
      pageSize,
      showSizeChanger: false,
      showQuickJumper: true,
      hideOnSinglePage: true,
      showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
    },
  };
}

function defaultGetName(it) {
  if (!it) return '';
  return it.metadata?.name || it.name || it.deploymentName || '';
}

function defaultGetNamespace(it) {
  if (!it) return '';
  return it.metadata?.namespace || it.namespace || '';
}
