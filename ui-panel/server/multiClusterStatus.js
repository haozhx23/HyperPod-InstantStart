const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const ClusterManager = require('./clusterManager');

class MultiClusterStatus {
  constructor() {
    this.clusterManager = new ClusterManager();
  }

  // 获取集群专用的缓存文件路径
  getCacheFilePath(clusterTag, step) {
    const metadataDir = this.clusterManager.getClusterMetadataDir(clusterTag);
    return path.join(metadataDir, `${step}_status_cache.json`);
  }

  // 读取缓存
  readCache(clusterTag, step) {
    try {
      const cacheFile = this.getCacheFilePath(clusterTag, step);
      if (fs.existsSync(cacheFile)) {
        const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        return cacheData;
      }
    } catch (error) {
      console.warn(`Failed to read cache for ${clusterTag}/${step}:`, error.message);
    }
    return null;
  }

  // 写入缓存
  writeCache(clusterTag, step, data) {
    try {
      const cacheFile = this.getCacheFilePath(clusterTag, step);
      fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.warn(`Failed to write cache for ${clusterTag}/${step}:`, error.message);
    }
  }

  // 检查 Step 1 状态 (CloudFormation)
  async checkStep1Status(clusterTag) {
    try {
      // 从 cluster_info.json 获取集群信息
      const clusterInfo = await this.clusterManager.getClusterInfo(clusterTag);
      
      if (!clusterInfo) {
        return {
          status: 'not_started',
          message: 'Configuration not found',
          details: null
        };
      }

      const stackName = clusterInfo.cloudFormation?.stackName;
      if (!stackName) {
        return { status: 'unknown', message: 'CloudFormation stack name not found in metadata' };
      }

      // 检查缓存
      const cachedStatus = this.readCache(clusterTag, 'step1');
      if (cachedStatus && cachedStatus.stackName === stackName && cachedStatus.status === 'completed') {
        console.log(`Using cached Step 1 status for cluster ${clusterTag}`);
        return cachedStatus;
      }

      // 查询 CloudFormation 状态
      const command = `aws cloudformation describe-stacks --stack-name "${stackName}" --output json`;
      
      return new Promise((resolve) => {
        exec(command, (error, stdout, stderr) => {
          let result;
          
          if (error) {
            if (stderr.includes('does not exist')) {
              result = {
                status: 'not_started',
                message: 'CloudFormation stack not found',
                stackName,
                details: null
              };
            } else {
              result = {
                status: 'error',
                message: `CloudFormation query failed: ${error.message}`,
                stackName,
                details: null
              };
            }
          } else {
            try {
              const stackData = JSON.parse(stdout);
              const stack = stackData.Stacks[0];
              const stackStatus = stack.StackStatus;
              
              let status;
              if (stackStatus === 'CREATE_COMPLETE' || stackStatus === 'UPDATE_COMPLETE') {
                status = 'completed';
              } else if (stackStatus.includes('IN_PROGRESS')) {
                status = 'running';
              } else if (stackStatus.includes('FAILED')) {
                status = 'failed';
              } else {
                status = 'unknown';
              }
              
              result = {
                status,
                message: `CloudFormation stack status: ${stackStatus}`,
                stackName,
                stackStatus,
                details: {
                  creationTime: stack.CreationTime,
                  lastUpdatedTime: stack.LastUpdatedTime,
                  outputs: stack.Outputs || []
                }
              };
              
              // 缓存完成状态
              if (status === 'completed') {
                this.writeCache(clusterTag, 'step1', result);
              }
              
            } catch (parseError) {
              result = {
                status: 'error',
                message: `Failed to parse CloudFormation response: ${parseError.message}`,
                stackName,
                details: null
              };
            }
          }
          
          resolve(result);
        });
      });

    } catch (error) {
      return {
        status: 'error',
        message: `Step 1 status check failed: ${error.message}`,
        details: null
      };
    }
  }

