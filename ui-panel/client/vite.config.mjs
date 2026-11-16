// Vite config for the panel UI (replaced Create React App on 2026-11-08).
//
// Behaviour kept from CRA so nothing else has to change:
// - Env vars still come from user.env via `env-cmd -f user.env vite ...`, and
//   code keeps reading them as `process.env.REACT_APP_*`: every REACT_APP_* in
//   the environment is defined at build time (CRA's rule). sync-release.sh
//   still stamps REACT_APP_VERSION into user.env before the build.
// - Output goes to build/ — the Express server, the Dockerfile COPY and
//   sync-release.sh's exclude all point there.
// - JSX lives in .js files (63 of them; renaming would touch release-manifest
//   paths and sentinel records). Vite's Oxc transform skips .js by default, so
//   srcJsJsx() compiles their JSX first (see below).
// - Dev server: port 3000, /api and /ws proxied to the backend on 3001 (CRA's
//   package.json "proxy").
import { defineConfig, transformWithOxc } from 'vite';
import react from '@vitejs/plugin-react';

const SRC_JS = /\/src\/.*\.jsx?$/;

// Vite 8 only treats .jsx/.tsx as JSX. Both the Rolldown build and the Oxc
// Fast Refresh transform decide by extension (the build ignores oxc.lang; the
// refresh transform only runs on files whose name ends in "x" or whose source
// already imports react/jsx-runtime). So compile the JSX in src/**/*.js first,
// to automatic-runtime calls: the build then sees plain JS, and in dev the
// emitted react/jsx-dev-runtime import lets Vite's Oxc pass add the Fast Refresh
// registration as it does for .jsx. node_modules are untouched.
function srcJsJsx() {
  let isBuild = false;
  return {
    name: 'src-js-jsx',
    enforce: 'pre',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    async transform(code, id) {
      const file = id.split('?')[0];
      if (!file.endsWith('.js') || !SRC_JS.test(file) || file.includes('/node_modules/')) return null;
      const result = await transformWithOxc(code, file, {
        lang: 'jsx',
        jsx: { runtime: 'automatic', development: !isBuild },
      });
      return { code: result.code, map: result.map ?? null };
    },
  };
}

function reactAppEnvDefines() {
  const defines = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('REACT_APP_')) defines[`process.env.${key}`] = JSON.stringify(value);
  }
  return defines;
}

export default defineConfig(({ mode }) => {
  const nodeEnv = mode === 'production' ? 'production' : mode === 'test' ? 'test' : 'development';
  const backend = `http://localhost:${process.env.API_PORT || 3001}`;
  const disableHostCheck = process.env.DANGEROUSLY_DISABLE_HOST_CHECK === 'true';
  return {
    plugins: [srcJsJsx(), react({ include: SRC_JS })],
    oxc: {
      include: SRC_JS,
      exclude: /node_modules/,
    },
    optimizeDeps: {
      // The dev-time dependency scan bundles the app's entry graph; let it parse
      // JSX in .js (Rolldown's equivalent of esbuild's loader: { '.js': 'jsx' }).
      rolldownOptions: { moduleTypes: { '.js': 'jsx' } },
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(nodeEnv),
      ...reactAppEnvDefines(),
    },
    preview: {
      allowedHosts: disableHostCheck ? true : undefined,
    },
    build: {
      outDir: 'build',
      emptyOutDir: true,
    },
    server: {
      host: process.env.HOST || 'localhost',
      // CRA honoured DANGEROUSLY_DISABLE_HOST_CHECK=true (set in user.env) and
      // accepted any Host header; Vite only allows localhost and IP addresses by
      // default, so access through a proxy/domain (e.g. code-server) was blocked.
      allowedHosts: disableHostCheck ? true : undefined,
      port: Number(process.env.PORT) || 3000,
      proxy: {
        '/api': backend,
        '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/setupTests.js'],
      include: ['src/**/*.test.{js,jsx}'],
      css: false,
    },
  };
});
