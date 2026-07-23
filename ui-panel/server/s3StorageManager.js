const fs = require('fs-extra');
const path = require('path');
const yaml = require('yaml');
const { exec, execAsync } = require('./utils/exec');
const { getEffectiveRegion } = require('./utils/regionResolver');
const { renderTemplate, patches: P } = require('./utils/renderTemplate');

class S3StorageManager {
  constructor() {
    // 不再使用全局配置路径
    this.managedClustersPath = path.join(__dirname, '../managed_clusters_info');
  }

  // ==================== Default Configuration ====================

  /**
   * 获取 S3 存储默认配置
   * 从容器元数据或环境变量中读取默认 bucket 信息
   * @returns {Object} { success, defaults: { name, bucketName, region } }
   */
  getStorageDefaults() {
    let detectedRegion = '';
    try {
      // 运维路径:优先活跃集群 region,主机兜底
      detectedRegion = getEffectiveRegion();
    } catch (e) {
      console.warn('Could not detect AWS region for S3 defaults:', e.message);
    }

    try {
      let defaultBucket = '';

      // 从容器中的 /s3-workspace-metadata 路径读取默认bucket
      try {
        const metadataPath = '/s3-workspace-metadata';
        const bucketInfoPath = path.join(metadataPath, 'CURRENT_BUCKET_INFO');

        if (fs.existsSync(bucketInfoPath)) {
          const bucketInfoContent = fs.readFileSync(bucketInfoPath, 'utf8');
          const bucketInfo = JSON.parse(bucketInfoContent);
          defaultBucket = bucketInfo.bucketName;
          console.log('Successfully read bucket info from CURRENT_BUCKET_INFO:', bucketInfo.bucketName);
        } else {
          console.log('CURRENT_BUCKET_INFO file not found at:', bucketInfoPath);
        }
      } catch (error) {
        console.log('Could not read s3-workspace-metadata:', error.message);
      }

      return {
        success: true,
        defaults: {
          name: 's3-claim',
          bucketName: defaultBucket,
          region: detectedRegion
        }
      };
    } catch (error) {
      console.error('Error getting S3 storage defaults:', error);
      return {
        success: false,
        error: error.message,
        defaults: {
          name: 's3-claim',
          bucketName: '',
          region: detectedRegion
        }
      };
    }
  }

  // ==================== S3 Content Listing ====================

  /**
   * 列出 S3 存储内容
   * @param {string} storageName - PVC 名称（可选，默认使用 s3-claim 或第一个存储）
   * @returns {Object} { success, data: [], bucketInfo: {} }
   */
  async listStorageContent(storageName = null) {
    try {
      console.log(`📦 Fetching S3 storage content for: ${storageName || 'default'}`);

      // 获取存储配置
      const storageResult = await this.getStorages();
      if (!storageResult.success) {
        return { success: false, error: 'Failed to get storage configurations' };
      }

      // 找到对应的存储配置
      const selectedStorage = storageResult.storages.find(s => s.pvcName === storageName) ||
                             storageResult.storages.find(s => s.pvcName === 's3-claim') ||
                             storageResult.storages[0];

      if (!selectedStorage) {
        return {
          success: true,
          data: [],
          bucketInfo: { bucket: 'No storage configured', region: 'Unknown' }
        };
      }

      console.log(`📦 Using storage: ${selectedStorage.name} -> ${selectedStorage.bucketName}`);

      // 使用AWS CLI获取S3内容
      const effectiveRegion = selectedStorage.region || getEffectiveRegion();
      const s3Data = await this._listS3Contents(selectedStorage.bucketName, effectiveRegion);

      console.log(`📊 Found ${s3Data.length} items in S3`);

      return {
        success: true,
        data: s3Data,
        bucketInfo: {
          bucket: selectedStorage.bucketName,
          region: selectedStorage.region || 'Unknown',
          pvcName: selectedStorage.pvcName
        }
      };

    } catch (error) {
      console.error('❌ Error fetching S3 storage:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 列出 S3 bucket 内容（内部方法）
   * @private
   */
  async _listS3Contents(bucketName, region) {
    const awsCommand = `aws s3 ls s3://${bucketName}/ --region ${region}`;
    console.log(`🔍 Executing: ${awsCommand}`);

    try {
      const { stdout, stderr } = await execAsync(awsCommand);

      if (stderr) {
        console.warn('AWS CLI stderr:', stderr);
      }

      const s3Data = [];

      if (stdout) {
        const lines = stdout.split('\n').filter(line => line.trim());

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith('PRE ')) {
            // 文件夹格式: "PRE folder-name/"
            const folderName = trimmed.substring(4); // 去掉 "PRE "
            s3Data.push({
              key: folderName,
              type: 'folder',
              size: null,
              lastModified: new Date().toISOString()
            });
          } else {
            // 文件格式: "2025-08-15 09:18:57 0 filename"
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 4) {
              const date = parts[0];
              const time = parts[1];
              const size = parts[2];
              const name = parts.slice(3).join(' ');

              s3Data.push({
                key: name,
                type: 'file',
                size: parseInt(size) || 0,
                lastModified: new Date(`${date} ${time}`).toISOString(),
                storageClass: 'STANDARD'
              });
            }
          }
        }
      }

      return s3Data;
    } catch (awsError) {
      console.error('AWS CLI error:', awsError);
      throw new Error(`Failed to list S3 contents: ${awsError.message}`);
    }
  }

