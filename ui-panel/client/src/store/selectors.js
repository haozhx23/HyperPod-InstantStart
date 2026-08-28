/**
 * 全局选择器文件
 * 包含跨越多个 state slices 的复杂选择器
 */

// 集群相关选择器
export const selectActiveCluster = state => state.clusters.activeCluster;
export const selectClustersList = state => state.clusters.list;
export const selectDependenciesStatus = state => state.clusters.dependencies;
export const selectClusterLoading = state => state.clusters.loading;
export const selectClusterError = state => state.clusters.error;
export const selectCreatingClusters = state => state.clusters.creatingClusters;

// 获取有效的依赖配置状态（考虑导入集群的特殊情况）
export const selectEffectiveDependenciesStatus = state => {
  const { list, activeCluster, dependencies } = state.clusters;
  
  // 从集群列表中找到当前集群
  const currentCluster = list.find(c => c.clusterTag === activeCluster);
  
  // 如果是导入的集群且有HyperPod，则视为已配置
  if (
    currentCluster?.type === 'imported' &&
    (currentCluster?.hyperPodCluster || currentCluster?.hasHyperPod)
  ) {
    return true;
  }

  return dependencies?.configured || false;
};

// 节点组相关选择器
export const selectHyperPodGroups = state => state.nodeGroups.hyperPodGroups;
export const selectNodeGroupsLoading = state => state.nodeGroups.loading;
export const selectNodeGroupsError = state => state.nodeGroups.error;
export const selectHyperPodCreationStatus = state => state.nodeGroups.hyperPodCreationStatus;
export const selectHyperPodDeletionStatus = state => state.nodeGroups.hyperPodDeletionStatus;
export const selectInstanceGroupAdditionStatus = state => state.nodeGroups.instanceGroupAdditionStatus;
export const selectNodeGroupScalingStatus = state => state.nodeGroups.nodeGroupScalingStatus;
export const selectNodeGroupDeletionStatus = state => state.nodeGroups.nodeGroupDeletionStatus;

// 推理服务相关选择器
export const selectDeployments = state => state.inference.deployments;
export const selectServices = state => state.inference.services;
export const selectInferenceLoading = state => state.inference.loading;
export const selectInferenceError = state => state.inference.error;
export const selectDeployStatus = state => state.inference.deployStatus;
export const selectServiceStatus = state => state.inference.serviceStatus;
export const selectUndeployStatus = state => state.inference.undeployStatus;
export const selectScaleStatus = state => state.inference.scaleStatus;
export const selectTestResults = state => state.inference.testResults;
export const selectTestLoading = state => state.inference.testLoading;
export const selectTestError = state => state.inference.testError;

// 训练作业相关选择器
export const selectTrainingJobs = state => state.training.jobs;
export const selectTrainingHistory = state => state.training.history;
export const selectActiveJob = state => state.training.activeJob;
export const selectTrainingLoading = state => state.training.loading;
export const selectTrainingError = state => state.training.error;
export const selectTrainingStatus = state => state.training.trainingStatus;
export const selectDeleteStatus = state => state.training.deleteStatus;
export const selectMlflowAuthStatus = state => state.training.mlflowAuthStatus;
export const selectMlflowServerStatus = state => state.training.mlflowServerStatus;
export const selectMlflowSyncStatus = state => state.training.mlflowSyncStatus;
export const selectJobLogs = state => state.training.jobLogs;

// 选择特定作业的日志
export const selectJobLogsByName = (state, jobName) => state.training.jobLogs[jobName] || [];

// 集群状态相关选择器
export const selectClusterNodes = state => state.clusterStatus?.nodes || [];
export const selectPendingGPUs = state => state.clusterStatus?.pendingGPUs || 0;
export const selectClusterStatusLoading = state => state.clusterStatus?.loading || false;
export const selectClusterStatusError = state => state.clusterStatus?.error;
export const selectClusterLastUpdate = state => state.clusterStatus?.lastUpdate;
export const selectClusterStats = state => state.clusterStatus?.stats;

// 计算集群统计信息的选择器
export const selectCalculatedClusterStats = state => {
  const nodes = selectClusterNodes(state);
  const pendingGPUs = selectPendingGPUs(state);

  const stats = nodes.reduce((acc, node) => ({
    totalNodes: acc.totalNodes + 1,
    readyNodes: acc.readyNodes + (node.nodeReady ? 1 : 0),
    totalGPUs: acc.totalGPUs + (node.totalGPU || 0),
    usedGPUs: acc.usedGPUs + (node.usedGPU || 0),
    availableGPUs: acc.availableGPUs + (node.availableGPU || 0),
    allocatableGPUs: acc.allocatableGPUs + (node.allocatableGPU || 0),
    errorNodes: acc.errorNodes + (node.error ? 1 : 0)
  }), {
    totalNodes: 0,
    readyNodes: 0,
    totalGPUs: 0,
    usedGPUs: 0,
    availableGPUs: 0,
    allocatableGPUs: 0,
    errorNodes: 0
  });

  return {
    ...stats,
    pendingGPUs
  };
};

