import React, { useState, useCallback } from 'react';
import { Row, Col, Card, Tabs } from 'antd';
import { useDispatch, useSelector } from 'react-redux';
import PageHeader from '../components/PageHeader';
import { selectPageTabs } from '../store/selectors';
import ConfigPanel from '../components/ConfigPanel';
import ServiceConfigPanel from '../components/ServiceConfigPanel';
import AdvancedScalingPanelV2 from '../components/AdvancedScalingPanelV2';
import ScalingPanel from '../components/ScalingPanel';
import TestPanel from '../components/TestPanel';
import {
  deployService,
  deployAdvancedScaling,
  deployScaling,
} from '../utils/actions/deployActions';
import { fetchAppStatusV2 } from '../store/slices/appStatusSlice';

export default function InferencePage() {
  const dispatch = useDispatch();
  const [configTab, setConfigTab] = useState('model-config');
  const tabs = useSelector(selectPageTabs('inference'));
  const isTabVisible = (k) => tabs[k] !== 'off';

  const onServicesRefresh = useCallback(() => {
    dispatch(fetchAppStatusV2());
  }, [dispatch]);

  // Card 视口满高 + body 内部滚动。和 MonitoringPage 同样的 B 方案。
  const cardHeight = 'calc((100vh - 170px) / var(--zoom-factor))';
  const cardBodyStyle = { height: 'calc(100% - 57px)', overflow: 'auto' };

  return (
    <>
      <PageHeader title="Inference" breadcrumb={['Home', 'Inference']} />
      <div style={{ padding: 16 }}>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card
              title="Inference Configuration"
              className="theme-card compute"
              style={{ height: cardHeight, overflow: 'hidden' }}
              styles={{ body: cardBodyStyle }}
            >
              <Tabs
                activeKey={configTab}
                onChange={setConfigTab}
                size="small"
                items={[
                  isTabVisible('modelConfig') && { key: 'model-config', label: 'Model Deployment', children: <ConfigPanel /> },
                  isTabVisible('serviceConfig') && { key: 'service-config', label: 'Service Binding', children: <ServiceConfigPanel onDeploy={deployService} /> },
                  isTabVisible('sglRouting') && { key: 'advanced-scaling-preview', label: 'SGL Routing', children: <AdvancedScalingPanelV2 onDeploy={deployAdvancedScaling} /> },
                  isTabVisible('kedaScaling') && { key: 'keda-scaling-preview', label: 'Unified Scaling', children: <ScalingPanel onDeploy={deployScaling} /> },
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
