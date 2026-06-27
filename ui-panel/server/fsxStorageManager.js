const fs = require('fs-extra');
const path = require('path');
const yaml = require('yaml');
const AWSHelpers = require('./utils/awsHelpers');
const { execAsync } = require('./utils/exec');

class FSxStorageManager {
  constructor() {
    this.managedClustersPath = path.join(__dirname, '../managed_clusters_info');
  }

  // ==================== FSx 信息获取 ====================

  /**
   * 通过 fileSystemId 获取 FSx 详细信息
   * @param {string} fileSystemId - FSx 文件系统 ID
   * @param {string} region - AWS 区域
   * @returns {Object} { success, fsxInfo: { dnsName, mountName, ... } }
   */
  async getFSxInfo(fileSystemId, region) {
    try {
      const command = `aws fsx describe-file-systems --file-system-ids ${fileSystemId} --region ${region} --output json`;
      const { stdout } = await execAsync(command);
      const result = JSON.parse(stdout);

      if (!result.FileSystems || result.FileSystems.length === 0) {
        return { success: false, error: 'File system not found' };
      }

      const fs = result.FileSystems[0];
      const lustreConfig = fs.LustreConfiguration || {};

      // 使用 AWSHelpers 获取 Security Groups 和 Subnet AZs
      const securityGroupIds = fs.NetworkInterfaceIds 
        ? await AWSHelpers.getSecurityGroupsFromENIs(fs.NetworkInterfaceIds, region) 
        : [];
      
      const subnetAZs = await AWSHelpers.getSubnetAZs(fs.SubnetIds || [], region);

      return {
        success: true,
        fsxInfo: {
          fileSystemId: fs.FileSystemId,
          dnsName: fs.DNSName,
          mountName: lustreConfig.MountName || 'fsx',
          storageCapacity: fs.StorageCapacity,
          lifecycle: fs.Lifecycle,
          vpcId: fs.VpcId,
          subnetIds: fs.SubnetIds || [],
          subnetAZs: subnetAZs,
          securityGroupIds: securityGroupIds,
          dataRepositoryConfiguration: lustreConfig.DataRepositoryConfiguration || null
        }
      };
    } catch (error) {
      console.error('Error getting FSx info:', error);
      return { success: false, error: error.message };
    }
  }

  // ==================== 检测现有 FSx 存储 ====================

  /**
   * 检测集群中现有的 FSx PVC
   */
  async detectExistingFSxStorages() {
    try {
      const { stdout } = await execAsync('kubectl get pvc -o json');
      const pvcList = JSON.parse(stdout);

      if (!pvcList.items || pvcList.items.length === 0) {
        return [];
      }

      const fsxStorages = [];

      for (let pvc of pvcList.items) {
        if (pvc.spec.volumeName) {
          try {
            const { stdout: pvStdout } = await execAsync(`kubectl get pv ${pvc.spec.volumeName} -o json`);
            const pv = JSON.parse(pvStdout);

            if (pv.spec.csi && pv.spec.csi.driver === 'fsx.csi.aws.com') {
              const volumeAttributes = pv.spec.csi.volumeAttributes || {};

              fsxStorages.push({
                type: 'fsx-lustre',
                name: pvc.metadata.name,
                fileSystemId: pv.spec.csi.volumeHandle || 'Unknown',
                dnsName: volumeAttributes.dnsname || 'Unknown',
                mountName: volumeAttributes.mountname || 'fsx',
                pvcName: pvc.metadata.name,
                pvName: pv.metadata.name,
                createdAt: pvc.metadata.creationTimestamp,
                source: 'detected'
              });
            }
          } catch (error) {
            // PV 不存在或无法访问，跳过
          }
        }
      }

      console.log(`Detected ${fsxStorages.length} FSx storages`);
      return fsxStorages;
    } catch (error) {
      console.error('Error detecting FSx storages:', error);
      return [];
    }
  }

  // ==================== 获取所有 FSx 存储 ====================

  /**
   * 获取所有 FSx 存储配置（检测到的 + 配置文件中的）
   */
  async getStorages() {
    try {
      const configPath = this.getActiveClusterStorageConfigPath();
      
      // 检测现有的 FSx PVC
      const existingStorages = await this.detectExistingFSxStorages();

      // 如果没有配置文件，只返回检测到的
      if (!configPath || !fs.existsSync(configPath)) {
        for (let storage of existingStorages) {
          storage.status = await this.checkStorageStatus(storage.pvcName);
        }
        return { success: true, storages: existingStorages };
      }

      // 合并配置文件中的存储
      const config = fs.readJsonSync(configPath);
      const fsxStorages = (config.fsxStorages || []).map(s => ({ ...s, type: 'fsx-lustre' }));

      const allStorages = [...fsxStorages];

      // 添加检测到但不在配置中的存储
      for (let existing of existingStorages) {
        const found = allStorages.find(s => s.pvcName === existing.pvcName);
        if (!found) {
          allStorages.push(existing);
        }
      }

      // 检查状态
      for (let storage of allStorages) {
        storage.status = await this.checkStorageStatus(storage.pvcName);
      }

      return { success: true, storages: allStorages };
    } catch (error) {
      console.error('Error getting FSx storages:', error);
      return { success: false, error: error.message };
    }
  }

  // ==================== 创建 FSx 存储 ====================

