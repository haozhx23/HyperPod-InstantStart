const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const ClusterManager = require('./cluster-manager');
const MultiClusterLogManager = require('./multi-cluster-log-manager');

// 多集群管理API
class MultiClusterAPIs {
  constructor() {
    this.clusterManager = new ClusterManager();
  }

  // 获取所有集群列表
  async handleGetClusters(req, res) {
    try {
      const clusters = this.clusterManager.getAllClusters();
      const activeCluster = this.clusterManager.getActiveCluster();
      
      res.json({
        success: true,
        clusters,
        activeCluster
      });
    } catch (error) {
      console.error('Error getting clusters:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 切换活跃集群
  async handleSwitchCluster(req, res) {
    try {
      const { clusterTag } = req.body;
      
      if (!clusterTag) {
        return res.status(400).json({
          success: false,
          error: 'clusterTag is required'
        });
      }

      // 验证集群是否存在
      if (!this.clusterManager.clusterExists(clusterTag)) {
        return res.status(404).json({
          success: false,
          error: 'Cluster not found'
        });
      }

      console.log(`Switching to cluster: ${clusterTag}`);

      // 设置为活跃集群
      this.clusterManager.setActiveCluster(clusterTag);
      
      // 恢复该集群的配置到 CLI 目录
      this.clusterManager.restoreClusterConfig(clusterTag);
      
      try {
        // 同步执行kubectl配置切换，确保完成后再返回
        await this.switchKubectlConfig(clusterTag);
        console.log(`Successfully switched kubectl config to cluster: ${clusterTag}`);
        
        res.json({
          success: true,
          activeCluster: clusterTag,
          message: `Successfully switched to cluster: ${clusterTag}`
        });
      } catch (kubectlError) {
        console.error(`Failed to switch kubectl config for ${clusterTag}:`, kubectlError.message);
        
        // 即使kubectl切换失败，也返回成功，但包含警告信息
        res.json({
          success: true,
          activeCluster: clusterTag,
          message: `Switched to cluster: ${clusterTag}. Warning: kubectl config switch failed - ${kubectlError.message}`,
          kubectlWarning: kubectlError.message
        });
      }
      
    } catch (error) {
      console.error('Error switching cluster:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 切换kubectl配置到指定集群
  async switchKubectlConfig(clusterTag) {
    try {
      // 读取集群配置获取AWS_REGION和EKS集群名称
      const configDir = this.clusterManager.getClusterConfigDir(clusterTag);
      const initEnvsPath = path.join(configDir, 'init_envs');
      
      if (!fs.existsSync(initEnvsPath)) {
        console.warn(`No init_envs found for cluster ${clusterTag}, skipping kubectl config switch`);
        return;
      }

      const envContent = fs.readFileSync(initEnvsPath, 'utf8');
      
      // 提取AWS_REGION和EKS集群名称
      const awsRegionMatch = envContent.match(/export AWS_REGION=(.+)/);
      const eksClusterMatch = envContent.match(/export EKS_CLUSTER_NAME=(.+)/);
      
      if (!awsRegionMatch || !eksClusterMatch) {
        console.warn(`Missing AWS_REGION or EKS_CLUSTER_NAME in ${clusterTag} config`);
        return;
      }

      const awsRegion = awsRegionMatch[1].replace(/['"]/g, '').trim();
      let eksClusterName = eksClusterMatch[1].replace(/['"]/g, '').trim();
      
      // 如果EKS集群名称包含变量，需要替换
      if (eksClusterName.includes('$CLUSTER_TAG')) {
        eksClusterName = eksClusterName.replace('$CLUSTER_TAG', clusterTag);
      }

      console.log(`Updating kubectl config for cluster: ${eksClusterName} in region: ${awsRegion}`);

      // 执行aws eks update-kubeconfig命令
      const command = `aws eks update-kubeconfig --region ${awsRegion} --name ${eksClusterName}`;
      
      return new Promise((resolve, reject) => {
        exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
          if (error) {
            console.error(`Failed to update kubectl config: ${error.message}`);
            console.error(`Command: ${command}`);
            console.error(`Stderr: ${stderr}`);
            reject(error);
          } else {
            console.log(`Successfully updated kubectl config for cluster: ${eksClusterName}`);
            console.log(`Stdout: ${stdout}`);
            resolve(stdout);
          }
        });
      });

    } catch (error) {
      console.error(`Error in switchKubectlConfig: ${error.message}`);
      throw error;
    }
  }

  // 保存集群配置（支持多集群）
  async handleSaveConfig(req, res) {
    try {
      const config = req.body;
      console.log('Saving cluster configuration:', config);

      // 读取现有的 init_envs 文件内容
      const cliInitEnvs = path.join(this.clusterManager.cliDir, 'init_envs');
      let existingContent = '';
      
      if (fs.existsSync(cliInitEnvs)) {
        existingContent = fs.readFileSync(cliInitEnvs, 'utf8');
      }

      // 更新指定的环境变量，保留其他内容
      const envContent = this.updateEnvVariables(existingContent, config);

      // 提取集群标识
      const clusterTag = config.clusterTag;
      
      // 创建集群目录结构
      this.clusterManager.createClusterDirs(clusterTag);
      
      // 保存集群专用的 init_envs
      const clusterConfigDir = this.clusterManager.getClusterConfigDir(clusterTag);
      const clusterInitEnvs = path.join(clusterConfigDir, 'init_envs');
      await fs.writeFile(clusterInitEnvs, envContent);
      
      // 更新 CLI 目录的 init_envs (用于执行脚本) - 重用已声明的变量
      
      // 备份原文件
      if (fs.existsSync(cliInitEnvs)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${cliInitEnvs}.backup.${timestamp}`;
        await fs.copy(cliInitEnvs, backupPath);
        console.log(`Backed up original init_envs to: ${backupPath}`);
      }
      
      await fs.writeFile(cliInitEnvs, envContent);
      
      // 保存集群基本信息
      this.clusterManager.saveClusterInfo(clusterTag, config);
      
      // 设置为活跃集群
      this.clusterManager.setActiveCluster(clusterTag);
      
      // 清除该集群的状态缓存
      this.clusterManager.clearClusterCache(clusterTag);
      
      console.log(`Configuration saved for cluster: ${clusterTag}`);

      res.json({
        success: true,
        message: 'Configuration saved successfully',
        clusterTag,
        backupCreated: true
      });

    } catch (error) {
      console.error('Error saving cluster configuration:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 更新环境变量，保留用户自定义内容
  updateEnvVariables(existingContent, config) {
    // 只更新前端可配置的变量
    const updates = {
      'CLUSTER_TAG': config.clusterTag,
      'AWS_REGION': config.awsRegion,
      'GPU_CAPACITY_AZ': config.gpuCapacityAz,
      'GPU_INSTANCE_TYPE': config.gpuInstanceType,
      'GPU_INSTANCE_COUNT': config.gpuInstanceCount
    };

    // 处理FTP_NAME的特殊逻辑
    if (config.enableFtp && config.ftpName) {
      updates['FTP_NAME'] = config.ftpName;
    }

    let content = existingContent;

    // 更新每个可配置的变量
    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^(#\\s*)?export\\s+${key}=.*$`, 'm');
      const newLine = `export ${key}=${value}`;
      
      if (regex.test(content)) {
        content = content.replace(regex, newLine);
      } else {
        // 如果变量不存在，添加到文件开头
        content = `${newLine}\n${content}`;
      }
    }

    // 处理FTP_NAME禁用时的注释
    if (!config.enableFtp || !config.ftpName) {
      const ftpRegex = /^export\s+FTP_NAME=.*$/m;
      if (ftpRegex.test(content)) {
        content = content.replace(ftpRegex, '# export FTP_NAME=your-ftp-name');
      }
    }

    return content;
  }

  // 从 CLI 目录自动初始化多集群结构
  async autoInitializeFromCLI() {
    try {
      // 1. 检查 CLI 目录的 init_envs 文件
      const cliInitEnvs = path.join(this.clusterManager.cliDir, 'init_envs');
      
      if (!fs.existsSync(cliInitEnvs)) {
        return {
          success: false,
          error: 'No init_envs found in CLI directory. Please save configuration first.'
        };
      }

      // 2. 提取集群标识
      const envContent = await fs.readFile(cliInitEnvs, 'utf8');
      const clusterTagMatch = envContent.match(/export CLUSTER_TAG=(.+)/);
      
      if (!clusterTagMatch) {
        return {
          success: false,
          error: 'CLUSTER_TAG not found in init_envs. Please check configuration.'
        };
      }

      const clusterTag = clusterTagMatch[1].replace(/['"]/g, '').trim();
      console.log(`Auto-initializing multi-cluster structure for: ${clusterTag}`);

      // 3. 检查是否已经初始化
      const clusterExists = this.clusterManager.clusterExists(clusterTag);
      let initialized = false;

      if (!clusterExists) {
        // 4. 创建集群目录结构
        this.clusterManager.createClusterDirs(clusterTag);
        
        // 5. 复制配置文件到集群目录
        const clusterConfigDir = this.clusterManager.getClusterConfigDir(clusterTag);
        await fs.copy(cliInitEnvs, path.join(clusterConfigDir, 'init_envs'));
        
        // 6. 复制其他已存在的配置文件
        const filesToCopy = ['stack_envs', 'mlflow-server-info.json'];
        for (const file of filesToCopy) {
          const sourcePath = path.join(this.clusterManager.cliDir, file);
          const targetPath = path.join(clusterConfigDir, file);
          
          if (fs.existsSync(sourcePath)) {
            await fs.copy(sourcePath, targetPath);
            console.log(`Copied existing ${file} to cluster directory`);
          }
        }
        
        // 7. 生成集群信息 metadata
        const config = await this.extractConfigFromInitEnvs(envContent);
        this.clusterManager.saveClusterInfo(clusterTag, config);
        
        initialized = true;
        console.log(`Initialized multi-cluster structure for: ${clusterTag}`);
      }

      // 8. 设置为活跃集群
      this.clusterManager.setActiveCluster(clusterTag);

      return {
        success: true,
        clusterTag,
        initialized
      };

    } catch (error) {
      console.error('Error in autoInitializeFromCLI:', error);
      return {
        success: false,
        error: `Failed to initialize multi-cluster structure: ${error.message}`
      };
    }
  }

  // 从 init_envs 内容提取配置信息
  async extractConfigFromInitEnvs(envContent) {
    const extractValue = (key) => {
      const match = envContent.match(new RegExp(`export ${key}=(.+)`));
      return match ? match[1].replace(/['"]/g, '').trim() : '';
    };

    return {
      clusterTag: extractValue('CLUSTER_TAG'),
      awsRegion: extractValue('AWS_REGION'),
      ftpName: extractValue('FTP_NAME'),
      gpuCapacityAz: extractValue('GPU_CAPACITY_AZ'),
      gpuInstanceType: extractValue('GPU_INSTANCE_TYPE'),
      gpuInstanceCount: parseInt(extractValue('GPU_INSTANCE_COUNT')) || 1,
      enableFtp: !!extractValue('FTP_NAME') && extractValue('FTP_NAME') !== 'your-ftp-name'
    };
  }

  // 执行集群启动 (Step 1) - 支持多集群
  async handleLaunch(req, res) {
    try {
      // 1. 自动初始化多集群结构（从 ../cli/init_envs 提取信息）
      const initResult = await this.autoInitializeFromCLI();
      
      if (!initResult.success) {
        return res.status(400).json({
          success: false,
          error: initResult.error
        });
      }

      const activeCluster = initResult.clusterTag;
      console.log(`Launching cluster (Step 1) for: ${activeCluster}`);
      
      // 2. 检查 Step 1 是否已经完成（防重复创建）
      const MultiClusterStatus = require('./multi-cluster-status');
      const statusChecker = new MultiClusterStatus();
      const step1Status = await statusChecker.checkStep1Status(activeCluster);
      
      if (step1Status.status === 'completed') {
        return res.json({
          success: true,
          message: `Step 1 already completed for cluster: ${activeCluster}. CloudFormation stack exists.`,
          clusterTag: activeCluster,
          alreadyCompleted: true,
          statusDetails: step1Status
        });
      }
      
      // 3. 清除 Step 1 缓存
      this.clusterManager.clearClusterCache(activeCluster);
      
      // 4. 创建集群专用的日志管理器
      const logManager = new MultiClusterLogManager(activeCluster);
      const logFilePath = logManager.createLogFile('launch');
      
      // 5. 执行脚本
      const cliPath = this.clusterManager.cliDir;
      const command = `cd "${cliPath}" && nohup bash -c 'echo "y" | bash 1-cluster-launch.sh' > "${logFilePath}" 2>&1 &`;
      
      exec(command, (error) => {
        if (error) {
          console.error('Failed to start launch script:', error);
        } else {
          console.log('Launch script started successfully');
          
          // 5秒后开始监控并备份生成的文件
          setTimeout(() => {
            this.clusterManager.backupGeneratedFiles(activeCluster, 'step1');
          }, 5000);
        }
      });

      res.json({
        success: true,
        message: `Step 1 launched for cluster: ${activeCluster}`,
        clusterTag: activeCluster,
        initialized: initResult.initialized
      });

    } catch (error) {
      console.error('Error launching cluster:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 执行集群配置 (Step 2) - 支持多集群
  async handleConfigure(req, res) {
    try {
      const activeCluster = this.clusterManager.getActiveCluster();
      
      if (!activeCluster) {
        return res.status(400).json({
          success: false,
          error: 'No active cluster. Please save configuration first.'
        });
      }

      console.log(`Configuring cluster (Step 2) for: ${activeCluster}`);
      
      // 1. 检查 Step 1 是否已完成（Step 2 的前置条件）
      const MultiClusterStatus = require('./multi-cluster-status');
      const statusChecker = new MultiClusterStatus();
      const step1Status = await statusChecker.checkStep1Status(activeCluster);
      
      if (step1Status.status !== 'completed') {
        return res.status(400).json({
          success: false,
          error: `Step 1 must be completed before Step 2. Current Step 1 status: ${step1Status.status}`,
          step1Status: step1Status
        });
      }
      
      // 2. 检查 Step 2 是否已经完成（防重复配置）
      const step2Status = await statusChecker.checkStep2Status(activeCluster);
      
      if (step2Status.status === 'completed') {
        return res.json({
          success: true,
          message: `Step 2 already completed for cluster: ${activeCluster}. All Kubernetes components are ready.`,
          clusterTag: activeCluster,
          alreadyCompleted: true,
          statusDetails: step2Status
        });
      }
      
      // 3. 清除 Step 2 缓存
      this.clusterManager.clearClusterCache(activeCluster);
      
      // 4. 创建集群专用的日志管理器
      const logManager = new MultiClusterLogManager(activeCluster);
      const logFilePath = logManager.createLogFile('configure');
      
      // 5. 执行脚本
      const cliPath = this.clusterManager.cliDir;
      const command = `cd "${cliPath}" && nohup bash -c 'echo "y" | bash 2-cluster-configs.sh' > "${logFilePath}" 2>&1 &`;
      
      exec(command, (error) => {
        if (error) {
          console.error('Failed to start configure script:', error);
        } else {
          console.log('Configure script started successfully');
          
          // 30秒后开始监控并备份生成的文件（给MLflow查询足够时间）
          setTimeout(() => {
            this.clusterManager.backupGeneratedFiles(activeCluster, 'step2');
          }, 30000);
        }
      });

      res.json({
        success: true,
        message: `Step 2 launched for cluster: ${activeCluster}`,
        clusterTag: activeCluster
      });

    } catch (error) {
      console.error('Error configuring cluster:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 获取日志内容 - 支持多集群
  async handleGetLogs(req, res) {
    try {
      const { step } = req.params;
      const offset = parseInt(req.query.offset) || 0;
      const activeCluster = this.clusterManager.getActiveCluster();
      
      if (!activeCluster) {
        return res.json({
          success: true,
          data: { content: '', offset: 0, exists: false },
          message: 'No active cluster'
        });
      }

      const logManager = new MultiClusterLogManager(activeCluster);
      const result = logManager.readLogContent(step, offset);
      
      res.json({
        success: true,
        data: result,
        clusterTag: activeCluster
      });

    } catch (error) {
      console.error('Error getting logs:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 获取历史日志列表 - 支持多集群
  async handleGetLogsHistory(req, res) {
    try {
      const activeCluster = this.clusterManager.getActiveCluster();
      
      if (!activeCluster) {
        return res.json({
          success: true,
          data: [],
          message: 'No active cluster'
        });
      }

      const logManager = new MultiClusterLogManager(activeCluster);
      const logFiles = logManager.getLogHistory();
      
      res.json({
        success: true,
        data: logFiles,
        clusterTag: activeCluster
      });

    } catch (error) {
      console.error('Error getting log history:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 手动切换kubectl配置
  async handleSwitchKubectlConfig(req, res) {
    try {
      const activeCluster = this.clusterManager.getActiveCluster();
      
      if (!activeCluster) {
        return res.status(400).json({
          success: false,
          error: 'No active cluster'
        });
      }

      console.log(`Manually switching kubectl config for cluster: ${activeCluster}`);
      
      await this.switchKubectlConfig(activeCluster);
      
      res.json({
        success: true,
        message: `Kubectl config updated for cluster: ${activeCluster}`,
        clusterTag: activeCluster
      });

    } catch (error) {
      console.error('Error switching kubectl config:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 清除状态缓存 - 支持多集群
  async handleClearStatusCache(req, res) {
    try {
      const activeCluster = this.clusterManager.getActiveCluster();
      
      if (!activeCluster) {
        return res.json({
          success: true,
          message: 'No active cluster'
        });
      }

      this.clusterManager.clearClusterCache(activeCluster);
      
      res.json({
        success: true,
        message: `Status cache cleared for cluster: ${activeCluster}`,
        clusterTag: activeCluster
      });

    } catch (error) {
      console.error('Error clearing status cache:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = MultiClusterAPIs;
