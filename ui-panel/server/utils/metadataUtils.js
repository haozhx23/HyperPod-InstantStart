const fs = require('fs');
const path = require('path');

/**
 * Metadata工具类 - 统一处理集群元数据的读取和转换
 */
class MetadataUtils {
  /**
   * 获取集群的metadata目录路径
   */
  static getMetadataDir(clusterTag) {
    return path.join(__dirname, '../../managed_clusters_info', clusterTag, 'metadata');
  }

  /**
   * 读取cluster_info.json
   */
  static getClusterInfo(clusterTag) {
    try {
      const clusterInfoPath = path.join(this.getMetadataDir(clusterTag), 'cluster_info.json');
      if (fs.existsSync(clusterInfoPath)) {
        return JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
      }
      return null;
    } catch (error) {
      console.error(`Error reading cluster_info.json for ${clusterTag}:`, error);
      return null;
    }
  }

  /**
   * 更新集群的 deps stack 信息（用于导入的 EKS 创建 HyperPod 时）
   */
  static async updateClusterDepsInfo(clusterTag, depsStackInfo) {
    try {
      const clusterInfo = this.getClusterInfo(clusterTag);
      if (!clusterInfo) {
        throw new Error(`Cluster info not found for: ${clusterTag}`);
      }

      // 更新 cloudFormation 信息
      clusterInfo.cloudFormation = clusterInfo.cloudFormation || {};
      clusterInfo.cloudFormation.depsStackName = depsStackInfo.stackName;
      clusterInfo.cloudFormation.depsStackId = depsStackInfo.stackId;
      clusterInfo.cloudFormation.outputs = clusterInfo.cloudFormation.outputs || {};
      clusterInfo.cloudFormation.outputs.OutputS3BucketName = depsStackInfo.outputs.S3BucketName;
      clusterInfo.cloudFormation.outputs.OutputSageMakerIAMRoleArn = depsStackInfo.outputs.SageMakerIAMRoleArn;

      // 更新 eksCluster 信息
      clusterInfo.eksCluster = clusterInfo.eksCluster || {};
      clusterInfo.eksCluster.s3BucketName = depsStackInfo.outputs.S3BucketName;
      clusterInfo.eksCluster.sageMakerRoleArn = depsStackInfo.outputs.SageMakerIAMRoleArn;

      clusterInfo.lastModified = new Date().toISOString();

      // 保存
      const clusterInfoPath = path.join(this.getMetadataDir(clusterTag), 'cluster_info.json');
      fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
      console.log(`Updated deps stack info for cluster: ${clusterTag}`);
      
      // ✅ 更新 cluster_envs 文件（添加依赖 Stack 输出）
      const EnvInjector = require('./envInjector');
      try {
        EnvInjector.updateClusterEnvFile(clusterTag);
        console.log(`✅ Updated cluster_envs with dependency stack outputs for ${clusterTag}`);
      } catch (error) {
        console.error(`Failed to update cluster_envs for ${clusterTag}:`, error);
      }
    } catch (error) {
      console.error(`Error updating deps info for ${clusterTag}:`, error);
      throw error;
    }
  }

  /**
   * 读取creation_metadata.json
   */
  static getCreationMetadata(clusterTag) {
    try {
      const metadataPath = path.join(this.getMetadataDir(clusterTag), 'creation_metadata.json');
      if (fs.existsSync(metadataPath)) {
        return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      }
      return null;
    } catch (error) {
      console.error(`Error reading creation_metadata.json for ${clusterTag}:`, error);
      return null;
    }
  }

  /**
   * 从metadata获取CloudFormation输出
   */
  static getCloudFormationOutputs(clusterTag) {
    const clusterInfo = this.getClusterInfo(clusterTag);
    if (clusterInfo && clusterInfo.cloudFormation && clusterInfo.cloudFormation.outputs) {
      return clusterInfo.cloudFormation.outputs;
    }

    const creationMetadata = this.getCreationMetadata(clusterTag);
    if (creationMetadata && creationMetadata.cloudFormation && creationMetadata.cloudFormation.outputs) {
      return creationMetadata.cloudFormation.outputs;
    }

    return {};
  }

