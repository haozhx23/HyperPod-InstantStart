import { createSlice } from '@reduxjs/toolkit';

// WebSocket lifecycle + latest deployment payload.
// Owned by hooks/useWebSocket.js; components only read via selectors.
const webSocketSlice = createSlice({
  name: 'webSocket',
  initialState: {
    connectionStatus: 'connecting', // 'connecting' | 'connected' | 'disconnected' | 'error'
    deploymentStatus: null,
  },
  reducers: {
    setConnectionStatus: (state, action) => {
      state.connectionStatus = action.payload;
    },
    setDeploymentStatus: (state, action) => {
      state.deploymentStatus = action.payload;
    },
    clearDeploymentStatus: (state) => {
      state.deploymentStatus = null;
    },
  },
});

export const {
  setConnectionStatus,
  setDeploymentStatus,
  clearDeploymentStatus,
} = webSocketSlice.actions;

export default webSocketSlice.reducer;
