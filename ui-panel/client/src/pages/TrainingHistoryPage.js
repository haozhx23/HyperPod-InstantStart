import React from 'react';
import PageHeader from '../components/PageHeader';
import TrainingHistoryPanel from '../components/TrainingHistoryPanel';

export default function TrainingHistoryPage() {
  return (
    <>
      <PageHeader title="Training History" breadcrumb={['Home', 'Training History']} />
      <div style={{ padding: 16 }}>
        <TrainingHistoryPanel />
      </div>
    </>
  );
}
