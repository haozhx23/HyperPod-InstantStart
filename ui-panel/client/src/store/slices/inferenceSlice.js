import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

// 异步操作：获取部署列表
export const fetchDeployments = createAsyncThunk(
  'inference/fetchDeployments',
  async (_, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/deployments');
      if (!response.ok) throw new Error('Failed to fetch deployments');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：部署模型
// @deprecated - 组件已直接调用 API:
//   ConfigPanel.js -> /api/deploy/container
//   ManagedInferencePanel.js -> /api/deploy/managed-inference
export const deployModel = createAsyncThunk(
  'inference/deployModel',
  async (deploymentConfig, { rejectWithValue }) => {
    try {
      // 根据 deploymentType 选择 API 端点
      let apiEndpoint = '/api/deploy/container';
      if (deploymentConfig.deploymentType === 'managed-inference') {
        apiEndpoint = '/api/deploy/managed-inference';
      }

      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deploymentConfig),
      });

      if (!response.ok) throw new Error('Failed to deploy model');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：部署服务（模型池使用）
export const deployService = createAsyncThunk(
  'inference/deployService',
  async (serviceConfig, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/deploy-service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serviceConfig),
      });

      if (!response.ok) throw new Error('Failed to deploy service');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：取消部署
export const undeployModel = createAsyncThunk(
  'inference/undeployModel',
  async (modelTag, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/undeploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelTag,
          deleteType: 'all'
        }),
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'Failed to undeploy model');
      }

      return { name: modelTag, ...result };
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：缩放部署
export const scaleDeployment = createAsyncThunk(
  'inference/scaleDeployment',
  async ({ name, replicas }, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/scale-deployment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, replicas }),
      });

      if (!response.ok) throw new Error('Failed to scale deployment');
      return { name, replicas, ...await response.json() };
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：发送请求到模型
export const sendModelRequest = createAsyncThunk(
  'inference/sendModelRequest',
  async ({ url, data, method = 'POST' }, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/proxy-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, data, method }),
      });

      if (!response.ok) throw new Error('Failed to send model request');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

const inferenceSlice = createSlice({
  name: 'inference',
  initialState: {
    deployments: [],
    services: [],
    loading: false,
    error: null,
    deployStatus: null,
    serviceStatus: null,
    undeployStatus: null,
    scaleStatus: null,
    testResults: null,
    testLoading: false,
    testError: null,
  },
  reducers: {
    updateDeploymentStatus(state, action) {
      const { name, status } = action.payload;
      const deployment = state.deployments.find(d => d.name === name);
      if (deployment) {
        deployment.status = status;
      }
    },
    clearDeployStatus(state) {
      state.deployStatus = null;
      state.undeployStatus = null;
      state.scaleStatus = null;
      state.serviceStatus = null;
    },
    clearTestResults(state) {
      state.testResults = null;
      state.testError = null;
    },
  },
  extraReducers: (builder) => {
    // 处理获取部署列表
    builder
      .addCase(fetchDeployments.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchDeployments.fulfilled, (state, action) => {
        // 分离部署和服务
        const allItems = action.payload || [];
        state.deployments = allItems.filter(item => !item.isService);
        state.services = allItems.filter(item => item.isService);
        state.loading = false;
      })
      .addCase(fetchDeployments.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

    // 处理部署模型
      .addCase(deployModel.pending, (state) => {
        state.deployStatus = 'deploying';
        state.error = null;
      })
      .addCase(deployModel.fulfilled, (state, action) => {
        state.deployStatus = 'deployed';
        // 不直接添加部署，等待下一次 fetchDeployments 刷新
      })
      .addCase(deployModel.rejected, (state, action) => {
        state.deployStatus = 'error';
        state.error = action.payload;
      })

    // 处理部署服务
      .addCase(deployService.pending, (state) => {
        state.serviceStatus = 'deploying';
        state.error = null;
      })
      .addCase(deployService.fulfilled, (state, action) => {
        state.serviceStatus = 'deployed';
        // 不直接添加服务，等待下一次 fetchDeployments 刷新
      })
      .addCase(deployService.rejected, (state, action) => {
        state.serviceStatus = 'error';
        state.error = action.payload;
      })

    // 处理取消部署
      .addCase(undeployModel.pending, (state) => {
        state.undeployStatus = 'undeploying';
        state.error = null;
      })
      .addCase(undeployModel.fulfilled, (state, action) => {
        state.undeployStatus = 'undeployed';
        // 从列表中移除已取消部署的项目
        const { name } = action.payload;
        state.deployments = state.deployments.filter(d => d.name !== name);
        state.services = state.services.filter(s => s.name !== name);
      })
      .addCase(undeployModel.rejected, (state, action) => {
        state.undeployStatus = 'error';
        state.error = action.payload;
      })

    // 处理缩放部署
      .addCase(scaleDeployment.pending, (state) => {
        state.scaleStatus = 'scaling';
        state.error = null;
      })
      .addCase(scaleDeployment.fulfilled, (state, action) => {
        state.scaleStatus = 'scaled';
        // 更新部署的副本数
        const { name, replicas } = action.payload;
        const deployment = state.deployments.find(d => d.name === name);
        if (deployment) {
          deployment.replicas = replicas;
        }
      })
      .addCase(scaleDeployment.rejected, (state, action) => {
        state.scaleStatus = 'error';
        state.error = action.payload;
      })

    // 处理模型请求
      .addCase(sendModelRequest.pending, (state) => {
        state.testLoading = true;
        state.testError = null;
      })
      .addCase(sendModelRequest.fulfilled, (state, action) => {
        state.testResults = action.payload;
        state.testLoading = false;
      })
      .addCase(sendModelRequest.rejected, (state, action) => {
        state.testError = action.payload;
        state.testLoading = false;
      });
  },
});

export const {
  updateDeploymentStatus,
  clearDeployStatus,
  clearTestResults,
} = inferenceSlice.actions;

export default inferenceSlice.reducer;