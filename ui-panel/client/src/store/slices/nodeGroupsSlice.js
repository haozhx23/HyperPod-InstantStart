import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { switchCluster } from './clustersSlice';

// 异步操作：获取节点组
export const fetchNodeGroups = createAsyncThunk(
  'nodeGroups/fetchNodeGroups',
  async (_, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/cluster/nodegroups');
      if (!response.ok) throw new Error('Failed to fetch node groups');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：创建 HyperPod 集群
export const createHyperPod = createAsyncThunk(
  'nodeGroups/createHyperPod',
  async (formData, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/cluster/create-hyperpod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create HyperPod');
      }
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：删除 HyperPod 集群
export const deleteHyperPod = createAsyncThunk(
  'nodeGroups/deleteHyperPod',
  async (clusterTag, { rejectWithValue }) => {
    try {
      const response = await fetch(`/api/cluster/${clusterTag}/hyperpod`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to delete HyperPod');
      }
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：添加实例组
export const addInstanceGroup = createAsyncThunk(
  'nodeGroups/addInstanceGroup',
  async (userConfig, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/cluster/hyperpod/add-instance-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userConfig }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to add instance group');
      }
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：获取高级功能配置
export const fetchAdvancedFeatures = createAsyncThunk(
  'nodeGroups/fetchAdvancedFeatures',
  async (_, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/cluster/hyperpod/advanced-features');
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch advanced features');
      }
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：更新高级功能配置
export const updateAdvancedFeatures = createAsyncThunk(
  'nodeGroups/updateAdvancedFeatures',
  async (updates, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/cluster/hyperpod/advanced-features', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update advanced features');
      }
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);


// 异步操作：扩展节点组
export const scaleNodeGroup = createAsyncThunk(
  'nodeGroups/scaleNodeGroup',
  async ({ name, count, minSize, maxSize }, { rejectWithValue }) => {
    try {
      const response = await fetch(`/api/cluster/nodegroups/${name}/scale`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          desiredSize: count,
          minSize: minSize,
          maxSize: maxSize
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to scale node group');
      }
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：删除节点组
export const deleteNodeGroup = createAsyncThunk(
  'nodeGroups/deleteNodeGroup',
  async (nodeGroupName, { rejectWithValue }) => {
    try {
      const response = await fetch(`/api/cluster/nodegroup/${nodeGroupName}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to delete node group');
      }
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：检查HyperPod创建状态
export const checkHyperPodCreationStatus = createAsyncThunk(
  'nodeGroups/checkHyperPodCreationStatus',
  async (_, { rejectWithValue }) => {
    try {
      // 先获取当前活跃集群
      const clusterInfoResponse = await fetch('/api/cluster/info');
      const clusterInfo = await clusterInfoResponse.json();
      const activeCluster = clusterInfo.activeCluster;

      if (!activeCluster) {
        return null; // 没有活跃集群
      }

      // 获取创建状态
      const response = await fetch('/api/cluster/creating-hyperpod-clusters');
      const result = await response.json();

      if (response.ok && result.data && result.data[activeCluster]) {
        return result.data[activeCluster]; // 返回详细状态对象
      }

      return null; // 没有创建状态
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

const nodeGroupsSlice = createSlice({
  name: 'nodeGroups',
  initialState: {
    hyperPodGroups: [],
    loading: false,
    error: null,
    hyperPodCreationStatus: null,
    hyperPodDeletionStatus: null,
    instanceGroupAdditionStatus: null,
    nodeGroupDeletionStatus: null,
    nodeGroupScalingStatus: null,
    advancedFeatures: null,
    advancedFeaturesLoading: false,
    advancedFeaturesUpdating: false,
  },
  reducers: {
    clearHyperPodCreationStatus(state) {
      state.hyperPodCreationStatus = null;
    },
    setHyperPodCreationStatus(state, action) {
      state.hyperPodCreationStatus = action.payload;
    },
    setHyperPodDeletionStatus(state, action) {
      state.hyperPodDeletionStatus = action.payload;
    },
    clearNodeGroupOperationStatus(state) {
      state.nodeGroupDeletionStatus = null;
      state.nodeGroupScalingStatus = null;
      state.instanceGroupAdditionStatus = null;
    },
  },
  extraReducers: (builder) => {
    // 处理获取节点组
    builder
      .addCase(fetchNodeGroups.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchNodeGroups.fulfilled, (state, action) => {
        const { hyperPodInstanceGroups } = action.payload;
        state.hyperPodGroups = hyperPodInstanceGroups || [];
        state.loading = false;
      })
      .addCase(fetchNodeGroups.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
        // 清空旧数据，避免显示已删除的节点组
        state.hyperPodGroups = [];
      })

    // 处理创建 HyperPod
      .addCase(createHyperPod.pending, (state) => {
        state.hyperPodCreationStatus = 'creating';
        state.error = null;
      })
      .addCase(createHyperPod.fulfilled, (state, action) => {
        // 使用 API 返回的数据构建状态对象，确保 UI 能正确显示
        state.hyperPodCreationStatus = {
          status: 'IN_PROGRESS',
          phase: 'CREATING_STACK',
          stackName: action.payload.stackName,
          stackId: action.payload.stackId
        };
      })
      .addCase(createHyperPod.rejected, (state, action) => {
        state.hyperPodCreationStatus = 'error';
        state.error = action.payload;
      })

    // 处理删除 HyperPod
      .addCase(deleteHyperPod.pending, (state) => {
        state.hyperPodDeletionStatus = 'deleting';
        state.error = null;
      })
      .addCase(deleteHyperPod.fulfilled, (state) => {
        state.hyperPodDeletionStatus = 'deleted';
        state.hyperPodGroups = [];
      })
      .addCase(deleteHyperPod.rejected, (state, action) => {
        state.hyperPodDeletionStatus = 'error';
        state.error = action.payload;
      })

    // 处理添加实例组
      .addCase(addInstanceGroup.pending, (state) => {
        state.instanceGroupAdditionStatus = 'adding';
        state.error = null;
      })
      .addCase(addInstanceGroup.fulfilled, (state) => {
        state.instanceGroupAdditionStatus = 'added';
      })
      .addCase(addInstanceGroup.rejected, (state, action) => {
        state.instanceGroupAdditionStatus = 'error';
        state.error = action.payload;
      })

    // 处理扩展节点组
      .addCase(scaleNodeGroup.pending, (state) => {
        state.nodeGroupScalingStatus = 'scaling';
        state.error = null;
      })
      .addCase(scaleNodeGroup.fulfilled, (state) => {
        state.nodeGroupScalingStatus = 'scaled';
      })
      .addCase(scaleNodeGroup.rejected, (state, action) => {
        state.nodeGroupScalingStatus = 'error';
        state.error = action.payload;
      })

    // 处理删除节点组
      .addCase(deleteNodeGroup.pending, (state) => {
        state.nodeGroupDeletionStatus = 'deleting';
        state.error = null;
      })
      .addCase(deleteNodeGroup.fulfilled, (state) => {
        state.nodeGroupDeletionStatus = 'deleted';
      })
      .addCase(deleteNodeGroup.rejected, (state, action) => {
        state.nodeGroupDeletionStatus = 'error';
        state.error = action.payload;
      })

    // 处理检查HyperPod创建状态
      .addCase(checkHyperPodCreationStatus.fulfilled, (state, action) => {
        // 来自持久化文件的详细状态对象会覆盖Redux中的简单状态
        // 这确保页面重启后能正确恢复创建状态显示
        state.hyperPodCreationStatus = action.payload;
      })

    // 处理获取高级功能配置
      .addCase(fetchAdvancedFeatures.pending, (state) => {
        state.advancedFeaturesLoading = true;
        state.error = null;
      })
      .addCase(fetchAdvancedFeatures.fulfilled, (state, action) => {
        state.advancedFeatures = action.payload.advancedFeatures;
        state.advancedFeaturesLoading = false;
      })
      .addCase(fetchAdvancedFeatures.rejected, (state, action) => {
        state.advancedFeaturesLoading = false;
        state.error = action.payload;
      })

    // 处理更新高级功能配置
      .addCase(updateAdvancedFeatures.pending, (state) => {
        state.advancedFeaturesUpdating = true;
        state.error = null;
      })
      .addCase(updateAdvancedFeatures.fulfilled, (state) => {
        state.advancedFeaturesUpdating = false;
      })
      .addCase(updateAdvancedFeatures.rejected, (state, action) => {
        state.advancedFeaturesUpdating = false;
        state.error = action.payload;
      })

      // 处理集群切换 - 清空旧集群的节点数据
      .addCase(switchCluster.pending, (state) => {
        // 清空节点组数据，避免显示旧集群的信息
        state.hyperPodGroups = [];
        state.loading = true;
      });
  },
});

export const {
  clearHyperPodCreationStatus,
  setHyperPodCreationStatus,
  setHyperPodDeletionStatus,
  clearNodeGroupOperationStatus,
} = nodeGroupsSlice.actions;

export default nodeGroupsSlice.reducer;