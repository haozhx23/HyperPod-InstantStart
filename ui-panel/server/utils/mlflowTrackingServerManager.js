const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { getCurrentAccountId } = require('./awsHelpers');
const { getEffectiveRegion } = require('./regionResolver');

class MLflowTrackingServerManager {
  constructor() {
    this.managedClustersPath = path.join(__dirname, '../../managed_clusters_info');
  }

  // 获取活跃集群信息
  getActiveCluster() {
    const activeClusterPath = path.join(this.managedClustersPath, 'active_cluster.json');
    if (!fs.existsSync(activeClusterPath)) {
      throw new Error('No active cluster found');
    }
    
    const activeClusterInfo = fs.readJsonSync(activeClusterPath);
    const activeCluster = activeClusterInfo.activeCluster;
    
    if (!activeCluster) {
      throw new Error('No active cluster selected');
    }
    
    return activeCluster;
  }

  // 获取环境变量 (保留用于其他特定用途)
  async getEnvVar(varName, activeCluster = null) {
    if (!activeCluster) {
      activeCluster = this.getActiveCluster();
    }
    
    const clusterEnvsPath = path.join(this.managedClustersPath, activeCluster, 'config/cluster_envs');
    const cmd = `source ${clusterEnvsPath} && echo $${varName}`;
    
    try {
      const result = execSync(cmd, { shell: '/bin/bash', encoding: 'utf8' });
      return result.trim();
    } catch (error) {
      console.warn(`Failed to get environment variable ${varName}:`, error.message);
      return null;
    }
  }

  // 创建MLflow tracking server
  async createTrackingServer(serverName, serverSize = 'Small') {
    try {
      console.log(`Creating MLflow tracking server: ${serverName}`);
      
      // 获取所有必需参数 - 运维路径:优先活跃集群 region,主机兜底
      const region = getEffectiveRegion();
      const s3Bucket = getCurrentS3Bucket();
      const iamRoleArn = await getDevAdminRoleArn();
      
      console.log(`Parameters: Region=${region}, S3Bucket=${s3Bucket}, IAMRole=${iamRoleArn}`);
      
      // 构建AWS CLI命令
      const cmd = `aws sagemaker create-mlflow-tracking-server \
        --tracking-server-name ${serverName} \
        --artifact-store-uri "s3://${s3Bucket}" \
        --tracking-server-size "${serverSize}" \
        --mlflow-version "3.0" \
        --role-arn ${iamRoleArn} \
        --region ${region}`;
      
      console.log('Executing command:', cmd);
      
      // 执行命令
      const result = execSync(cmd, { encoding: 'utf8' });
      
      console.log('MLflow tracking server created successfully');
      console.log('Result:', result);
      
      // 解析返回结果
      const serverInfo = JSON.parse(result);
      
      // 保存服务器信息到集群配置
      await this.saveTrackingServerInfo(serverInfo, {
        serverName,
        serverSize,
        region,
        s3Bucket,
        iamRoleArn
      });
      
      return {
        success: true,
        message: `MLflow tracking server "${serverName}" created successfully`,
        serverInfo: serverInfo
      };
      
    } catch (error) {
      console.error('Error creating MLflow tracking server:', error);
      throw new Error(`Failed to create MLflow tracking server: ${error.message}`);
    }
  }

  // 保存tracking server信息到集群配置
  async saveTrackingServerInfo(serverInfo, additionalInfo) {
    try {
      const activeCluster = this.getActiveCluster();
      const configDir = path.join(this.managedClustersPath, activeCluster, 'config');
      
      // 确保配置目录存在
      await fs.ensureDir(configDir);
      
      // 保存完整的服务器信息
      const trackingServerInfoPath = path.join(configDir, 'mlflow-server-info.json');
      const completeInfo = {
        ...serverInfo,
        ...additionalInfo,
        createdAt: new Date().toISOString(),
        clusterTag: activeCluster
      };
      
      await fs.writeJson(trackingServerInfoPath, completeInfo, { spaces: 2 });
      
      console.log(`MLflow server info saved to: ${trackingServerInfoPath}`);
      
    } catch (error) {
      console.error('Error saving tracking server info:', error);
      // 不抛出错误，因为服务器已经创建成功
    }
  }

  // 获取tracking server状态
  async getTrackingServerStatus(serverName, region = null) {
    try {
      if (!region) {
        region = getEffectiveRegion();
      }
      
      const cmd = `aws sagemaker describe-mlflow-tracking-server --tracking-server-name ${serverName} --region ${region}`;
      const result = execSync(cmd, { encoding: 'utf8' });
      
      return JSON.parse(result);
      
    } catch (error) {
      if (error.message.includes('does not exist')) {
        return null;
      }
      throw new Error(`Failed to get tracking server status: ${error.message}`);
    }
  }

