const { execSync } = require('./exec');
const { execAsync: exec } = require('./exec');
const fs = require('fs-extra');
const path = require('path');
const YAML = require('yaml');

/**
 * Managed Scaling Manager
 * 管理单个推理 Deployment 的 KEDA ScaledObject 配置
 */
class ManagedScalingManager {
  
  /**
   * 生成 ScaledObject YAML
   */
  static generateScaledObjectYAML(config) {
    const {
      deploymentName,
      minReplicaCount = 1,
      maxReplicaCount = 5,
      pollingInterval = 30,
      cooldownPeriod = 120,
      scaleDownStabilizationTime = 60,
      scaleUpStabilizationTime = 0,
      promServerAddress,
      promQuery,
      promTargetValue = 5,
      promActivationTargetValue = 2
    } = config;

    const scaledObjectName = `${deploymentName}-scaleobj`;

    const scaledobject = {
      apiVersion: 'keda.sh/v1alpha1',
      kind: 'ScaledObject',
      metadata: {
        name: scaledObjectName,
        namespace: 'default'
      },
      spec: {
        scaleTargetRef: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          name: deploymentName
        },
        minReplicaCount: parseInt(minReplicaCount),
        maxReplicaCount: parseInt(maxReplicaCount),
        pollingInterval: parseInt(pollingInterval),
        cooldownPeriod: parseInt(cooldownPeriod),
        advanced: {
          horizontalPodAutoscalerConfig: {
            behavior: {
              scaleDown: {
                stabilizationWindowSeconds: parseInt(scaleDownStabilizationTime)
              },
              scaleUp: {
                stabilizationWindowSeconds: parseInt(scaleUpStabilizationTime)
              }
            }
          }
        },
        triggers: [
          {
            type: 'prometheus',
            metadata: {
              serverAddress: promServerAddress,
              query: promQuery,
              threshold: promTargetValue.toString(),
              activationThreshold: promActivationTargetValue.toString(),
              identityOwner: 'operator'
            }
          }
        ]
      }
    };

    return YAML.stringify(scaledobject);
  }

  /**
   * 预览 ScaledObject YAML
   */
  static async previewScaledObject(config) {
    try {
      const yaml = this.generateScaledObjectYAML(config);
      return { success: true, yaml };
    } catch (error) {
      console.error('Error generating ScaledObject preview:', error);
      throw error;
    }
  }

  /**
   * 部署 ScaledObject
   */
  static async deployScaledObject(config) {
    try {
      const yaml = this.generateScaledObjectYAML(config);
      
      const tmpDir = path.join(__dirname, '../../tmp');
      fs.ensureDirSync(tmpDir);
      
      const timestamp = Date.now();
      const yamlPath = path.join(tmpDir, `scaledobject-${timestamp}.yaml`);
      fs.writeFileSync(yamlPath, yaml);
      
      const { stdout, stderr } = await exec(`kubectl apply -f ${yamlPath}`);
      
      // 保存到 deployments/inference/ 目录
      const deploymentsDir = path.join(__dirname, '../../deployments/inference');
      fs.ensureDirSync(deploymentsDir);
      const savedYamlPath = path.join(deploymentsDir, `scaledobject-${timestamp}.yaml`);
      fs.copyFileSync(yamlPath, savedYamlPath);
      
      fs.unlinkSync(yamlPath);
      
      return {
        success: true,
        message: 'KEDA ScaledObject deployed successfully',
        output: stdout,
        savedPath: savedYamlPath
      };
    } catch (error) {
      console.error('Error deploying ScaledObject:', error);
      throw error;
    }
  }

  /**
   * 删除 ScaledObject
   */
  static async deleteScaledObject(name, namespace = 'default') {
    try {
      const deleteCommand = `kubectl delete scaledobject ${name} -n ${namespace}`;
      const result = execSync(deleteCommand, { encoding: 'utf8' });

      return {
        success: true,
        message: `ScaledObject ${name} deleted successfully`,
        kubectlOutput: result
      };
    } catch (error) {
      console.error('Error deleting ScaledObject:', error);
      return {
        success: false,
        error: error.message,
        message: `Failed to delete ScaledObject ${name}`
      };
    }
  }
}

module.exports = ManagedScalingManager;
