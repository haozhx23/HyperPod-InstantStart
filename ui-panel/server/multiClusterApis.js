const fs = require('fs-extra');
const path = require('path');
const { exec } = require('./utils/exec');
const { runKubectl } = require('./utils/kubectl');
const kubectlContext = require('./utils/kubectlContext');
const ClusterManager = require('./clusterManager');
const { getCurrentIdentity, extractRoleArn } = require('./utils/awsHelpers');
const { collectInvalid, rejectInvalid } = require('./utils/validateInput');

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

      // clusterTag 是目录名（`getClusterDir()` 是裸 path.join），也会进
      // `aws eks update-kubeconfig --name`。两条路径都必须在这里挡住。
      if (clusterTag !== undefined) {
        const problems = collectInvalid([['clusterTag', clusterTag, 'token', { maxLength: 100 }]]);
        if (problems.length > 0) return rejectInvalid(res, problems, 'POST /multi-cluster/switch');
      }

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

  /**
   * 根据 `describe-cluster` 的 resourcesVpcConfig 判断面板能否经公网访问 EKS API。
   *
   * 面板的所有 kubectl 调用都走 EKS API endpoint。集群与面板主机在不同 region（或不同 VPC）时，
   * 只开私有 endpoint 的集群从面板访问不到，除非网络另行打通；公网 endpoint 限制了来源 CIDR 时，
   * 主机出口 IP 也必须在列表里。这里只给出提示、不阻断：主机就在集群 VPC 内时私有 endpoint 也能用。
   *
   * @param {object} vpcConfig cluster.resourcesVpcConfig
   * @returns {string|null}
   */
  static endpointAccessWarning(vpcConfig) {
    if (!vpcConfig) return null;
    if (vpcConfig.endpointPublicAccess === false) {
      return 'The EKS API endpoint has public access disabled. The panel can reach it only if its host ' +
        'is inside the cluster VPC or has a private network path to it (for example through Transit Gateway or a VPN).';
    }
    const cidrs = Array.isArray(vpcConfig.publicAccessCidrs) ? vpcConfig.publicAccessCidrs : [];
    if (vpcConfig.endpointPublicAccess === true && cidrs.length > 0 && !cidrs.includes('0.0.0.0/0')) {
      return `The EKS API public endpoint only accepts ${cidrs.join(', ')}. ` +
        "Make sure the panel host's public egress IP is in this list.";
    }
    return null;
  }

  // 导入现有集群
  async handleImportCluster(req, res) {
    // 声明在 try 外：endpoint 不可达时失败发生在后面的 kubectl 步骤，报错里要带上这条提示
    let endpointWarning = null;
    try {
      const { eksClusterName, awsRegion, hyperPodClusters, computeSecurityGroup } = req.body;

      // 这里是**整个系统里名字的源头**：eksClusterName 之后会
      //   1. 进 `aws eks describe-cluster --name ${eksClusterName}`（shell）；
      //   2. 作为 clusterTag 进 `createClusterDirs()` → `mkdirSync(path.join(...))`（建目录）；
      //   3. 写进 metadata，成为后续几乎所有 kubectl/aws 命令的插值来源（二阶注入）。
      // 一处没挡住，后面 121 处插值都跟着不安全，所以这个端点优先级最高。
      // EKS 集群名上限 100 字符。
      const importProblems = collectInvalid([
        ['eksClusterName', eksClusterName, 'token', { maxLength: 100 }],
        ['awsRegion', awsRegion, 'region'],
      ]);
      // hyperPodClusters 是逗号分隔的名字列表；给了就每一段都要干净
      if (hyperPodClusters && String(hyperPodClusters).trim()) {
        String(hyperPodClusters).split(',').forEach((name, i) => {
          importProblems.push(...collectInvalid([[`hyperPodClusters[${i}]`, name.trim(), 'token', { maxLength: 63 }]]));
        });
      }
      if (computeSecurityGroup && String(computeSecurityGroup).trim()) {
        importProblems.push(...collectInvalid([['computeSecurityGroup', String(computeSecurityGroup).trim(), 'token', { maxLength: 64 }]]));
      }
      if (importProblems.length > 0) return rejectInvalid(res, importProblems, 'POST /cluster/import');

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
      endpointWarning = clusterExists.endpointWarning || null;
      if (endpointWarning) console.warn(`Import ${eksClusterName}: ${endpointWarning}`);

      // 2. 确保当前EC2 role有集群访问权限
      const accessResult = await this.ensureClusterAccess(eksClusterName, awsRegion);
      
      // 3. 创建集群目录结构
      this.clusterManager.createClusterDirs(eksClusterName);
      
      // 4. 生成导入配置（先保存配置文件）
      const importConfig = {
        CLUSTER_TYPE: 'imported',
        EKS_CLUSTER_NAME: eksClusterName,
        EKS_CLUSTER_ARN: clusterExists.context,
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
      const detectedState = await this.detectClusterState(eksClusterName, awsRegion, hyperPodClusters, clusterExists.context);
      
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

      // 导入不切换活跃集群，查询必须使用 describe-cluster 返回的目标 ARN。
      const nodeCount = await this.getNodeCount(clusterExists.context);
      
      res.json({
        success: true,
        message: `Successfully imported cluster: ${eksClusterName}. Please select it in Cluster Information to use.`,
        clusterTag: eksClusterName,
        nodeCount,
        accessInfo: accessResult,
        detectedState: detectedState,
        warnings: endpointWarning ? [endpointWarning] : []
      });

    } catch (error) {
      console.error('Error importing cluster:', error);
      res.status(500).json({
        success: false,
        error: endpointWarning ? `${error.message} (${endpointWarning})` : error.message
      });
    }
  }

  // 测试集群连接
  async handleTestConnection(req, res) {
    try {
      const { eksClusterName, awsRegion } = req.body;

      // 与 import 同一条 `aws eks describe-cluster` 路径
      const problems = collectInvalid([
        ['eksClusterName', eksClusterName, 'token', { maxLength: 100 }],
        ['awsRegion', awsRegion, 'region'],
      ]);
      if (problems.length > 0) return rejectInvalid(res, problems, 'POST /cluster/test-connection');

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
      exec(`aws eks describe-cluster --region ${awsRegion} --name ${eksClusterName} --output json`, (error, stdout) => {
        if (error) {
          resolve({
            success: false,
            error: `EKS cluster not found or access denied: ${error.message}`
          });
        } else {
          try {
            const cluster = JSON.parse(stdout).cluster;
            const context = cluster?.arn;
            if (!kubectlContext.isValidContextName(context)) throw new Error('EKS response is missing a valid cluster ARN');
            resolve({
              success: true,
              context,
              endpointWarning: MultiClusterAPIs.endpointAccessWarning(cluster?.resourcesVpcConfig),
              message: `Cluster ${eksClusterName} exists and is accessible`
            });
          } catch (parseError) {
            resolve({ success: false, error: parseError.message });
          }
        }
      });
    });
  }

  // 获取节点数量（在权限配置完成后）
  async getNodeCount(context) {
    if (!kubectlContext.isValidContextName(context)) throw new Error('A target EKS context is required');
    const output = await runKubectl('get nodes -o json', { context });
    return JSON.parse(output).items.length;
  }

  // 检测集群实际状态
  async detectClusterState(eksClusterName, awsRegion, userSpecifiedHyperPodClusters = null,
    context = kubectlContext.resolveClusterTarget(eksClusterName).context) {
    if (!kubectlContext.isValidContextName(context)) throw new Error('A target EKS context is required');
    console.log(`Detecting state for cluster: ${eksClusterName}`);
    
    const state = {
      dependencies: await this.detectDependencies(context),
      hyperPodClusters: await this.detectHyperPodClusters(eksClusterName, awsRegion, userSpecifiedHyperPodClusters),
      nodeGroups: await this.detectNodeGroups(context),
      detectedAt: new Date().toISOString()
    };
    
    console.log('Detected cluster state:', JSON.stringify(state, null, 2));
    return state;
  }

  // 检测依赖组件状态
  async detectDependencies(context) {
    const components = {
      helmDependencies: false,
      nlbController: false,
      s3CsiDriver: false,
      certManager: false
    };

    try {
      // 检测 AWS Load Balancer Controller
      const nlbResult = await this.execCommand('kubectl get deployment -n kube-system aws-load-balancer-controller --no-headers 2>/dev/null', context);
      components.nlbController = nlbResult.success && nlbResult.output.includes('aws-load-balancer-controller');

      // 检测 S3 CSI Driver
      const s3Result = await this.execCommand('kubectl get daemonset -n kube-system s3-csi-node --no-headers 2>/dev/null', context);
      components.s3CsiDriver = s3Result.success && s3Result.output.includes('s3-csi-node');

      // 检测 Cert Manager
      const certResult = await this.execCommand('kubectl get pods -n cert-manager --no-headers 2>/dev/null', context);
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
  async detectNodeGroups(context) {
    try {
      const result = await this.execCommand('kubectl get nodes -o json 2>/dev/null', context);
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

      // 进 `getClusterDir()`（裸 path.join）与下游 kubectl
      const problems = collectInvalid([['clusterTag', clusterTag, 'token', { maxLength: 100 }]]);
      if (problems.length > 0) return rejectInvalid(res, problems, 'POST /cluster/:clusterTag/redetect-state');

      if (!clusterTag) {
        return res.status(400).json({
          success: false,
          error: 'clusterTag is required'
        });
      }

      console.log(`Re-detecting state for cluster: ${clusterTag}`);

      // 获取集群信息
      const clusterInfo = await this.clusterManager.getClusterInfo(clusterTag);
      if (!clusterInfo) {
        return res.status(404).json({
          success: false,
          error: 'Cluster not found'
        });
      }

      // 切换到目标集群
      await this.switchKubectlConfig(clusterTag);

      // 重新检测状态
      const detectedState = await this.detectClusterState(
        clusterInfo.eksCluster.name, clusterInfo.region, null,
        kubectlContext.resolveClusterTarget(clusterTag).context
      );
      
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
  async execCommand(command, context) {
    if (context !== undefined) {
      if (!kubectlContext.isValidContextName(context)) throw new Error('A target EKS context is required');
      command = kubectlContext.injectContextIntoCommand(command, context);
    }
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
      exec(`aws eks describe-cluster --region ${awsRegion} --name ${eksClusterName} --output json`, (error, stdout) => {
        if (error) {
          resolve({
            success: false,
            error: `EKS cluster not found or access denied: ${error.message}`
          });
          return;
        }

        let targetContext;
        let endpointWarning = null;
        try {
          const cluster = JSON.parse(stdout).cluster;
          targetContext = cluster?.arn;
          endpointWarning = MultiClusterAPIs.endpointAccessWarning(cluster?.resourcesVpcConfig);
          if (!kubectlContext.isValidContextName(targetContext)) throw new Error('EKS response is missing a valid cluster ARN');
        } catch (parseError) {
          resolve({ success: false, error: parseError.message });
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

            // 4. 测试连接沿用统一 kubectl 层的超时和大输出限制。
            const finishTest = (nodeError, nodeCount) => {
              // 5. 恢复原来的kubectl配置（如果有的话）
              if (originalContext && originalContext !== 'error') {
                exec(`kubectl config use-context ${originalContext}`, (restoreError) => {
                  if (restoreError) {
                    console.warn('Failed to restore original kubectl context:', restoreError.message);
                  }
                });
              }

              if (nodeError) {
                const hint = endpointWarning ? ` (${endpointWarning})` : '';
                resolve({
                  success: false,
                  error: `Failed to connect to cluster: ${nodeError.message}${hint}`
                });
              } else {
                resolve({
                  success: true,
                  nodeCount,
                  message: `Successfully connected to cluster with ${nodeCount} nodes`,
                  warning: originalContext ? 'Kubectl context restored to original' : 'No original context to restore',
                  endpointWarning
                });
              }
            };
            this.getNodeCount(targetContext).then(
              nodeCount => finishTest(null, nodeCount),
              nodeError => finishTest(nodeError, 0)
            );
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
