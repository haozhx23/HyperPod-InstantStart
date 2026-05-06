import React from 'react';
import { Row, Col, Card, Tabs, Space, Badge } from 'antd';
import { useSelector } from 'react-redux';
import {
  ContainerOutlined,
  ApiOutlined,
  RocketOutlined,
  ExperimentOutlined,
  ThunderboltOutlined,
  FireOutlined,
  CodeOutlined,
} from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import ClusterStatusV2Redux from '../components/ClusterStatusV2Redux';
import StatusMonitorRedux from '../components/StatusMonitorRedux';
import {
  selectAppPods,
  selectAppServices,
  selectAppTabConfig,
} from '../store/selectors';

const { TabPane } = Tabs;

export default function MonitoringPage() {
  const pods = useSelector(selectAppPods);
  const services = useSelector(selectAppServices);
  const tabConfig = useSelector(selectAppTabConfig);
  const isTabVisible = (k) => tabConfig[k] !== 'off';

  // B 方案：Card 撑满视口剩余空间；左 Card 内部 body 自滚；
  // 右 Card body padding:0，把滚动让给 Tabs 的 TabPane 里的 Table。
  // body 有 zoom，vh 是物理视口值不随 zoom 缩；除以 --zoom-factor 校正回物理高度。
  const cardHeight = 'calc((100vh - 170px) / var(--zoom-factor))';
  const cardBodyHeight = 'calc(100% - 57px)'; // 100% - AntD Card title bar

  return (
    <>
      <PageHeader title="Monitoring" breadcrumb={['Home', 'Monitoring']} />
      <div style={{ padding: 16 }}>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card
              title="Cluster Status"
              className="theme-card analytics"
              style={{ height: cardHeight, overflow: 'hidden' }}
              styles={{ body: { height: cardBodyHeight, overflow: 'auto' } }}
            >
              <ClusterStatusV2Redux />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card
              title="App Status"
              className="theme-card database"
              style={{ height: cardHeight, overflow: 'hidden' }}
              styles={{ body: { height: cardBodyHeight, padding: 0 } }}
            >
              <Tabs
                defaultActiveKey="pods"
                size="small"
                style={{ padding: '0 16px' }}
              >
                {isTabVisible('pods') && (
                  <TabPane
                    tab={<Space><ContainerOutlined />Pods<Badge count={pods.length} style={{ backgroundColor: '#1890ff' }} /></Space>}
                    key="pods"
                  >
                    <div style={{ padding: 16 }}><StatusMonitorRedux activeTab="pods" /></div>
                  </TabPane>
                )}
                {isTabVisible('services') && (
                  <TabPane
                    tab={<Space><ApiOutlined />Services<Badge count={services.length} style={{ backgroundColor: '#52c41a' }} /></Space>}
                    key="services"
                  >
                    <div style={{ padding: 16 }}><StatusMonitorRedux activeTab="services" /></div>
                  </TabPane>
                )}
                {isTabVisible('deployments') && (
                  <TabPane tab={<Space><ContainerOutlined />Deployments</Space>} key="deployments">
                    <div style={{ padding: 16 }}><StatusMonitorRedux activeTab="deployments" /></div>
                  </TabPane>
                )}
                {isTabVisible('inference') && (
                  <TabPane tab={<Space><ThunderboltOutlined />InferenceEndpointConfig</Space>} key="inference-endpoints">
                    <div style={{ padding: 16 }}><StatusMonitorRedux activeTab="inference" /></div>
                  </TabPane>
                )}
                {isTabVisible('hyperpodJobs') && (
                  <TabPane tab={<Space><ExperimentOutlined />HyperPodPytorchJob</Space>} key="hyperpod-jobs">
                    <div style={{ padding: 16 }}><StatusMonitorRedux activeTab="jobs" /></div>
                  </TabPane>
                )}
                {isTabVisible('rayjobs') && (
                  <TabPane tab={<Space><RocketOutlined />RayJobs</Space>} key="rayjobs">
                    <div style={{ padding: 16 }}><StatusMonitorRedux activeTab="rayjobs" /></div>
                  </TabPane>
                )}
                {isTabVisible('jobs') && (
                  <TabPane tab={<Space><CodeOutlined />Jobs</Space>} key="k8s-jobs">
                    <div style={{ padding: 16 }}><StatusMonitorRedux activeTab="k8sjobs" /></div>
                  </TabPane>
                )}
              </Tabs>
            </Card>
          </Col>
        </Row>
      </div>
    </>
  );
}
