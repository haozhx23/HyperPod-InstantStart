const { execSync } = require('./exec');
const fs = require('fs');
const path = require('path');
const EKSServiceHelper = require('./eksServiceHelper');
const { generateNLBAnnotations } = require('./inferenceUtils');

class RoutingManager {
  static generateRouterYaml(config) {
    const {
      deploymentName = 'sglang-router',
      routingPolicy = 'cache_aware',
      routerPort = 30000,
      metricsPort = 29000,
      serviceType = 'external'
    } = config;

    // Generate timestamp for unique naming
    // 格式: 251222021347 (YYMMDDHHMMSS) - 用于资源命名
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `${yy}${mm}${dd}${hh}${min}${ss}`;
    const resourceName = `${deploymentName}-${timestamp}`;

    // 生成 Deployment 和相关 RBAC 资源
    const deploymentYaml = this.generateRouterDeploymentYaml(config, resourceName);

    // 使用 EKSServiceHelper 生成 Service
    const portConfig = {
      http: routerPort,
      metrics: metricsPort
    };

    // 使用用户选择的服务类型
    const serviceYaml = this.generateRouterServiceYaml(
      serviceType,
      resourceName,
      portConfig
    );

    return `${deploymentYaml}\n${serviceYaml}`;
  }

  /**
   * 生成 Router Deployment 及相关 RBAC 资源的 YAML
   * @param {Object} config - 配置对象
   * @param {string} resourceName - 资源名称 (包含时间戳)
   * @returns {string} Deployment YAML 字符串
   */
  static generateRouterDeploymentYaml(config, resourceName) {
    const {
      deploymentName = 'sglang-router',
      routingPolicy = 'cache_aware',
      routerPort = 30000,
      metricsPort = 29000,
      targetDeployment,
      discoveryPort = 8000,
      checkInterval = 120,
      cacheThreshold = 0.5,
      balanceAbsThreshold = 32,
      balanceRelThreshold = 1.1,
      evictionIntervalSecs = 30,
      maxTreeSize = 10000
    } = config;

    return `---
# ServiceAccount for Router
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${resourceName}
  namespace: default

---
# ClusterRole for Pod discovery
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${resourceName}
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]

---
# ClusterRoleBinding
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${resourceName}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${resourceName}
subjects:
- kind: ServiceAccount
  name: ${resourceName}
  namespace: default

---
# Router Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${resourceName}
  labels:
    app: ${resourceName}
    deployment-name: "${resourceName}"
    service-type: "router"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${resourceName}
  template:
    metadata:
      labels:
        app: ${resourceName}
        deployment-name: "${resourceName}"
        service-type: "router"
    spec:
      serviceAccountName: ${resourceName}
      containers:
        - name: sglang-router
          image: lmsysorg/sglang:latest
          resources:
            requests:
              cpu: "2"
              memory: 4Gi
            limits:
              cpu: "4"
              memory: 8Gi
          # command: ["sglang-router"]
          command: ["python", "-m", "sglang_router.launch_router"]
          args: ${this.generateRouterArgs(config, deploymentName)}
          ports:
            - containerPort: ${routerPort}
              name: http
            - containerPort: ${metricsPort}
              name: metrics
          env:
            - name: RUST_LOG
              value: "info"`;
  }

  /**
   * 生成 Router 启动参数
   * @param {Object} config - 配置对象
   * @param {string} deploymentName - 部署名称
   * @returns {string} YAML格式的args数组
   */
  static generateRouterArgs(config, deploymentName) {
    const {
      routingPolicy = 'cache_aware',
      routerPort = 30000,
      metricsPort = 29000,
      targetDeployment,
      discoveryPort = 8000,
      checkInterval = 120,
      cacheThreshold = 0.5,
      balanceAbsThreshold = 32,
      balanceRelThreshold = 1.1,
      evictionIntervalSecs = 30,
      maxTreeSize = 10000
    } = config;

    let args = [];

    // 固定的Kubernetes服务发现模式
    // 根据targetDeployment生成正确的selector - 只使用app标签，避免复杂selector问题
    const podSelector = `app=sglang-${targetDeployment}-inference`;

    args.push(
      '- "--service-discovery"',
      '- "--selector"',
      `- "${podSelector}"`,
      '- "--service-discovery-port"',
      `- "${discoveryPort}"`
    );

    // 路由策略
    args.push('- "--policy"', `- "${routingPolicy}"`);

    // Cache-Aware策略专用参数
    if (routingPolicy === 'cache_aware') {
      args.push(
        '- "--cache-threshold"',
        `- "${cacheThreshold}"`,
        '- "--balance-abs-threshold"',
        `- "${balanceAbsThreshold}"`,
        '- "--balance-rel-threshold"',
        `- "${balanceRelThreshold}"`,
        '- "--eviction-interval"',
        `- "${evictionIntervalSecs}"`,
        '- "--max-tree-size"',
        `- "${maxTreeSize}"`
      );
    }

    // 基础网络配置
    args.push(
      '- "--host"',
      '- "0.0.0.0"',
      '- "--port"',
      `- "${routerPort}"`,
      '- "--prometheus-port"',
      `- "${metricsPort}"`
    );

    // 返回YAML格式的数组
    return `\n            ${args.join('\n            ')}`;
  }