  /**
   * 获取EKS集群基本信息
   */
  static getEKSClusterInfo(clusterTag) {
    const clusterInfo = this.getClusterInfo(clusterTag);
    if (clusterInfo?.eksCluster) {
      return clusterInfo.eksCluster;
    }

    // 从CloudFormation输出中提取
    const outputs = this.getCloudFormationOutputs(clusterTag);
    return {
      name: outputs.OutputEKSClusterName || null,
      arn: outputs.OutputEKSClusterArn || null,
      vpcId: outputs.OutputVpcId || null,
      securityGroupId: outputs.OutputSecurityGroupId || null,
      privateSubnetIds: outputs.OutputPrivateSubnetIds || null,
      s3BucketName: outputs.OutputS3BucketName || null,
      sageMakerRoleArn: outputs.OutputSageMakerIAMRoleArn || null
    };
  }

  /**
   * 获取集群类型（created/imported）
   */
  static getClusterType(clusterTag) {
    const clusterInfo = this.getClusterInfo(clusterTag);
    return clusterInfo?.type || 'unknown';
  }

  /**
   * 检查集群是否为创建的集群（非导入）
   */
  static isCreatedCluster(clusterTag) {
    return this.getClusterType(clusterTag) === 'created';
  }

  /**
   * 获取集群的AWS区域
   */
  static getClusterRegion(clusterTag) {
    const clusterInfo = this.getClusterInfo(clusterTag);
    return clusterInfo?.region || null;
  }

  /**
   * 获取实例类型缓存文件路径
   */
  static getInstanceTypesCachePath(clusterTag) {
    return path.join(this.getMetadataDir(clusterTag), 'instance_types_cache.json');
  }

  /**
   * 读取实例类型缓存
   */
  static getInstanceTypesCache(clusterTag) {
    try {
      const cachePath = this.getInstanceTypesCachePath(clusterTag);
      if (fs.existsSync(cachePath)) {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      }
      return null;
    } catch (error) {
      console.error(`Error reading instance types cache for ${clusterTag}:`, error);
      return null;
    }
  }

  /**
   * 保存实例类型缓存
   */
  static saveInstanceTypesCache(clusterTag, cacheData) {
    try {
      const cachePath = this.getInstanceTypesCachePath(clusterTag);

      // 确保metadata目录存在
      const metadataDir = this.getMetadataDir(clusterTag);
      if (!fs.existsSync(metadataDir)) {
        fs.mkdirSync(metadataDir, { recursive: true });
      }

      fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
      console.log(`Instance types cache saved for cluster: ${clusterTag}`);
      return true;
    } catch (error) {
      console.error(`Error saving instance types cache for ${clusterTag}:`, error);
      return false;
    }
  }

  /**
   * 获取子网实例类型缓存文件路径
   */
  static getSubnetInstanceTypesCachePath(clusterTag, subnetId) {
    return path.join(this.getMetadataDir(clusterTag), `subnet_instances_${subnetId}.json`);
  }

  /**
   * 保存子网特定的实例类型缓存
   */
  static saveSubnetInstanceTypesCache(clusterTag, subnetId, cacheData) {
    try {
      const cachePath = this.getSubnetInstanceTypesCachePath(clusterTag, subnetId);

      // 确保metadata目录存在
      const metadataDir = this.getMetadataDir(clusterTag);
      if (!fs.existsSync(metadataDir)) {
        fs.mkdirSync(metadataDir, { recursive: true });
      }

      fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
      console.log(`Subnet instance types cache saved for cluster: ${clusterTag}, subnet: ${subnetId}`);
      return true;
    } catch (error) {
      console.error(`Error saving subnet instance types cache for ${clusterTag}, subnet ${subnetId}:`, error);
      return false;
    }
  }

  /**
   * 读取子网特定的实例类型缓存
   */
  static getSubnetInstanceTypesCache(clusterTag, subnetId) {
    try {
      const cachePath = this.getSubnetInstanceTypesCachePath(clusterTag, subnetId);
      if (fs.existsSync(cachePath)) {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      }
      return null;
    } catch (error) {
      console.error(`Error reading subnet instance types cache for ${clusterTag}, subnet ${subnetId}:`, error);
      return null;
    }
  }

