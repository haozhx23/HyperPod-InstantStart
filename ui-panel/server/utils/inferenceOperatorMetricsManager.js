const { execSync } = require('./exec');

class InferenceOperatorMetricsManager {
  /**
   * 获取 Inference Operator deployment 的可用指标
   * @param {string} deploymentName - Deployment 名称
   * @returns {Promise<Object>} 指标列表
   */
  static async getDeploymentMetrics(deploymentName) {
    try {
      // 获取 pod 名称
      const getPodCmd = `kubectl get pods -l app=${deploymentName} -o jsonpath='{.items[0].metadata.name}'`;
      const podName = execSync(getPodCmd, { encoding: 'utf8', timeout: 10000 }).trim();

      if (!podName) {
        throw new Error(`No pods found for deployment: ${deploymentName}`);
      }

      // 获取业务指标（sidecar 容器）
      let businessMetrics = [];
      try {
        const businessMetricsCmd = `kubectl exec ${podName} -c sidecar-reverse-proxy -- curl -s localhost:9113/metrics`;
        const businessMetricsOutput = execSync(businessMetricsCmd, { encoding: 'utf8', timeout: 10000 });
        businessMetrics = this.parseMetricNames(businessMetricsOutput);
      } catch (error) {
        console.warn('Failed to fetch business metrics:', error.message);
      }

      // 获取 vLLM 指标（主容器）
      let vllmMetrics = [];
      try {
        const vllmMetricsCmd = `kubectl exec ${podName} -- curl -s localhost:8000/metrics`;
        const vllmMetricsOutput = execSync(vllmMetricsCmd, { encoding: 'utf8', timeout: 10000 });
        vllmMetrics = this.parseMetricNames(vllmMetricsOutput);
      } catch (error) {
        console.warn('Failed to fetch vLLM metrics:', error.message);
      }

      return {
        success: true,
        podName: podName,
        businessMetrics: businessMetrics,
        vllmMetrics: vllmMetrics
      };

    } catch (error) {
      console.error('Error fetching deployment metrics:', error);
      return {
        success: false,
        error: error.message,
        businessMetrics: [],
        vllmMetrics: []
      };
    }
  }

  /**
   * 解析 Prometheus 指标输出，提取指标名称
   * @param {string} metricsText - Prometheus metrics 文本
   * @returns {Array<string>} 指标名称列表
   */
  static parseMetricNames(metricsText) {
    const lines = metricsText.split('\n');
    const metricNames = new Set();

    for (const line of lines) {
      // 跳过注释和空行
      if (line.startsWith('#') || !line.trim()) {
        continue;
      }

      // 提取指标名称（在 { 之前或空格之前）
      const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)/);
      if (match) {
        metricNames.add(match[1]);
      }
    }

    return Array.from(metricNames).sort();
  }
}

module.exports = InferenceOperatorMetricsManager;