  /**
   * 生成 Router Service YAML (专门匹配Router Deployment的标签)
   * @param {string} serviceType - 服务类型 ('external' 或 'clusterip')
   * @param {string} resourceName - 资源名称 (完整名称包含时间戳)
   * @param {Object} portConfig - 端口配置对象 {http: 30000, metrics: 29000}
   * @returns {string} Service YAML 字符串
   */
  static generateRouterServiceYaml(serviceType, resourceName, portConfig) {
    const portsSection = Object.entries(portConfig).map(([name, portNum]) =>
      `    - name: ${name}
      port: ${portNum}
      targetPort: ${portNum}
      protocol: TCP`
    ).join('\n');

    if (serviceType === 'external') {
      const nlbAnnotations = generateNLBAnnotations(true);
      return `---
apiVersion: v1
kind: Service
metadata:
  name: ${resourceName}-nlb
  labels:
    app: ${resourceName}
    service-type: "router"
    deployment-name: "${resourceName}"
  annotations:${nlbAnnotations}
spec:
  ports:
${portsSection}
  selector:
    app: ${resourceName}
  type: LoadBalancer`;
    } else {
      return `---
apiVersion: v1
kind: Service
metadata:
  name: ${resourceName}-service
  labels:
    app: ${resourceName}
    service-type: "router"
    deployment-name: "${resourceName}"
spec:
  type: ClusterIP
  selector:
    app: ${resourceName}
  ports:
${portsSection}`;
    }
  }

  // generateNLBAnnotations 已迁移至 inferenceUtils.js

  static async applyRouterConfiguration(config) {
    try {
      const yaml = this.generateRouterYaml(config);

      // Create deployments/inference directory if it doesn't exist
      const deploymentDir = path.join(__dirname, '../../deployments/inference');
      if (!fs.existsSync(deploymentDir)) {
        fs.mkdirSync(deploymentDir, { recursive: true });
      }

      // Save YAML file with timestamp
      // 格式: 251222-021347 (YYMMDD-HHMMSS)
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const min = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      const timestamp = `${yy}${mm}${dd}-${hh}${min}${ss}`;
      const yamlPath = path.join(deploymentDir, `sglang-router-${timestamp}.yaml`);

      fs.writeFileSync(yamlPath, yaml);
      console.log(`SGLang Router YAML saved to: ${yamlPath}`);

      // Apply to Kubernetes
      const applyCommand = `kubectl apply -f ${yamlPath}`;
      const result = execSync(applyCommand, { encoding: 'utf8' });

      return {
        success: true,
        message: 'SGLang Router deployed successfully',
        yamlPath: yamlPath,
        kubectlOutput: result,
        generatedYaml: yaml
      };

    } catch (error) {
      console.error('Error applying SGLang Router configuration:', error);
      return {
        success: false,
        error: error.message,
        message: 'Failed to deploy SGLang Router'
      };
    }
  }

  static async getRouterStatus() {
    try {
      // Check SGLang Router deployment
      const deploymentCmd = 'kubectl get deployment sglang-router -o json';
      const deploymentResult = execSync(deploymentCmd, { encoding: 'utf8' });
      const deployment = JSON.parse(deploymentResult);

      // Check SGLang Router service
      const serviceCmd = 'kubectl get service sglang-router-service -o json';
      const serviceResult = execSync(serviceCmd, { encoding: 'utf8' });
      const service = JSON.parse(serviceResult);

      // Check pods
      const podsCmd = 'kubectl get pods -l app=sglang-router -o json';
      const podsResult = execSync(podsCmd, { encoding: 'utf8' });
      const pods = JSON.parse(podsResult);

      return {
        success: true,
        deployment: {
          name: deployment.metadata.name,
          replicas: deployment.status.replicas || 0,
          readyReplicas: deployment.status.readyReplicas || 0,
          creationTime: deployment.metadata.creationTimestamp
        },
        service: {
          name: service.metadata.name,
          type: service.spec.type,
          clusterIP: service.spec.clusterIP,
          externalIP: service.status?.loadBalancer?.ingress?.[0]?.ip || 'Pending',
          ports: service.spec.ports
        },
        pods: pods.items.map(pod => ({
          name: pod.metadata.name,
          status: pod.status.phase,
          ready: pod.status.containerStatuses?.[0]?.ready || false,
          restarts: pod.status.containerStatuses?.[0]?.restartCount || 0,
          creationTime: pod.metadata.creationTimestamp
        }))
      };

    } catch (error) {
      console.error('Error getting SGLang Router status:', error);
      return {
        success: false,
        error: error.message,
        routerInstalled: false
      };
    }
  }

