const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { getCurrentAccountId, getCurrentRegion } = require('./awsHelpers');
const MetadataUtils = require('./metadataUtils');

/**
 * HyperPod Karpenter 安装管理器
 */
class HyperPodKarpenterInstaller {
  
  /**
   * 安装 HyperPod Karpenter
   */
  static async installHyperPodKarpenter(clusterTag, hyperPodClusterName) {
    const logFile = path.join('/app/managed_clusters_info', clusterTag, 'logs', 'hyperpod-karpenter-install.log');
    
    try {
      // 确保日志目录存在
      await fs.ensureDir(path.dirname(logFile));
      
      // 写入日志头
      const timestamp = new Date().toISOString();
      await fs.appendFile(logFile, `\n=== HyperPod Karpenter Installation Started at ${timestamp} ===\n`);
      await fs.appendFile(logFile, `Cluster Tag: ${clusterTag}\n`);
      await fs.appendFile(logFile, `HyperPod Cluster: ${hyperPodClusterName}\n\n`);
      
      // 检查是否已安装
      const existingStatus = await this.getInstallationStatus(clusterTag);
      if (existingStatus.installed) {
        await fs.appendFile(logFile, `Already installed, skipping...\n`);
        return {
          success: true,
          message: 'HyperPod Karpenter already installed',
          roleName: existingStatus.roleName,
          roleArn: existingStatus.roleArn,
          alreadyInstalled: true
        };
      }
      
      // 获取 AWS 信息
      const region = getCurrentRegion();
      const accountId = getCurrentAccountId();
      
      await fs.appendFile(logFile, `Region: ${region}\n`);
      await fs.appendFile(logFile, `Account ID: ${accountId}\n\n`);
      
      // 1. 创建 IAM Role
      const roleName = `hyperpod-karpenter-role-${clusterTag}`;
      await fs.appendFile(logFile, `Step 1: Creating IAM Role: ${roleName}\n`);
      
      const trustPolicy = {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "hyperpod.sagemaker.amazonaws.com" },
          Action: "sts:AssumeRole"
        }]
      };
      
      const createRoleCmd = `aws iam create-role --role-name "${roleName}" --assume-role-policy-document '${JSON.stringify(trustPolicy)}' --region ${region}`;
      
      try {
        const roleOutput = execSync(createRoleCmd, { encoding: 'utf8' });
        await fs.appendFile(logFile, `Role created successfully\n${roleOutput}\n\n`);
      } catch (error) {
        if (error.message.includes('EntityAlreadyExists')) {
          await fs.appendFile(logFile, `Role already exists, continuing...\n\n`);
        } else {
          throw error;
        }
      }
      
      // 2. 创建 Managed Policy 并 Attach
      await fs.appendFile(logFile, `Step 2: Creating and attaching managed policy\n`);
      
      const policyName = `SageMakerHyperPodKarpenterPolicy-${clusterTag}`;
      const policyDocument = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "sagemaker:BatchAddClusterNodes",
              "sagemaker:BatchDeleteClusterNodes"
            ],
            Resource: "arn:aws:sagemaker:*:*:cluster/*",
            Condition: {
              StringEquals: {
                "aws:ResourceAccount": "${aws:PrincipalAccount}"
              }
            }
          },
          {
            Effect: "Allow",
            Action: [
              "kms:CreateGrant",
              "kms:DescribeKey"
            ],
            Resource: "arn:aws:kms:*:*:key/*",
            Condition: {
              StringLike: {
                "kms:ViaService": "sagemaker.*.amazonaws.com"
              },
              Bool: {
                "kms:GrantIsForAWSResource": "true"
              },
              "ForAllValues:StringEquals": {
                "kms:GrantOperations": [
                  "CreateGrant",
                  "Decrypt",
                  "DescribeKey",
                  "GenerateDataKeyWithoutPlaintext",
                  "ReEncryptTo",
                  "ReEncryptFrom",
                  "RetireGrant"
                ]
              }
            }
          }
        ]
      };
      
      let policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;
      try {
        const createPolicyCmd = `aws iam create-policy --policy-name "${policyName}" --policy-document '${JSON.stringify(policyDocument)}'`;
        const policyOutput = execSync(createPolicyCmd, { encoding: 'utf8' });
        policyArn = JSON.parse(policyOutput).Policy.Arn;
        await fs.appendFile(logFile, `Policy created: ${policyArn}\n`);
      } catch (error) {
        if (error.message.includes('EntityAlreadyExists')) {
          await fs.appendFile(logFile, `Policy already exists, continuing...\n`);
        } else {
          throw error;
        }
      }
      
      try {
        const attachPolicyCmd = `aws iam attach-role-policy --role-name "${roleName}" --policy-arn "${policyArn}"`;
        execSync(attachPolicyCmd, { encoding: 'utf8' });
        await fs.appendFile(logFile, `Policy attached to role successfully\n\n`);
      } catch (error) {
        await fs.appendFile(logFile, `Policy attach: ${error.message} (may already be attached)\n\n`);
      }
      
      // 等待 IAM 资源传播（最终一致性）
      await fs.appendFile(logFile, `Waiting 20 seconds for IAM resources to propagate...\n`);
      await new Promise(resolve => setTimeout(resolve, 20000));
      await fs.appendFile(logFile, `Wait completed\n\n`);
      
      // 3. Update Cluster
      const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
      await fs.appendFile(logFile, `Step 3: Updating HyperPod cluster with Karpenter\n`);
      await fs.appendFile(logFile, `Role ARN: ${roleArn}\n`);
      
      const updateClusterCmd = `aws sagemaker update-cluster --cluster-name "${hyperPodClusterName}" --auto-scaling Mode=Enable,AutoScalerType=Karpenter --cluster-role "${roleArn}" --node-recovery Automatic --region ${region}`;
      
      try {
        const updateOutput = execSync(updateClusterCmd, { encoding: 'utf8' });
        await fs.appendFile(logFile, `Cluster updated successfully\n${updateOutput}\n\n`);
      } catch (error) {
        // 记录完整的错误信息
        await fs.appendFile(logFile, `Update cluster error: ${error.message}\n`);
        await fs.appendFile(logFile, `Error stderr: ${error.stderr || 'N/A'}\n`);
        await fs.appendFile(logFile, `Error stdout: ${error.stdout || 'N/A'}\n\n`);
        
        // 只有明确的"no changes"才跳过，其他错误都抛出
        if (error.message.includes('no changes')) {
          await fs.appendFile(logFile, `No changes needed, cluster already configured\n\n`);
        } else {
          throw error;
        }
      }
      
      // 4. 更新 metadata
      await this.updateMetadata(clusterTag, {
        installed: true,
        roleName: roleName,
        roleArn: roleArn,
        installationDate: new Date().toISOString()
      });
      
      await fs.appendFile(logFile, `=== Installation completed successfully ===\n`);
      
      return {
        success: true,
        message: 'HyperPod Karpenter installed successfully',
        roleName: roleName,
        roleArn: roleArn
      };
      
    } catch (error) {
      await fs.appendFile(logFile, `\n!!! Installation failed: ${error.message} !!!\n`);
      await fs.appendFile(logFile, `Stack trace: ${error.stack}\n`);
      throw error;
    }
  }
  
  /**
   * 更新集群 metadata
   */
  static async updateMetadata(clusterTag, karpenterInfo) {
    const metadataFile = path.join('/app/managed_clusters_info', clusterTag, 'metadata', 'cluster_info.json');
    
    try {
      const metadata = await fs.readJson(metadataFile);
      
      // 添加 hyperpodKarpenter 字段
      metadata.hyperpodKarpenter = karpenterInfo;
      metadata.lastModified = new Date().toISOString();
      
      await fs.writeJson(metadataFile, metadata, { spaces: 2 });
      
      console.log(`Updated metadata for cluster ${clusterTag}`);
    } catch (error) {
      console.error('Failed to update metadata:', error);
      throw error;
    }
  }
  
  /**
   * 检查 HyperPod Karpenter 安装状态
   */
  static async getInstallationStatus(clusterTag) {
    const metadataFile = path.join('/app/managed_clusters_info', clusterTag, 'metadata', 'cluster_info.json');
    
    try {
      const metadata = await fs.readJson(metadataFile);
      return metadata.hyperpodKarpenter || { installed: false };
    } catch (error) {
      return { installed: false };
    }
  }
}

module.exports = HyperPodKarpenterInstaller;
