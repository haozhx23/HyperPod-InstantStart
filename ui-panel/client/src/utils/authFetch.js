import { getAuthToken } from '../components/AuthGate';

// Intercept all fetch calls to inject auth token
const originalFetch = window.fetch;
window.fetch = function (url, options = {}) {
  const token = getAuthToken();
  if (token) {
    options.headers = {
      ...options.headers,
      'x-auth-token': token,
    };
  }
  return originalFetch.call(this, url, options);
};