  /**
   * 获取所有Router部署列表
   * @returns {Array} Router部署列表
   */
  static async getRouterDeployments() {
    try {
      // 查找所有Router类型的Deployment
      const cmd = 'kubectl get deployments -l service-type=router -o json';
      const result = execSync(cmd, { encoding: 'utf8' });
      const deployments = JSON.parse(result);

      return deployments.items.map(deployment => ({
        resourceName: deployment.metadata.name,           // sglang-router-1761786858801
        deploymentName: deployment.metadata.labels['deployment-name'] || 'unknown', // sglang-router
        namespace: deployment.metadata.namespace || 'default',
        creationTime: deployment.metadata.creationTimestamp,
        replicas: deployment.status.replicas || 0,
        readyReplicas: deployment.status.readyReplicas || 0,
        labels: deployment.metadata.labels,
        status: (deployment.status.replicas === deployment.status.readyReplicas &&
                deployment.status.readyReplicas > 0) ? 'Ready' : 'NotReady'
      }));

    } catch (error) {
      console.error('Error getting Router deployments:', error);
      return [];
    }
  }

  /**
   * 删除指定的Router部署实例
   * @param {string} deploymentName - 部署名称（如 'sglang-router'）
   * @returns {Object} 删除结果
   */
  static async deleteRouter(deploymentName) {
    try {
      console.log(`Deleting Router deployment: ${deploymentName}`);

      // 步骤1: 智能查找Router Deployment
      // 现在labels使用完整resourceName，支持直接按resourceName查询
      const cmd = `kubectl get deployment -l deployment-name=${deploymentName},service-type=router -o json`;
      const result = execSync(cmd, { encoding: 'utf8' });
      const deployments = JSON.parse(result).items;

      if (deployments.length === 0) {
        return {
          success: false,
          message: `Router deployment '${deploymentName}' not found`
        };
      }

      const results = [];
      let totalDeleted = 0;

      for (const deployment of deployments) {
        const resourceName = deployment.metadata.name; // 获取实际名称: sglang-router-1761786858801
        const timestamp = resourceName.split('-').pop(); // 提取时间戳: 1761786858801

        console.log(`Processing Router instance: ${resourceName}`);

        // 步骤2: 删除各类资源 - 按照创建时的命名规律
        const deleteOperations = [
          // Deployment - 直接删除
          {
            type: 'deployment',
            cmd: `kubectl delete deployment ${resourceName}`,
            name: resourceName
          },

          // Service - 基于实际Router Service的命名格式
          // Router Service的实际命名格式是: {resourceName}-nlb 和 {resourceName}-service
          {
            type: 'service-nlb',
            cmd: `kubectl delete service ${resourceName}-nlb --ignore-not-found=true`,
            name: `${resourceName}-nlb`
          },
          {
            type: 'service-clusterip',
            cmd: `kubectl delete service ${resourceName}-service --ignore-not-found=true`,
            name: `${resourceName}-service`
          },

          // RBAC资源 - 基于resourceName（命名规则确定）
          {
            type: 'serviceaccount',
            cmd: `kubectl delete serviceaccount ${resourceName} --ignore-not-found=true`,
            name: resourceName
          },
          {
            type: 'clusterrole',
            cmd: `kubectl delete clusterrole ${resourceName} --ignore-not-found=true`,
            name: resourceName
          },
          {
            type: 'clusterrolebinding',
            cmd: `kubectl delete clusterrolebinding ${resourceName} --ignore-not-found=true`,
            name: resourceName
          }
        ];

        // 执行删除操作
        for (const operation of deleteOperations) {
          try {
            console.log(`Executing: ${operation.cmd}`);
            const output = execSync(operation.cmd, { encoding: 'utf8' });
            const cleanOutput = output.trim();

            if (cleanOutput && !cleanOutput.includes('not found') && !cleanOutput.includes('No resources found')) {
              totalDeleted++;
              results.push({
                resource: operation.type,
                name: operation.name,
                success: true,
                output: cleanOutput
              });
            } else {
              results.push({
                resource: operation.type,
                name: operation.name,
                success: true,
                output: 'Resource not found (already deleted or never existed)'
              });
            }
          } catch (error) {
            console.warn(`Failed to delete ${operation.type} ${operation.name}:`, error.message);
            results.push({
              resource: operation.type,
              name: operation.name,
              success: false,
              error: error.message
            });
          }
        }
      }

      return {
        success: true,
        message: `Router deployment '${deploymentName}' deleted successfully`,
        processedInstances: deployments.length,
        totalDeleted: totalDeleted,
        results: results
      };

    } catch (error) {
      console.error('Error deleting Router:', error);
      return {
        success: false,
        error: error.message,
        message: `Failed to delete Router deployment '${deploymentName}'`
      };
    }
  }

