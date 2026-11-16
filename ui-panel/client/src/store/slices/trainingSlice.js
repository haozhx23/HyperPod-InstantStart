import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

// 异步操作：获取训练历史
export const fetchTrainingHistory = createAsyncThunk(
  'training/fetchTrainingHistory',
  async (_, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/training-history');
      if (!response.ok) throw new Error('Failed to fetch training history');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：获取训练作业列表
export const fetchTrainingJobs = createAsyncThunk(
  'training/fetchTrainingJobs',
  async (_, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/training-jobs');
      if (!response.ok) throw new Error('Failed to fetch training jobs');
      const result = await response.json();
      return result.success ? result.jobs : [];
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：启动 PyTorch 训练
export const launchTorchTraining = createAsyncThunk(
  'training/launchTorchTraining',
  async (trainingConfig, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/launch-torch-training', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trainingConfig),
      });

      if (!response.ok) throw new Error('Failed to launch PyTorch training');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：启动 LlamaFactory 训练
export const launchLlamaFactoryTraining = createAsyncThunk(
  'training/launchLlamaFactoryTraining',
  async (trainingConfig, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/launch-training', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trainingConfig),
      });

      if (!response.ok) throw new Error('Failed to launch LlamaFactory training');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：启动脚本训练
export const launchScriptTraining = createAsyncThunk(
  'training/launchScriptTraining',
  async (trainingConfig, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/launch-script-training', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trainingConfig),
      });

      if (!response.ok) throw new Error('Failed to launch script training');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：启动 VERL 训练
export const launchVerlTraining = createAsyncThunk(
  'training/launchVerlTraining',
  async (trainingConfig, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/launch-verl-training', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trainingConfig),
      });

      if (!response.ok) throw new Error('Failed to launch VERL training');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);


// 异步操作：删除训练作业
export const deleteTrainingJob = createAsyncThunk(
  'training/deleteTrainingJob',
  async (jobName, { rejectWithValue }) => {
    try {
      const response = await fetch(`/api/hyperpod-jobs/${jobName}`, {
        method: 'DELETE',
      });

      if (!response.ok) throw new Error('Failed to delete training job');
      return { jobName, ...await response.json() };
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：配置 MLflow 认证
export const configureMlflowAuth = createAsyncThunk(
  'training/configureMlflowAuth',
  async (_, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/configure-mlflow-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) throw new Error('Failed to configure MLflow authentication');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：创建 MLflow Tracking Server
export const createMlflowTrackingServer = createAsyncThunk(
  'training/createMlflowTrackingServer',
  async (config, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/create-mlflow-tracking-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!response.ok) throw new Error('Failed to create MLflow tracking server');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：同步 MLflow 数据
export const syncMlflow = createAsyncThunk(
  'training/syncMlflow',
  async (config, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/mlflow-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!response.ok) throw new Error('Failed to sync MLflow data');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

const trainingSlice = createSlice({
  name: 'training',
  initialState: {
    history: [],
    jobs: [],
    activeJob: null,
    loading: false,
    error: null,
    trainingStatus: null,
    deleteStatus: null,
    mlflowAuthStatus: null,
    mlflowServerStatus: null,
    mlflowSyncStatus: null,
    jobLogs: {},
  },
  reducers: {
    setActiveJob(state, action) {
      state.activeJob = action.payload;
    },
    updateTrainingStatus(state, action) {
      const { jobName, status } = action.payload;
      const job = state.jobs.find(j => j.name === jobName);
      if (job) {
        job.status = status;
      }
    },
    clearTrainingStatus(state) {
      state.trainingStatus = null;
      state.deleteStatus = null;
    },
    updateJobLogs(state, action) {
      const { jobName, logs } = action.payload;

      if (!state.jobLogs[jobName]) {
        state.jobLogs[jobName] = [];
      }

      // 添加新日志，避免重复
      const existingLogs = state.jobLogs[jobName];
      const newLogs = logs.filter(log => {
        const isDuplicate = existingLogs.some(
          existingLog => existingLog.timestamp === log.timestamp && existingLog.message === log.message
        );
        return !isDuplicate;
      });

      state.jobLogs[jobName] = [...existingLogs, ...newLogs];
    },
    clearMlflowStatus(state) {
      state.mlflowAuthStatus = null;
      state.mlflowServerStatus = null;
      state.mlflowSyncStatus = null;
    },
  },
  extraReducers: (builder) => {
    // 处理获取训练历史
    builder
      .addCase(fetchTrainingHistory.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchTrainingHistory.fulfilled, (state, action) => {
        state.history = action.payload || [];
        state.loading = false;
      })
      .addCase(fetchTrainingHistory.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

    // 处理获取训练作业
      .addCase(fetchTrainingJobs.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchTrainingJobs.fulfilled, (state, action) => {
        state.jobs = action.payload || [];
        state.loading = false;
      })
      .addCase(fetchTrainingJobs.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

    // 处理 PyTorch 训练
      .addCase(launchTorchTraining.pending, (state) => {
        state.trainingStatus = 'launching';
        state.error = null;
      })
      .addCase(launchTorchTraining.fulfilled, (state) => {
        state.trainingStatus = 'launched';
      })
      .addCase(launchTorchTraining.rejected, (state, action) => {
        state.trainingStatus = 'error';
        state.error = action.payload;
      })

    // 处理 LlamaFactory 训练
      .addCase(launchLlamaFactoryTraining.pending, (state) => {
        state.trainingStatus = 'launching';
        state.error = null;
      })
      .addCase(launchLlamaFactoryTraining.fulfilled, (state) => {
        state.trainingStatus = 'launched';
      })
      .addCase(launchLlamaFactoryTraining.rejected, (state, action) => {
        state.trainingStatus = 'error';
        state.error = action.payload;
      })

    // 处理脚本训练
      .addCase(launchScriptTraining.pending, (state) => {
        state.trainingStatus = 'launching';
        state.error = null;
      })
      .addCase(launchScriptTraining.fulfilled, (state) => {
        state.trainingStatus = 'launched';
      })
      .addCase(launchScriptTraining.rejected, (state, action) => {
        state.trainingStatus = 'error';
        state.error = action.payload;
      })

    // 处理 VERL 训练
      .addCase(launchVerlTraining.pending, (state) => {
        state.trainingStatus = 'launching';
        state.error = null;
      })
      .addCase(launchVerlTraining.fulfilled, (state) => {
        state.trainingStatus = 'launched';
      })
      .addCase(launchVerlTraining.rejected, (state, action) => {
        state.trainingStatus = 'error';
        state.error = action.payload;
      })


    // 处理删除训练作业
      .addCase(deleteTrainingJob.pending, (state) => {
        state.deleteStatus = 'deleting';
        state.error = null;
      })
      .addCase(deleteTrainingJob.fulfilled, (state, action) => {
        state.deleteStatus = 'deleted';
        const { jobName } = action.payload;
        state.jobs = state.jobs.filter(j => j.name !== jobName);

        // 清理相关日志
        if (state.jobLogs[jobName]) {
          delete state.jobLogs[jobName];
        }
      })
      .addCase(deleteTrainingJob.rejected, (state, action) => {
        state.deleteStatus = 'error';
        state.error = action.payload;
      })

    // 处理 MLflow 认证配置
      .addCase(configureMlflowAuth.pending, (state) => {
        state.mlflowAuthStatus = 'configuring';
        state.error = null;
      })
      .addCase(configureMlflowAuth.fulfilled, (state) => {
        state.mlflowAuthStatus = 'configured';
      })
      .addCase(configureMlflowAuth.rejected, (state, action) => {
        state.mlflowAuthStatus = 'error';
        state.error = action.payload;
      })

    // 处理 MLflow Tracking Server 创建
      .addCase(createMlflowTrackingServer.pending, (state) => {
        state.mlflowServerStatus = 'creating';
        state.error = null;
      })
      .addCase(createMlflowTrackingServer.fulfilled, (state) => {
        state.mlflowServerStatus = 'created';
      })
      .addCase(createMlflowTrackingServer.rejected, (state, action) => {
        state.mlflowServerStatus = 'error';
        state.error = action.payload;
      })

    // 处理 MLflow 同步
      .addCase(syncMlflow.pending, (state) => {
        state.mlflowSyncStatus = 'syncing';
        state.error = null;
      })
      .addCase(syncMlflow.fulfilled, (state) => {
        state.mlflowSyncStatus = 'synced';
      })
      .addCase(syncMlflow.rejected, (state, action) => {
        state.mlflowSyncStatus = 'error';
        state.error = action.payload;
      });
  },
});

export const {
  setActiveJob,
  updateTrainingStatus,
  clearTrainingStatus,
  updateJobLogs,
  clearMlflowStatus,
} = trainingSlice.actions;

export default trainingSlice.reducer;