  // 列出所有tracking servers
  async listTrackingServers(region = null) {
    try {
      if (!region) {
        region = getEffectiveRegion();
      }
      
      const cmd = `aws sagemaker list-mlflow-tracking-servers --region ${region}`;
      const result = execSync(cmd, { encoding: 'utf8' });
      
      return JSON.parse(result);
      
    } catch (error) {
      throw new Error(`Failed to list tracking servers: ${error.message}`);
    }
  }

  // 删除tracking server
  async deleteTrackingServer(serverName, region = null) {
    try {
      if (!region) {
        region = getEffectiveRegion();
      }
      
      const cmd = `aws sagemaker delete-mlflow-tracking-server --tracking-server-name ${serverName} --region ${region}`;
      const result = execSync(cmd, { encoding: 'utf8' });
      
      // 删除本地保存的服务器信息
      await this.removeTrackingServerInfo();
      
      return {
        success: true,
        message: `MLflow tracking server "${serverName}" deleted successfully`
      };
      
    } catch (error) {
      throw new Error(`Failed to delete tracking server: ${error.message}`);
    }
  }

  // 删除本地保存的tracking server信息
  async removeTrackingServerInfo() {
    try {
      const activeCluster = this.getActiveCluster();
      const trackingServerInfoPath = path.join(this.managedClustersPath, activeCluster, 'config', 'mlflow-server-info.json');
      
      if (await fs.pathExists(trackingServerInfoPath)) {
        await fs.remove(trackingServerInfoPath);
        console.log('Local MLflow server info removed');
      }
      
    } catch (error) {
      console.error('Error removing local tracking server info:', error);
      // 不抛出错误
    }
  }

  // 配置MLflow认证
  async configureAuthentication() {
    try {
      console.log('Configuring MLflow authentication...');
      
      const activeCluster = this.getActiveCluster();
      const region = getEffectiveRegion(activeCluster);
      const accountId = getCurrentAccountId();
      const eksClusterName = await this.getEnvVar('EKS_CLUSTER_NAME', activeCluster);
      const clusterTag = await this.getEnvVar('CLUSTER_TAG', activeCluster);
      
      if (!accountId || !eksClusterName || !clusterTag) {
        throw new Error('Missing required parameters');
      }
      
      console.log(`Parameters: Region=${region}, AccountId=${accountId}, EksCluster=${eksClusterName}, ClusterTag=${clusterTag}`);
      
      // 1. 创建service account
      await this.createServiceAccount();
      
      // 2. 获取OIDC信息
      const oidcInfo = await this.getOIDCInfo(eksClusterName, region);
      
      // 3. 创建IAM角色和策略
      await this.createIAMRoleAndPolicy(accountId, region, oidcInfo.oidcId, clusterTag);
      
      // 4. 绑定角色到service account
      await this.bindRoleToServiceAccount(accountId, clusterTag);
      
      console.log('MLflow authentication configured successfully');
      
      return {
        success: true,
        message: 'MLflow authentication configured successfully'
      };
      
    } catch (error) {
      console.error('Error configuring MLflow authentication:', error);
      throw new Error(`Failed to configure MLflow authentication: ${error.message}`);
    }
  }

