/**
 * WebSocket 管理器
 * 负责处理 WebSocket 连接和消息，并将消息分发到 Redux store
 */

import { store } from '../store';
import { updateCreatingClusterStatus, checkDependenciesStatus } from '../store/slices/clustersSlice';
import { setHyperPodCreationStatus, setHyperPodDeletionStatus, fetchNodeGroups } from '../store/slices/nodeGroupsSlice';
import { updateDeploymentStatus, fetchDeployments } from '../store/slices/inferenceSlice';
import { updateTrainingStatus, fetchTrainingJobs, updateJobLogs } from '../store/slices/trainingSlice';
import { getAuthToken } from '../components/AuthGate';

class WebSocketManager {
  constructor() {
    this.socket = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectTimeout = null;
    this.listeners = new Map();
    this.isConnected = false;
  }

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      console.log('WebSocket is already connected or connecting');
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getAuthToken();
    const wsUrl = `${protocol}//${window.location.host}/ws${token ? `?token=${token}` : ''}`;

    console.log(`Connecting to WebSocket at ${wsUrl}`);

    this.socket = new WebSocket(wsUrl);

    this.socket.onopen = () => {
      console.log('WebSocket connected');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.dispatchEvent('connected', null);
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('WebSocket message received:', data);

        this.handleMessage(data);
        this.dispatchEvent('message', data);
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
      }
    };

    this.socket.onclose = () => {
      console.log('WebSocket disconnected');
      this.isConnected = false;
      this.dispatchEvent('disconnected', null);

      // 尝试重新连接
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1000 * (2 ** this.reconnectAttempts), 30000);
        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);

        this.reconnectTimeout = setTimeout(() => {
          this.reconnectAttempts++;
          this.connect();
        }, delay);
      } else {
        console.error('Max reconnect attempts reached');
      }
    };

    this.socket.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.dispatchEvent('error', error);
    };
  }

  disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.isConnected = false;
    this.reconnectAttempts = 0;
  }

  send(message) {
    if (!this.isConnected) {
      console.error('Cannot send message, WebSocket is not connected');
      return false;
    }

    try {
      this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
      return true;
    } catch (error) {
      console.error('Error sending message:', error);
      return false;
    }
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }

    this.listeners.get(type).push(callback);
    return () => this.removeEventListener(type, callback);
  }

  removeEventListener(type, callback) {
    if (!this.listeners.has(type)) return;

    const typeListeners = this.listeners.get(type);
    const index = typeListeners.indexOf(callback);

    if (index !== -1) {
      typeListeners.splice(index, 1);
    }
  }

  dispatchEvent(type, data) {
    if (!this.listeners.has(type)) return;

    this.listeners.get(type).forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in ${type} event listener:`, error);
      }
    });
  }

  // 处理 WebSocket 消息并分发 Redux 操作
  handleMessage(data) {
    const { type } = data;

    switch (type) {
      case 'cloudformation_status_change': {
        // 更新创建中集群的状态
        const { clusterTag, status } = data;
        store.dispatch(updateCreatingClusterStatus({ clusterTag, status }));
        break;
      }

      case 'cluster_dependencies_completed': {
        // 依赖配置完成，更新依赖状态
        const activeCluster = store.getState().clusters.activeCluster;
        if (activeCluster) {
          store.dispatch(checkDependenciesStatus(activeCluster));
        }
        break;
      }

      // HyperPod 创建完成
      case 'hyperpod_creation_completed': {
        store.dispatch(setHyperPodCreationStatus(null));
        store.dispatch(fetchNodeGroups());
        break;
      }

      // HyperPod 创建失败
      case 'hyperpod_creation_failed': {
        store.dispatch(setHyperPodCreationStatus(null));
        store.dispatch(fetchNodeGroups());
        break;
      }

      // HyperPod 删除完成
      case 'hyperpod_deletion_completed': {
        store.dispatch(setHyperPodDeletionStatus('completed'));
        store.dispatch(fetchNodeGroups());
        break;
      }

      // 节点组创建完成
      case 'nodegroup_creation_completed': {
        store.dispatch(fetchNodeGroups());
        break;
      }

      // 节点组删除完成
      case 'nodegroup_deletion_completed': {
        store.dispatch(fetchNodeGroups());
        break;
      }

      // 节点组缩放完成
      case 'nodegroup_scaling_completed': {
        store.dispatch(fetchNodeGroups());
        break;
      }

      // 处理推理服务部署消息
      case 'deployment': {
        const { name, status } = data;
        store.dispatch(updateDeploymentStatus({ name, status }));

        // 如果是完成或失败状态，重新获取部署列表
        if (status === 'Running' || status === 'Failed') {
          store.dispatch(fetchDeployments());
        }
        break;
      }

      // 处理训练作业消息
      case 'training_launch': {
        const { jobName, status, logs } = data;

        // 更新训练作业状态
        if (jobName && status) {
          store.dispatch(updateTrainingStatus({ jobName, status }));
        }

        // 更新训练作业日志
        if (jobName && logs) {
          store.dispatch(updateJobLogs({ jobName, logs }));
        }

        // 如果是完成或失败状态，重新获取训练作业列表
        if (status === 'Completed' || status === 'Failed') {
          store.dispatch(fetchTrainingJobs());
        }
        break;
      }

      // 处理训练日志更新
      case 'training_log_update': {
        const { jobName, logs } = data;
        if (jobName && logs) {
          store.dispatch(updateJobLogs({ jobName, logs }));
        }
        break;
      }

      // 处理MLflow相关消息
      case 'mlflow_server_created': {
        store.dispatch(fetchTrainingJobs());
        break;
      }

      case 'mlflow_sync_completed': {
        store.dispatch(fetchTrainingJobs());
        break;
      }

      default:
        console.log(`Unknown message type: ${type}`);
        break;
    }
  }
}

// 创建单例实例
const webSocketManager = new WebSocketManager();

export default webSocketManager;