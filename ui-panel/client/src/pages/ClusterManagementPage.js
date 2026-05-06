import React from 'react';
import PageHeader from '../components/PageHeader';
import ClusterManagement from '../components/ClusterManagementRedux';

export default function ClusterManagementPage() {
  return (
    <>
      <PageHeader title="Cluster Management" breadcrumb={['Home', 'Cluster Management']} />
      <div style={{ padding: 16 }}>
        <ClusterManagement />
      </div>
    </>
  );
}