  // 创建service account
  async createServiceAccount() {
    try {
      console.log('Creating service account...');
      execSync('kubectl create serviceaccount mlflow-service-account -n default', { encoding: 'utf8' });
      console.log('Service account created successfully');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('Service account already exists, skipping creation');
      } else {
        throw error;
      }
    }
  }

  // 获取OIDC信息
  async getOIDCInfo(eksClusterName, region) {
    console.log('Getting OIDC information...');
    
    const oidcIssuerCmd = `aws eks describe-cluster --name ${eksClusterName} --region ${region} --query 'cluster.identity.oidc.issuer' --output text`;
    const oidcIssuer = execSync(oidcIssuerCmd, { encoding: 'utf8' }).trim();
    const oidcId = oidcIssuer.split('/')[4];
    
    console.log(`OIDC Issuer: ${oidcIssuer}`);
    console.log(`OIDC ID: ${oidcId}`);
    
    return { oidcIssuer, oidcId };
  }

  // 创建IAM角色和策略
  async createIAMRoleAndPolicy(accountId, region, oidcId, clusterTag) {
    const roleName = `EKS-MLflow-ServiceAccount-Role-${clusterTag}`;
    const policyName = `EKS-MLflow-Policy-${clusterTag}`;
    
    // 创建信任策略
    const trustPolicy = {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Principal": {
            "Federated": `arn:aws:iam::${accountId}:oidc-provider/oidc.eks.${region}.amazonaws.com/id/${oidcId}`
          },
          "Action": "sts:AssumeRoleWithWebIdentity",
          "Condition": {
            "StringEquals": {
              [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:sub`]: "system:serviceaccount:default:mlflow-service-account",
              [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:aud`]: "sts.amazonaws.com"
            }
          }
        }
      ]
    };

    // 创建权限策略
    const permissionsPolicy = {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Action": [
            "sagemaker:CreateExperiment",
            "sagemaker:CreateTrial",
            "sagemaker:CreateTrialComponent",
            "sagemaker:UpdateExperiment",
            "sagemaker:UpdateTrial",
            "sagemaker:UpdateTrialComponent",
            "sagemaker:DescribeExperiment",
            "sagemaker:DescribeTrial",
            "sagemaker:DescribeTrialComponent",
            "sagemaker:ListExperiments",
            "sagemaker:ListTrials",
            "sagemaker:ListTrialComponents",
            "sagemaker:AddTags",
            "sagemaker:ListTags",
            "sagemaker:CallMlflowAppApi",
            "sagemaker-mlflow:*"
          ],
          "Resource": "*"
        },
        {
          "Effect": "Allow",
          "Action": [
            "s3:GetObject",
            "s3:PutObject",
            "s3:ListBucket"
          ],
          "Resource": ["*"]
        }
      ]
    };

    // 写入临时文件
    const trustPolicyPath = '/tmp/mlflow-trust-policy.json';
    const permissionsPolicyPath = '/tmp/mlflow-permissions-policy.json';
    
    await fs.writeJson(trustPolicyPath, trustPolicy);
    await fs.writeJson(permissionsPolicyPath, permissionsPolicy);

    try {
      // 创建IAM角色
      console.log(`Creating IAM role: ${roleName}`);
      try {
        execSync(`aws iam get-role --role-name ${roleName} --region ${region}`, { encoding: 'utf8' });
        console.log('Role already exists, skipping creation');
      } catch (error) {
        execSync(`aws iam create-role --role-name ${roleName} --assume-role-policy-document file://${trustPolicyPath} --region ${region}`, { encoding: 'utf8' });
        console.log('IAM role created');
      }

      // 创建IAM策略
      console.log(`Creating IAM policy: ${policyName}`);
      const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;
      try {
        execSync(`aws iam get-policy --policy-arn ${policyArn} --region ${region}`, { encoding: 'utf8' });
        console.log('Policy already exists, skipping creation');
      } catch (error) {
        execSync(`aws iam create-policy --policy-name ${policyName} --policy-document file://${permissionsPolicyPath} --region ${region}`, { encoding: 'utf8' });
        console.log('IAM policy created');
      }

      // 绑定策略到角色
      execSync(`aws iam attach-role-policy --role-name ${roleName} --policy-arn ${policyArn} --region ${region}`, { encoding: 'utf8' });
      console.log('Policy attached to role');

    } finally {
      // 清理临时文件
      await fs.remove(trustPolicyPath);
      await fs.remove(permissionsPolicyPath);
    }
  }

  // 绑定角色到service account
  async bindRoleToServiceAccount(accountId, clusterTag) {
    const roleName = `EKS-MLflow-ServiceAccount-Role-${clusterTag}`;
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    
    console.log('Binding role to service account...');
    
    const cmd = `kubectl annotate serviceaccount mlflow-service-account -n default eks.amazonaws.com/role-arn=${roleArn} --overwrite`;
    execSync(cmd, { encoding: 'utf8' });
    
    console.log('Role bound to service account successfully');
    
    // 验证配置
    const verifyCmd = 'kubectl get serviceaccount mlflow-service-account -n default -o yaml';
    const result = execSync(verifyCmd, { encoding: 'utf8' });
    console.log('Service account configuration verified');
  }

  // 验证服务器名称
  validateServerName(serverName) {
    if (!serverName) {
      throw new Error('Server name is required');
    }
    
    if (!/^[a-zA-Z0-9-]+$/.test(serverName)) {
      throw new Error('Server name can only contain alphanumeric characters and hyphens');
    }
    
    if (serverName.length > 63) {
      throw new Error('Server name cannot exceed 63 characters');
    }
    
    return true;
  }

  // 验证服务器大小
  validateServerSize(serverSize) {
    const validSizes = ['Small', 'Medium', 'Large'];
    if (!validSizes.includes(serverSize)) {
      throw new Error(`Invalid server size. Must be one of: ${validSizes.join(', ')}`);
    }
    
    return true;
  }
}

module.exports = MLflowTrackingServerManager;
