import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Row, Col, Card, Tabs, Space, Select, Button } from 'antd';
import {
  DownloadOutlined,
  SettingOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import EnhancedModelDownloadPanel from '../components/EnhancedModelDownloadPanel';
import S3StorageManager from '../components/S3StorageManager';
import FSxStorageManager from '../components/FSxStorageManager';
import S3StoragePanel from '../components/S3StoragePanel';

export default function StoragePage() {
  const [selectedStorage, setSelectedStorage] = useState('s3-claim');
  const [availableStorages, setAvailableStorages] = useState([]);
  const [s3PanelLoading, setS3PanelLoading] = useState(false);
  const s3PanelRef = useRef(null);

  const fetchAvailableStorages = useCallback(async () => {
    try {
      const response = await fetch('/api/s3-storages');
      const result = await response.json();
      if (result.success) {
        setAvailableStorages(result.storages || []);
        if (result.storages.length > 0 && !result.storages.find((s) => s.pvcName === selectedStorage)) {
          setSelectedStorage(result.storages[0].pvcName);
        }
      }
    } catch (error) {
      console.error('Error fetching storages:', error);
    }
  }, [selectedStorage]);

  useEffect(() => {
    fetchAvailableStorages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Card 视口满高 + body 内部滚动。和 MonitoringPage 同样的 B 方案。
  const cardHeight = 'calc((100vh - 170px) / var(--zoom-factor))';
  const cardBodyStyle = { height: 'calc(100% - 57px)', overflow: 'auto' };

  return (
    <>
      <PageHeader title="Storage" breadcrumb={['Home', 'Storage']} />
      <div style={{ padding: 16 }}>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card
              title="Storage Configuration"
              className="theme-card storage"
              style={{ height: cardHeight, overflow: 'hidden' }}
              styles={{ body: cardBodyStyle }}
            >
              <Tabs
                defaultActiveKey="enhanced-download"
                size="small"
                items={[
                  {
                    key: 'enhanced-download',
                    label: <Space><DownloadOutlined />HuggingFace Download</Space>,
                    children: (
                      <EnhancedModelDownloadPanel
                        onStorageChange={setSelectedStorage}
                        onStorageRefresh={fetchAvailableStorages}
                      />
                    ),
                  },
                  {
                    key: 'storage-config',
                    label: <Space><SettingOutlined />S3 Mount Config</Space>,
                    children: <S3StorageManager onStorageChange={fetchAvailableStorages} />,
                  },
                  {
                    key: 'fsx-config',
                    label: <Space><CloudServerOutlined />FSx Lustre Config</Space>,
                    children: <FSxStorageManager onStorageChange={fetchAvailableStorages} />,
                  },
                ]}
              />
            </Card>
          </Col>
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
                      {availableStorages.map((storage) => (
                        <Select.Option key={storage.pvcName} value={storage.pvcName}>
                          {storage.name} ({storage.bucketName})
                        </Select.Option>
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
              style={{ height: cardHeight, overflow: 'hidden' }}
              styles={{ body: cardBodyStyle }}
            >
              <S3StoragePanel
                ref={s3PanelRef}
                selectedStorage={selectedStorage}
                onLoadingChange={setS3PanelLoading}
              />
            </Card>
          </Col>
        </Row>
      </div>
    </>
  );
}