  // 检查 Step 2 状态 (Kubernetes 资源)
  async checkStep2Status(clusterTag) {
    try {
      // 检查缓存
      const cachedStatus = this.readCache(clusterTag, 'step2');
      if (cachedStatus && cachedStatus.status === 'completed') {
        console.log(`Using cached Step 2 status for cluster ${clusterTag}`);
        return cachedStatus;
      }

      // 首先检查是否有 Step2 的执行记录（日志文件）
      const currentDir = this.clusterManager.getClusterCurrentDir(clusterTag);
      const step2LogFile = path.join(currentDir, 'configure.log');
      const step2LogExists = fs.existsSync(step2LogFile);
      
      // 如果没有 Step2 的执行记录，说明还未启动过
      if (!step2LogExists) {
        return {
          status: 'not_started',
          message: 'Step 2 has not been executed yet',
          summary: {
            total: 0,
            ready: 0,
            error: 0,
            missing: 0
          },
          checks: [],
          details: {
            totalChecks: 0,
            readyCount: 0,
            errorCount: 0,
            missingCount: 0,
            components: []
          }
        };
      }

      // 检查 Kubernetes 资源
      const checks = [
        this.checkS3CSINodes(),
        this.checkHyperPodOperator(),
        this.checkControllerManager()
      ];

      const results = await Promise.all(checks);
      
      const totalChecks = results.length;
      const readyCount = results.filter(r => r.status === 'ready').length;
      const errorCount = results.filter(r => r.status === 'error').length;
      const missingCount = results.filter(r => r.status === 'missing').length;

      let overallStatus;
      let message;

      if (readyCount === totalChecks) {
        overallStatus = 'completed';
        message = 'All Kubernetes components are ready';
      } else if (errorCount > 0) {
        overallStatus = 'error';
        message = `${errorCount} component(s) have errors`;
      } else if (missingCount === totalChecks) {
        overallStatus = 'not_started';
        message = 'No Kubernetes components found';
      } else {
        overallStatus = 'partial';
        message = `${readyCount}/${totalChecks} components ready`;
      }

      const result = {
        status: overallStatus,
        message,
        summary: {
          total: totalChecks,
          ready: readyCount,
          error: errorCount,
          missing: missingCount
        },
        checks: results,
        details: {
          totalChecks,
          readyCount,
          errorCount,
          missingCount,
          components: results
        }
      };

      // 缓存完成状态
      if (overallStatus === 'completed') {
        this.writeCache(clusterTag, 'step2', result);
      }

      return result;

    } catch (error) {
      return {
        status: 'error',
        message: `Step 2 status check failed: ${error.message}`,
        details: null
      };
    }
  }

  // 检查 S3 CSI Node Pods
  checkS3CSINodes() {
    return new Promise((resolve) => {
      exec('kubectl get pods -n kube-system -l app=s3-csi-node --no-headers', (error, stdout, stderr) => {
        if (error) {
          resolve({
            name: 's3-csi-node',
            status: 'error',
            message: `Failed to check S3 CSI nodes: ${error.message}`,
            details: null
          });
          return;
        }

        const lines = stdout.trim().split('\n').filter(line => line.trim());
        
        if (lines.length === 0) {
          resolve({
            name: 's3-csi-node',
            status: 'missing',
            message: 'No S3 CSI node pods found',
            details: { totalPods: 0, runningPods: 0, readyPods: 0 }
          });
          return;
        }

        let runningPods = 0;
        let readyPods = 0;
        
        lines.forEach(line => {
          const parts = line.split(/\s+/);
          if (parts.length >= 3) {
            const status = parts[2]; // STATUS column
            const ready = parts[1];  // READY column (e.g., "1/1")
            
            if (status === 'Running') {
              runningPods++;
            }
            
            // Check if ready (e.g., "1/1" means ready)
            const [readyCount, totalCount] = ready.split('/').map(n => parseInt(n));
            if (readyCount === totalCount && readyCount > 0) {
              readyPods++;
            }
          }
        });

        const status = readyPods === lines.length ? 'ready' : 'partial';
        
        resolve({
          name: 's3-csi-node',
          status,
          message: `${readyPods}/${lines.length} S3 CSI node pods ready`,
          details: {
            totalPods: lines.length,
            runningPods: runningPods,
            readyPods: readyPods
          }
        });
      });
    });
  }

