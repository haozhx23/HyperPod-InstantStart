import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

// 异步操作：获取 Pods 状态 (使用V2 API)
export const fetchPods = createAsyncThunk(
  'appStatus/fetchPods',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching pods status via Redux V2...');
      const response = await fetch('/api/v2/app-status');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('Pods V2 status response:', data);

      return {
        pods: data.rawPods || data.pods || [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching pods V2:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：获取 Services 状态 (使用V2 API)
export const fetchServices = createAsyncThunk(
  'appStatus/fetchServices',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching services status via Redux V2...');
      const response = await fetch('/api/v2/app-status');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('Services V2 status response:', data);

      return {
        services: data.rawServices || data.services || [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching services V2:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：获取 RayJobs 状态
export const fetchRayJobs = createAsyncThunk(
  'appStatus/fetchRayJobs',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching RayJobs status via Redux...');
      const response = await fetch('/api/rayjobs');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('RayJobs status response:', data);

      return {
        rayJobs: data.items || [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching RayJobs:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：获取业务服务状态
export const fetchBindingServices = createAsyncThunk(
  'appStatus/fetchBindingServices',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching binding services status via Redux...');
      const response = await fetch('/api/binding-services');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('Business services status response:', data);

      return {
        bindingServices: data || [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching business services:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：获取部署状态
export const fetchDeployments = createAsyncThunk(
  'appStatus/fetchDeployments',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching deployments status via Redux...');
      const response = await fetch('/api/deployments');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('Deployments status response:', data);

      return {
        deployments: Array.isArray(data) ? data : [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching deployments:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：获取训练任务状态（只包括HyperPod，不包括RayJob）
export const fetchTrainingJobs = createAsyncThunk(
  'appStatus/fetchTrainingJobs',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching HyperPod training jobs status via Redux...');
      const response = await fetch('/api/hyperpod-jobs');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('Training jobs status response:', data);

      return {
        trainingJobs: data.success ? (data.jobs || []) : [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching training jobs:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：获取 InferenceEndpointConfig 资源
export const fetchInferenceEndpoints = createAsyncThunk(
  'appStatus/fetchInferenceEndpoints',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching InferenceEndpointConfig resources via Redux...');
      const response = await fetch('/api/inference-endpoints');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('Inference endpoints status response:', data);

      return {
        inferenceEndpoints: data.success ? (data.endpoints || []) : [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching inference endpoints:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：获取 Kubernetes Jobs（kubectl get jobs）
export const fetchK8sJobs = createAsyncThunk(
  'appStatus/fetchK8sJobs',
  async (_, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/k8s-jobs');
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      return { k8sJobs: data.success ? (data.jobs || []) : [], timestamp: new Date().toISOString() };
    } catch (error) {
      console.error('Error fetching k8s jobs:', error);
      return rejectWithValue(error.message);
    }
  }
);


// Training-Jobs page 的 tab key,用来从 legacy training-recipes 里切分出来
const TRAINING_JOB_TAB_KEYS = [
  'sagemaker',
  'hyperpodrunJob',
  'rayJob',
];

/**
 * 兼容 shim: 从新 schema (config.pages) 或 legacy 扁平 schema 归一化出 pages 结构。
 * 新 schema 优先; 缺失时从旧 3 个顶层 key 重建。
 */
function normalizePagesConfig(raw) {
  if (raw && raw.pages && typeof raw.pages === 'object') {
    return raw.pages;
  }
  // Legacy 重建
  const legacyRecipes = raw?.['training-recipes'] || {};
  const legacyApp = raw?.['app-status'] || {};
  const legacyCluster = raw?.['cluster-management'] || {};

  const trainingTabs = {};
  const recipeTabs = {};
  for (const [k, v] of Object.entries(legacyRecipes)) {
    if (TRAINING_JOB_TAB_KEYS.includes(k)) trainingTabs[k] = v;
    else recipeTabs[k] = v;
  }
  return {
    'cluster-management': { enabled: 'on', tabs: legacyCluster },
    'storage': { enabled: 'on' },
    'inference': { enabled: 'on', tabs: {} },
    'training': { enabled: 'on', tabs: trainingTabs },
    'training-recipes': { enabled: 'on', tabs: recipeTabs },
    'training-history': { enabled: 'on' },
    'monitoring': { enabled: 'on', tabs: legacyApp },
  };
}

// 异步操作：获取 App Status 配置
export const fetchAppStatusConfig = createAsyncThunk(
  'appStatus/fetchAppStatusConfig',
  async (_, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/config/app-status');
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      const pages = normalizePagesConfig(data.config || {});

      // 扁平兼容视图: 让 selectTabConfig/selectRecipeConfig/selectClusterConfig 继续工作。
      // recipeConfig 合并 training + training-recipes 两个页面的 tabs,兼容老代码里按 key 判 isRecipeVisible 的逻辑。
      return {
        pagesConfig: pages,
        tabConfig: pages.monitoring?.tabs || {},
        recipeConfig: { ...(pages.training?.tabs || {}), ...(pages['training-recipes']?.tabs || {}) },
        clusterConfig: pages['cluster-management']?.tabs || {},
      };
    } catch (error) {
      console.error('Error fetching app-status config:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 新增：使用V2 API的优化组合获取
export const fetchAppStatusV2 = createAsyncThunk(
  'appStatus/fetchAppStatusV2',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching app status via V2 API...');
      const response = await fetch('/api/v2/app-status');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('App Status V2 response:', data);

      return {
        pods: data.rawPods || data.pods || [],
        services: data.rawServices || data.services || [],
        timestamp: new Date().toISOString(),
        stats: data.stats || null,
        fetchTime: data.fetchTime || null,
        version: 'v2'
      };
    } catch (error) {
      console.error('Error fetching app status V2:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 组合操作：刷新所有应用状态 (优化版本)
export const refreshAllAppStatus = createAsyncThunk(
  'appStatus/refreshAllAppStatus',
  async (_, { dispatch, rejectWithValue }) => {
    try {
      // 使用V2 API获取pods和services，其他资源单独获取
      const results = await Promise.allSettled([
        dispatch(fetchAppStatusV2()).unwrap(),
        dispatch(fetchRayJobs()).unwrap(),
        dispatch(fetchBindingServices()).unwrap(),
        dispatch(fetchDeployments()).unwrap(),        // 新增
        dispatch(fetchTrainingJobs()).unwrap(),       // 新增
        dispatch(fetchInferenceEndpoints()).unwrap(),
        dispatch(fetchK8sJobs()).unwrap(),            // K8s Jobs
      ]);

      const errors = [];
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const operations = [
            'App Status V2', 'RayJobs', 'Business Services', 'Deployments', 'Training Jobs',
            'Inference Endpoints',
            'K8s Jobs',
          ];
          errors.push(`${operations[index]}: ${result.reason}`);
        }
      });

      if (errors.length > 0) {
        console.warn('Some app status operations failed:', errors);
      }

      return {
        success: true,
        timestamp: new Date().toISOString(),
        errors: errors.length > 0 ? errors : null
      };
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

const appStatusSlice = createSlice({
  name: 'appStatus',
  initialState: {
    // 各类应用数据
    pods: [],
    services: [],
    rayJobs: [],
    bindingServices: [],
    deployments: [],           // 新增
    trainingJobs: [],          // 新增
    inferenceEndpoints: [],
    k8sJobs: [],               // K8s Jobs (kubectl get jobs)
    pagesConfig: {},           // 顶层页面层级配置 { pages.{page}.enabled, pages.{page}.tabs }
    tabConfig: {},             // Legacy flat: Monitoring tab 显示/隐藏 (由 pages.monitoring.tabs 派生)
    recipeConfig: {},          // Legacy flat: Training + TrainingRecipes tab 合并 (派生)
    clusterConfig: {},         // Legacy flat: Cluster Management tab (由 pages.cluster-management.tabs 派生)

    // 加载状态管理
    loading: false,
    podsLoading: false,
    servicesLoading: false,
    rayJobsLoading: false,
    bindingServicesLoading: false,
    deploymentsLoading: false, // 新增
    trainingJobsLoading: false, // 新增
    inferenceEndpointsLoading: false,
    k8sJobsLoading: false,

    // 错误状态管理
    error: null,
    podsError: null,
    servicesError: null,
    rayJobsError: null,
    bindingServicesError: null,
    deploymentsError: null,    // 新增
    trainingJobsError: null,   // 新增
    inferenceEndpointsError: null,
    k8sJobsError: null,

    // 时间戳记录
    lastUpdate: null,
    lastPodsUpdate: null,
    lastServicesUpdate: null,
    lastRayJobsUpdate: null,
    lastBindingServicesUpdate: null,
    lastDeploymentsUpdate: null,    // 新增
    lastTrainingJobsUpdate: null,   // 新增
    lastInferenceEndpointsUpdate: null,
    lastK8sJobsUpdate: null,

    // 统计信息
    stats: {
      totalPods: 0,
      runningPods: 0,
      pendingPods: 0,
      failedPods: 0,
      totalServices: 0,
      activeServices: 0,
      totalRayJobs: 0,
      runningRayJobs: 0,
      completedRayJobs: 0,
      failedRayJobs: 0,
      totalBindingServices: 0,
      healthyBindingServices: 0,
      totalDeployments: 0,        // 新增
      activeDeployments: 0,       // 新增
      totalTrainingJobs: 0,       // 新增
      runningTrainingJobs: 0,     // 新增
      completedTrainingJobs: 0,   // 新增
      failedTrainingJobs: 0,      // 新增
      totalInferenceEndpoints: 0,
      activeInferenceEndpoints: 0
    }
  },
  reducers: {
    // 清除错误状态
    clearError: (state) => {
      state.error = null;
      state.podsError = null;
      state.servicesError = null;
      state.rayJobsError = null;
      state.bindingServicesError = null;
      state.deploymentsError = null;      // 新增
      state.trainingJobsError = null;     // 新增
      state.inferenceEndpointsError = null;
      state.k8sJobsError = null;
    },

    // 批量写入 pods + services（用于 WebSocket status_update 消息）
    setPodsServices: (state, action) => {
      const { pods, services } = action.payload || {};
      if (Array.isArray(pods)) {
        state.pods = pods;
        state.lastPodsUpdate = new Date().toISOString();
      }
      if (Array.isArray(services)) {
        state.services = services;
        state.lastServicesUpdate = new Date().toISOString();
      }
      appStatusSlice.caseReducers.updateStats(state);
    },

    // 更新单个 Pod 状态（用于 WebSocket 实时更新）
    updatePodStatus: (state, action) => {
      const { podName, status } = action.payload;
      const podIndex = state.pods.findIndex(pod => pod.metadata?.name === podName);

      if (podIndex !== -1) {
        state.pods[podIndex] = { ...state.pods[podIndex], ...status };
        state.lastPodsUpdate = new Date().toISOString();
        // 触发统计更新
        appStatusSlice.caseReducers.updateStats(state);
      }
    },

    // 更新单个 Service 状态
    updateServiceStatus: (state, action) => {
      const { serviceName, status } = action.payload;
      const serviceIndex = state.services.findIndex(service => service.metadata?.name === serviceName);

      if (serviceIndex !== -1) {
        state.services[serviceIndex] = { ...state.services[serviceIndex], ...status };
        state.lastServicesUpdate = new Date().toISOString();
        appStatusSlice.caseReducers.updateStats(state);
      }
    },

    // 更新单个 RayJob 状态
    updateRayJobStatus: (state, action) => {
      const { jobName, status } = action.payload;
      const jobIndex = state.rayJobs.findIndex(job => job.metadata?.name === jobName);

      if (jobIndex !== -1) {
        state.rayJobs[jobIndex] = { ...state.rayJobs[jobIndex], ...status };
        state.lastRayJobsUpdate = new Date().toISOString();
        appStatusSlice.caseReducers.updateStats(state);
      }
    },

    // 更新业务服务状态
    updateBusinessServiceStatus: (state, action) => {
      const { serviceName, status } = action.payload;
      const serviceIndex = state.bindingServices.findIndex(service => service.name === serviceName);

      if (serviceIndex !== -1) {
        state.bindingServices[serviceIndex] = { ...state.bindingServices[serviceIndex], ...status };
        state.lastBindingServicesUpdate = new Date().toISOString();
        appStatusSlice.caseReducers.updateStats(state);
      }
    },

    // 更新单个部署状态
    updateDeploymentStatus: (state, action) => {
      const { deploymentName, status } = action.payload;
      const deploymentIndex = state.deployments.findIndex(deployment =>
        deployment.metadata?.name === deploymentName || deployment.modelTag === deploymentName
      );

      if (deploymentIndex !== -1) {
        state.deployments[deploymentIndex] = { ...state.deployments[deploymentIndex], ...status };
        state.lastDeploymentsUpdate = new Date().toISOString();
        appStatusSlice.caseReducers.updateStats(state);
      }
    },

    // 更新单个训练任务状态
    updateTrainingJobStatus: (state, action) => {
      const { jobName, status } = action.payload;
      const jobIndex = state.trainingJobs.findIndex(job =>
        job.metadata?.name === jobName || job.jobName === jobName
      );

      if (jobIndex !== -1) {
        state.trainingJobs[jobIndex] = { ...state.trainingJobs[jobIndex], ...status };
        state.lastTrainingJobsUpdate = new Date().toISOString();
        appStatusSlice.caseReducers.updateStats(state);
      }
    },

    // 计算并更新统计信息
    updateStats: (state) => {
      // Pods 统计
      const podStats = state.pods.reduce((acc, pod) => {
        const phase = pod.status?.phase;
        return {
          totalPods: acc.totalPods + 1,
          runningPods: acc.runningPods + (phase === 'Running' ? 1 : 0),
          pendingPods: acc.pendingPods + (phase === 'Pending' ? 1 : 0),
          failedPods: acc.failedPods + (phase === 'Failed' ? 1 : 0)
        };
      }, {
        totalPods: 0,
        runningPods: 0,
        pendingPods: 0,
        failedPods: 0
      });

      // Services 统计
      const serviceStats = {
        totalServices: state.services.length,
        activeServices: state.services.filter(service =>
          service.spec?.type && service.status?.loadBalancer
        ).length
      };

      // RayJobs 统计
      const rayJobStats = state.rayJobs.reduce((acc, job) => {
        const jobStatus = job.status?.jobStatus;
        return {
          totalRayJobs: acc.totalRayJobs + 1,
          runningRayJobs: acc.runningRayJobs + (jobStatus === 'RUNNING' ? 1 : 0),
          completedRayJobs: acc.completedRayJobs + (jobStatus === 'SUCCEEDED' ? 1 : 0),
          failedRayJobs: acc.failedRayJobs + (jobStatus === 'FAILED' ? 1 : 0)
        };
      }, {
        totalRayJobs: 0,
        runningRayJobs: 0,
        completedRayJobs: 0,
        failedRayJobs: 0
      });

      // 业务服务统计
      const businessServiceStats = {
        totalBindingServices: state.bindingServices.length,
        healthyBindingServices: state.bindingServices.filter(service =>
          service.status === 'healthy' || service.health === 'ok'
        ).length
      };

      // 部署统计
      const deploymentStats = {
        totalDeployments: state.deployments.length,
        activeDeployments: state.deployments.filter(deployment =>
          deployment.status === 'Running' || deployment.replicas > 0
        ).length
      };

      // 训练任务统计
      const trainingJobStats = state.trainingJobs.reduce((acc, job) => {
        const status = job.status || (job.conditions && job.conditions.length > 0 ?
          job.conditions[job.conditions.length - 1].type : 'Unknown');

        return {
          totalTrainingJobs: acc.totalTrainingJobs + 1,
          runningTrainingJobs: acc.runningTrainingJobs + (status === 'Running' ? 1 : 0),
          completedTrainingJobs: acc.completedTrainingJobs + (status === 'Succeeded' || status === 'Complete' ? 1 : 0),
          failedTrainingJobs: acc.failedTrainingJobs + (status === 'Failed' ? 1 : 0)
        };
      }, {
        totalTrainingJobs: 0,
        runningTrainingJobs: 0,
        completedTrainingJobs: 0,
        failedTrainingJobs: 0
      });

      // InferenceEndpointConfig 统计
      const inferenceEndpointStats = {
        totalInferenceEndpoints: state.inferenceEndpoints.length,
        activeInferenceEndpoints: state.inferenceEndpoints.filter(endpoint =>
          endpoint.state === 'InService' ||
          endpoint.deploymentStatus === 'DeploymentComplete' ||
          endpoint.availableReplicas > 0
        ).length
      };

      state.stats = {
        ...podStats,
        ...serviceStats,
        ...rayJobStats,
        ...businessServiceStats,
        ...deploymentStats,        // 新增
        ...trainingJobStats,       // 新增
        ...inferenceEndpointStats
      };
    }
  },
  extraReducers: (builder) => {
    // 处理V2 API组合获取
    builder
      .addCase(fetchAppStatusV2.pending, (state) => {
        state.podsLoading = true;
        state.servicesLoading = true;
        state.podsError = null;
        state.servicesError = null;
      })
      .addCase(fetchAppStatusV2.fulfilled, (state, action) => {
        state.podsLoading = false;
        state.servicesLoading = false;
        state.pods = action.payload.pods;
        state.services = action.payload.services;
        state.lastPodsUpdate = action.payload.timestamp;
        state.lastServicesUpdate = action.payload.timestamp;

        console.log('Redux: Updated pods and services from V2 API:', {
          podsCount: state.pods.length,
          servicesCount: state.services.length
        });

        // 自动更新统计信息
        appStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchAppStatusV2.rejected, (state, action) => {
        state.podsLoading = false;
        state.servicesLoading = false;
        state.podsError = action.payload;
        state.servicesError = action.payload;
        // 清空旧数据
        state.pods = [];
        state.services = [];
      })

    // 处理获取 Pods (保留向后兼容)
      .addCase(fetchPods.pending, (state) => {
        state.podsLoading = true;
        state.podsError = null;
      })
      .addCase(fetchPods.fulfilled, (state, action) => {
        state.podsLoading = false;
        state.pods = action.payload.pods;
        state.lastPodsUpdate = action.payload.timestamp;

        // 自动更新统计信息
        appStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchPods.rejected, (state, action) => {
        state.podsLoading = false;
        state.podsError = action.payload;
        state.pods = [];
      })

    // 处理获取 Services (保留向后兼容)
      .addCase(fetchServices.pending, (state) => {
        state.servicesLoading = true;
        state.servicesError = null;
      })
      .addCase(fetchServices.fulfilled, (state, action) => {
        state.servicesLoading = false;
        state.services = action.payload.services;
        state.lastServicesUpdate = action.payload.timestamp;

        appStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchServices.rejected, (state, action) => {
        state.servicesLoading = false;
        state.servicesError = action.payload;
        state.services = [];
      })

    // 处理获取 RayJobs
      .addCase(fetchRayJobs.pending, (state) => {
        state.rayJobsLoading = true;
        state.rayJobsError = null;
      })
      .addCase(fetchRayJobs.fulfilled, (state, action) => {
        state.rayJobsLoading = false;
        state.rayJobs = action.payload.rayJobs;
        state.lastRayJobsUpdate = action.payload.timestamp;

        appStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchRayJobs.rejected, (state, action) => {
        state.rayJobsLoading = false;
        state.rayJobsError = action.payload;
        state.rayJobs = [];
      })

    // 处理获取业务服务
      .addCase(fetchBindingServices.pending, (state) => {
        state.bindingServicesLoading = true;
        state.bindingServicesError = null;
      })
      .addCase(fetchBindingServices.fulfilled, (state, action) => {
        state.bindingServicesLoading = false;
        state.bindingServices = action.payload.bindingServices;
        state.lastBindingServicesUpdate = action.payload.timestamp;

        appStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchBindingServices.rejected, (state, action) => {
        state.bindingServicesLoading = false;
        state.bindingServicesError = action.payload;
      })

    // 处理获取部署状态
      .addCase(fetchDeployments.pending, (state) => {
        state.deploymentsLoading = true;
        state.deploymentsError = null;
      })
      .addCase(fetchDeployments.fulfilled, (state, action) => {
        state.deploymentsLoading = false;
        state.deployments = action.payload.deployments;
        state.lastDeploymentsUpdate = action.payload.timestamp;

        console.log('Redux: Updated deployments:', {
          deploymentsCount: state.deployments.length
        });

        appStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchDeployments.rejected, (state, action) => {
        state.deploymentsLoading = false;
        state.deploymentsError = action.payload;
      })

    // 处理获取训练任务
      .addCase(fetchTrainingJobs.pending, (state) => {
        state.trainingJobsLoading = true;
        state.trainingJobsError = null;
      })
      .addCase(fetchTrainingJobs.fulfilled, (state, action) => {
        state.trainingJobsLoading = false;
        state.trainingJobs = action.payload.trainingJobs;
        state.lastTrainingJobsUpdate = action.payload.timestamp;

        console.log('Redux: Updated training jobs:', {
          trainingJobsCount: state.trainingJobs.length
        });

        appStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchTrainingJobs.rejected, (state, action) => {
        state.trainingJobsLoading = false;
        state.trainingJobsError = action.payload;
      })

    // 处理获取 InferenceEndpointConfig
      .addCase(fetchInferenceEndpoints.pending, (state) => {
        state.inferenceEndpointsLoading = true;
        state.inferenceEndpointsError = null;
      })
      .addCase(fetchInferenceEndpoints.fulfilled, (state, action) => {
        state.inferenceEndpointsLoading = false;
        state.inferenceEndpoints = action.payload.inferenceEndpoints;
        state.lastInferenceEndpointsUpdate = action.payload.timestamp;

        console.log('Redux: Updated inference endpoints:', {
          inferenceEndpointsCount: state.inferenceEndpoints.length
        });

        appStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchInferenceEndpoints.rejected, (state, action) => {
        state.inferenceEndpointsLoading = false;
        state.inferenceEndpointsError = action.payload;
      })

    // 处理获取 K8s Jobs
      .addCase(fetchK8sJobs.pending, (state) => {
        state.k8sJobsLoading = true;
        state.k8sJobsError = null;
      })
      .addCase(fetchK8sJobs.fulfilled, (state, action) => {
        state.k8sJobsLoading = false;
        state.k8sJobs = action.payload.k8sJobs;
        state.lastK8sJobsUpdate = action.payload.timestamp;
      })
      .addCase(fetchK8sJobs.rejected, (state, action) => {
        state.k8sJobsLoading = false;
        state.k8sJobsError = action.payload;
      })


    // 处理获取 App Status 配置
      .addCase(fetchAppStatusConfig.fulfilled, (state, action) => {
        state.pagesConfig = action.payload.pagesConfig;
        state.tabConfig = action.payload.tabConfig;
        state.recipeConfig = action.payload.recipeConfig;
        state.clusterConfig = action.payload.clusterConfig;
      })

    // 处理组合刷新操作
      .addCase(refreshAllAppStatus.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(refreshAllAppStatus.fulfilled, (state, action) => {
        state.loading = false;
        state.lastUpdate = action.payload.timestamp;

        if (action.payload.errors) {
          console.warn('Some app status refresh operations had errors:', action.payload.errors);
        }
      })
      .addCase(refreshAllAppStatus.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });
  }
});

export const {
  clearError,
  setPodsServices,
  updatePodStatus,
  updateServiceStatus,
  updateRayJobStatus,
  updateBusinessServiceStatus,
  updateDeploymentStatus,        // 新增
  updateTrainingJobStatus,       // 新增
  updateStats
} = appStatusSlice.actions;

export default appStatusSlice.reducer;