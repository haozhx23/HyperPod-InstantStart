/**
 * EKS Creation Manager
 * 处理 EKS 集群创建、状态检查、依赖配置相关的 API
 */

const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

// 依赖注入
let broadcast = null;
let clusterManager = null;
let CloudFormationManager = null;
let ClusterDependencyManager = null;
let NetworkManager = null;

// 防止并发配置的互斥锁
const configurationMutex = new Set();

/**
 * 初始化模块依赖
 * @param {Object} deps - 依赖对象
 */
function initialize(deps) {
  broadcast = deps.broadcast;
  clusterManager = deps.clusterManager;
  CloudFormationManager = deps.CloudFormationManager;
  ClusterDependencyManager = deps.ClusterDependencyManager;
  NetworkManager = deps.NetworkManager;
}

// ==================== 辅助函数 ====================

/**
 * 更新 creating-clusters 状态
 */
function updateCreatingClustersStatus(clusterTag, status, additionalData = {}) {
  const creatingClustersPath = path.join(__dirname, '../managed_clusters_info/creating-clusters.json');

  console.log(`🔄 Updating creating status for ${clusterTag}: ${status}`);

  let creatingClusters = {};
  if (fs.existsSync(creatingClustersPath)) {
    creatingClusters = JSON.parse(fs.readFileSync(creatingClustersPath, 'utf8'));
  }

  if (status === 'COMPLETED') {
    // 完成时删除记录
    delete creatingClusters[clusterTag];
    console.log(`✅ Removed ${clusterTag} from creating-clusters (completed)`);
  } else {
    // 更新状态和附加数据
    if (creatingClusters[clusterTag]) {
      creatingClusters[clusterTag] = {
        ...creatingClusters[clusterTag],
        status: status,
        lastUpdated: new Date().toISOString(),
        ...additionalData
      };
    }
  }

  fs.writeFileSync(creatingClustersPath, JSON.stringify(creatingClusters, null, 2));
}

/**
 * 更新已存在集群的状态
 */
async function updateClusterStatus(clusterTag, status) {
  try {
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

    if (fs.existsSync(clusterInfoPath)) {
      const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
      clusterInfo.status = status;
      clusterInfo.lastModified = new Date().toISOString();
      fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
      console.log(`Updated cluster ${clusterTag} status to: ${status}`);
    }
  } catch (error) {
    console.error(`Failed to update cluster status for ${clusterTag}:`, error);
  }
}

/**
 * 注册完成的集群到可选列表
 */
