import { setPodsServices } from '../store/slices/appStatusSlice';
import { setDeploymentStatus } from '../store/slices/webSocketSlice';

// 1:1 port of the WebSocket message switch that used to live in App.js (94-454).
// ctx = {
//   dispatch,            // Redux dispatch
//   message,             // antd message API
//   globalRefresh,       // globalRefreshManager instance
//   operationRefresh,    // operationRefreshManager instance
// }
// Each case preserves the exact text, call order, and refresh trigger semantics
// of the original inline switch. Do not change behavior here without a matching
// Plan update — this file is the "reference implementation" of pre-refactor WS.
export function handleWsMessage(data, ctx) {
  const { dispatch, message, globalRefresh, operationRefresh } = ctx;

  switch (data.type) {
    case 'status_update':
      console.log('📊 Status update:', data.pods?.length, 'pods,', data.services?.length, 'services');
      dispatch(setPodsServices({ pods: data.pods || [], services: data.services || [] }));
      break;

    case 'request_status_update_broadcast':
      console.log('🔄 Server requested status update');
      globalRefresh.triggerGlobalRefresh({
        source: 'websocket-broadcast',
        silent: true,
      });
      break;

    case 'pong':
      console.log('❤️ WebSocket pong received');
      break;

    case 'deployment':
      dispatch(setDeploymentStatus(data));
      if (data.status === 'success') {
        message.success(data.message);
        operationRefresh.triggerOperationRefresh('model-deploy', data);
      } else {
        message.error(data.message);
      }
      break;

    case 'service_deployment':
      if (data.status === 'success') {
        message.success(data.message);
        operationRefresh.triggerOperationRefresh('service-deploy', data);
      } else {
        message.error(data.message);
      }
      break;

    case 'service_deleted':
      if (data.status === 'success') {
        message.success(data.message);
        operationRefresh.triggerOperationRefresh('service-delete', data);
      } else {
        message.error(data.message);
      }
      break;

    case 'training_launch':
      operationRefresh.triggerOperationRefresh('training-start', data);
      break;

    case 'nodegroup_creation_started':
      if (data.status === 'success' || data.status === 'info') {
        message.success(data.message);
      } else {
        message.error(data.message);
      }
      operationRefresh.triggerOperationRefresh('nodegroup-create', data);
      break;

    case 'nodegroup_creation_completed':
      if (data.status === 'success') {
        message.success(data.message);
      } else {
        message.error(data.message);
      }
      operationRefresh.triggerOperationRefresh('nodegroup-create', data);
      break;

    case 'nodegroup_creation_failed':
      message.error(data.message);
      operationRefresh.triggerOperationRefresh('nodegroup-create', data);
      break;

    case 'nodegroup_dependencies_started':
      if (data.status === 'success' || data.status === 'info') {
        message.info(data.message);
      }
      break;

    case 'nodegroup_dependencies_completed':
      if (data.status === 'success') {
        message.success(data.message);
      } else {
        message.error(data.message);
      }
      operationRefresh.triggerOperationRefresh('nodegroup-create', data);
      break;

    case 'nodegroup_dependencies_failed':
      message.error(data.message);
      operationRefresh.triggerOperationRefresh('nodegroup-create', data);
      break;

    case 'hyperpod_creation_started':
      if (data.status === 'success' || data.status === 'info') {
        message.info(data.message);
        operationRefresh.triggerOperationRefresh('hyperpod-create', data);
      } else {
        message.error(data.message);
      }
      break;

    case 'hyperpod_creation_completed':
      if (data.status === 'success') {
        message.success(data.message);
        operationRefresh.triggerOperationRefresh('hyperpod-create', data);
      }
      break;

    case 'hyperpod_creation_failed':
      message.error(data.message);
      operationRefresh.triggerOperationRefresh('hyperpod-create', data);
      break;

    case 'hyperpod_deletion_started':
      message.info(data.message);
      operationRefresh.triggerOperationRefresh('hyperpod-delete', data);
      break;

    case 'hyperpod_deletion_completed':
      message.success('HyperPod cluster deleted successfully');
      operationRefresh.triggerOperationRefresh('hyperpod-delete', data);
      break;

    case 'hyperpod_deletion_failed':
      message.error('HyperPod deletion failed');
      operationRefresh.triggerOperationRefresh('hyperpod-delete', data);
      break;

    case 'karpenter_installation_completed':
      message.success('Karpenter installation completed successfully');
      break;

    case 'karpenter_installation_failed':
      message.error('Karpenter installation failed');
      break;

    case 'karpenter_uninstallation_completed':
      message.success('Karpenter uninstallation completed successfully');
      break;

    case 'karpenter_uninstallation_failed':
      message.error('Karpenter uninstallation failed');
      break;

    case 'undeployment':
      if (data.status === 'success') {
        message.success(data.message);
        operationRefresh.triggerOperationRefresh('model-undeploy', data);
      } else {
        message.error(data.message);
      }
      break;

    case 'sglang_router_deletion':
      if (data.status === 'success') {
        message.success(`Router "${data.deploymentName}" deleted successfully`);
        operationRefresh.triggerOperationRefresh('router-delete', data);
      } else {
        message.error(`Failed to delete Router: ${data.error}`);
      }
      break;

    case 'rayjob_deleted':
      operationRefresh.triggerOperationRefresh('rayjob-delete', data);
      break;

    case 'pod_assigned':
      if (data.status === 'success') {
        message.success(data.message);
        operationRefresh.triggerOperationRefresh('pod-assign', data);
      } else {
        message.error(data.message);
      }
      break;

    case 'training_job_deleted':
      operationRefresh.triggerOperationRefresh('training-delete', data);
      break;

    case 'model_download':
      if (data.status === 'success') {
        message.success(data.message);
        operationRefresh.triggerOperationRefresh('model-download', data);
      } else {
        message.error(data.message);
      }
      break;

    case 'nodegroup_updated':
      if (data.status === 'success') {
        message.success(data.message);
        operationRefresh.triggerOperationRefresh('nodegroup-scale', data);
      } else {
        message.error(data.message);
      }
      break;

    case 'hyperpod_software_update':
      if (data.status === 'success') {
        message.success(data.message);
        operationRefresh.triggerOperationRefresh('hyperpod-software-update', data);
      } else {
        message.error(data.message);
      }
      break;

    case 'cluster_dependencies_started':
      if (data.status === 'success' || data.status === 'info') {
        message.info(data.message);
      }
      break;

    case 'cluster_dependencies_completed':
      if (data.status === 'success') {
        message.success(data.message);
        globalRefresh.triggerGlobalRefresh();
      }
      break;

    case 'cluster_dependencies_failed':
      if (data.status === 'warning') {
        message.warning(data.message);
        globalRefresh.triggerGlobalRefresh();
      } else {
        message.error(data.message);
      }
      break;

    case 'cluster_creation_cancelled':
      if (data.status === 'info') {
        message.info(data.message);
      }
      break;

    case 'cluster_creation_cancel_failed':
      if (data.status === 'error') {
        message.error(data.message);
      }
      break;

    case 'keda_deployment':
      if (data.status === 'success') {
        message.success(data.message);
        operationRefresh.triggerOperationRefresh('keda-deploy', data);
      } else {
        message.error(data.message);
      }
      break;

    case 'keda_scaledobject_deleted':
      if (data.status === 'success') {
        message.success(data.message);
        operationRefresh.triggerOperationRefresh('keda-delete', data);
      } else {
        message.error(data.message);
      }
      break;

    case 'sglang_router_deployment':
      if (data.status === 'success') {
        message.success(data.message);
        operationRefresh.triggerOperationRefresh('sglang-router-deploy', data);
      } else {
        message.error(data.message);
      }
      break;

    default:
      console.log('❓ Unknown message type:', data.type);
      break;
  }
}