// 应用状态相关选择器
export const selectAppPods = state => state.appStatus?.pods || [];
export const selectAppServices = state => state.appStatus?.services || [];
export const selectAppRayJobs = state => state.appStatus?.rayJobs || [];
export const selectAppBindingServices = state => state.appStatus?.bindingServices || [];
export const selectAppDeployments = state => state.appStatus?.deployments || [];          // 新增
export const selectAppTrainingJobs = state => state.appStatus?.trainingJobs || [];       // 新增
export const selectAppInferenceEndpoints = state => state.appStatus?.inferenceEndpoints || [];
export const selectAppK8sJobs = state => state.appStatus?.k8sJobs || [];
export const selectAppTabConfig = state => state.appStatus?.tabConfig || {};
export const selectRecipeConfig = state => state.appStatus?.recipeConfig || {};
export const selectClusterConfig = state => state.appStatus?.clusterConfig || {};
export const selectPagesConfig = state => state.appStatus?.pagesConfig || {};
// 便捷 selector: 指定 page 的 enabled/tabs。未加载完或未配置时默认放行 ('on')。
export const selectPageEnabled = (pageKey) => state =>
  state.appStatus?.pagesConfig?.[pageKey]?.enabled !== 'off';
export const selectPageTabs = (pageKey) => state =>
  state.appStatus?.pagesConfig?.[pageKey]?.tabs || {};
export const selectAppStatusLoading = state => state.appStatus?.loading || false;
export const selectAppStatusError = state => state.appStatus?.error;
export const selectAppLastUpdate = state => state.appStatus?.lastUpdate;
export const selectAppStats = state => state.appStatus?.stats;

// WebSocket 相关选择器
export const selectConnectionStatus = state => state.webSocket?.connectionStatus || 'connecting';
export const selectDeploymentStatus = state => state.webSocket?.deploymentStatus || null;

// 分别获取各个组件的加载状态
export const selectPodsLoading = state => state.appStatus?.podsLoading || false;
export const selectServicesLoading = state => state.appStatus?.servicesLoading || false;
export const selectRayJobsLoading = state => state.appStatus?.rayJobsLoading || false;
export const selectBindingServicesLoading = state => state.appStatus?.bindingServicesLoading || false;
export const selectDeploymentsLoading = state => state.appStatus?.deploymentsLoading || false;           // 新增
export const selectTrainingJobsLoading = state => state.appStatus?.trainingJobsLoading || false;         // 新增
export const selectInferenceEndpointsLoading = state => state.appStatus?.inferenceEndpointsLoading || false;

// 分别获取各个组件的错误状态
export const selectPodsError = state => state.appStatus?.podsError;
export const selectServicesError = state => state.appStatus?.servicesError;
export const selectRayJobsError = state => state.appStatus?.rayJobsError;
export const selectBindingServicesError = state => state.appStatus?.bindingServicesError;
export const selectDeploymentsError = state => state.appStatus?.deploymentsError;                       // 新增
export const selectTrainingJobsError = state => state.appStatus?.trainingJobsError;                     // 新增
export const selectInferenceEndpointsError = state => state.appStatus?.inferenceEndpointsError;

// 分别获取各个组件的更新时间
export const selectPodsLastUpdate = state => state.appStatus?.lastPodsUpdate;
export const selectServicesLastUpdate = state => state.appStatus?.lastServicesUpdate;
export const selectRayJobsLastUpdate = state => state.appStatus?.lastRayJobsUpdate;
export const selectBindingServicesLastUpdate = state => state.appStatus?.lastBindingServicesUpdate;
export const selectDeploymentsLastUpdate = state => state.appStatus?.lastDeploymentsUpdate;             // 新增
export const selectTrainingJobsLastUpdate = state => state.appStatus?.lastTrainingJobsUpdate;           // 新增
export const selectInferenceEndpointsLastUpdate = state => state.appStatus?.lastInferenceEndpointsUpdate;