  /**
   * 创建 FSx PV/PVC
   * @param {Object} config - { name, fileSystemId, region }
   */
  async createStorage(config) {
    try {
      const { name, fileSystemId, region } = config;

      // 获取 FSx 详细信息
      const fsxInfoResult = await this.getFSxInfo(fileSystemId, region);
      if (!fsxInfoResult.success) {
        return { success: false, error: `Failed to get FSx info: ${fsxInfoResult.error}` };
      }

      const fsxInfo = fsxInfoResult.fsxInfo;
      const pvcName = name;
      const pvName = `pv-${name}`;

      // 检查是否已存在
      try {
        await execAsync(`kubectl get pvc ${pvcName} --no-headers 2>/dev/null`);
        return { success: false, error: `Storage "${name}" already exists` };
      } catch (error) {
        // PVC 不存在，继续创建
      }

      // 生成 PV YAML
      const pvYaml = {
        apiVersion: 'v1',
        kind: 'PersistentVolume',
        metadata: {
          name: pvName
        },
        spec: {
          capacity: {
            storage: `${fsxInfo.storageCapacity}Gi`
          },
          volumeMode: 'Filesystem',
          accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: '',
          csi: {
            driver: 'fsx.csi.aws.com',
            volumeHandle: fsxInfo.fileSystemId,
            volumeAttributes: {
              dnsname: fsxInfo.dnsName,
              mountname: fsxInfo.mountName
            }
          }
        }
      };

      // 生成 PVC YAML
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
              storage: `${fsxInfo.storageCapacity}Gi`
            }
          },
          volumeName: pvName
        }
      };

      // 应用资源
      await this.applyKubernetesResource(yaml.stringify(pvYaml));
      await this.applyKubernetesResource(yaml.stringify(pvcYaml));

      // 保存到 metadata
      const configPath = this.getActiveClusterStorageConfigPath();
      if (configPath) {
        this.ensureClusterConfigFile(configPath);
        const clusterConfig = fs.readJsonSync(configPath);
        clusterConfig.fsxStorages = clusterConfig.fsxStorages || [];
        clusterConfig.fsxStorages.push({
          type: 'fsx-lustre',
          name,
          fileSystemId: fsxInfo.fileSystemId,
          dnsName: fsxInfo.dnsName,
          mountName: fsxInfo.mountName,
          subnetIds: fsxInfo.subnetIds,
          subnetAZs: fsxInfo.subnetAZs,
          securityGroupIds: fsxInfo.securityGroupIds,
          region,
          pvcName,
          pvName,
          createdAt: new Date().toISOString()
        });
        fs.writeJsonSync(configPath, clusterConfig, { spaces: 2 });
      }

      return { success: true, pvcName, pvName, fsxInfo };
    } catch (error) {
      console.error('Error creating FSx storage:', error);
      return { success: false, error: error.message };
    }
  }

  // ==================== 删除 FSx 存储 ====================

  /**
   * 删除 FSx PV/PVC
   */
  async deleteStorage(name) {
    try {
      const configPath = this.getActiveClusterStorageConfigPath();
      let storage = null;

      // 从配置文件查找
      if (configPath && fs.existsSync(configPath)) {
        const config = fs.readJsonSync(configPath);
        storage = (config.fsxStorages || []).find(s => s.name === name);
      }

      // 如果配置文件中没有，从检测到的存储中查找
      if (!storage) {
        const existingStorages = await this.detectExistingFSxStorages();
        storage = existingStorages.find(s => s.name === name);
      }

      if (!storage) {
        return { success: false, error: 'Storage not found' };
      }

      // 删除 Kubernetes 资源
      await this.deleteKubernetesResource('pvc', storage.pvcName);
      await this.deleteKubernetesResource('pv', storage.pvName);

      // 从配置文件中移除
      if (configPath && fs.existsSync(configPath)) {
        const config = fs.readJsonSync(configPath);
        config.fsxStorages = (config.fsxStorages || []).filter(s => s.name !== name);
        fs.writeJsonSync(configPath, config, { spaces: 2 });
      }

      return { success: true };
    } catch (error) {
      console.error('Error deleting FSx storage:', error);
      return { success: false, error: error.message };
    }
  }

  // ==================== 工具方法 ====================

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

      return path.join(this.managedClustersPath, activeCluster, 'config', 'fsx-storages.json');
    } catch (error) {
      console.error('Error getting active cluster storage config path:', error);
      return null;
    }
  }

  ensureClusterConfigFile(configPath) {
    if (!configPath) return false;

    if (!fs.existsSync(configPath)) {
      fs.ensureDirSync(path.dirname(configPath));
      fs.writeJsonSync(configPath, { fsxStorages: [] }, { spaces: 2 });
    }
    return true;
  }

  async checkStorageStatus(pvcName) {
    try {
      const { stdout } = await execAsync(`kubectl get pvc ${pvcName} -o jsonpath='{.status.phase}'`);
      return stdout.trim() === 'Bound' ? 'Ready' : 'Pending';
    } catch (error) {
      return 'Not Found';
    }
  }

  async applyKubernetesResource(yamlContent) {
    const tempFile = `/tmp/k8s-fsx-resource-${Date.now()}.yaml`;
    fs.writeFileSync(tempFile, yamlContent);

    try {
      await execAsync(`kubectl apply -f ${tempFile}`);
      fs.removeSync(tempFile);
    } catch (error) {
      fs.removeSync(tempFile);
      throw error;
    }
  }

  async deleteKubernetesResource(type, name) {
    try {
      await execAsync(`kubectl delete ${type} ${name} --ignore-not-found=true`);
    } catch (error) {
      console.warn(`Failed to delete ${type} ${name}:`, error.message);
    }
  }
}

module.exports = FSxStorageManager;