  /**
   * 通过AWS CLI获取导入集群的资源信息（包含HyperPod子网）
   */
  static async fetchImportedClusterResources(eksClusterName, awsRegion, hyperPodClusters = null) {
    const { execSync } = require('child_process');
    
    try {
      console.log(`Fetching resources for imported cluster: ${eksClusterName}`);
      
      // 获取EKS集群基本信息
      const clusterCmd = `aws eks describe-cluster --name ${eksClusterName} --region ${awsRegion} --output json`;
      const clusterResult = JSON.parse(execSync(clusterCmd, { encoding: 'utf8' }));
      const cluster = clusterResult.cluster;
      
      // 获取HyperPod计算节点信息（容错处理）
      let hyperPodClusterData = null;
      if (hyperPodClusters) {
        try {
          const hyperPodNames = hyperPodClusters.split(',').map(name => name.trim());
          // 只取第一个HyperPod集群（一个EKS只能有一个HyperPod）
          const hpClusterName = hyperPodNames[0];
          
          const hpCmd = `aws sagemaker describe-cluster --cluster-name ${hpClusterName} --region ${awsRegion} --output json`;
          const hpResult = execSync(hpCmd, { encoding: 'utf8' });
          hyperPodClusterData = JSON.parse(hpResult);
          
          // 添加来源标识
          hyperPodClusterData.source = 'imported';
          
          console.log(`Found imported HyperPod cluster: ${hpClusterName}`);
        } catch (error) {
          console.warn('Error fetching HyperPod cluster info (continuing import):', error.message);
        }
      }
      
      // 构建与创建集群格式对齐的资源信息
      // 导入的 EKS 没有 S3 和 SageMaker Role，这些在创建 HyperPod 时由 CF 创建
      // 安全组优先使用用户附加的安全组（securityGroupIds），而非 EKS 自动创建的集群安全组
      const additionalSecurityGroups = cluster.resourcesVpcConfig.securityGroupIds || [];
      const securityGroupId = additionalSecurityGroups.length > 0 
        ? additionalSecurityGroups[0] 
        : cluster.resourcesVpcConfig.clusterSecurityGroupId;
      
      const resources = {
        OutputVpcId: cluster.resourcesVpcConfig.vpcId,
        OutputEKSClusterName: cluster.name,
        OutputEKSClusterArn: cluster.arn,
        OutputSecurityGroupId: securityGroupId,
        OutputSageMakerIAMRoleArn: null,  // 导入时不推断，创建 HyperPod 时由 CF 创建
        OutputS3BucketName: null,          // 导入时不推断，创建 HyperPod 时由 CF 创建
        OutputPrivateSubnetIds: cluster.resourcesVpcConfig.subnetIds ? cluster.resourcesVpcConfig.subnetIds.join(',') : null
      };
      
      // 获取 VPC CIDR（用于后续创建 HyperPod 时生成子网 CIDR）
      let vpcCidr = null;
      try {
        const vpcCmd = `aws ec2 describe-vpcs --vpc-ids ${cluster.resourcesVpcConfig.vpcId} --region ${awsRegion} --query "Vpcs[0].CidrBlock" --output text`;
        vpcCidr = execSync(vpcCmd, { encoding: 'utf8' }).trim();
        console.log(`Fetched VPC CIDR: ${vpcCidr}`);
      } catch (error) {
        console.warn('Failed to fetch VPC CIDR:', error.message);
      }
      
      // 返回EKS资源信息和HyperPod集群数据
      const result = {
        cloudFormationOutputs: resources,
        hyperPodCluster: hyperPodClusterData,
        vpcCidr: vpcCidr
      };
      
      console.log('Fetched imported cluster resources:', Object.keys(result.cloudFormationOutputs));
      if (result.hyperPodCluster) {
        console.log('Fetched HyperPod cluster:', result.hyperPodCluster.ClusterName);
      }
      return result;
      
    } catch (error) {
      console.error('Error fetching imported cluster resources:', error);
      throw new Error(`Failed to fetch cluster resources: ${error.message}`);
    }
  }