async function registerCompletedCluster(clusterTag, status = 'active') {
  try {
    console.log(`Registering completed cluster: ${clusterTag}`);

    // 读取创建时的 metadata
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const creationMetadataPath = path.join(metadataDir, 'creation_metadata.json');

    console.log(`Looking for creation metadata at: ${creationMetadataPath}`);

    if (!fs.existsSync(creationMetadataPath)) {
      console.error(`Creation metadata not found for cluster: ${clusterTag}`);
      console.log(`Metadata directory contents:`, fs.existsSync(metadataDir) ? fs.readdirSync(metadataDir) : 'Directory does not exist');
      throw new Error(`Creation metadata not found for cluster: ${clusterTag}`);
    }

    const creationMetadata = JSON.parse(fs.readFileSync(creationMetadataPath, 'utf8'));

    // 获取 CloudFormation Stack 输出
    let stackOutputs = {};
    try {
      const stackStatus = await CloudFormationManager.getStackStatus(
        creationMetadata.cloudFormation.stackName,
        creationMetadata.userConfig.awsRegion
      );

      if (stackStatus.outputs && stackStatus.outputs.length > 0) {
        // 将输出数组转换为键值对对象
        stackOutputs = stackStatus.outputs.reduce((acc, output) => {
          acc[output.OutputKey] = output.OutputValue;
          return acc;
        }, {});
        console.log(`Retrieved CloudFormation outputs for ${clusterTag}:`, Object.keys(stackOutputs));
      }
    } catch (error) {
      console.error(`Failed to get CloudFormation outputs for ${clusterTag}:`, error);
    }

    // 生成 cluster_info.json（兼容现有格式 + 新增 dependencies 字段）
    const clusterInfo = {
      clusterTag: clusterTag,
      region: creationMetadata.userConfig.awsRegion,
      status: status,
      type: 'created',
      createdAt: creationMetadata.createdAt,
      lastModified: new Date().toISOString(),
      source: 'ui-panel-creation',
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
      cloudFormation: {
        stackName: creationMetadata.cloudFormation.stackName,
        stackId: creationMetadata.cloudFormation.stackId,
        outputs: stackOutputs
      },
      eksCluster: {
        name: stackOutputs.OutputEKSClusterName || null,
        arn: stackOutputs.OutputEKSClusterArn || null,
        vpcId: stackOutputs.OutputVpcId || null,
        securityGroupId: stackOutputs.OutputSecurityGroupId || null,
        privateSubnetIds: stackOutputs.OutputPrivateSubnetIds || null,
        s3BucketName: stackOutputs.OutputS3BucketName || null,
        sageMakerRoleArn: stackOutputs.OutputSageMakerIAMRoleArn || null
      }
    };

    // 保存 cluster_info.json
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));

    // ✅ 生成 cluster_envs 文件
    const EnvInjector = require('./utils/envInjector');
    try {
      EnvInjector.updateClusterEnvFile(clusterTag);
      console.log(`✅ Generated cluster_envs for ${clusterTag}`);
    } catch (error) {
      console.error(`Failed to generate cluster_envs for ${clusterTag}:`, error);
    }

    // 更新 creation_metadata.json，添加 CloudFormation 输出
    if (Object.keys(stackOutputs).length > 0) {
      creationMetadata.cloudFormation.outputs = stackOutputs;
      creationMetadata.cloudFormation.outputsRetrievedAt = new Date().toISOString();
      fs.writeFileSync(creationMetadataPath, JSON.stringify(creationMetadata, null, 2));
      console.log(`Updated creation_metadata.json with CloudFormation outputs for ${clusterTag}`);
    }

    console.log(`Successfully registered cluster: ${clusterTag}`);

    // 不自动切换 active cluster，让用户在 Cluster Information 页面手动选择
    // 用户可以通过刷新集群列表后手动切换到新创建的集群

    // 发送 WebSocket 通知
    if (broadcast) {
      broadcast({
        type: 'cluster_creation_completed',
        status: 'success',
        message: `EKS cluster created and registered: ${clusterTag}. Please select it in Cluster Information to use.`,
        clusterTag: clusterTag
      });
    }

  } catch (error) {
    console.error(`Failed to register completed cluster ${clusterTag}:`, error);
  }
}

/**
 * 获取集群信息
 */
async function getClusterInfo(clusterTag) {
  try {
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

    if (fs.existsSync(clusterInfoPath)) {
      return JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
    }
    return null;
  } catch (error) {
    console.error(`Error getting cluster info for ${clusterTag}:`, error);
    return null;
  }
}

/**
 * 更新依赖配置状态
 */
async function updateDependencyStatus(clusterTag, status, additionalData = {}) {
  try {
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

    if (fs.existsSync(clusterInfoPath)) {
      const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));

      clusterInfo.dependencies = {
        ...clusterInfo.dependencies,
        status: status,
        lastAttempt: new Date().toISOString(),
        ...(status === 'success' && {
          configured: true,
          lastSuccess: new Date().toISOString()
        }),
        ...additionalData
      };

      clusterInfo.lastModified = new Date().toISOString();
      fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
      console.log(`Updated dependency status for ${clusterTag}: ${status}`);
    }
  } catch (error) {
    console.error(`Error updating dependency status for ${clusterTag}:`, error);
  }
}

/**
 * 配置集群依赖（helm 等）
 */