  // 获取当前活跃集群的S3配置路径
  getActiveClusterStorageConfigPath() {
    try {
      const activeClusterPath = path.join(this.managedClustersPath, 'active_cluster.json');
      if (!fs.existsSync(activeClusterPath)) {
        return null;
      }
      
      const activeClusterInfo = fs.readJsonSync(activeClusterPath);
      const activeCluster = activeClusterInfo.activeCluster;
      
      if (!activeCluster) {
        return null;
      }
      
      const clusterConfigPath = path.join(this.managedClustersPath, activeCluster, 'config', 's3-storages.json');
      return clusterConfigPath;
    } catch (error) {
      console.error('Error getting active cluster storage config path:', error);
      return null;
    }
  }

  // 确保集群配置文件存在
  ensureClusterConfigFile(configPath) {
    if (!configPath) return false;
    
    if (!fs.existsSync(configPath)) {
      fs.ensureDirSync(path.dirname(configPath));
      fs.writeJsonSync(configPath, { storages: [] });
    }
    return true;
  }

  // 获取所有S3存储配置
  async getStorages() {
    try {
      const configPath = this.getActiveClusterStorageConfigPath();
      if (!configPath || !this.ensureClusterConfigFile(configPath)) {
        // 如果没有活跃集群，返回空列表
        return { success: true, storages: [] };
      }
      
      const config = fs.readJsonSync(configPath);
      
      // 检测现有的S3 PV/PVC
      const existingStorages = await this.detectExistingS3Storages();
      
      // 合并配置文件中的存储和检测到的存储
      const allStorages = [...config.storages];
      
      for (let existing of existingStorages) {
        const found = allStorages.find(s => s.pvcName === existing.pvcName);
        if (!found) {
          allStorages.push(existing);
        }
      }
      
      // 检查每个存储的状态
      for (let storage of allStorages) {
        storage.status = await this.checkStorageStatus(storage.pvcName);
      }
      
      return { success: true, storages: allStorages };
    } catch (error) {
      console.error('Error getting S3 storages:', error);
      return { success: false, error: error.message };
    }
  }

  // 检测现有的S3存储
  async detectExistingS3Storages() {
    return new Promise((resolve) => {
      exec('kubectl get pvc -o json', (error, stdout) => {
        if (error) {
          console.log('kubectl connection failed, returning empty storage list:', error.message);
          resolve([]);
          return;
        }
        
        try {
          const pvcList = JSON.parse(stdout);
          const s3Storages = [];
          
          if (!pvcList.items || pvcList.items.length === 0) {
            console.log('No PVCs found in cluster, returning empty storage list');
            resolve([]);
            return;
          }
          
          let pendingChecks = pvcList.items.length;
          let completedChecks = 0;
          
          if (pendingChecks === 0) {
            resolve([]);
            return;
          }
          
          for (let pvc of pvcList.items) {
            // 检查是否是S3存储（通过volumeName查找对应的PV）
            if (pvc.spec.volumeName) {
              exec(`kubectl get pv ${pvc.spec.volumeName} -o json`, (pvError, pvStdout) => {
                completedChecks++;
                if (!pvError) {
                  try {
                    const pv = JSON.parse(pvStdout);
                    if (pv.spec.csi && pv.spec.csi.driver === 's3.csi.aws.com') {
                      s3Storages.push({
                        name: pvc.metadata.name,
                        bucketName: pv.spec.csi.volumeAttributes?.bucketName || 'Unknown',
                        region: this.extractRegionFromPV(pv),
                        pvcName: pvc.metadata.name,
                        pvName: pv.metadata.name,
                        createdAt: pvc.metadata.creationTimestamp,
                        source: 'detected'
                      });
                    }
                  } catch (e) {
                    console.warn('Error parsing PV JSON:', e);
                  }
                }
                
                // 所有检查完成后返回结果
                if (completedChecks === pendingChecks) {
                  console.log(`Detected ${s3Storages.length} S3 storages from ${pendingChecks} PVCs`);
                  resolve(s3Storages);
                }
              });
            } else {
              completedChecks++;
              if (completedChecks === pendingChecks) {
                resolve(s3Storages);
              }
            }
          }
        } catch (e) {
          console.error('Error parsing PVC list:', e);
          resolve([]);
        }
      });
    });
  }