  /**
   * 为导入集群保存资源信息到metadata（与创建集群格式对齐）
   * @param {string} clusterTag
   * @param {string} eksClusterName
   * @param {string} awsRegion
   * @param {string} hyperPodClusters - 用户指定的 HyperPod 集群名
   * @param {Object} depsStackInfo - eks-hp-deps stack 输出（没有 HyperPod 时必须提供）
   * @param {string} userSecurityGroup - 用户指定的 Compute Security Group（可选）
   */
  static async saveImportedClusterResources(clusterTag, eksClusterName, awsRegion, hyperPodClusters = null, depsStackInfo = null, userSecurityGroup = null) {
    try {
      // 获取资源信息（包含HyperPod集群数据和VPC CIDR）
      const resourceData = await this.fetchImportedClusterResources(eksClusterName, awsRegion, hyperPodClusters);
      const resources = resourceData.cloudFormationOutputs;
      const hyperPodCluster = resourceData.hyperPodCluster;
      const vpcCidr = resourceData.vpcCidr;

      // 如果用户指定了 Compute Security Group，使用用户指定的值覆盖自动检测的值
      if (userSecurityGroup && userSecurityGroup.trim()) {
        console.log(`Using user-specified Compute Security Group: ${userSecurityGroup}`);
        resources.OutputSecurityGroupId = userSecurityGroup.trim();
      }

      const hasHyperPod = hyperPodClusters && hyperPodClusters.trim();
      
      if (hasHyperPod && hyperPodCluster) {
        // 有 HyperPod：从 HyperPod 集群获取 S3 和 Role
        const hpVpcConfig = hyperPodCluster.VpcConfig || {};
        // HyperPod 的 ExecutionRole 在 InstanceGroups 中
        const executionRole = hyperPodCluster.InstanceGroups?.[0]?.ExecutionRole;
        if (executionRole) {
          resources.OutputSageMakerIAMRoleArn = executionRole;
        }
        console.log(`Using HyperPod cluster info: Role=${executionRole}`);
      } else if (depsStackInfo && depsStackInfo.outputs) {
        // 从 deps stack 获取 S3 和 Role
        resources.OutputS3BucketName = depsStackInfo.outputs.S3BucketName;
        resources.OutputSageMakerIAMRoleArn = depsStackInfo.outputs.SageMakerIAMRoleArn;
        console.log(`Using deps stack outputs: S3=${depsStackInfo.outputs.S3BucketName}, Role=${depsStackInfo.outputs.SageMakerIAMRoleName}`);
      }
      // 导入的裸 EKS：S3 和 Role 保持 null，创建 HyperPod 时再处理
      
      // 读取现有的cluster_info.json
      const clusterInfo = this.getClusterInfo(clusterTag);
      if (!clusterInfo) {
        throw new Error(`Cluster info not found for: ${clusterTag}`);
      }
      
      // 添加CloudFormation输出格式的资源信息
      clusterInfo.cloudFormation = {
        stackName: depsStackInfo ? depsStackInfo.stackName : null,
        stackId: depsStackInfo ? depsStackInfo.stackId : null,
        outputs: resources
      };
      
      // 添加结构化的EKS集群信息
      clusterInfo.eksCluster = {
        name: resources.OutputEKSClusterName,
        arn: resources.OutputEKSClusterArn,
        vpcId: resources.OutputVpcId,
        securityGroupId: resources.OutputSecurityGroupId,
        privateSubnetIds: resources.OutputPrivateSubnetIds,
        s3BucketName: resources.OutputS3BucketName,
        sageMakerRoleArn: resources.OutputSageMakerIAMRoleArn
      };
      
      // 如果有HyperPod集群，保存完整的集群数据
      if (hyperPodCluster) {
        clusterInfo.hyperPodCluster = hyperPodCluster;
        console.log(`Saved complete HyperPod cluster data for ${clusterTag} (imported)`);
      }
      
      clusterInfo.lastModified = new Date().toISOString();
      
      // 保存更新后的cluster_info.json
      const fs = require('fs');
      const clusterInfoPath = path.join(this.getMetadataDir(clusterTag), 'cluster_info.json');
      fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
      
      // 基于 VPC CIDR 生成并保存 cidr_configuration.json（用于后续创建 HyperPod）
      // 只有没有 HyperPod 时才预生成（已有 HyperPod 的集群不需要再创建 compute subnet）
      if (vpcCidr && !hyperPodCluster) {
        // 导入的 EKS 保存基本 CIDR 信息
        const cidrConfig = {
          vpcCidr,
          generatedAt: new Date().toISOString(),
          region: awsRegion,
          autoGenerated: true,
          comment: 'Generated CIDR config for imported cluster'
        };
        const cidrConfigPath = path.join(this.getMetadataDir(clusterTag), 'cidr_configuration.json');
        fs.writeFileSync(cidrConfigPath, JSON.stringify(cidrConfig, null, 2));
        console.log(`Saved CIDR configuration for imported cluster: ${clusterTag}`);
      }
      
      console.log(`Saved imported cluster resources for: ${clusterTag}`);
      return resources;
      
    } catch (error) {
      console.error(`Error saving imported cluster resources for ${clusterTag}:`, error);
      throw error;
    }
  }
}

module.exports = MetadataUtils;
