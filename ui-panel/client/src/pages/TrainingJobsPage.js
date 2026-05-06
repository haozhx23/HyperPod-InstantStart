import React, { useState } from 'react';
import { Row, Col, Card, Tabs, Space } from 'antd';
import { useSelector, useDispatch } from 'react-redux';
import {
  RocketOutlined,
  CloudOutlined,
  ClusterOutlined,
  ApartmentOutlined,
} from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import SageMakerJobPanel from '../components/SageMakerJobPanel';
import HyperPodJobPanel from '../components/HyperPodJobPanel';
import RayJobPanel from '../components/RayJobPanel';
import TrainingMonitorPanel from '../components/TrainingMonitorPanelRedux';
import { selectPageTabs } from '../store/selectors';
import { useHyperPodInstanceTypes } from '../utils/hyperPodInstanceTypes';
import { launchTraining } from '../utils/actions/deployActions';

export default function TrainingJobsPage() {
  const dispatch = useDispatch();
  const tabs = useSelector(selectPageTabs('training'));
  const isTabVisible = (k) => tabs[k] !== 'off';
  const {
    instanceTypes: hyperPodInstanceTypes,
    loading: instanceTypesLoading,
    refresh: refreshInstanceTypes,
  } = useHyperPodInstanceTypes();
  const [jobTab, setJobTab] = useState('hyperpodrun-job');

  const onLaunch = (config) => launchTraining(config, dispatch);
  const recipeCommon = { onLaunch, hyperPodInstanceTypes, instanceTypesLoading, refreshInstanceTypes };

  const items = [
    isTabVisible('hyperpodrunJob') && {
      key: 'hyperpodrun-job',
      label: <Space><RocketOutlined />HyperPod Job</Space>,
      children: <HyperPodJobPanel {...recipeCommon} />,
    },
    isTabVisible('rayJob') && {
      key: 'rayjob',
      label: <Space><ApartmentOutlined />Ray Job</Space>,
      children: <RayJobPanel {...recipeCommon} />,
    },
    isTabVisible('sagemaker') && {
      key: 'sagemaker',
      label: <Space><CloudOutlined />SageMaker Job</Space>,
      children: <SageMakerJobPanel onLaunch={onLaunch} />,
    },
  ].filter(Boolean);

  const cardHeight = 'calc((100vh - 170px) / var(--zoom-factor))';
  const cardBodyStyle = { height: 'calc(100% - 57px)', overflow: 'auto' };

  return (
    <>
      <PageHeader title="Training" breadcrumb={['Home', 'Training']} />
      <div style={{ padding: 16 }}>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card
              title="Training Jobs"
              className="theme-card compute"
              style={{ height: cardHeight, overflow: 'hidden' }}
              styles={{ body: cardBodyStyle }}
            >
              <Tabs activeKey={jobTab} onChange={setJobTab} size="small" items={items} />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card
              title="Training Job Monitor"
              className="theme-card analytics"
              style={{ height: cardHeight, overflow: 'hidden' }}
              styles={{ body: cardBodyStyle }}
            >
              <TrainingMonitorPanel />
            </Card>
          </Col>
        </Row>
      </div>
    </>
  );
}
