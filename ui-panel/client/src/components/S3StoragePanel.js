import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { List, Space, Typography, Spin, Empty, Tag, message } from 'antd';
import { FolderOutlined, FileOutlined } from '@ant-design/icons';

const { Text } = Typography;

const S3StoragePanel = forwardRef(({ selectedStorage = 'default', onLoadingChange }, ref) => {
  const [loading, setLoading] = useState(false);
  const [s3Data, setS3Data] = useState([]);
  const [bucketInfo, setBucketInfo] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const fetchS3Data = async () => {
    try {
      setLoading(true);
      if (onLoadingChange) onLoadingChange(true);
      console.log(`Fetching S3 storage data for: ${selectedStorage}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 120秒超时
      
      const response = await fetch(`/api/s3-storage?storage=${selectedStorage}`, {
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      const result = await response.json();
      
      if (result.success) {
        setS3Data(result.data || []);
        setBucketInfo(result.bucketInfo || null);
        setLastRefresh(new Date().toLocaleTimeString());
        message.success(`Loaded ${result.data?.length || 0} items from S3`);
      } else {
        message.error(`Failed to fetch S3 data: ${result.error}`);
        setS3Data([]);
        setBucketInfo(null);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.warn('S3 data fetch timeout');
        message.warning('S3 data fetch timeout, but keeping existing data. Try refresh again.');
        // 保持现有数据，不清空
        return;
      } else {
        console.error('Error fetching S3 data:', error);
        message.error('Failed to fetch S3 storage information');
        // 只在真正失败时清空数据
        setS3Data([]);
        setBucketInfo(null);
      }
    } finally {
      setLoading(false);
      if (onLoadingChange) onLoadingChange(false);
    }
  };

  useImperativeHandle(ref, () => ({
    refresh: fetchS3Data,
  }));

  useEffect(() => {
    fetchS3Data();
    // S3 数据不需要频繁刷新，只在初始加载和手动刷新时获取
  }, [selectedStorage]);

  const formatFileSize = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'Unknown';
    try {
      return new Date(dateString).toLocaleString();
    } catch {
      return dateString;
    }
  };

  const getItemIcon = (item) => {
    if (item.type === 'folder' || item.key?.endsWith('/')) {
      return <FolderOutlined style={{ color: '#1890ff' }} />;
    }
    return <FileOutlined style={{ color: '#52c41a' }} />;
  };

  const getItemType = (item) => {
    if (item.type === 'folder' || item.key?.endsWith('/')) {
      return <Tag color="blue">Folder</Tag>;
    }
    
    const extension = item.key?.split('.').pop()?.toLowerCase();
    switch (extension) {
      case 'bin':
      case 'safetensors':
        return <Tag color="purple">Model</Tag>;
      case 'json':
        return <Tag color="orange">Config</Tag>;
      case 'txt':
      case 'md':
        return <Tag color="green">Text</Tag>;
      default:
        return <Tag color="default">File</Tag>;
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '16px' }}>
      {/* Bucket info 信息条（仅在有数据时显示） */}
      {bucketInfo && (
        <div style={{ marginBottom: '16px', flexShrink: 0 }}>
          <div style={{ backgroundColor: '#f0f9ff', border: '1px solid #91d5ff', borderRadius: '4px', padding: '8px 12px' }}>
            <Space split={<span style={{ color: '#d9d9d9' }}>|</span>} wrap>
              <Text>
                <strong>Bucket:</strong> <span style={{ color: '#1890ff' }}>{bucketInfo.bucket}</span>
              </Text>
              <Text>
                <strong>Region:</strong> {bucketInfo.region || 'Unknown'}
              </Text>
              <Text>
                <strong>Items:</strong> {s3Data.length}
              </Text>
              {lastRefresh && (
                <Text>
                  <strong>Refresh:</strong> {lastRefresh}
                </Text>
              )}
            </Space>
          </div>
        </div>
      )}

      {/* S3 Contents List */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Spin spinning={loading} style={{ height: '100%' }}>
          {s3Data.length === 0 ? (
            <Empty
              description={
                <Space direction="vertical">
                  <Text>No files found in S3 storage</Text>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    Download models to see them appear here
                  </Text>
                </Space>
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : (
          <div style={{ flex: 1, overflow: 'auto', paddingRight: '8px' }}>
            <div style={{ height: '100%', overflow: 'auto' }}>
              <List
                dataSource={s3Data}
                renderItem={(item) => (
                  <List.Item
                    key={item.key}
                    style={{ 
                      padding: '12px 16px',
                      border: '1px solid #f0f0f0',
                      borderRadius: '6px',
                      marginBottom: '8px',
                      backgroundColor: '#fafafa'
                    }}
                  >
                    <List.Item.Meta
                      avatar={getItemIcon(item)}
                      title={
                        <Space>
                          <Text strong style={{ fontSize: '14px' }}>
                            {item.key || item.name}
                          </Text>
                          {getItemType(item)}
                        </Space>
                      }
                      description={
                        <Space direction="vertical" size="small">
                          {item.size && (
                            <Text style={{ fontSize: '12px' }}>
                              <strong>Size:</strong> {formatFileSize(item.size)}
                            </Text>
                          )}
                          {item.lastModified && (
                            <Text style={{ fontSize: '12px' }}>
                              <strong>Modified:</strong> {formatDate(item.lastModified)}
                            </Text>
                          )}
                          {item.storageClass && (
                            <Text style={{ fontSize: '12px' }}>
                              <strong>Storage Class:</strong> {item.storageClass}
                            </Text>
                          )}
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            </div>
          </div>
          )}
        </Spin>
      </div>
    </div>
  );
});

export default S3StoragePanel;
