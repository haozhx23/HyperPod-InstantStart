const fs = require('fs');
const path = require('path');

class ClusterManager {
  constructor() {
    this.baseDir = path.join(__dirname, '..', 'managed_clusters_info'); // 修正路径
    this.clustersDir = this.baseDir; // 添加clustersDir属性
    this.cliDir = path.join(__dirname, '..', '..', 'cli'); // 修正路径
    this.activeClusterFile = path.join(this.baseDir, 'active_cluster.json');
    
    // 确保基础目录存在
    this.ensureBaseDir();
  }

  ensureBaseDir() {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  // 获取集群目录路径
  getClusterDir(clusterTag) {
    return path.join(this.baseDir, clusterTag);
  }

  getClusterConfigDir(clusterTag) {
    return path.join(this.getClusterDir(clusterTag), 'config');
  }

  getClusterLogsDir(clusterTag) {
    return path.join(this.getClusterDir(clusterTag), 'logs');
  }

  getClusterCurrentDir(clusterTag) {
    return path.join(this.getClusterDir(clusterTag), 'current');
  }

  getClusterMetadataDir(clusterTag) {
    return path.join(this.getClusterDir(clusterTag), 'metadata');
  }

  // 创建集群目录结构
  createClusterDirs(clusterTag) {
    const dirs = [
      this.getClusterDir(clusterTag),
      this.getClusterConfigDir(clusterTag),
      this.getClusterLogsDir(clusterTag),
      this.getClusterCurrentDir(clusterTag),
      this.getClusterMetadataDir(clusterTag)
    ];

    dirs.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    // Auto-generate quick_links.json template for user to fill in
    const quickLinksPath = path.join(this.getClusterConfigDir(clusterTag), 'quick_links.json');
    if (!fs.existsSync(quickLinksPath)) {
      fs.writeFileSync(quickLinksPath, JSON.stringify({ grafana: "" }, null, 2));
    }
  }

  // 获取活跃集群
  getActiveCluster() {
    try {
      if (fs.existsSync(this.activeClusterFile)) {
        const data = JSON.parse(fs.readFileSync(this.activeClusterFile, 'utf8'));
        return data.activeCluster;
      }
    } catch (error) {
      console.warn('Failed to read active cluster:', error.message);
    }
    return null;
  }

  // 设置活跃集群
  setActiveCluster(clusterTag) {
    const data = { activeCluster: clusterTag, lastUpdated: new Date().toISOString() };
    fs.writeFileSync(this.activeClusterFile, JSON.stringify(data, null, 2));
  }

  // 获取所有集群列表
  getAllClusters() {
    const clusters = [];
    
    try {
      if (!fs.existsSync(this.baseDir)) {
        return clusters;
      }

      const dirs = fs.readdirSync(this.baseDir);
      
      for (const dir of dirs) {
        if (dir === 'active_cluster.json') continue;
        
        const clusterInfoPath = path.join(this.getClusterMetadataDir(dir), 'cluster_info.json');
        if (fs.existsSync(clusterInfoPath)) {
          try {
            const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
            // Merge quick_links from config
            const quickLinksPath = path.join(this.getClusterConfigDir(dir), 'quick_links.json');
            if (fs.existsSync(quickLinksPath)) {
              try {
                clusterInfo.quickLinks = JSON.parse(fs.readFileSync(quickLinksPath, 'utf8'));
              } catch (e) { /* ignore parse errors */ }
            }
            clusters.push(clusterInfo);
          } catch (error) {
            console.warn(`Failed to read cluster info for ${dir}:`, error.message);
          }
        }
      }
    } catch (error) {
      console.error('Failed to get clusters:', error.message);
    }

    return clusters.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  }

  // 保存集群信息
  saveClusterInfo(clusterTag, config) {
    const clusterInfo = {
      clusterTag,
      createdAt: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      config: config,
      status: 'configured'
    };

    const clusterInfoPath = path.join(this.getClusterMetadataDir(clusterTag), 'cluster_info.json');
    fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
    
    return clusterInfo;
  }

  // 恢复集群配置到 CLI 目录
  restoreClusterConfig(clusterTag) {
    const configDir = this.getClusterConfigDir(clusterTag);
    const filesToRestore = ['cluster_envs', 'mlflow-server-info.json'];
    
    for (const file of filesToRestore) {
      const sourcePath = path.join(configDir, file);
      const targetPath = path.join(this.cliDir, file);
      
      if (fs.existsSync(sourcePath)) {
        try {
          fs.copyFileSync(sourcePath, targetPath);
          console.log(`Restored ${file} for cluster ${clusterTag}`);
        } catch (error) {
          console.warn(`Failed to restore ${file}:`, error.message);
        }
      }
    }
  }

  // 清除集群状态缓存
  clearClusterCache(clusterTag) {
    const metadataDir = this.getClusterMetadataDir(clusterTag);
    const cacheFiles = [
      'step1_status_cache.json',
      'step2_status_cache.json'
    ];

    cacheFiles.forEach(file => {
      const filePath = path.join(metadataDir, file);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`Cleared cache file: ${file}`);
        } catch (error) {
          console.warn(`Failed to clear cache ${file}:`, error.message);
        }
      }
    });
  }

  /**
   * 保存HyperPod配置
   * @param {string} clusterTag - 集群标识
   * @param {Object} hyperPodConfig - HyperPod配置
   */
  async saveHyperPodConfig(clusterTag, hyperPodConfig) {
    try {
      const clusterDir = path.join(this.clustersDir, clusterTag);
      const metadataDir = path.join(clusterDir, 'metadata');
      
      // 确保目录存在
      if (!fs.existsSync(metadataDir)) {
        fs.mkdirSync(metadataDir, { recursive: true });
      }
      
      // 保存HyperPod配置
      const hyperPodConfigPath = path.join(metadataDir, 'hyperpod-config.json');
      fs.writeFileSync(hyperPodConfigPath, JSON.stringify({
        hyperPodCluster: hyperPodConfig,
        savedAt: new Date().toISOString()
      }, null, 2));
      
      console.log(`HyperPod configuration saved for cluster: ${clusterTag}`);
    } catch (error) {
      console.error('Error saving HyperPod configuration:', error);
      throw error;
    }
  }

  /**
   * 获取HyperPod配置
   * @param {string} clusterTag - 集群标识
   * @returns {Object|null} HyperPod配置
   */
  async getHyperPodConfig(clusterTag) {
    try {
      const hyperPodConfigPath = path.join(this.clustersDir, clusterTag, 'metadata', 'hyperpod-config.json');
      
      if (await fs.pathExists(hyperPodConfigPath)) {
        const config = await fs.readJson(hyperPodConfigPath);
        return config.hyperPodCluster;
      }
      
      return null;
    } catch (error) {
      console.error('Error getting HyperPod configuration:', error);
      return null;
    }
  }

  // 保存导入集群配置
  async saveImportConfig(clusterTag, importConfig, accessInfo = null, detectedState = null) {
    const metadataDir = this.getClusterMetadataDir(clusterTag);
    
    // 创建导入元数据
    const importMetadata = {
      type: 'imported',
      importedAt: new Date().toISOString(),
      eksClusterName: importConfig.EKS_CLUSTER_NAME,
      awsRegion: importConfig.AWS_REGION,
      accessEntry: accessInfo ? {
        action: accessInfo.action,
        roleArn: accessInfo.roleArn,
        policies: accessInfo.policies || [],
        configuredAt: new Date().toISOString(),
        message: accessInfo.message
      } : null,
      detectedState: detectedState || null
    };
    
    fs.writeFileSync(
      path.join(metadataDir, 'import_metadata.json'),
      JSON.stringify(importMetadata, null, 2)
    );
    
    // 创建cluster_info.json
    const clusterInfo = {
      clusterTag,
      status: 'imported',
      region: importConfig.AWS_REGION,
      lastModified: new Date().toISOString(),
      type: 'imported',
      source: 'ui-panel-import',
      dependencies: detectedState?.dependencies ? {
        configured: detectedState.dependencies.configured,
        detected: true,
        effectiveStatus: detectedState.dependencies.configured,
        components: detectedState.dependencies.components,
        lastDetected: detectedState.dependencies.lastDetected
      } : {
        configured: false,
        detected: false,
        effectiveStatus: false
      },
      hyperPodClusters: {
        detected: detectedState?.hyperPodClusters || [],
        userCreated: []
      },
      nodeGroups: {
        detected: detectedState?.nodeGroups || [],
        userCreated: []
      },
      detectedAt: detectedState?.detectedAt || null,
      eksCluster: {
        name: importConfig.EKS_CLUSTER_NAME,
        arn: null,
        vpcId: null,
        securityGroupId: null
      }
    };
    
    fs.writeFileSync(
      path.join(metadataDir, 'cluster_info.json'),
      JSON.stringify(clusterInfo, null, 2)
    );
    
    // 生成 cluster_envs 文件
    const EnvInjector = require('./utils/envInjector');
    EnvInjector.updateClusterEnvFile(clusterTag);
    
    console.log(`Saved import config and generated cluster_envs for cluster: ${clusterTag}`);
  }

  // 保存基础导入配置（不包含检测状态）
  async saveImportConfigBasic(clusterTag, importConfig, accessInfo = null, hasHyperPod = false) {
    const metadataDir = this.getClusterMetadataDir(clusterTag);
    
    // 创建导入元数据
    const importMetadata = {
      type: 'imported',
      importedAt: new Date().toISOString(),
      eksClusterName: importConfig.EKS_CLUSTER_NAME,
      awsRegion: importConfig.AWS_REGION,
      hasHyperPod: hasHyperPod,
      accessEntry: accessInfo ? {
        action: accessInfo.action,
        roleArn: accessInfo.roleArn,
        policies: accessInfo.policies || [],
        configuredAt: new Date().toISOString(),
        message: accessInfo.message
      } : null
    };
    
    fs.writeFileSync(
      path.join(metadataDir, 'import_metadata.json'),
      JSON.stringify(importMetadata, null, 2)
    );
    
    // 创建基础cluster_info.json
    const clusterInfo = {
      clusterTag,
      region: importConfig.AWS_REGION,
      status: 'imported',
      type: 'imported',
      createdAt: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      source: 'ui-panel-import',
      dependencies: {
        configured: false,
        status: 'pending',
        lastAttempt: null,
        lastSuccess: null,
        components: {
          helmDependencies: false,
          nlbController: false,
          s3CsiDriver: false,
          certManager: false
        }
      },
      eksCluster: {
        name: importConfig.EKS_CLUSTER_NAME,
        arn: null,
        vpcId: null,
        securityGroupId: null
      }
    };
    
    fs.writeFileSync(
      path.join(metadataDir, 'cluster_info.json'),
      JSON.stringify(clusterInfo, null, 2)
    );
    
    // 生成 cluster_envs 文件
    const EnvInjector = require('./utils/envInjector');
    EnvInjector.updateClusterEnvFile(clusterTag);
    
    console.log(`Created basic cluster info and cluster_envs for imported cluster: ${clusterTag} (hasHyperPod: ${hasHyperPod})`);
  }

  // 更新导入配置包含检测状态
  async updateImportConfigWithDetectedState(clusterTag, detectedState) {
    const metadataDir = this.getClusterMetadataDir(clusterTag);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    
    if (!fs.existsSync(clusterInfoPath)) {
      throw new Error(`Cluster info not found for: ${clusterTag}`);
    }
    
    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
    
    // 更新依赖检测状态（保持与创建集群一致的结构）
    if (detectedState?.dependencies) {
      clusterInfo.dependencies.components = detectedState.dependencies.components;
      // 不添加detected、effectiveStatus等字段，保持与创建集群一致
    }
    
    clusterInfo.lastModified = new Date().toISOString();
    
    fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
    console.log(`Updated cluster info with detected state for: ${clusterTag}`);
  }

  // 检查集群是否存在
  clusterExists(clusterTag) {
    return fs.existsSync(this.getClusterDir(clusterTag));
  }

  // 更新集群检测状态
  async updateClusterDetectedState(clusterTag, detectedState) {
    const metadataDir = this.getClusterMetadataDir(clusterTag);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    
    if (!fs.existsSync(clusterInfoPath)) {
      throw new Error(`Cluster info not found for: ${clusterTag}`);
    }
    
    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
    
    // 更新检测状态
    clusterInfo.dependencies = detectedState?.dependencies ? {
      configured: clusterInfo.dependencies?.configured || false,
      detected: true,
      effectiveStatus: detectedState.dependencies.configured,
      components: detectedState.dependencies.components,
      lastDetected: detectedState.dependencies.lastDetected
    } : clusterInfo.dependencies;
    
    clusterInfo.hyperPodClusters = {
      detected: detectedState?.hyperPodClusters || [],
      userCreated: clusterInfo.hyperPodClusters?.userCreated || []
    };
    
    clusterInfo.nodeGroups = {
      detected: detectedState?.nodeGroups || [],
      userCreated: clusterInfo.nodeGroups?.userCreated || []
    };
    
    clusterInfo.detectedAt = detectedState?.detectedAt || new Date().toISOString();
    clusterInfo.lastModified = new Date().toISOString();
    
    fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
    console.log(`Updated detected state for cluster: ${clusterTag}`);
  }

  // 保存EKS集群创建配置
  async saveCreationConfig(clusterTag, clusterConfig, cidrConfig, stackResult) {
    // 创建集群目录结构
    this.createClusterDirs(clusterTag);
    
    const configDir = this.getClusterConfigDir(clusterTag);
    const metadataDir = this.getClusterMetadataDir(clusterTag);
    
    // 保存创建元数据
    const creationMetadata = {
      type: 'created',
      createdAt: new Date().toISOString(),
      creationMethod: 'ui-panel',
      userConfig: clusterConfig,
      cidrConfiguration: cidrConfig,
      cloudFormation: {
        stackName: stackResult.stackName,
        stackId: stackResult.stackId,
        templateFile: '1-eks-full-stack.yaml',
        status: 'CREATE_IN_PROGRESS',
        parameters: stackResult.parameters
      }
    };
    
    fs.writeFileSync(
      path.join(metadataDir, 'creation_metadata.json'),
      JSON.stringify(creationMetadata, null, 2)
    );
    
    // 保存CIDR配置
    fs.writeFileSync(
      path.join(metadataDir, 'cidr_configuration.json'),
      JSON.stringify(cidrConfig, null, 2)
    );
    
    // 注意：cluster_info.json 应该在创建完成后由 registerCompletedCluster() 生成
    // 这样可以避免未完成的集群出现在 Active Cluster 列表中
    
    console.log(`✅ Saved creation config for cluster: ${clusterTag}`);
    
    console.log(`Saved creation config for cluster: ${clusterTag}`);
  }

  // 获取集群信息
  async getClusterInfo(clusterTag) {
    try {
      const clusterInfoPath = path.join(this.getClusterMetadataDir(clusterTag), 'cluster_info.json');
      if (fs.existsSync(clusterInfoPath)) {
        return JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
      }
      return null;
    } catch (error) {
      console.error(`Error getting cluster info for ${clusterTag}:`, error);
      return null;
    }
  }

  // 更新集群状态
  async updateClusterStatus(clusterTag, status, additionalInfo = {}) {
    try {
      const clusterInfo = await this.getClusterInfo(clusterTag);
      if (clusterInfo) {
        clusterInfo.status = status;
        clusterInfo.lastModified = new Date().toISOString();
        Object.assign(clusterInfo, additionalInfo);
        
        const clusterInfoPath = path.join(this.getClusterMetadataDir(clusterTag), 'cluster_info.json');
        fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
      }
    } catch (error) {
      console.error(`Error updating cluster status for ${clusterTag}:`, error);
    }
  }
}

module.exports = ClusterManager;