async function configureClusterDependencies(clusterTag) {
  // 检查是否已经在配置中
  if (configurationMutex.has(clusterTag)) {
    console.log(`Dependencies configuration already in progress for ${clusterTag}, skipping...`);
    return;
  }

  // 添加到互斥锁
  configurationMutex.add(clusterTag);

  try {
    console.log(`Configuring dependencies for cluster: ${clusterTag}`);

    // 1. 更新状态为配置依赖中
    updateCreatingClustersStatus(clusterTag, 'IN_PROGRESS', {
      phase: 'CONFIGURING_DEPENDENCIES',
      currentStackStatus: 'CONFIGURING_DEPENDENCIES'
    });

    // 2. 先注册基础集群信息（让集群立即出现在列表中）
    await registerCompletedCluster(clusterTag, 'configuring');

    // 3. 广播依赖配置开始
    if (broadcast) {
      broadcast({
        type: 'cluster_dependencies_started',
        status: 'info',
        message: `Configuring dependencies for cluster: ${clusterTag}`,
        clusterTag: clusterTag
      });
    }

    // 4. 配置依赖
    await ClusterDependencyManager.configureClusterDependencies(clusterTag, clusterManager);

    console.log(`Successfully configured dependencies for cluster: ${clusterTag}`);

    // 5. 更新集群状态为 active
    await updateClusterStatus(clusterTag, 'active');

    // 6. 最后清理 creating 状态
    updateCreatingClustersStatus(clusterTag, 'COMPLETED');

    // 7. 广播完成
    if (broadcast) {
      broadcast({
        type: 'cluster_creation_completed',
        status: 'success',
        message: `Cluster ${clusterTag} is now ready and available`,
        clusterTag: clusterTag
      });
    }

  } catch (error) {
    console.error(`Error configuring dependencies for cluster ${clusterTag}:`, error);

    // 即使依赖配置失败，也要注册集群（让用户能看到集群）
    console.log(`Registering cluster ${clusterTag} despite dependency configuration failure`);
    try {
      await registerCompletedCluster(clusterTag, 'active');
    } catch (registerError) {
      console.error(`Failed to register cluster ${clusterTag}:`, registerError);
    }

    // 清除 creating 状态
    updateCreatingClustersStatus(clusterTag, 'COMPLETED');

    // 广播依赖配置失败
    if (broadcast) {
      broadcast({
        type: 'cluster_dependencies_failed',
        status: 'warning',
        message: `Dependencies configuration failed for cluster: ${clusterTag}, but cluster is still available`,
        clusterTag: clusterTag
      });
    }

  } finally {
    // 移除互斥锁
    configurationMutex.delete(clusterTag);
  }
}

/**
 * 针对当前 active 集群配置依赖
 */
async function configureDependenciesForActiveCluster(clusterTag) {
  try {
    console.log(`Configuring dependencies for active cluster: ${clusterTag}`);

    // 广播开始配置
    if (broadcast) {
      broadcast({
        type: 'cluster_dependencies_started',
        status: 'info',
        message: `Configuring dependencies for cluster: ${clusterTag}`,
        clusterTag: clusterTag
      });
    }

    // 使用现有的 ClusterDependencyManager 进行配置
    await ClusterDependencyManager.configureClusterDependencies(clusterTag, clusterManager);

    console.log(`Successfully configured dependencies for cluster: ${clusterTag}`);

    // 更新状态为成功
    // [2026-04-08] certManager 不再在 configure dependency 阶段安装，改由 training operator 一起管理
    await updateDependencyStatus(clusterTag, 'success', {
      components: {
        helmDependencies: true,
        nlbController: true,
        s3CsiDriver: true,
        certManager: false
      }
    });

    // 广播完成
    if (broadcast) {
      broadcast({
        type: 'cluster_dependencies_completed',
        status: 'success',
        message: `Dependencies configured successfully for cluster: ${clusterTag}`,
        clusterTag: clusterTag
      });
    }

  } catch (error) {
    console.error(`Error configuring dependencies for cluster ${clusterTag}:`, error);

    // 更新状态为失败
    await updateDependencyStatus(clusterTag, 'failed', {
      error: error.message,
      failedAt: new Date().toISOString()
    });

    // 广播失败
    if (broadcast) {
      broadcast({
        type: 'cluster_dependencies_failed',
        status: 'error',
        message: `Dependencies configuration failed for cluster: ${clusterTag}`,
        clusterTag: clusterTag,
        error: error.message
      });
    }
  }
}

/**
 * 清理创建中的 metadata
 */
