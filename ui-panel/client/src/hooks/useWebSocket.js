import { useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { message } from 'antd';
import globalRefreshManager from './useGlobalRefresh';
import operationRefreshManager from './useOperationRefresh';
import { handleWsMessage } from '../utils/wsMessageHandlers';
import { setConnectionStatus } from '../store/slices/webSocketSlice';
import { selectConnectionStatus } from '../store/selectors';
import { getAuthToken } from '../components/AuthGate';

// Singleton WebSocket lifecycle manager. Follows the class-manager pattern of
// useGlobalRefresh / useOperationRefresh. One instance per browser tab.
class WebSocketManager {
  constructor() {
    this.ws = null;
    this.ctx = null;                // { dispatch, message, globalRefresh, operationRefresh }
    this.connectTimeoutId = null;   // 10s connect timeout
    this.reconnectTimeoutId = null; // 5s reconnect delay
    this.pingIntervalId = null;     // 30s heartbeat
    this.disposed = false;
  }

  _setStatus(status) {
    if (this.ctx && this.ctx.dispatch) {
      this.ctx.dispatch(setConnectionStatus(status));
    }
  }

  _clearPing() {
    if (this.pingIntervalId) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
  }

  _startPing() {
    this._clearPing();
    this.pingIntervalId = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'ping',
          timestamp: new Date().toISOString(),
        }));
      }
    }, 30000);
  }

  _scheduleReconnect() {
    if (this.disposed) return;
    if (this.reconnectTimeoutId) return;
    console.log('Attempting to reconnect in 5 seconds...');
    this.reconnectTimeoutId = setTimeout(() => {
      this.reconnectTimeoutId = null;
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this._openSocket();
      }
    }, 5000);
  }

  _openSocket() {
    if (this.disposed) return;
    console.log('Attempting to connect to WebSocket...');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getAuthToken();
    const wsUrl = `${protocol}//${window.location.host}/ws${token ? `?token=${token}` : ''}`;

    console.log(`Connecting to WebSocket: ${wsUrl}`);
    const websocket = new WebSocket(wsUrl);
    this.ws = websocket;

    // 10秒连接超时
    this.connectTimeoutId = setTimeout(() => {
      if (websocket.readyState === WebSocket.CONNECTING) {
        console.log('WebSocket connection timeout, closing...');
        websocket.close();
        this._setStatus('error');
      }
    }, 10000);

    websocket.onopen = () => {
      console.log('WebSocket connected successfully');
      if (this.connectTimeoutId) {
        clearTimeout(this.connectTimeoutId);
        this.connectTimeoutId = null;
      }
      this._setStatus('connected');
      this._startPing();
    };

    websocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('📡 WebSocket message received:', data.type);
        if (this.ctx) {
          handleWsMessage(data, this.ctx);
        }
      } catch (error) {
        console.error('❌ Error parsing WebSocket message:', error);
      }
    };

    websocket.onclose = (event) => {
      console.log('WebSocket disconnected:', event.code, event.reason);
      if (this.connectTimeoutId) {
        clearTimeout(this.connectTimeoutId);
        this.connectTimeoutId = null;
      }
      this._clearPing();
      this.ws = null;
      this._setStatus('disconnected');
      if (event.code !== 1000) {
        this._scheduleReconnect();
      }
    };

    websocket.onerror = (error) => {
      console.error('WebSocket error:', error);
      if (this.connectTimeoutId) {
        clearTimeout(this.connectTimeoutId);
        this.connectTimeoutId = null;
      }
      this._setStatus('error');
    };
  }

  // Called once by the top-level React hook.
  connect(ctx) {
    this.ctx = ctx;
    this.disposed = false;
    // 保留原 App.js 的 1 秒延迟：给后端启动时间
    this.reconnectTimeoutId = setTimeout(() => {
      this.reconnectTimeoutId = null;
      this._openSocket();
    }, 1000);
  }

  disconnect() {
    this.disposed = true;
    if (this.connectTimeoutId) {
      clearTimeout(this.connectTimeoutId);
      this.connectTimeoutId = null;
    }
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    this._clearPing();
    if (this.ws) {
      try {
        this.ws.close(1000, 'Component unmounting');
      } catch (_) {}
      this.ws = null;
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  requestStatusUpdate() {
    const ok = this.send({
      type: 'request_status_update',
      timestamp: new Date().toISOString(),
    });
    if (ok) console.log('📡 Requested WebSocket status update');
    return ok;
  }

  isOpen() {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }
}

const webSocketManager = new WebSocketManager();
export { webSocketManager };

export default function useWebSocket() {
  const dispatch = useDispatch();
  const connectionStatus = useSelector(selectConnectionStatus);
  const ctxRef = useRef(null);

  useEffect(() => {
    // Build ctx once per mount. The manager is a module singleton, so in
    // practice this runs exactly once (App is rendered once under the root).
    ctxRef.current = {
      dispatch,
      message,
      globalRefresh: globalRefreshManager,
      operationRefresh: operationRefreshManager,
    };
    webSocketManager.connect(ctxRef.current);
    return () => {
      webSocketManager.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    connectionStatus,
    requestStatusUpdate: () => webSocketManager.requestStatusUpdate(),
    sendMessage: (obj) => webSocketManager.send(obj),
    isOpen: () => webSocketManager.isOpen(),
  };
}
