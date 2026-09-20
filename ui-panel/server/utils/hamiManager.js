const { execSync } = require('./exec');
const path = require('path');
const fs = require('fs');

class HAMiManager {
  /**
   * 写入日志到文件
   */
  static writeLog(message) {
    const logDir = path.join(__dirname, '../../tmp');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, 'hami-install.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
    console.log(message);
  }

  /**
   * 获取 Kubernetes 版本
   */
  static getKubeVersion() {
    try {
      const cmd = `kubectl version -o json | jq -r '.serverVersion.gitVersion' | cut -d'-' -f1`;
      return execSync(cmd, { encoding: 'utf8' }).trim();
    } catch (error) {
      this.writeLog(`Failed to get kube version: ${error.message}`);
      throw error;
    }
  }

  /**
   * 重启 S3 CSI controller（确保与 HAMi 兼容）
   */
  static restartS3CsiController() {
    try {
      this.writeLog('Restarting S3 CSI controller for HAMi compatibility...');
      const cmd = `kubectl delete pod -n kube-system -l app=s3-csi-controller`;
      execSync(cmd, { encoding: 'utf8' });
      this.writeLog('S3 CSI controller restarted successfully');
      return { success: true };
    } catch (error) {
      this.writeLog(`Warning: Failed to restart S3 CSI controller: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 全局安装/更新 HAMi（不包含节点标签）
   */
  static async installHAMi(config) {
    const { splitCount, nodePolicy, gpuPolicy } = config;
    
    this.writeLog('='.repeat(80));
    this.writeLog('Starting HAMi installation/configuration');
    this.writeLog(`Config: ${JSON.stringify(config, null, 2)}`);
    
    const kubeVersion = this.getKubeVersion();
    this.writeLog(`Kubernetes version: ${kubeVersion}`);

    // 步骤1: 添加 Helm repo（幂等）
    this.writeLog('Step 1: Adding Helm repository...');
    try {
      execSync('helm repo add hami-charts https://project-hami.github.io/HAMi/', { encoding: 'utf8' });
      execSync('helm repo update', { encoding: 'utf8' });
      this.writeLog('Helm repo added/updated successfully');
    } catch (error) {
      this.writeLog(`Helm repo operation: ${error.message}`);
    }

    // 步骤2: 安装/升级 HAMi
    this.writeLog('Step 2: Installing/Upgrading HAMi via Helm...');
    const helmCmd = `helm upgrade --install hami hami-charts/hami --set scheduler.kubeScheduler.imageTag=${kubeVersion} --set devicePlugin.deviceSplitCount=${splitCount} --set scheduler.defaultSchedulerPolicy.nodeSchedulerPolicy=${nodePolicy} --set scheduler.defaultSchedulerPolicy.gpuSchedulerPolicy=${gpuPolicy} --set scheduler.kubeScheduler.image.registry=registry.k8s.io --set scheduler.kubeScheduler.image.repository=kube-scheduler --set devicePlugin.image.registry=docker.io --set devicePlugin.image.repository=projecthami/hami -n kube-system --create-namespace --wait`;

    this.writeLog('Executing HAMi installation...');
    const result = execSync(helmCmd, { encoding: 'utf8', timeout: 300000 });
    this.writeLog(`Helm output: ${result}`);
    this.writeLog('HAMi installation completed successfully');
    
    // 步骤3: 重启 S3 CSI controller
    this.writeLog('Step 3: Restarting S3 CSI controller...');
    this.restartS3CsiController();
    
    this.writeLog('='.repeat(80));

    return {
      success: true,
      message: 'HAMi installed/configured successfully',
      output: result
    };
  }

  /**
   * 卸载 HAMi
   */
  static async uninstallHAMi() {
    this.writeLog('='.repeat(80));
    this.writeLog('Starting HAMi uninstallation');
    
    try {
      const cmd = `helm uninstall hami -n kube-system`;
      this.writeLog(`Executing: ${cmd}`);
      const result = execSync(cmd, { encoding: 'utf8', timeout: 120000 });
      this.writeLog(`Helm output: ${result}`);
      this.writeLog('HAMi uninstalled successfully');
      this.writeLog('='.repeat(80));

      return {
        success: true,
        message: 'HAMi uninstalled successfully',
        output: result
      };
    } catch (error) {
      this.writeLog(`ERROR: Failed to uninstall HAMi: ${error.message}`);
      this.writeLog('='.repeat(80));
      throw new Error(`Failed to uninstall HAMi: ${error.message}`);
    }
  }

  /**
   * 启用节点（打标签）
   */
  static async enableNode(nodeName) {
    this.writeLog('='.repeat(80));
    this.writeLog(`Enabling HAMi for node: ${nodeName}`);
    
    try {
      const labelCmd = `kubectl label nodes ${nodeName} gpu=on --overwrite`;
      this.writeLog(`Executing: ${labelCmd}`);
      const result = execSync(labelCmd, { encoding: 'utf8' });
      this.writeLog(`Label command output: ${result}`);
      this.writeLog(`Successfully enabled node: ${nodeName}`);
      this.writeLog('='.repeat(80));

      return {
        success: true,
        message: `Node ${nodeName} enabled for HAMi`,
        output: result
      };
    } catch (error) {
      this.writeLog(`ERROR: Failed to enable node ${nodeName}: ${error.message}`);
      this.writeLog('='.repeat(80));
      throw new Error(`Failed to enable node: ${error.message}`);
    }
  }

  /**
   * 禁用节点（删除标签 + 清理 pods）
   */
  static async disableNode(nodeName) {
    this.writeLog('='.repeat(80));
    this.writeLog(`Disabling HAMi for node: ${nodeName}`);
    
    try {
      // 步骤1: 删除 gpu=on 标签
      this.writeLog('Step 1: Removing gpu=on label...');
      try {
        const result = execSync(`kubectl label nodes ${nodeName} gpu- 2>&1`, { encoding: 'utf8' });
        this.writeLog(`Label removal output: ${result}`);
        this.writeLog('Label removed successfully');
      } catch (error) {
        this.writeLog('Label not found or already removed');
      }

      // 步骤2: 删除该节点上的 device plugin pods
      this.writeLog('Step 2: Deleting device plugin pods...');
      
      const getPodsCmd = `kubectl get pods -n kube-system -o json --field-selector spec.nodeName=${nodeName}`;
      const podsResult = execSync(getPodsCmd, { encoding: 'utf8' });
      const pods = JSON.parse(podsResult);
      
      const podsToDelete = [];
      for (const pod of pods.items) {
        const podName = pod.metadata.name;
        // 删除 nvidia device plugin 和 hami device plugin
        if (podName.includes('nvidia-device-plugin') || podName.includes('hami-device-plugin')) {
          podsToDelete.push(podName);
        }
      }

      if (podsToDelete.length > 0) {
        this.writeLog(`Found ${podsToDelete.length} device plugin pods to delete`);
        for (const podName of podsToDelete) {
          try {
            execSync(`kubectl delete pod ${podName} -n kube-system`, { encoding: 'utf8' });
            this.writeLog(`Deleted pod: ${podName}`);
          } catch (error) {
            this.writeLog(`Failed to delete pod ${podName}: ${error.message}`);
          }
        }
      } else {
        this.writeLog('No device plugin pods found on this node');
      }

      this.writeLog(`Node ${nodeName} disabled successfully`);
      
      // 重启 S3 CSI controller
      this.writeLog('Restarting S3 CSI controller after disable...');
      this.restartS3CsiController();
      
      this.writeLog('='.repeat(80));

      return {
        success: true,
        message: `Node ${nodeName} disabled for HAMi`,
        deletedPods: podsToDelete
      };
    } catch (error) {
      this.writeLog(`ERROR: Failed to disable node: ${error.message}`);
      this.writeLog('='.repeat(80));
      throw new Error(`Failed to disable node: ${error.message}`);
    }
  }

  /**
   * 检查 HAMi 状态（包含配置信息）
   */
  static async checkStatus(clusterTag, clusterManager) {
    try {
      // 检查 Helm 安装状态
      const cmd = `helm list -n kube-system -o json`;
      const result = execSync(cmd, { encoding: 'utf8' });
      const releases = JSON.parse(result);
      const hamiRelease = releases.find(r => r.name === 'hami');
      
      if (!hamiRelease) {
        return { installed: false };
      }

      // 实时获取配置信息
      const config = this.getRealTimeConfig();

      return {
        installed: true,
        version: hamiRelease.chart,
        status: hamiRelease.status,
        config: config
      };
    } catch (error) {
      return { installed: false, error: error.message };
    }
  }

  /**
   * 实时获取 HAMi 配置信息
   */
  static getRealTimeConfig() {
    const config = {
      splitCount: null,
      nodePolicy: null,
      gpuPolicy: null
    };

    try {
      // 从 Helm values 获取配置
      const helmValuesCmd = `helm get values hami -n kube-system -o json`;
      try {
        const valuesResult = execSync(helmValuesCmd, { encoding: 'utf8' });
        const values = JSON.parse(valuesResult);
        
        // 获取 splitCount
        config.splitCount = values.devicePlugin?.deviceSplitCount || 10;
        
        // 获取调度策略
        config.nodePolicy = values.scheduler?.defaultSchedulerPolicy?.nodeSchedulerPolicy || 'binpack';
        config.gpuPolicy = values.scheduler?.defaultSchedulerPolicy?.gpuSchedulerPolicy || 'spread';
        
        this.writeLog(`Real-time HAMi config: ${JSON.stringify(config)}`);
      } catch (error) {
        console.log('Failed to get Helm values, trying ConfigMap fallback');
        
        // 备用方案：从 ConfigMap 获取 splitCount
        const splitCountCmd = `kubectl get configmap hami-scheduler-device -n kube-system -o jsonpath='{.data.device-config\\.yaml}' | grep -oP 'deviceSplitCount:\\s*\\K\\d+'`;
        try {
          const splitCount = execSync(splitCountCmd, { encoding: 'utf8' }).trim();
          config.splitCount = parseInt(splitCount) || 10;
        } catch (e) {
          config.splitCount = 10;
        }
        
        // 策略使用默认值
        config.nodePolicy = 'binpack';
        config.gpuPolicy = 'spread';
      }

      return config;
    } catch (error) {
      console.error('Error getting real-time HAMi config:', error.message);
      return {
        splitCount: 10,
        nodePolicy: 'binpack',
        gpuPolicy: 'spread'
      };
    }
  }

  /**
   * 保存配置到 metadata
   */
  static saveConfig(clusterTag, config, clusterManager) {
    try {
      const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
      const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

      if (fs.existsSync(clusterInfoPath)) {
        const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
        
        clusterInfo.hami = {
          installed: true,
          config: config,
          lastUpdated: new Date().toISOString()
        };

        fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
        console.log(`HAMi config saved to metadata for cluster: ${clusterTag}`);
      }
    } catch (error) {
      console.error('Failed to save HAMi config to metadata:', error);
    }
  }

  /**
   * 清除配置（卸载时）
   */
  static clearConfig(clusterTag, clusterManager) {
    try {
      const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
      const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

      if (fs.existsSync(clusterInfoPath)) {
        const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
        
        if (clusterInfo.hami) {
          delete clusterInfo.hami;
          fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
          console.log(`HAMi config cleared from metadata for cluster: ${clusterTag}`);
        }
      }
    } catch (error) {
      console.error('Failed to clear HAMi config from metadata:', error);
    }
  }
}

module.exports = HAMiManager;
