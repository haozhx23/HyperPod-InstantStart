import React, { useState, useCallback } from 'react';
import { Row, Col, Card, Tabs } from 'antd';
import { useDispatch, useSelector } from 'react-redux';
import PageHeader from '../components/PageHeader';
import { selectPageTabs } from '../store/selectors';
import ManagedInferencePanel from '../components/ManagedInferencePanel';
import ManagedInferenceScalingPanel from '../components/ManagedInferenceScalingPanel';
import TestPanel from '../components/TestPanel';
import { fetchAppStatusV2 } from '../store/slices/appStatusSlice';

// Managed Inference 独立页面：把原 Inference 页面里 managed-inference sentinel
// 块（Managed Inference + Managed Scaling 两个 tab）拆出来单独承载。布局与
// InferencePage 保持一致 —— 左侧 Tabs Card + 右侧 Model Testing Card，复用
// 同样的 cardHeight / cardBodyStyle，让两个页面视觉一致。
export default function ManagedInferencePage() {
  const dispatch = useDispatch();
  const [configTab, setConfigTab] = useState('managed-vllm-inference');
  const tabs = useSelector(selectPageTabs('managed-inference'));
  const isTabVisible = (k) => tabs[k] !== 'off';

  const onServicesRefresh = useCallback(() => {
    dispatch(fetchAppStatusV2());
  }, [dispatch]);

  // Card 视口满高 + body 内部滚动。和 InferencePage / MonitoringPage 同样的 B 方案。
  const cardHeight = 'calc((100vh - 170px) / var(--zoom-factor))';
  const cardBodyStyle = { height: 'calc(100% - 57px)', overflow: 'auto' };

  return (
    <>
      <PageHeader title="Managed Inference" breadcrumb={['Home', 'Managed Inference']} />
      <div style={{ padding: 16 }}>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card
              title="Managed Inference Configuration"
              className="theme-card compute"
              style={{ height: cardHeight, overflow: 'hidden' }}
              styles={{ body: cardBodyStyle }}
            >
              <Tabs
                activeKey={configTab}
                onChange={setConfigTab}
                size="small"
                items={[
                  isTabVisible('managedVllmInference') && { key: 'managed-vllm-inference', label: 'Managed vLLM Inference', children: <ManagedInferencePanel engine="vllm" /> },
                  isTabVisible('managedSglangInference') && { key: 'managed-sglang-inference', label: 'Managed SGLang Inference', children: <ManagedInferencePanel engine="sglang" /> },
                  isTabVisible('managedScaling') && { key: 'managed-inference-scaling', label: 'Managed Scaling', children: <ManagedInferenceScalingPanel /> },
                ].filter(Boolean)}
              />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card
              title="Model Testing"
              className="theme-card ml"
              style={{ height: cardHeight, overflow: 'hidden' }}
              styles={{ body: cardBodyStyle }}
            >
              <TestPanel onRefresh={onServicesRefresh} />
            </Card>
          </Col>
        </Row>
      </div>
    </>
  );
}