  // 检查 HyperPod Training Operator
  checkHyperPodOperator() {
    return new Promise((resolve) => {
      // 根据实际输出，使用更通用的搜索
      exec('kubectl get pods -A --no-headers | grep -E "training-operator|hp-training"', (error, stdout, stderr) => {
        if (error || !stdout.trim()) {
          resolve({
            name: 'hp-training-operator',
            status: 'missing',
            message: 'HyperPod training operator not found',
            details: { totalPods: 0 }
          });
          return;
        }

        const lines = stdout.trim().split('\n').filter(line => line.trim());
        
        if (lines.length === 0) {
          resolve({
            name: 'hp-training-operator',
            status: 'missing',
            message: 'HyperPod training operator not found',
            details: { totalPods: 0 }
          });
          return;
        }

        let runningPods = 0;
        let readyPods = 0;
        
        lines.forEach(line => {
          const parts = line.split(/\s+/);
          if (parts.length >= 4) {
            const status = parts[3]; // STATUS column
            const ready = parts[2];  // READY column
            
            if (status === 'Running') {
              runningPods++;
            }
            
            // Check if ready
            const [readyCount, totalCount] = ready.split('/').map(n => parseInt(n));
            if (readyCount === totalCount && readyCount > 0) {
              readyPods++;
            }
          }
        });

        const status = readyPods > 0 ? 'ready' : 'partial';
        
        resolve({
          name: 'hp-training-operator',
          status,
          message: `${readyPods}/${lines.length} HyperPod operator pods ready`,
          details: {
            totalPods: lines.length,
            runningPods: runningPods,
            readyPods: readyPods
          }
        });
      });
    });
  }

  // 检查 Controller Manager
  checkControllerManager() {
    return new Promise((resolve) => {
      exec('kubectl get pods -A --no-headers | grep -E "hp-training-controller-manager|training-operator"', (error, stdout, stderr) => {
        if (error || !stdout.trim()) {
          resolve({
            name: 'controller-manager',
            status: 'missing',
            message: 'Controller manager not found',
            details: null
          });
          return;
        }

        const lines = stdout.trim().split('\n').filter(line => line.trim());
        
        if (lines.length === 0) {
          resolve({
            name: 'controller-manager',
            status: 'missing',
            message: 'Controller manager not found',
            details: null
          });
          return;
        }

        let runningPods = 0;
        let readyPods = 0;
        
        lines.forEach(line => {
          const parts = line.split(/\s+/);
          if (parts.length >= 4) {
            const status = parts[3]; // STATUS column
            const ready = parts[2];  // READY column
            
            if (status === 'Running') {
              runningPods++;
            }
            
            // Check if ready
            const [readyCount, totalCount] = ready.split('/').map(n => parseInt(n));
            if (readyCount === totalCount && readyCount > 0) {
              readyPods++;
            }
          }
        });

        const status = readyPods > 0 ? 'ready' : 'partial';
        
        resolve({
          name: 'controller-manager',
          status,
          message: `Found ${readyPods}/${lines.length} controller manager pod(s) ready`,
          details: {
            totalPods: lines.length,
            runningPods: runningPods,
            readyPods: readyPods
          }
        });
      });
    });
  }

  // API 处理函数
  async handleStep1Status(req, res) {
    try {
      const activeCluster = this.clusterManager.getActiveCluster();
      
      if (!activeCluster) {
        return res.json({
          success: true,
          data: {
            status: 'not_started',
            message: 'No active cluster',
            details: null
          }
        });
      }

      const status = await this.checkStep1Status(activeCluster);
      
      res.json({
        success: true,
        data: status,
        clusterTag: activeCluster
      });

    } catch (error) {
      console.error('Error checking Step 1 status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async handleStep2Status(req, res) {
    try {
      const activeCluster = this.clusterManager.getActiveCluster();
      
      if (!activeCluster) {
        return res.json({
          success: true,
          data: {
            status: 'not_started',
            message: 'No active cluster',
            details: null
          }
        });
      }

      const status = await this.checkStep2Status(activeCluster);
      
      res.json({
        success: true,
        data: status,
        clusterTag: activeCluster
      });

    } catch (error) {
      console.error('Error checking Step 2 status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 处理 CloudFormation 状态请求
  async handleCloudFormationStatus(req, res) {
    try {
      const activeCluster = this.clusterManager.getActiveCluster();
      
      if (!activeCluster) {
        return res.json({
          success: false,
          error: 'No active cluster found'
        });
      }

      // 使用 Step1 状态检查，它包含了 CloudFormation 状态
      const step1Status = await this.checkStep1Status(activeCluster);
      
      res.json({
        success: true,
        data: {
          stackName: step1Status.stackName,
          status: step1Status.status,
          message: step1Status.message,
          details: step1Status.details,
          clusterTag: activeCluster
        }
      });

    } catch (error) {
      console.error('Error checking CloudFormation status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = MultiClusterStatus;
