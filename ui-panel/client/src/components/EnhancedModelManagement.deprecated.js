import React, { useState, useEffect, useRef } from 'react';
import { Row, Col, Card, Tabs, Space, Select, Button } from 'antd';
import { DownloadOutlined, DatabaseOutlined, SettingOutlined, CloudServerOutlined, ReloadOutlined } from '@ant-design/icons';
import EnhancedModelDownloadPanel from './EnhancedModelDownloadPanel';
import S3StorageManager from './S3StorageManager';
import FSxStorageManager from './FSxStorageManager';
import S3StoragePanel from './S3StoragePanel';

const { TabPane } = Tabs;
const { Option } = Select;

const EnhancedModelManagement = () => {
  const [selectedStorage, setSelectedStorage] = useState('s3-claim');
  const [availableStorages, setAvailableStorages] = useState([]);
  const [s3PanelLoading, setS3PanelLoading] = useState(false);
  const s3PanelRef = useRef(null);

  // 获取可用的存储配置 - 改为手动触发，不在组件挂载时自动执行
  const fetchAvailableStorages = async () => {
    try {
      const response = await fetch('/api/s3-storages');
      const result = await response.json();
      if (result.success) {
        setAvailableStorages(result.storages || []);
        // 如果当前选择的存储不存在，选择第一个可用的
        if (result.storages.length > 0 && !result.storages.find(s => s.pvcName === selectedStorage)) {
          setSelectedStorage(result.storages[0].pvcName);
        }
      }
    } catch (error) {
      console.error('Error fetching storages:', error);
    }
  };

  // 移除自动触发的useEffect，让S3StoragePanel自主管理数据获取
  // useEffect(() => {
  //   fetchAvailableStorages();
  // }, []);

  return (
    <Row gutter={[16, 16]} style={{ height: '100%' }}>
      {/* 左侧：配置面板 */}
      <Col xs={24} lg={12}>
        <Card
          title="Storage Configuration"
          className="theme-card storage"
          style={{ height: '60vh', overflow: 'auto' }}
        >
          <Tabs 
            defaultActiveKey="enhanced-download" 
            size="small"
          >
            <TabPane
              tab={
                <Space>
                  <DownloadOutlined />
                  HuggingFace Download
                </Space>
              }
              key="enhanced-download"
            >
              <EnhancedModelDownloadPanel 
                onStorageChange={setSelectedStorage}
                onStorageRefresh={fetchAvailableStorages}
              />
            </TabPane>
            
            <TabPane
              tab={
                <Space>
                  <SettingOutlined />
                  S3 Mount Config
                </Space>
              }
              key="storage-config"
            >
              <S3StorageManager onStorageChange={fetchAvailableStorages} />
            </TabPane>

            <TabPane
              tab={
                <Space>
                  <CloudServerOutlined />
                  FSx Lustre Config
                </Space>
              }
              key="fsx-config"
            >
              <FSxStorageManager onStorageChange={fetchAvailableStorages} />
            </TabPane>
          </Tabs>
        </Card>
      </Col>

      {/* 右侧：S3存储显示 */}
      <Col xs={24} lg={12}>
        <Card 
          title={
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <Space>
                <DatabaseOutlined />
                S3 Storage Contents
                <Select
                  size="small"
                  value={selectedStorage}
                  onChange={setSelectedStorage}
                  style={{ minWidth: 150 }}
                >
                  {availableStorages.map(storage => (
                    <Option key={storage.pvcName} value={storage.pvcName}>
                      {storage.name} ({storage.bucketName})
                    </Option>
                  ))}
                </Select>
              </Space>
              <Button
                icon={<ReloadOutlined />}
                onClick={() => s3PanelRef.current?.refresh()}
                loading={s3PanelLoading}
                size="small"
              >
                Refresh
              </Button>
            </div>
          }
          className="theme-card storage"
          style={{ height: '60vh', overflow: 'auto' }}
        >
          <S3StoragePanel
            ref={s3PanelRef}
            selectedStorage={selectedStorage}
            onLoadingChange={setS3PanelLoading}
          />
        </Card>
      </Col>
    </Row>
  );
};

export default EnhancedModelManagement;