  /**
   * 删除所有Router部署（危险操作，仅限管理使用）
   * @returns {Object} 删除结果
   */
  static async deleteAllRouters() {
    try {
      const routers = await this.getRouterDeployments();

      if (routers.length === 0) {
        return {
          success: true,
          message: 'No Router deployments found',
          results: []
        };
      }

      const results = [];
      for (const router of routers) {
        const result = await this.deleteRouter(router.deploymentName);
        results.push(result);
      }

      return {
        success: true,
        message: `Deleted ${routers.length} Router deployment(s)`,
        results: results
      };

    } catch (error) {
      console.error('Error deleting all Routers:', error);
      return {
        success: false,
        error: error.message,
        message: 'Failed to delete all Router deployments'
      };
    }
  }

  static validateConfig(config) {
    const errors = [];

    if (!config) {
      errors.push('Configuration is required');
      return { valid: false, errors };
    }

    if (!config.deploymentName || config.deploymentName.trim() === '') {
      errors.push('Deployment name is required');
    } else if (!/^[a-z0-9-]+$/.test(config.deploymentName)) {
      errors.push('Deployment name must contain only lowercase letters, numbers and hyphens');
    }

    // Target deployment validation (必须指定特定的SGLang部署)
    if (!config.targetDeployment || config.targetDeployment.trim() === '') {
      errors.push('Target deployment is required');
    }

    // Service discovery validation
    if (config.discoveryPort && (config.discoveryPort < 1000 || config.discoveryPort > 65535)) {
      errors.push('Discovery port must be between 1000 and 65535');
    }
    if (config.checkInterval && (config.checkInterval < 30 || config.checkInterval > 600)) {
      errors.push('Check interval must be between 30 and 600 seconds');
    }

    if (config.routerPort && (config.routerPort < 1000 || config.routerPort > 65535)) {
      errors.push('Router port must be between 1000 and 65535');
    }

    if (config.metricsPort && (config.metricsPort < 1000 || config.metricsPort > 65535)) {
      errors.push('Metrics port must be between 1000 and 65535');
    }

    if (config.routerPort && config.metricsPort && config.routerPort === config.metricsPort) {
      errors.push('Router port and metrics port cannot be the same');
    }

    if (config.serviceType && !['external', 'clusterip'].includes(config.serviceType)) {
      errors.push('Service type must be either "external" or "clusterip"');
    }

    if (config.routingPolicy && !['cache_aware', 'round_robin', 'random'].includes(config.routingPolicy)) {
      errors.push('Routing policy must be one of: cache_aware, round_robin, random');
    }

    // Cache-Aware policy specific validation
    if (config.routingPolicy === 'cache_aware') {
      if (config.cacheThreshold !== undefined && (config.cacheThreshold < 0 || config.cacheThreshold > 1)) {
        errors.push('Cache threshold must be between 0.0 and 1.0');
      }
      if (config.balanceAbsThreshold !== undefined && config.balanceAbsThreshold < 1) {
        errors.push('Balance absolute threshold must be at least 1');
      }
      if (config.balanceRelThreshold !== undefined && config.balanceRelThreshold < 1) {
        errors.push('Balance relative threshold must be at least 1.0');
      }
      if (config.evictionIntervalSecs !== undefined && config.evictionIntervalSecs < 10) {
        errors.push('Eviction interval must be at least 10 seconds');
      }
      if (config.maxTreeSize !== undefined && config.maxTreeSize < 1000) {
        errors.push('Max tree size must be at least 1000');
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  static getDefaultConfig() {
    return {
      deploymentName: 'sglang-router',
      routingPolicy: 'cache_aware',
      routerPort: 30000,
      metricsPort: 29000,
      serviceType: 'clusterip', // 默认为clusterip
      targetDeployment: 'qwensgl-2025-10-30-06-39-57', // 默认选择有效的SGLang部署
      discoveryPort: 8000,
      checkInterval: 120,
      cacheThreshold: 0.5,
      balanceAbsThreshold: 32,
      balanceRelThreshold: 1.1,
      evictionIntervalSecs: 30,
      maxTreeSize: 10000
    };
  }

  static async previewYaml(config) {
    try {
      const validation = this.validateConfig(config);
      if (!validation.valid) {
        return {
          success: false,
          error: 'Invalid configuration',
          errors: validation.errors
        };
      }

      const yaml = this.generateRouterYaml(config);

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

  /**
   * 获取所有Router Services列表（用于KEDA配置）
   * @returns {Array} Router Services列表，包含端口信息
   */
  static async getRouterServices() {
    try {
      // 1. 获取所有Router类型的Services
      const servicesCmd = 'kubectl get services -l service-type=router -o json';
      const servicesResult = execSync(servicesCmd, { encoding: 'utf8' });
      const services = JSON.parse(servicesResult);

      const routerServices = [];

      for (const service of services.items) {
        try {
          // 2. 从Service labels中获取deployment-name
          const deploymentName = service.metadata.labels['deployment-name'];
          if (!deploymentName) {
            console.warn(`Service ${service.metadata.name} missing deployment-name label`);
            continue;
          }

          // 3. 提取端口信息
          const ports = service.spec.ports || [];
          const httpPort = ports.find(p => p.name === 'http')?.port;
          const metricsPort = ports.find(p => p.name === 'metrics')?.port;

          if (!metricsPort) {
            console.warn(`Service ${service.metadata.name} missing metrics port`);
            continue;
          }

          // 4. 获取Router deployment配置，解析关联的模型deployment
          let modelDeploymentName = null;
          let modelSelector = null;

          try {
            // 获取Router deployment的详细配置
            const deploymentCmd = `kubectl get deployment ${deploymentName} -o json`;
            const deploymentResult = execSync(deploymentCmd, { encoding: 'utf8' });
            const deployment = JSON.parse(deploymentResult);

            // 解析容器参数中的 --selector
            const containers = deployment.spec?.template?.spec?.containers || [];
            const routerContainer = containers.find(c => c.name === 'sglang-router') || containers[0];

            if (routerContainer?.args) {
              const args = routerContainer.args;
              const selectorIndex = args.findIndex(arg => arg === '--selector');

              if (selectorIndex !== -1 && selectorIndex + 1 < args.length) {
                modelSelector = args[selectorIndex + 1]; // 例如: app=xxx-inference
                console.log(`Found router selector: ${modelSelector} for ${deploymentName}`);

                // 根据selector查找对应的模型deployment
                const modelCmd = `kubectl get deployments -l "${modelSelector}" -o json`;
                const modelResult = execSync(modelCmd, { encoding: 'utf8' });
                const modelDeployments = JSON.parse(modelResult);

                if (modelDeployments.items && modelDeployments.items.length > 0) {
                  modelDeploymentName = modelDeployments.items[0].metadata.name;
                  console.log(`Found associated model deployment: ${modelDeploymentName}`);
                } else {
                  console.warn(`No model deployment found for selector: ${modelSelector}`);
                }
              }
            }
          } catch (parseError) {
            console.warn(`Could not parse model deployment for router ${deploymentName}:`, parseError.message);
          }

          // 5. 构建Router Service信息（包含关联的模型deployment）
          const routerService = {
            name: service.metadata.name,
            deploymentName: deploymentName,              // Router deployment名称
            modelDeploymentName: modelDeploymentName,    // 关联的模型deployment名称
            modelSelector: modelSelector,               // 模型选择器
            namespace: service.metadata.namespace || 'default',
            serviceType: service.spec.type,
            httpPort: httpPort,
            metricPort: metricsPort,
            creationTime: service.metadata.creationTimestamp,
            // 判断是否为external类型
            isExternal: service.spec.type === 'LoadBalancer',
            // 获取访问地址
            clusterIP: service.spec.clusterIP,
            externalIP: service.status?.loadBalancer?.ingress?.[0]?.hostname ||
                       service.status?.loadBalancer?.ingress?.[0]?.ip || null
          };

          routerServices.push(routerService);

        } catch (error) {
          console.warn(`Error processing service ${service.metadata.name}:`, error.message);
          continue;
        }
      }

      console.log(`Found ${routerServices.length} Router services`);
      return routerServices;

    } catch (error) {
      console.error('Error getting Router services:', error);
      // 如果没有找到任何Router services，返回空数组而不是错误
      if (error.message.includes('No resources found')) {
        return [];
      }
      throw error;
    }
  }
}

module.exports = RoutingManager;