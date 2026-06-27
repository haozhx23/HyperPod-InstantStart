/**
 * appStatusThunks.js — app-status fetch thunks (split out of appStatusSlice.js, Phase 4).
 * Behavior-preserving: same thunks, re-exported by appStatusSlice.js so all existing
 * imports keep working. Only the sentinel-free public thunks live here.
 */
import { createAsyncThunk } from '@reduxjs/toolkit';

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
