/* Shared render-smoke scaffolding for big monitor/management components.
 * NOT a test file (kept out of __tests__) — imported by the render smoke tests. */
import { configureStore } from '@reduxjs/toolkit';
import appStatusReducer from '../store/slices/appStatusSlice';
import nodeGroupsReducer from '../store/slices/nodeGroupsSlice';
import clustersReducer from '../store/slices/clustersSlice';

export function makeStore() {
  return configureStore({
    reducer: {
      appStatus: appStatusReducer,
      nodeGroups: nodeGroupsReducer,
      clusters: clustersReducer
    }
  });
}

export function installBrowserMocks() {
  global.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
  // NOTE: use a PLAIN function, not jest.fn(). CRA's jest config sets
  // `resetMocks: true`, whose internal beforeEach runs AFTER beforeAll and would
  // wipe a jest.fn's implementation — making fetch() return undefined and crash
  // components that chain `.then` on it inside an unguarded useEffect. A plain
  // function survives resetMocks. These are render-smoke tests; they don't assert
  // on fetch calls, so a stub return is sufficient.
  const fetchStub = () =>
    Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, clusters: [], jobs: [], instanceTypes: [], items: [] }), text: async () => '' });
  global.fetch = fetchStub;
  // components call bare `fetch` (→ window.fetch in jsdom) on mount, so set both.
  if (typeof window !== 'undefined') window.fetch = fetchStub;
  // antd responsive components call matchMedia, which jsdom lacks.
  if (typeof window !== 'undefined' && !window.matchMedia) {
    window.matchMedia = () => ({
      matches: false, media: '', onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; }
    });
  }
}
