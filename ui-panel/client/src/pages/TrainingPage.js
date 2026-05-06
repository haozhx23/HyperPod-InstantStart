import React, { useState } from 'react';
import { Row, Col, Card, Tabs, Space } from 'antd';
import { useSelector, useDispatch } from 'react-redux';
import {
  ExperimentOutlined,
  ThunderboltOutlined,
  RocketOutlined,
  FireOutlined,
  CodeOutlined,
} from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import ScriptRecipePanel from '../components/ScriptRecipePanel';
import TorchRecipePanel from '../components/TorchRecipePanel';
import TrainingConfigPanel from '../components/TrainingConfigPanel';
import MSSwiftRecipePanel from '../components/MSSwiftRecipePanel';
import VerlRecipePanel from '../components/VerlRecipePanel';
import TrainingMonitorPanel from '../components/TrainingMonitorPanelRedux';
import { selectPageTabs } from '../store/selectors';
import { useHyperPodInstanceTypes } from '../utils/hyperPodInstanceTypes';
import { launchTraining } from '../utils/actions/deployActions';

export default function TrainingPage() {
  const dispatch = useDispatch();
  const tabs = useSelector(selectPageTabs('training-recipes'));
  const isTabVisible = (k) => tabs[k] !== 'off';
  const {
    instanceTypes: hyperPodInstanceTypes,
    loading: instanceTypesLoading,
    refresh: refreshInstanceTypes,
  } = useHyperPodInstanceTypes();
  const [recipeTab, setRecipeTab] = useState('torch');

  const onLaunch = (config) => launchTraining(config, dispatch);
  const recipeCommon = { onLaunch, hyperPodInstanceTypes, instanceTypesLoading, refreshInstanceTypes };

  const items = [
    isTabVisible('script') && {
      key: 'script',
      label: <Space><CodeOutlined />Script Recipe</Space>,
      children: <ScriptRecipePanel {...recipeCommon} />,
    },
    isTabVisible('torch') && {
      key: 'torch',
      label: <Space><FireOutlined />Torch Recipe</Space>,
      children: <TorchRecipePanel {...recipeCommon} />,
    },
    isTabVisible('llamafactory') && {
      key: 'llamafactory',
      label: <Space><ExperimentOutlined />LlamaFactory Recipe</Space>,
      children: <TrainingConfigPanel {...recipeCommon} />,
    },
    isTabVisible('msswift') && {
      key: 'msswift',
      label: <Space><ThunderboltOutlined />MS-Swift Recipe</Space>,
      children: <MSSwiftRecipePanel {...recipeCommon} />,
    },
    isTabVisible('verl') && {
      key: 'verl',
      label: <Space><RocketOutlined />Verl Recipe</Space>,
      children: <VerlRecipePanel {...recipeCommon} />,
    },
  ].filter(Boolean);

  // Card 视口满高 + body 内部滚动。和 MonitoringPage 同样的 B 方案。
  const cardHeight = 'calc((100vh - 170px) / var(--zoom-factor))';
  const cardBodyStyle = { height: 'calc(100% - 57px)', overflow: 'auto' };

  return (
    <>
      <PageHeader title="Training Recipes" breadcrumb={['Home', 'Training Recipes']} />
      <div style={{ padding: 16 }}>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card
              title="Training Recipes"
              className="theme-card compute"
              style={{ height: cardHeight, overflow: 'hidden' }}
              styles={{ body: cardBodyStyle }}
            >
              <Tabs activeKey={recipeTab} onChange={setRecipeTab} size="small" items={items} />
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
