import { message } from 'antd';
import operationRefreshManager from '../../hooks/useOperationRefresh';
import resourceEventBus from '../resourceEventBus';
import { fetchClusterStatus } from '../../store/slices/clusterStatusSlice';
import { fetchAppStatusV2 } from '../../store/slices/appStatusSlice';

// Extracted from LegacyRoot's inline handlers (Step 1 era App.js).
// Each function preserves the original message.xxx text, operationRefresh keys,
// and resourceEventBus emits 1:1.

export async function deployService(config) {
  console.log('🚀 deployService called with config:', config);
  try {
    const response = await fetch('/api/deploy-service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const result = await response.json();
    if (result.success) {
      message.success('Business service deployed successfully!');
      operationRefreshManager.triggerOperationRefresh('service-deploy', {
        serviceName: config.serviceName,
        timestamp: new Date().toISOString(),
        source: 'service-config-panel',
      });
      resourceEventBus.emit('app-status-only', {
        serviceName: config.serviceName,
      });
    } else {
      message.error(`Service deployment failed: ${result.error}`);
    }
  } catch (error) {
    console.error('❌ Error deploying service:', error);
    message.error('Failed to deploy service');
  }
}

export async function deployAdvancedScaling(config) {
  try {
    console.log('Deploying advanced scaling configuration:', config);
    const response = await fetch('/api/deploy-advanced-scaling', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const result = await response.json();
    if (result.success) {
      message.success('Advanced scaling stack deployed successfully!');
      operationRefreshManager.triggerOperationRefresh('advanced-scaling-deploy', {
        timestamp: new Date().toISOString(),
        source: 'advanced-scaling-panel',
      });
      resourceEventBus.emit('app-status-only');
    } else {
      message.error(`Advanced scaling deployment failed: ${result.error}`);
    }
  } catch (error) {
    console.error('❌ Error deploying advanced scaling:', error);
    message.error('Failed to deploy advanced scaling stack');
  }
}

export async function deployScaling(config) {
  try {
    console.log('Deploying KEDA scaling configuration:', config);
    let apiEndpoint = '/api/deploy-keda-scaling';
    if (config.type === 'keda-scaling-unified') {
      apiEndpoint = '/api/deploy-keda-scaling-unified';
    }
    console.log(`Using API endpoint: ${apiEndpoint} for config type: ${config.type}`);
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const result = await response.json();
    if (result.success) {
      if (config.type === 'keda-scaling-unified') {
        message.success(`Unified KEDA scaling deployed for service: ${config.serviceName}`);
      } else {
        message.success('KEDA scaling configuration deployed successfully!');
      }
      operationRefreshManager.triggerOperationRefresh('keda-scaling-deploy', {
        timestamp: new Date().toISOString(),
        source: 'scaling-panel',
        configType: config.type,
      });
      resourceEventBus.emit('app-status-only', {
        serviceName: config.serviceName,
        configType: config.type,
      });
    } else {
      message.error(`KEDA scaling deployment failed: ${result.error}`);
      if (result.errors && result.errors.length > 0) {
        result.errors.forEach((e) => message.error(e));
      }
    }
  } catch (error) {
    console.error('❌ Error deploying KEDA scaling:', error);
    message.error('Failed to deploy KEDA scaling configuration');
  }
}

// dispatch 必传：原 handleTrainingLaunch 直接调 App.js 的 fetchClusterStatus /
// fetchPodsAndServices（post-PR1.1 已是壳），这里换成等效的 Redux thunks 以保持
// 在任意路由下都能正常刷新（LegacyRoot 之外也能工作）。
export async function launchTraining(config, dispatch) {
  try {
    // Append timestamp to job name: -MMdd-HHmm
    const now = new Date();
    const ts = `-${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    if (config.jobName) {
      config.jobName = config.jobName + ts;
    } else if (config.trainingJobName) {
      config.trainingJobName = config.trainingJobName + ts;
    }

    console.log('Launching training job with config:', config);

    let apiEndpoint = '/api/launch-training';
    if (config.recipeType === 'torch') {
      apiEndpoint = '/api/launch-torch-training';
    } else if (config.recipeType === 'script') {
      apiEndpoint = '/api/launch-script-training';
    } else if (config.recipeType === 'msswift') {
      apiEndpoint = '/api/launch-msswift-training';
    } else if (config.recipeType === 'hyperpodrun-job') {
      apiEndpoint = '/api/launch-hyperpodrun-job';
    } else if (config.recipeType === 'rayjob') {
      apiEndpoint = '/api/launch-rayjob';
    }
    if (config.recipeType === 'verl') {
      apiEndpoint = '/api/launch-verl-training';
    }
    console.log(`Using API endpoint: ${apiEndpoint} for recipe type: ${config.recipeType}`);

    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const result = await response.json();

    if (result.success) {
      // Refresh cluster + app status via Redux thunks (replaces App.js useCallbacks).
      if (dispatch) {
        dispatch(fetchClusterStatus());
        dispatch(fetchAppStatusV2());
      }
      message.success(result.message || 'Training job launched successfully');
      resourceEventBus.emit('training-launch', {
        recipeType: config.recipeType,
      });
    } else {
      message.error(`Training launch failed: ${result.error}`);
    }
  } catch (error) {
    console.error('Error launching training job:', error);
    message.error('Failed to launch training job');
  }
}
