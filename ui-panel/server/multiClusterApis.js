const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const ClusterManager = require('./clusterManager');
const MultiClusterLogManager = require('./multiClusterLogManager');
const { getCurrentIdentity, extractRoleArn } = require('./utils/awsHelpers');

// 多集群管理API
class MultiClusterAPIs {
  constructor() {
    this.clusterManager = new ClusterManager();
  }

  normalizeKubeconfigExecApiVersion(kubeconfigPath) {
    try {
      if (!kubeconfigPath || !fs.existsSync(kubeconfigPath)) {
        return false;
      }

      const originalContent = fs.readFileSync(kubeconfigPath, 'utf8');
      if (!originalContent.includes('client.authentication.k8s.io/v1alpha1')) {
        return false;
      }

      const updatedContent = originalContent.replaceAll(
        'client.authentication.k8s.io/v1alpha1',
        'client.authentication.k8s.io/v1beta1'
      );
      fs.writeFileSync(kubeconfigPath, updatedContent, 'utf8');
      console.log(`Normalized kubeconfig exec apiVersion to v1beta1: ${kubeconfigPath}`);
      return true;
    } catch (error) {
      console.warn(`Failed to normalize kubeconfig exec apiVersion for ${kubeconfigPath}:`, error.message);
      return false;
    }
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
        // 切换kubectl配置到新集群
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
      // 从 cluster_info.json 获取集群信息
      const clusterInfo = await this.clusterManager.getClusterInfo(clusterTag);
      
      if (!clusterInfo) {
        console.warn(`No cluster info found for cluster ${clusterTag}, skipping kubectl config switch`);
        return;
      }

      const awsRegion = clusterInfo.region;
      const eksClusterName = clusterInfo.eksCluster?.name;
      
      if (!awsRegion || !eksClusterName) {
        console.warn(`Missing region or EKS cluster name in ${clusterTag} config`);
        return;
      }

      console.log(`Updating kubectl config for cluster: ${eksClusterName} in region: ${awsRegion}`);

      // 执行aws eks update-kubeconfig命令
      const command = `aws eks update-kubeconfig --region ${awsRegion} --name ${eksClusterName}`;
      
      return new Promise((resolve, reject) => {
        exec(command, { 
          timeout: 30000,
          env: { 
            ...process.env, 
            HOME: process.env.HOME || '/home/node',
            KUBECONFIG: process.env.KUBECONFIG || '/home/node/.kube/config'
          }
        }, (error, stdout, stderr) => {
          if (error) {
            console.error(`Failed to update kubectl config: ${error.message}`);
            console.error(`Command: ${command}`);
            console.error(`Stderr: ${stderr}`);
            reject(error);
          } else {
            this.normalizeKubeconfigExecApiVersion(kubeconfigPath);
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

  // DEPRECATED: handleSaveConfig - depends on cli/ directory
  async handleSaveConfig(req, res) {
    return res.status(410).json({
      success: false,
      error: 'This API endpoint is deprecated.'
    });
  }

  // DEPRECATED: autoInitializeFromCLI
  async autoInitializeFromCLI() {
    return { success: false, error: 'This method is deprecated.' };
  }

  // DEPRECATED: handleLaunch
  async handleLaunch(req, res) {
    return res.status(410).json({ success: false, error: 'This API endpoint is deprecated.' });
  }

  // DEPRECATED: handleConfigure
  async handleConfigure(req, res) {
    return res.status(410).json({ success: false, error: 'This API endpoint is deprecated.' });
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

  // 导入现有集群
  async handleImportCluster(req, res) {
    try {
      const { eksClusterName, awsRegion, hyperPodClusters, computeSecurityGroup } = req.body;

      if (!eksClusterName || !awsRegion) {
        return res.status(400).json({
          success: false,
          error: 'eksClusterName and awsRegion are required'
        });
      }

      console.log(`Importing existing cluster: ${eksClusterName} in ${awsRegion}`);
      if (hyperPodClusters) {
        console.log(`User specified HyperPod clusters: ${hyperPodClusters}`);
      }
      if (computeSecurityGroup) {
        console.log(`User specified Compute Security Group: ${computeSecurityGroup}`);
      }

      // 1. 验证集群存在
      const clusterExists = await this.verifyClusterExists(eksClusterName, awsRegion);
      if (!clusterExists.success) {
        return res.status(400).json({
          success: false,
          error: `Cluster verification failed: ${clusterExists.error}`
        });
      }

      // 2. 确保当前EC2 role有集群访问权限
      const accessResult = await this.ensureClusterAccess(eksClusterName, awsRegion);
      
      // 3. 创建集群目录结构
      this.clusterManager.createClusterDirs(eksClusterName);
      
      // 4. 生成导入配置（先保存配置文件）
      const importConfig = {
        CLUSTER_TYPE: 'imported',
        EKS_CLUSTER_NAME: eksClusterName,
        AWS_REGION: awsRegion,
        SKIP_CLUSTER_CREATION: 'true',
        SKIP_CLOUDFORMATION: 'true'
      };
      
      // 5. 先保存基础配置（不包含检测状态）
      const hasHyperPod = hyperPodClusters && hyperPodClusters.trim();
      await this.clusterManager.saveImportConfigBasic(eksClusterName, importConfig, accessResult, hasHyperPod);

      // 6. 更新kubectl配置
      await this.switchKubectlConfig(eksClusterName);

      // 6.5. 下载 sagemaker-hyperpod-cli 仓库
      try {
        const ClusterDependencyManager = require('./utils/clusterDependencyManager');
        const clusterConfigDir = path.join(__dirname, '../managed_clusters_info', eksClusterName, 'config');
        await ClusterDependencyManager.cloneHyperPodCLI(clusterConfigDir);
        console.log(`Successfully cloned sagemaker-hyperpod-cli for imported cluster: ${eksClusterName}`);
      } catch (error) {
        console.warn(`Failed to clone sagemaker-hyperpod-cli: ${error.message}`);
        // 不阻断导入流程
      }

      // 7. 检测集群实际状态（传递用户指定的HyperPod集群）
      const detectedState = await this.detectClusterState(eksClusterName, awsRegion, hyperPodClusters);
      
      // 8. 更新配置文件包含检测状态
      await this.clusterManager.updateImportConfigWithDetectedState(eksClusterName, detectedState);
      
      // 9. 获取并保存集群资源信息（与创建集群格式对齐）
      try {
        const MetadataUtils = require('./utils/metadataUtils');
        await MetadataUtils.saveImportedClusterResources(
          eksClusterName, eksClusterName, awsRegion, hyperPodClusters, null, computeSecurityGroup
        );
        console.log(`Successfully saved imported cluster resources for: ${eksClusterName}`);
      } catch (error) {
        console.warn(`Failed to save imported cluster resources: ${error.message}`);
        // 不阻断导入流程，但记录警告
      }
      
      // 不自动切换 active cluster，让用户在 Cluster Information 页面手动选择
      // 与创建集群的流程保持一致

      // 10. 获取节点数量（使用当前 active cluster 的 kubectl 配置）
      const nodeCount = await this.getNodeCount();
      
      res.json({
        success: true,
        message: `Successfully imported cluster: ${eksClusterName}. Please select it in Cluster Information to use.`,
        clusterTag: eksClusterName,
        nodeCount,
        accessInfo: accessResult,
        detectedState: detectedState
      });

    } catch (error) {
      console.error('Error importing cluster:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 测试集群连接
  async handleTestConnection(req, res) {
    try {
      const { eksClusterName, awsRegion } = req.body;
      
      if (!eksClusterName || !awsRegion) {
        return res.status(400).json({
          success: false,
          error: 'eksClusterName and awsRegion are required'
        });
      }

      const result = await this.testConnection(eksClusterName, awsRegion);
      res.json(result);

    } catch (error) {
      console.error('Error testing connection:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 验证集群存在（不测试连接）
  async verifyClusterExists(eksClusterName, awsRegion) {
    return new Promise((resolve) => {
      exec(`aws eks describe-cluster --region ${awsRegion} --name ${eksClusterName}`, (error, stdout) => {
        if (error) {
          resolve({
            success: false,
            error: `EKS cluster not found or access denied: ${error.message}`
          });
        } else {
          resolve({
            success: true,
            message: `Cluster ${eksClusterName} exists and is accessible`
          });
        }
      });
    });
  }

  // 获取节点数量（在权限配置完成后）
  async getNodeCount() {
    return new Promise((resolve) => {
      exec('kubectl get nodes --no-headers | wc -l', (error, stdout) => {
        if (error) {
          console.warn('Failed to get node count:', error.message);
          resolve(0);
        } else {
          resolve(parseInt(stdout.trim()) || 0);
        }
      });
    });
  }

  // 检测集群实际状态
  async detectClusterState(eksClusterName, awsRegion, userSpecifiedHyperPodClusters = null) {
    console.log(`Detecting state for cluster: ${eksClusterName}`);
    
    const state = {
      dependencies: await this.detectDependencies(),
      hyperPodClusters: await this.detectHyperPodClusters(eksClusterName, awsRegion, userSpecifiedHyperPodClusters),
      nodeGroups: await this.detectNodeGroups(),
      detectedAt: new Date().toISOString()
    };
    
    console.log('Detected cluster state:', JSON.stringify(state, null, 2));
    return state;
  }

  // 检测依赖组件状态
  async detectDependencies() {
    const components = {
      helmDependencies: false,
      nlbController: false,
      s3CsiDriver: false,
      certManager: false
    };

    try {
      // 检测 AWS Load Balancer Controller
      const nlbResult = await this.execCommand('kubectl get deployment -n kube-system aws-load-balancer-controller --no-headers 2>/dev/null');
      components.nlbController = nlbResult.success && nlbResult.output.includes('aws-load-balancer-controller');

      // 检测 S3 CSI Driver
      const s3Result = await this.execCommand('kubectl get daemonset -n kube-system s3-csi-node --no-headers 2>/dev/null');
      components.s3CsiDriver = s3Result.success && s3Result.output.includes('s3-csi-node');

      // 检测 Cert Manager
      const certResult = await this.execCommand('kubectl get pods -n cert-manager --no-headers 2>/dev/null');
      components.certManager = certResult.success && certResult.output.includes('cert-manager');

      // 检测 Helm 相关组件 (简化检测)
      components.helmDependencies = components.nlbController && components.s3CsiDriver;

    } catch (error) {
      console.warn('Error detecting dependencies:', error.message);
    }

    const configured = Object.values(components).filter(Boolean).length >= 3; // 至少3个组件正常
    
    return {
      configured,
      status: configured ? 'success' : 'pending',
      components,
      lastDetected: new Date().toISOString()
    };
  }

  // 检测 HyperPod 集群 - 使用用户指定的集群名称
  async detectHyperPodClusters(eksClusterName, awsRegion, userSpecifiedCluster = null) {
    try {
      const relatedClusters = [];
      
      if (userSpecifiedCluster && userSpecifiedCluster.trim()) {
        // 使用用户指定的HyperPod集群名称（单个）
        const clusterName = userSpecifiedCluster.trim();
        console.log(`Using user-specified HyperPod cluster: ${clusterName}`);
        
        try {
          // 验证HyperPod集群是否存在
          const detailResult = await this.execCommand(`aws sagemaker describe-cluster --cluster-name ${clusterName} --region ${awsRegion} --output json 2>/dev/null`);
          if (detailResult.success) {
            const clusterDetail = JSON.parse(detailResult.output);
            relatedClusters.push({
              name: clusterDetail.ClusterName,
              arn: clusterDetail.ClusterArn,
              status: clusterDetail.ClusterStatus,
              creationTime: clusterDetail.CreationTime
            });
            console.log(`Found user-specified HyperPod cluster: ${clusterName}`);
          } else {
            console.warn(`User-specified HyperPod cluster not found: ${clusterName}`);
          }
        } catch (error) {
          console.warn(`Failed to verify HyperPod cluster ${clusterName}:`, error.message);
        }
      } else {
        // 如果用户没有指定，则不检测任何HyperPod集群
        console.log('No HyperPod cluster specified by user, skipping detection');
      }
      
      return relatedClusters;
    } catch (error) {
      console.warn('Error detecting HyperPod clusters:', error.message);
    }
    return [];
  }

  // 检测节点组
  async detectNodeGroups() {
    try {
      const result = await this.execCommand('kubectl get nodes -o json 2>/dev/null');
      if (result.success) {
        const nodes = JSON.parse(result.output);
        const nodeGroups = {};
        
        nodes.items?.forEach(node => {
          const nodeGroup = node.metadata?.labels?.['eks.amazonaws.com/nodegroup'] || 'unknown';
          const instanceType = node.metadata?.labels?.['node.kubernetes.io/instance-type'] || 'unknown';
          
          if (!nodeGroups[nodeGroup]) {
            nodeGroups[nodeGroup] = {
              name: nodeGroup,
              instanceType,
              nodeCount: 0,
              nodes: []
            };
          }
          nodeGroups[nodeGroup].nodeCount++;
          nodeGroups[nodeGroup].nodes.push(node.metadata.name);
        });
        
        return Object.values(nodeGroups);
      }
    } catch (error) {
      console.warn('Error detecting node groups:', error.message);
    }
    return [];
  }

  // 重新检测集群状态
  async handleRedetectClusterState(req, res) {
    try {
      const { clusterTag } = req.params;
      
      if (!clusterTag) {
        return res.status(400).json({
          success: false,
          error: 'clusterTag is required'
        });
      }

      console.log(`Re-detecting state for cluster: ${clusterTag}`);

      // 获取集群信息
      const clusterInfo = this.clusterManager.getClusterInfo(clusterTag);
      if (!clusterInfo) {
        return res.status(404).json({
          success: false,
          error: 'Cluster not found'
        });
      }

      // 切换到目标集群
      await this.switchKubectlConfig(clusterTag);

      // 重新检测状态
      const detectedState = await this.detectClusterState(clusterTag, clusterInfo.config?.awsRegion);
      
      // 更新集群信息
      await this.clusterManager.updateClusterDetectedState(clusterTag, detectedState);
      
      res.json({
        success: true,
        message: `Successfully re-detected state for cluster: ${clusterTag}`,
        detectedState: detectedState
      });

    } catch (error) {
      console.error('Error re-detecting cluster state:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 执行命令的辅助方法
  async execCommand(command) {
    return new Promise((resolve) => {
      exec(command, (error, stdout, stderr) => {
        resolve({
          success: !error,
          output: stdout.trim(),
          error: error?.message || stderr
        });
      });
    });
  }
  async ensureClusterAccess(eksClusterName, awsRegion) {
    try {
      // 1. 获取当前EC2的IAM role
      const identity = await getCurrentIdentity();
      const roleArn = extractRoleArn(identity.Arn);
      
      console.log(`Current EC2 role: ${roleArn}`);
      
      // 2. 检查是否已有access entry
      const hasAccess = await this.checkExistingAccess(eksClusterName, roleArn, awsRegion);
      
      if (hasAccess.exists) {
        console.log(`Access entry already exists for role: ${roleArn}`);
        return {
          action: 'existing',
          message: 'Role already has cluster access',
          roleArn,
          policies: hasAccess.policies
        };
      }
      
      // 3. 创建access entry
      await this.createAccessEntry(eksClusterName, roleArn, awsRegion);
      
      // 4. 关联cluster admin policy
      await this.associateClusterAdminPolicy(eksClusterName, roleArn, awsRegion);
      
      console.log(`Successfully granted cluster admin access to role: ${roleArn}`);
      
      return {
        action: 'created',
        message: 'Successfully granted cluster admin access',
        roleArn,
        policies: ['AmazonEKSClusterAdminPolicy']
      };
      
    } catch (error) {
      console.warn(`Failed to ensure cluster access: ${error.message}`);
      return {
        action: 'failed',
        message: `Access management failed: ${error.message}`,
        warning: 'Cluster import will continue, but you may need to manually add access permissions'
      };
    }
  }

  // 检查现有访问权限
  async checkExistingAccess(eksClusterName, roleArn, awsRegion) {
    try {
      // 检查access entry是否存在
      const result = await new Promise((resolve, reject) => {
        exec(`aws eks describe-access-entry --cluster-name ${eksClusterName} --principal-arn "${roleArn}" --region ${awsRegion}`, 
          (error, stdout) => {
            if (error) {
              if (error.message.includes('ResourceNotFoundException')) {
                resolve({ exists: false });
              } else {
                reject(error);
              }
            } else {
              resolve({ exists: true, entry: JSON.parse(stdout) });
            }
          });
      });

      if (!result.exists) {
        return { exists: false };
      }

      // 获取关联的policies
      const policies = await new Promise((resolve, reject) => {
        exec(`aws eks list-associated-access-policies --cluster-name ${eksClusterName} --principal-arn "${roleArn}" --region ${awsRegion}`, 
          (error, stdout) => {
            if (error) {
              resolve([]);
            } else {
              const data = JSON.parse(stdout);
              resolve(data.associatedAccessPolicies || []);
            }
          });
      });

      return { 
        exists: true, 
        policies: policies.map(p => p.policyArn.split('/').pop()) 
      };

    } catch (error) {
      console.warn(`Error checking existing access: ${error.message}`);
      return { exists: false };
    }
  }

  // 创建access entry
  async createAccessEntry(eksClusterName, roleArn, awsRegion) {
    return new Promise((resolve, reject) => {
      const command = `aws eks create-access-entry --cluster-name ${eksClusterName} --principal-arn "${roleArn}" --region ${awsRegion}`;
      exec(command, (error, stdout) => {
        if (error) {
          reject(new Error(`Failed to create access entry: ${error.message}`));
        } else {
          console.log(`Created access entry for role: ${roleArn}`);
          resolve(JSON.parse(stdout));
        }
      });
    });
  }

  // 关联cluster admin policy
  async associateClusterAdminPolicy(eksClusterName, roleArn, awsRegion) {
    return new Promise((resolve, reject) => {
      const policyArn = 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy';
      const command = `aws eks associate-access-policy --cluster-name ${eksClusterName} --principal-arn "${roleArn}" --policy-arn ${policyArn} --access-scope type=cluster --region ${awsRegion}`;
      
      exec(command, (error, stdout) => {
        if (error) {
          reject(new Error(`Failed to associate cluster admin policy: ${error.message}`));
        } else {
          console.log(`Associated cluster admin policy for role: ${roleArn}`);
          resolve(JSON.parse(stdout));
        }
      });
    });
  }
  async testConnection(eksClusterName, awsRegion) {
    return new Promise((resolve) => {
      // 1. 测试EKS集群是否存在
      exec(`aws eks describe-cluster --region ${awsRegion} --name ${eksClusterName}`, (error, stdout) => {
        if (error) {
          resolve({
            success: false,
            error: `EKS cluster not found or access denied: ${error.message}`
          });
          return;
        }

        // 2. 保存当前kubectl配置
        exec('kubectl config current-context', (contextError, currentContext) => {
          const originalContext = currentContext ? currentContext.trim() : null;
          
          // 3. 临时更新kubectl配置进行测试
          exec(`aws eks update-kubeconfig --region ${awsRegion} --name ${eksClusterName}`, {
            env: { 
              ...process.env, 
              HOME: process.env.HOME || '/home/node',
              KUBECONFIG: process.env.KUBECONFIG || '/home/node/.kube/config'
            }
          }, (kubectlError) => {
            if (kubectlError) {
              resolve({
                success: false,
                error: `Failed to update kubectl config: ${kubectlError.message}`
              });
              return;
            }

            this.normalizeKubeconfigExecApiVersion(kubeconfigPath);

            // 4. 测试kubectl连接
            exec('kubectl get nodes --no-headers | wc -l', (nodeError, nodeStdout) => {
              const nodeCount = nodeError ? 0 : parseInt(nodeStdout.trim()) || 0;
              
              // 5. 恢复原来的kubectl配置（如果有的话）
              if (originalContext && originalContext !== 'error') {
                exec(`kubectl config use-context ${originalContext}`, (restoreError) => {
                  if (restoreError) {
                    console.warn('Failed to restore original kubectl context:', restoreError.message);
                  }
                });
              }

              if (nodeError) {
                resolve({
                  success: false,
                  error: `Failed to connect to cluster: ${nodeError.message}`
                });
              } else {
                resolve({
                  success: true,
                  nodeCount,
                  message: `Successfully connected to cluster with ${nodeCount} nodes`,
                  warning: originalContext ? 'Kubectl context restored to original' : 'No original context to restore'
                });
              }
            });
          });
        });
      });
    });
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