// 计算应用健康度的选择器
export const selectAppHealthSummary = state => {
  const stats = selectAppStats(state);
  if (!stats) return { overall: 'unknown', details: {} };

  const podHealth = stats.totalPods > 0 ?
    (stats.runningPods / stats.totalPods) * 100 : 100;

  const serviceHealth = stats.totalServices > 0 ?
    (stats.activeServices / stats.totalServices) * 100 : 100;

  const rayJobHealth = stats.totalRayJobs > 0 ?
    ((stats.runningRayJobs + stats.completedRayJobs) / stats.totalRayJobs) * 100 : 100;

  const businessServiceHealth = stats.totalBindingServices > 0 ?
    (stats.healthyBindingServices / stats.totalBindingServices) * 100 : 100;

  // 新增：部署健康度
  const deploymentHealth = stats.totalDeployments > 0 ?
    (stats.activeDeployments / stats.totalDeployments) * 100 : 100;

  // 新增：训练任务健康度
  const trainingJobHealth = stats.totalTrainingJobs > 0 ?
    ((stats.runningTrainingJobs + stats.completedTrainingJobs) / stats.totalTrainingJobs) * 100 : 100;

  // 新增：推理端点健康度
  const inferenceEndpointHealth = stats.totalInferenceEndpoints > 0 ?
    (stats.activeInferenceEndpoints / stats.totalInferenceEndpoints) * 100 : 100;

  const healths = [
    podHealth, serviceHealth, rayJobHealth, businessServiceHealth,
    deploymentHealth, trainingJobHealth,
  ];
  healths.push(inferenceEndpointHealth);
  const overallHealth = healths.reduce((sum, h) => sum + h, 0) / healths.length;

  let healthLevel = 'healthy';
  if (overallHealth < 50) healthLevel = 'critical';
  else if (overallHealth < 75) healthLevel = 'warning';
  else if (overallHealth < 90) healthLevel = 'good';

  return {
    overall: healthLevel,
    percentage: Math.round(overallHealth),
    details: {
      pods: Math.round(podHealth),
      services: Math.round(serviceHealth),
      rayJobs: Math.round(rayJobHealth),
      bindingServices: Math.round(businessServiceHealth),
      deployments: Math.round(deploymentHealth),          // 新增
      trainingJobs: Math.round(trainingJobHealth),        // 新增
      inferenceEndpoints: Math.round(inferenceEndpointHealth)
    }
  };
};

// 选择特定类型的 Pod
export const selectPodsByStatus = (state, status) => {
  const pods = selectAppPods(state);
  return pods.filter(pod => pod.status?.phase === status);
};

// 选择特定类型的 RayJob
export const selectRayJobsByStatus = (state, status) => {
  const rayJobs = selectAppRayJobs(state);
  return rayJobs.filter(job => job.status?.jobStatus === status);
};

// 选择特定状态的部署
export const selectDeploymentsByStatus = (state, status) => {
  const deployments = selectAppDeployments(state);
  return deployments.filter(deployment => deployment.status === status);
};

// 选择特定状态的训练任务
export const selectTrainingJobsByStatus = (state, status) => {
  const trainingJobs = selectAppTrainingJobs(state);
  return trainingJobs.filter(job => {
    const jobStatus = job.status || (job.conditions && job.conditions.length > 0 ?
      job.conditions[job.conditions.length - 1].type : 'Unknown');
    return jobStatus === status;
  });
};

// 全局刷新相关选择器
export const selectIsGlobalRefreshing = state => state.globalRefresh?.isRefreshing || false;
export const selectLastGlobalRefreshTime = state => state.globalRefresh?.lastRefreshTime;
export const selectAutoRefreshEnabled = state => state.globalRefresh?.autoRefreshEnabled || false;
export const selectAutoRefreshInterval = state => state.globalRefresh?.autoRefreshInterval || 60000;
export const selectGlobalRefreshStats = state => state.globalRefresh?.stats;
export const selectGlobalRefreshHistory = state => state.globalRefresh?.refreshHistory || [];
export const selectGlobalRefreshError = state => state.globalRefresh?.error;

// 获取最近的刷新记录
export const selectRecentRefreshHistory = (state, limit = 10) => {
  const history = selectGlobalRefreshHistory(state);
  return history.slice(0, limit);
};

// 计算全局系统健康度
export const selectOverallSystemHealth = state => {
  const clusterStats = selectCalculatedClusterStats(state);
  const appHealth = selectAppHealthSummary(state);
  const refreshStats = selectGlobalRefreshStats(state);

  if (!clusterStats || !appHealth.overall || !refreshStats) {
    return { overall: 'unknown', score: 0, components: {} };
  }

  // 计算集群健康度
  const clusterHealthScore = clusterStats.totalNodes > 0 ?
    (clusterStats.readyNodes / clusterStats.totalNodes) * 100 : 0;

  // 应用健康度得分
  const appHealthScore = appHealth.percentage || 0;

  // 刷新系统健康度（基于成功率）
  const refreshHealthScore = refreshStats.successRate || 0;

  // 综合得分
  const overallScore = (clusterHealthScore + appHealthScore + refreshHealthScore) / 3;

  let healthLevel = 'critical';
  if (overallScore >= 90) healthLevel = 'healthy';
  else if (overallScore >= 75) healthLevel = 'good';
  else if (overallScore >= 50) healthLevel = 'warning';

  return {
    overall: healthLevel,
    score: Math.round(overallScore),
    components: {
      cluster: {
        score: Math.round(clusterHealthScore),
        status: clusterHealthScore >= 80 ? 'good' : clusterHealthScore >= 50 ? 'warning' : 'critical'
      },
      applications: {
        score: appHealthScore,
        status: appHealth.overall
      },
      refresh: {
        score: refreshHealthScore,
        status: refreshHealthScore >= 90 ? 'good' : refreshHealthScore >= 70 ? 'warning' : 'critical'
      }
    }
  };
};