  // 从PV中提取region信息
  extractRegionFromPV(pv) {
    const mountOptions = pv.spec.mountOptions || [];
    for (let option of mountOptions) {
      if (option.startsWith('region ')) {
        return option.replace('region ', '');
      }
    }
    return 'Unknown';
  }

  // 检查存储状态
  async checkStorageStatus(pvcName) {
    return new Promise((resolve) => {
      exec(`kubectl get pvc ${pvcName} -o jsonpath='{.status.phase}'`, (error, stdout) => {
        if (error) {
          resolve('Not Found');
        } else {
          resolve(stdout.trim() === 'Bound' ? 'Ready' : 'Pending');
        }
      });
    });
  }

  // 创建S3存储配置
  async createStorage(storageConfig) {
    try {
      const configPath = this.getActiveClusterStorageConfigPath();
      if (!configPath || !this.ensureClusterConfigFile(configPath)) {
        return { success: false, error: 'No active cluster found' };
      }

      const { name, bucketName, region } = storageConfig;
      
      // 直接使用用户输入的名称，完全透传
      const pvcName = name;
      const pvName = `pv-${name}`;

      // 检查是否已存在同名的PVC
      try {
        const checkCmd = `kubectl get pvc ${pvcName} --no-headers 2>/dev/null`;
        const { stdout } = await execAsync(checkCmd);
        if (stdout.trim()) {
          return { success: false, error: `Storage "${name}" already exists` };
        }
      } catch (error) {
        // PVC不存在，继续创建
      }

      // 检查是否已存在同名的PV
      try {
        const checkCmd = `kubectl get pv ${pvName} --no-headers 2>/dev/null`;
        const { stdout } = await execAsync(checkCmd);
        if (stdout.trim()) {
          return { success: false, error: `Storage "${name}" already exists (PV conflict)` };
        }
      } catch (error) {
        // PV不存在，继续创建
      }

      // 构建 mountOptions（性能参数）
      const mountOptions = [
        'allow-delete',
        `region ${region}`,
        '--read-part-size 25165824',
        '--maximum-throughput-gbps 100',
        '--metadata-ttl 3600'
      ];

      // 构建 volumeAttributes
      const volumeAttributes = {
        bucketName: bucketName,
        'mount-timeout-seconds': '300'
      };

      // 创建PV YAML
      const pvYaml = {
        apiVersion: 'v1',
        kind: 'PersistentVolume',
        metadata: {
          name: pvName
        },
        spec: {
          capacity: {
            storage: '1200Gi'
          },
          accessModes: ['ReadWriteMany'],
          mountOptions,
          csi: {
            driver: 's3.csi.aws.com',
            volumeHandle: `s3-csi-driver-volume-${pvcName}`,
            volumeAttributes
          }
        }
      };

      // 创建PVC YAML
      const pvcYaml = {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: pvcName
        },
        spec: {
          accessModes: ['ReadWriteMany'],
          storageClassName: '',
          resources: {
            requests: {
              storage: '1200Gi'
            }
          },
          volumeName: pvName
        }
      };

      // 应用PV
      const pvYamlStr = yaml.stringify(pvYaml);
      await this.applyKubernetesResource(pvYamlStr);

      // 应用PVC
      const pvcYamlStr = yaml.stringify(pvcYaml);
      await this.applyKubernetesResource(pvcYamlStr);

      // 保存配置到当前集群的配置文件
      const config = fs.readJsonSync(configPath);
      config.storages.push({
        name,
        bucketName,
        region,
        pvcName,
        pvName,
        createdAt: new Date().toISOString()
      });
      fs.writeJsonSync(configPath, config);

      return { success: true, pvcName, pvName };
    } catch (error) {
      console.error('Error creating S3 storage:', error);
      return { success: false, error: error.message };
    }
  }

  // 删除S3存储配置
  async deleteStorage(name) {
    try {
      const configPath = this.getActiveClusterStorageConfigPath();
      if (!configPath || !this.ensureClusterConfigFile(configPath)) {
        return { success: false, error: 'No active cluster found' };
      }

      const config = fs.readJsonSync(configPath);
      let storage = config.storages.find(s => s.name === name);
      
      // 如果配置文件中没有，尝试从检测到的存储中查找
      if (!storage) {
        const existingStorages = await this.detectExistingS3Storages();
        storage = existingStorages.find(s => s.name === name);
        
        if (!storage) {
          return { success: false, error: 'Storage not found' };
        }
      }

      // 删除PVC和PV
      await this.deleteKubernetesResource('pvc', storage.pvcName);
      await this.deleteKubernetesResource('pv', storage.pvName);

      // 从配置中移除（如果存在）
      config.storages = config.storages.filter(s => s.name !== name);
      fs.writeJsonSync(configPath, config);

      return { success: true };
    } catch (error) {
      console.error('Error deleting S3 storage:', error);
      return { success: false, error: error.message };
    }
  }

  // 应用Kubernetes资源
  async applyKubernetesResource(yamlContent) {
    return new Promise((resolve, reject) => {
      const tempFile = `/tmp/k8s-resource-${Date.now()}.yaml`;
      fs.writeFileSync(tempFile, yamlContent);
      
      exec(`kubectl apply -f ${tempFile}`, (error, stdout, stderr) => {
        fs.removeSync(tempFile);
        if (error) {
          reject(new Error(`kubectl apply failed: ${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  // 删除Kubernetes资源
  async deleteKubernetesResource(type, name) {
    return new Promise((resolve, reject) => {
      exec(`kubectl delete ${type} ${name} --ignore-not-found=true`, (error, stdout, stderr) => {
        if (error) {
          console.warn(`Warning deleting ${type} ${name}:`, stderr);
        }
        resolve(stdout);
      });
    });
  }

  // 生成增强的模型/数据集下载Job
  async generateEnhancedDownloadJob(config) {
    try {
      const { modelId, resources, s3Storage, hfToken, instanceType, repoType, storageType = 's3' } = config;

      // 生成短的模型标签，限制长度
      let modelTag = modelId.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      if (modelTag.length > 20) {
        modelTag = modelTag.substring(0, 20);
      }

      // 生成短的时间戳
      const timestamp = Date.now().toString().slice(-8);
      const jobPrefix = repoType === 'dataset' ? 'dataset-dl' : 'model-dl';
      const jobName = `${jobPrefix}-${modelTag}-${timestamp}`;
      const finalJobName = jobName.length > 63 ? jobName.substring(0, 63) : jobName;

      // 组装可选 block 的 patches
      const containerPath = ['spec', 'template', 'spec', 'containers', 0];
      const extraPatches = [];

      // 资源请求 / 限制（-1 表示不设置 → 模板里本就没有，跳过）
      if (resources.cpu !== -1 || resources.memory !== -1) {
        extraPatches.push(P.set([...containerPath, 'resources'], {
          requests: {
            cpu: resources.cpu.toString(),
            memory: `${resources.memory}Gi`,
          },
          limits: {
            cpu: resources.cpu.toString(),
            memory: `${resources.memory}Gi`,
          },
        }));
      }

      // HF Token 注入到 env 列表最前面
      if (hfToken) {
        extraPatches.push(P.prepend([...containerPath, 'env'], { name: 'HF_TOKEN', value: hfToken }));
      }

      // nodeSelector
      if (instanceType) {
        extraPatches.push(P.set(['spec', 'template', 'spec', 'nodeSelector'], {
          'node.kubernetes.io/instance-type': instanceType,
        }));
      }

      // 渲染模板
      const templateFile = storageType === 'fsx'
        ? 'hf-download-fsx-template.yaml'
        : 'hf-download-s3-template.yaml';
      const templatePath = path.join(__dirname, '../templates', templateFile);

      const yamlContent = renderTemplate(templatePath, {
        values: {
          JOB_NAME: finalJobName,
          MODEL_ID: modelId,
          REPO_TYPE_ARG: repoType === 'dataset' ? '--repo-type dataset ' : '',
          PVC_NAME: s3Storage,
        },
        patches: extraPatches,
      });

      return { success: true, yamlContent, jobName: finalJobName };
    } catch (error) {
      console.error('Error generating enhanced download job:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 生成模型标签（用于 Kubernetes 资源命名）
   * 将模型 ID 转换为符合 Kubernetes 命名规范的标签
   * @param {string} modelId - 模型 ID（如 "meta-llama/Llama-3.1-8B"）
   * @returns {string} 符合 K8s 命名规范的标签
   */
  static generateModelTag(modelId) {
    if (!modelId) return 'model';
    return modelId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'model';
  }

  /**
   * 应用增强的模型下载 Job
   * 生成 YAML、保存文件、执行 kubectl apply
   * @param {Object} config - 下载配置
   * @param {string} config.modelId - 模型 ID
   * @param {string} config.hfToken - HuggingFace Token
   * @param {Object} config.resources - 资源配置 { cpu, memory }
   * @param {string} config.s3Storage - S3 存储名称
   * @param {string} config.instanceType - 实例类型（可选）
   * @returns {Promise<Object>} { success, jobName, deploymentFile, error }
   */
  async applyEnhancedDownloadJob(config) {
    const { modelId, hfToken, resources, s3Storage, instanceType, repoType, storageType: clientStorageType } = config;

    try {
      const resourceLabel = repoType === 'dataset' ? 'dataset' : 'model';
      console.log(`🚀 Starting enhanced ${resourceLabel} download: ${modelId}`);
      console.log(`📊 Resources: CPU=${resources?.cpu}, Memory=${resources?.memory}GB`);
      console.log(`💾 Storage: ${s3Storage}`);
      console.log(`📦 Repo Type: ${repoType || 'model'}`);
      if (instanceType) console.log(`🖥️ Instance Type: ${instanceType}`);

      // 判断存储类型（优先使用前端传入的类型）
      const storageType = clientStorageType || (s3Storage.startsWith('fsx-') ? 'fsx' : 's3');
      console.log(`📁 Storage Type: ${storageType}`);

      // 生成增强的下载Job
      const jobResult = await this.generateEnhancedDownloadJob({
        modelId,
        hfToken,
        resources,
        s3Storage,
        instanceType,
        repoType,
        storageType
      });

      if (!jobResult.success) {
        return { success: false, error: jobResult.error };
      }

      // 确保deployments/storage目录存在
      const deploymentsDir = path.join(__dirname, '..', 'deployments', 'storage');
      if (!fs.existsSync(deploymentsDir)) {
        fs.mkdirSync(deploymentsDir, { recursive: true });
      }

      // 保存生成的YAML文件到deployments/storage目录
      const modelTag = modelId.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').slice(0, 14);
      const deploymentFile = path.join(deploymentsDir, `hf-download-${modelTag}-${timestamp}.yaml`);
      await fs.writeFile(deploymentFile, jobResult.yamlContent);

      console.log(`📁 Saved deployment template: ${deploymentFile}`);

      // 应用Job到Kubernetes
      const tempFile = `/tmp/enhanced-download-job-${Date.now()}.yaml`;
      fs.writeFileSync(tempFile, jobResult.yamlContent);

      try {
        const { stdout, stderr } = await execAsync(`kubectl apply -f ${tempFile}`);
        fs.removeSync(tempFile);

        console.log(`✅ Download job created successfully`);
        return {
          success: true,
          message: `Download job created successfully`,
          jobName: jobResult.jobName,
          deploymentFile: path.basename(deploymentFile)
        };
      } catch (kubectlError) {
        fs.removeSync(tempFile);
        console.error('❌ Failed to create download job:', kubectlError.stderr || kubectlError.message);
        return {
          success: false,
          error: kubectlError.stderr || kubectlError.message
        };
      }

    } catch (error) {
      console.error('❌ Error in download:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = S3StorageManager;
