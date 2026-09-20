const { execSync, exec } = require('./exec');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

class KedaManager {



  static async getKedaStatus() {
    try {
      // Check if KEDA operator is installed
      const kedaStatusCommand = 'kubectl get deployment keda-operator -n keda';
      const kedaStatus = execSync(kedaStatusCommand, { encoding: 'utf8' });

      // Get ScaledObjects
      const scaledObjectsCommand = 'kubectl get scaledobjects -o json';
      const scaledObjectsResult = execSync(scaledObjectsCommand, { encoding: 'utf8' });
      const scaledObjects = JSON.parse(scaledObjectsResult);

      return {
        success: true,
        kedaInstalled: true,
        kedaOperatorStatus: kedaStatus,
        scaledObjects: scaledObjects.items || []
      };

    } catch (error) {
      console.error('Error getting KEDA status:', error);
      return {
        success: false,
        kedaInstalled: false,
        error: error.message
      };
    }
  }

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

  static validateConfig(config) {
    const errors = [];

    if (!config.targetDeployment) {
      errors.push('Target deployment name is required');
    }

    if (config.minReplicaCount && config.maxReplicaCount &&
        config.minReplicaCount > config.maxReplicaCount) {
      errors.push('Minimum replica count cannot be greater than maximum replica count');
    }

    if (config.threshold && isNaN(parseFloat(config.threshold))) {
      errors.push('Threshold must be a valid number');
    }

    if (config.activationThreshold && isNaN(parseFloat(config.activationThreshold))) {
      errors.push('Activation threshold must be a valid number');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }



  /**
   * 生成统一扩缩容YAML（使用内嵌模板）
   * @param {Object} config - 配置对象
   * @returns {string} 完整的YAML内容
   */
  static generateUnifiedScalingYaml(config) {
    try {
      // S5：不再用「内嵌模板 + 一串 template.replace」生成 YAML。
      //
      // 旧实现有两个独立的问题：
      // 1. 任何带换行的值（serviceName / deploymentName）都能改写文档结构。同类问题
      //    在 Karpenter 与 eksctl 上都已实测可加出执行命令的字段，见 260920-refactor.md S9。
      // 2. trigger 的启用/禁用靠正则**删掉模板里的一段文本**，模板缩进变一个空格
      //    那个正则就静默失配——留下没被替换的 `${KedaTrig1ValueThreshold}$` 占位符。
      //    改成按需 push trigger 之后，这类失配在结构上不存在。
      const serviceName = config.serviceName;
      const deploymentName = config.deploymentName;
      const scrapeInterval = `${config.scrapeInterval}s`;

      // Prometheus 的配置是 ConfigMap 里的**嵌套 YAML 文档**（block scalar），
      // 所以先序列化成字符串，再作为 data 的值——由外层序列化器负责转义。
      const prometheusYml = {
        global: {
          scrape_interval: '1m',
          evaluation_interval: '1m',
        },
        scrape_configs: [
          {
            job_name: `${serviceName}-prom-job`,
            static_configs: [{
              targets: [`${serviceName}.default.svc.cluster.local:${config.routerMetricPort}`],
            }],
            scrape_interval: scrapeInterval,
            metrics_path: '/metrics',
          },
          {
            job_name: 'kube-state-metrics',
            static_configs: [{
              targets: ['prometheus-kube-state-metrics.monitoring.svc.cluster.local:8080'],
            }],
            scrape_interval: scrapeInterval,
          },
        ],
      };

      const configMap = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'prometheus-server', namespace: 'monitoring' },
        data: { 'prometheus.yml': YAML.stringify(prometheusYml) },
      };

      const PROM_SERVER = 'http://prometheus-server.monitoring.svc.cluster.local:80';
      const triggers = [];

      // Trigger 1：每 pod QPS（总 QPS 除以当前副本数）
      if (config.enabledTriggers?.includes('qps')) {
        const window = config.qpsWindow || '1m';
        triggers.push({
          type: 'prometheus',
          metadata: {
            serverAddress: PROM_SERVER,
            query: `(\n  rate(sgl_router_requests_total{job="${serviceName}-prom-job"}[${window}]) /\n`
              + `  scalar(kube_deployment_status_replicas{deployment="${deploymentName}"})\n)\n`,
            // KEDA 的 threshold 是字符串字段，旧模板用单引号保证这一点
            threshold: String(config.kedaTrig1ValueThreshold),
            activationThreshold: String(config.kedaTrig1ActThreshold),
          },
        });
      }

      // Trigger 2：队列深度
      if (config.enabledTriggers?.includes('queue')) {
        triggers.push({
          type: 'prometheus',
          metadata: {
            serverAddress: PROM_SERVER,
            query: `sgl_router_job_queue_depth{job="${serviceName}-prom-job"}`,
            threshold: String(config.kedaTrig2ValueThreshold),
            activationThreshold: String(config.kedaTrig2ActThreshold),
          },
        });
      }

      const scaledObject = {
        apiVersion: 'keda.sh/v1alpha1',
        kind: 'ScaledObject',
        metadata: { name: 'sglang-router-scaler', namespace: 'default' },
        spec: {
          scaleTargetRef: { name: deploymentName },
          // 这四个在 KEDA 里都是整数字段
          minReplicaCount: Number(config.minReplica),
          maxReplicaCount: Number(config.maxReplica),
          pollingInterval: Number(config.kedaPollInterval),
          cooldownPeriod: Number(config.kedaCoolDownPeriod),
          triggers,
        },
      };

      return [configMap, scaledObject].map(d => `---\n${YAML.stringify(d)}`).join('');

    } catch (error) {
      console.error('Error generating unified scaling YAML:', error);
      throw new Error(`Template processing failed: ${error.message}`);
    }
  }

  /**
   * 应用统一扩缩容配置
   * @param {Object} config - 配置对象
   * @returns {Object} 部署结果
   */
  static async applyUnifiedScalingConfiguration(config) {
    try {
      // 验证配置
      const validation = this.validateUnifiedConfig(config);
      if (!validation.valid) {
        return {
          success: false,
          error: 'Invalid configuration',
          errors: validation.errors
        };
      }

      const fullYaml = this.generateUnifiedScalingYaml(config);

      // 保存到 deployments/inference 目录，与其他推理组件保持一致
      const deploymentDir = path.join(__dirname, '../../deployments/inference');
      if (!fs.existsSync(deploymentDir)) {
        fs.mkdirSync(deploymentDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').slice(0, 14);
      const configFilePath = path.join(deploymentDir, `keda-scaling-${config.serviceName}-${timestamp}.yaml`);

      fs.writeFileSync(configFilePath, fullYaml);
      console.log(`Unified KEDA configuration saved to: ${configFilePath}`);

      // 应用到 Kubernetes
      const applyCommand = `kubectl apply -f ${configFilePath}`;
      const result = execSync(applyCommand, { encoding: 'utf8' });

      // 异步触发 Prometheus server rollout status 检查
      setImmediate(() => {
        try {
          console.log('Checking Prometheus server rollout status...');
          const rolloutCommand = 'kubectl rollout status deployment prometheus-server -n monitoring';
          exec(rolloutCommand, (error, stdout, stderr) => {
            if (error) {
              console.warn('Prometheus rollout status check failed:', error.message);
            } else {
              console.log('Prometheus rollout status:', stdout);
            }
          });
        } catch (rolloutError) {
          console.warn('Error triggering Prometheus rollout status check:', rolloutError.message);
        }
      });

      return {
        success: true,
        message: 'Unified KEDA configuration applied successfully',
        yamlPath: configFilePath,
        kubectlOutput: result,
        generatedYaml: fullYaml
      };

    } catch (error) {
      console.error('Error applying unified KEDA configuration:', error);
      return {
        success: false,
        error: error.message,
        message: 'Failed to apply unified KEDA configuration'
      };
    }
  }

  /**
   * 验证统一扩缩容配置
   * @param {Object} config - 配置对象
   * @returns {Object} 验证结果
   */
  static validateUnifiedConfig(config) {
    const errors = [];

    if (!config.serviceName) {
      errors.push('Service name is required');
    }

    if (!config.deploymentName) {
      errors.push('Deployment name is required');
    }

    if (!config.routerMetricPort) {
      errors.push('Router metric port is required');
    }

    if (!config.enabledTriggers || config.enabledTriggers.length === 0) {
      errors.push('At least one trigger must be enabled');
    }

    if (config.enabledTriggers?.includes('qps')) {
      if (!config.kedaTrig1ValueThreshold) {
        errors.push('QPS trigger value threshold is required');
      }
      if (!config.kedaTrig1ActThreshold) {
        errors.push('QPS trigger activation threshold is required');
      }
      if (!config.qpsWindow) {
        errors.push('QPS window length is required');
      }
    }

    if (config.enabledTriggers?.includes('queue')) {
      if (!config.kedaTrig2ValueThreshold) {
        errors.push('Queue trigger value threshold is required');
      }
      if (!config.kedaTrig2ActThreshold) {
        errors.push('Queue trigger activation threshold is required');
      }
    }

    if (config.minReplica && config.maxReplica && config.minReplica > config.maxReplica) {
      errors.push('Minimum replica count cannot be greater than maximum replica count');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 预览统一扩缩容YAML
   * @param {Object} config - 配置对象
   * @returns {Object} 预览结果
   */
  static async previewUnifiedScalingYaml(config) {
    try {
      const validation = this.validateUnifiedConfig(config);
      if (!validation.valid) {
        return {
          success: false,
          error: 'Invalid configuration',
          errors: validation.errors
        };
      }

      const yaml = this.generateUnifiedScalingYaml(config);

      return {
        success: true,
        yaml: yaml,
        config: config
      };
    } catch (error) {
      console.error('Error generating preview:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = KedaManager;