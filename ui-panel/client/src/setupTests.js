// CRA auto-loads this before every test. jsdom lacks several browser globals
// that components touch on mount (fetch, matchMedia, WebSocket); provide inert
// defaults so render-smoke tests can mount components without crashing.
// Individual tests may still override global.fetch with a jest.fn() to assert calls.

if (!global.fetch) {
  global.fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ success: true, clusters: [], jobs: [], instanceTypes: [], items: [] }),
      text: async () => ''
    });
}
if (typeof window !== 'undefined' && !window.fetch) {
  window.fetch = global.fetch;
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = () => ({
    matches: false, media: '', onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; }
  });
}

if (!global.WebSocket) {
  global.WebSocket = class {
    constructor() { this.readyState = 0; }
    send() {} close() {}
    addEventListener() {} removeEventListener() {}
  };
}