function cleanupCreatingMetadata(clusterTag) {
  try {
    console.log(`Cleaning up creating metadata for: ${clusterTag}`);

    // 从 creating-clusters.json 中移除
    const creatingClustersPath = path.join(__dirname, '../managed_clusters_info/creating-clusters.json');
    if (fs.existsSync(creatingClustersPath)) {
      const creatingClusters = JSON.parse(fs.readFileSync(creatingClustersPath, 'utf8'));
      delete creatingClusters[clusterTag];
      fs.writeFileSync(creatingClustersPath, JSON.stringify(creatingClusters, null, 2));
    }

    // 删除集群目录（恢复到空白状态）
    const clusterDir = path.join(__dirname, '../managed_clusters_info', clusterTag);
    if (fs.existsSync(clusterDir)) {
      fs.rmSync(clusterDir, { recursive: true, force: true });
      console.log(`Removed cluster directory: ${clusterDir}`);
    }

    console.log(`Successfully cleaned up metadata for cluster: ${clusterTag}`);

  } catch (error) {
    console.error(`Error cleaning up metadata for cluster ${clusterTag}:`, error);
  }
}

// ==================== API 路由 ====================

/**
 * POST /api/cluster/create-eks
 * 创建 EKS 集群
 */
router.post('/create-eks', async (req, res) => {
  try {
    const { clusterTag, awsRegion, customVpcCidr, cidrConfig: userCidrConfig } = req.body;

    // 验证必填字段
    if (!clusterTag || !awsRegion) {
      return res.status(400).json({ error: 'Missing required fields: clusterTag and awsRegion' });
    }

    // 使用用户提供的 CIDR 配置，或自动生成
    let cidrConfig;
    if (userCidrConfig && userCidrConfig.vpcCidr) {
      // 用户提供了完整的 CIDR 配置，直接使用
      console.log('Using user-provided CIDR configuration:', userCidrConfig);
      cidrConfig = userCidrConfig;
    } else {
      // 自动生成 CIDR 配置（向后兼容）
      console.log('Auto-generating CIDR configuration for region:', awsRegion);
      const cidrResult = await NetworkManager.generateCidrConfig(awsRegion, customVpcCidr);
      if (!cidrResult.success) {
        return res.status(500).json({ error: `Failed to generate CIDR config: ${cidrResult.error}` });
      }
      cidrConfig = cidrResult;
    }

    // 立即创建集群目录和状态记录（在 CloudFormation 调用前）
    const stackName = `full-cfn-${clusterTag}`;

    const clusterConfig = {
      clusterTag,
      awsRegion,
      customVpcCidr: customVpcCidr || 'auto-generated'
    };

    // 创建集群目录结构
    clusterManager.createClusterDirs(clusterTag);

    // 立即保存用户输入和 CIDR 配置
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);

    // 添加到 creating-clusters 跟踪文件
    const creatingClustersPath = path.join(__dirname, '../managed_clusters_info/creating-clusters.json');
    let creatingClusters = {};
    if (fs.existsSync(creatingClustersPath)) {
      creatingClusters = JSON.parse(fs.readFileSync(creatingClustersPath, 'utf8'));
    }
    creatingClusters[clusterTag] = {
      type: 'eks',
      status: 'IN_PROGRESS',
      createdAt: new Date().toISOString(),
      stackName: stackName,
      region: awsRegion
    };
    fs.writeFileSync(creatingClustersPath, JSON.stringify(creatingClusters, null, 2));

    // 保存用户输入信息
    fs.writeFileSync(
      path.join(metadataDir, 'user_input.json'),
      JSON.stringify({
        clusterTag,
        awsRegion,
        customVpcCidr: customVpcCidr || null,
        inputAt: new Date().toISOString()
      }, null, 2)
    );

    // 保存 CIDR 配置
    fs.writeFileSync(
      path.join(metadataDir, 'cidr_configuration.json'),
      JSON.stringify(cidrConfig, null, 2)
    );

    // 保存创建状态
    fs.writeFileSync(
      path.join(metadataDir, 'creation_status.json'),
      JSON.stringify({
        status: 'IN_PROGRESS',
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        stackName: stackName,
        region: awsRegion,
        phase: 'CLOUDFORMATION_CREATING'
      }, null, 2)
    );

    // 创建 CloudFormation Stack
    let stackResult;
    try {
      stackResult = await CloudFormationManager.createEKSStack({
        clusterTag,
        awsRegion,
        stackName
      }, cidrConfig);
    } catch (stackError) {
      // CloudFormation 创建失败，清理 metadata
      console.error(`CloudFormation stack creation failed for ${clusterTag}:`, stackError);
      cleanupCreatingMetadata(clusterTag);
      throw stackError; // 重新抛出异常到外层 catch
    }

    // 更新创建状态，添加 Stack ID
    fs.writeFileSync(
      path.join(metadataDir, 'creation_status.json'),
      JSON.stringify({
        status: 'IN_PROGRESS',
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        stackName: stackName,
        stackId: stackResult.stackId,
        region: awsRegion,
        phase: 'CLOUDFORMATION_IN_PROGRESS'
      }, null, 2)
    );

    // 更新 creating-clusters 跟踪文件
    creatingClusters[clusterTag].stackId = stackResult.stackId;
    creatingClusters[clusterTag].phase = 'CLOUDFORMATION_IN_PROGRESS';
    creatingClusters[clusterTag].lastUpdated = new Date().toISOString();
    fs.writeFileSync(creatingClustersPath, JSON.stringify(creatingClusters, null, 2));

    await clusterManager.saveCreationConfig(clusterTag, clusterConfig, cidrConfig, stackResult);

    // 发送 WebSocket 通知
    if (broadcast) {
      broadcast({
        type: 'cluster_creation_started',
        status: 'success',
        message: `EKS cluster creation started: ${clusterTag}`,
        clusterTag,
        stackName: stackResult.stackName
      });
    }

    res.json({
      success: true,
      clusterTag,
      stackName: stackResult.stackName,
      stackId: stackResult.stackId,
      cidrConfig,
      message: 'EKS cluster creation started successfully'
    });
  } catch (error) {
    console.error('Error creating EKS cluster:', error);

    if (broadcast) {
      broadcast({
        type: 'cluster_creation_started',
        status: 'error',
        message: `Failed to create EKS cluster: ${error.message}`,
        clusterTag: req.body.clusterTag
      });
    }

    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/cluster/creating-clusters
 * 获取正在创建的集群列表
 */
router.get('/creating-clusters', async (req, res) => {
  try {
    const creatingClustersPath = path.join(__dirname, '../managed_clusters_info/creating-clusters.json');

    if (!fs.existsSync(creatingClustersPath)) {
      return res.json({ success: true, clusters: {} });
    }

    const creatingClusters = JSON.parse(fs.readFileSync(creatingClustersPath, 'utf8'));

    // 检查状态并处理完成的集群
    for (const [clusterTag, clusterInfo] of Object.entries(creatingClusters)) {
      if (clusterInfo.type === 'eks' && clusterInfo.stackName) {
        try {
          const stackStatus = await CloudFormationManager.getStackStatus(clusterInfo.stackName, clusterInfo.region);
          clusterInfo.currentStackStatus = stackStatus.stackStatus;

          // 如果 EKS 集群创建完成，注册基础集群（不自动配置依赖）
          if (stackStatus.stackStatus === 'CREATE_COMPLETE' &&
              clusterInfo.currentStackStatus !== 'COMPLETED') {
            console.log(`EKS cluster ${clusterTag} creation completed, registering basic cluster...`);

            // 注册基础集群（dependencies.configured = false）
            await registerCompletedCluster(clusterTag, 'active');

            // 清理 creating 状态
            updateCreatingClustersStatus(clusterTag, 'COMPLETED');

            // 广播集群创建完成
            if (broadcast) {
              broadcast({
                type: 'cluster_creation_completed',
                status: 'success',
                message: `EKS cluster ${clusterTag} created successfully. Configure dependencies in Cluster Information.`,
                clusterTag: clusterTag
              });
            }

          } else if (stackStatus.stackStatus.includes('FAILED') || stackStatus.stackStatus.includes('ROLLBACK')) {
            // 创建失败，清理状态
            console.log(`EKS cluster ${clusterTag} creation failed, cleaning up...`);
            updateCreatingClustersStatus(clusterTag, 'COMPLETED');
          }

        } catch (error) {
          console.error(`Error checking status for cluster ${clusterTag}:`, error);
          clusterInfo.currentStackStatus = 'UNKNOWN';

          // 如果 stack 不存在，清理状态
          if (error.message && error.message.includes('does not exist')) {
            console.log(`Stack for ${clusterTag} does not exist, cleaning up...`);
            updateCreatingClustersStatus(clusterTag, 'COMPLETED');
          }
        }
      }
    }

    // 重读磁盘拿权威状态（本次循环的 delete 和其它触发源的写入都已落盘）
    const finalState = fs.existsSync(creatingClustersPath)
      ? JSON.parse(fs.readFileSync(creatingClustersPath, 'utf8'))
      : {};

    // currentStackStatus 只在本次循环的内存里采集，不持久化——合并回响应
    for (const [tag, info] of Object.entries(finalState)) {
      if (creatingClusters[tag]?.currentStackStatus) {
        info.currentStackStatus = creatingClusters[tag].currentStackStatus;
      }
    }

    res.json({ success: true, clusters: finalState });
  } catch (error) {
    console.error('Error getting creating clusters:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/cluster/configure-dependencies
 * 独立依赖配置 API - 针对当前 active 集群
 */
router.post('/configure-dependencies', async (req, res) => {
  try {
    // 获取当前 active 集群
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({ error: 'No active cluster selected' });
    }

    // 检查集群是否存在
    const clusterInfo = await getClusterInfo(activeCluster);
    if (!clusterInfo) {
      return res.status(400).json({ error: 'Active cluster not found' });
    }

    // 检查是否已配置或正在配置中
    if (clusterInfo.dependencies?.configured) {
      return res.status(400).json({ error: 'Dependencies already configured' });
    }

    if (clusterInfo.dependencies?.status === 'configuring') {
      return res.status(400).json({ error: 'Dependencies configuration already in progress' });
    }

    // 更新状态为配置中
    await updateDependencyStatus(activeCluster, 'configuring');

    // 异步执行配置
    process.nextTick(() => {
      configureDependenciesForActiveCluster(activeCluster).catch(error => {
        console.error(`Dependency configuration failed for ${activeCluster}:`, error);
        updateDependencyStatus(activeCluster, 'failed', { error: error.message });
      });
    });

    res.json({
      success: true,
      message: `Dependency configuration started for cluster: ${activeCluster}`,
      clusterTag: activeCluster
    });

  } catch (error) {
    console.error('Error starting dependency configuration:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/cluster/:clusterTag/dependencies/status
 * 获取依赖配置状态
 */
router.get('/:clusterTag/dependencies/status', async (req, res) => {
  try {
    const { clusterTag } = req.params;
    const clusterInfo = await getClusterInfo(clusterTag);

    if (!clusterInfo) {
      return res.status(404).json({ error: 'Cluster not found' });
    }

    res.json({
      success: true,
      clusterTag: clusterTag,
      dependencies: clusterInfo.dependencies || {
        configured: false,
        status: 'pending',
        components: {}
      }
    });

  } catch (error) {
    console.error('Error getting dependency status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/cluster/cancel-creation/:clusterTag
 * 取消集群创建
 */
router.post('/cancel-creation/:clusterTag', async (req, res) => {
  try {
    const { clusterTag } = req.params;

    // 1. 获取创建状态信息
    const creatingClustersPath = path.join(__dirname, '../managed_clusters_info/creating-clusters.json');
    if (!fs.existsSync(creatingClustersPath)) {
      return res.status(404).json({ error: 'No creating clusters found' });
    }

    const creatingClusters = JSON.parse(fs.readFileSync(creatingClustersPath, 'utf8'));
    const clusterInfo = creatingClusters[clusterTag];

    if (!clusterInfo) {
      return res.status(404).json({ error: 'Cluster creation not found' });
    }

    console.log(`Canceling creation for cluster: ${clusterTag}`);

    // 2. 删除 CloudFormation Stack（异步触发）
    if (clusterInfo.stackName && clusterInfo.region) {
      process.nextTick(() => {
        try {
          const deleteCmd = `aws cloudformation delete-stack --stack-name ${clusterInfo.stackName} --region ${clusterInfo.region}`;
          execSync(deleteCmd, { stdio: 'inherit' });
          console.log(`CloudFormation stack deletion triggered: ${clusterInfo.stackName}`);

          // 广播删除开始
          if (broadcast) {
            broadcast({
              type: 'cluster_creation_cancelled',
              status: 'info',
              message: `CloudFormation stack deletion started: ${clusterInfo.stackName}`,
              clusterTag: clusterTag
            });
          }
        } catch (error) {
          console.error(`Failed to delete CloudFormation stack: ${error.message}`);
          if (broadcast) {
            broadcast({
              type: 'cluster_creation_cancel_failed',
              status: 'error',
              message: `Failed to delete CloudFormation stack: ${error.message}`,
              clusterTag: clusterTag
            });
          }
        }
      });
    }

    // 3. 清理 metadata
    cleanupCreatingMetadata(clusterTag);

    res.json({
      success: true,
      message: `Cluster creation cancelled: ${clusterTag}`,
      clusterTag: clusterTag
    });

  } catch (error) {
    console.error('Error canceling cluster creation:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/cluster/dependency-status/:clusterTag
 * 检查集群依赖配置状态
 */
router.get('/dependency-status/:clusterTag', async (req, res) => {
  try {
    const { clusterTag } = req.params;

    const clusterDir = clusterManager.getClusterDir(clusterTag);
    const configDir = path.join(clusterDir, 'config');

    if (!fs.existsSync(configDir)) {
      return res.status(404).json({ error: 'Cluster not found' });
    }

    const status = await ClusterDependencyManager.checkDependencyStatus(configDir);

    res.json({
      success: true,
      clusterTag,
      dependencyStatus: status
    });

  } catch (error) {
    console.error('Error checking dependency status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/cluster/reconfigure-dependencies/:clusterTag
 * 手动重新配置集群依赖（用于调试）
 */
router.post('/reconfigure-dependencies/:clusterTag', async (req, res) => {
  try {
    const { clusterTag } = req.params;

    console.log(`Manual reconfiguration requested for cluster: ${clusterTag}`);

    // 先清理现有配置
    const clusterDir = clusterManager.getClusterDir(clusterTag);
    const configDir = path.join(clusterDir, 'config');

    await ClusterDependencyManager.cleanupDependencies(configDir);

    // 重新配置
    await ClusterDependencyManager.configureClusterDependencies(clusterTag, clusterManager);

    res.json({
      success: true,
      message: `Successfully reconfigured dependencies for cluster: ${clusterTag}`
    });

  } catch (error) {
    console.error('Error reconfiguring dependencies:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/cluster/creation-status/:clusterTag
 * 获取集群创建状态
 */
router.get('/creation-status/:clusterTag', async (req, res) => {
  try {
    const { clusterTag } = req.params;

    // 读取创建 metadata 获取 region 和 stack 信息
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const creationStatusPath = path.join(metadataDir, 'creation_status.json');

    if (!fs.existsSync(creationStatusPath)) {
      return res.status(404).json({ error: 'Creation status not found' });
    }

    const creationStatus = JSON.parse(fs.readFileSync(creationStatusPath, 'utf8'));
    const stackName = creationStatus.stackName;
    const region = creationStatus.region;

    if (!stackName || !region) {
      return res.status(400).json({ error: 'Missing stack name or region in metadata' });
    }

    const stackStatus = await CloudFormationManager.getStackStatus(stackName, region);

    res.json({
      success: true,
      clusterTag,
      stackName,
      region,
      ...stackStatus
    });
  } catch (error) {
    console.error('Error getting cluster creation status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/cluster/creation-logs/:clusterTag
 * 获取集群创建日志
 */
router.get('/creation-logs/:clusterTag', async (req, res) => {
  try {
    const { clusterTag } = req.params;

    // 读取集群配置
    const clusterInfo = await clusterManager.getClusterInfo(clusterTag);
    if (!clusterInfo) {
      return res.status(404).json({ error: 'Cluster not found' });
    }

    const stackName = clusterInfo?.cloudFormation?.stackName;
    if (!stackName) {
      return res.status(400).json({ error: 'CloudFormation stack name not found in cluster metadata' });
    }
    const events = await CloudFormationManager.getStackEvents(stackName, clusterInfo.awsRegion);

    res.json({
      success: true,
      clusterTag,
      stackName,
      events
    });
  } catch (error) {
    console.error('Error getting cluster creation logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== 导出 ====================

module.exports = {
  router,
  initialize,
  // 导出辅助函数供其他模块使用
  updateCreatingClustersStatus,
  registerCompletedCluster,
  configureClusterDependencies,
  getClusterInfo,
  updateDependencyStatus
};
