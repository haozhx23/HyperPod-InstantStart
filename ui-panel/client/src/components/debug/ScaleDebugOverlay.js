import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useSelector } from 'react-redux';

// Phase S0 measurement overlay — hidden by default.
// Enable via ?debug=scale, localStorage.scaleDebug="1", or Ctrl+Shift+D.
// Purely observational: reads Redux state and patches window.WebSocket on the fly.

const LS_KEY = 'scaleDebug';
const WS_PATCH_FLAG = '__scaleDebugPatched';
const WS_EVENT = '__scaleDebug:wsMessage';

function isEnabledInitially() {
  try {
    const qs = new URLSearchParams(window.location.search);
    if (qs.get('debug') === 'scale') return true;
    if (window.localStorage.getItem(LS_KEY) === '1') return true;
  } catch (_) {}
  return false;
}

function patchWebSocket() {
  if (typeof window === 'undefined') return () => {};
  const Original = window.WebSocket;
  if (!Original || Original[WS_PATCH_FLAG]) return () => {};

  function Patched(url, protocols) {
    const ws = protocols ? new Original(url, protocols) : new Original(url);
    ws.addEventListener('message', (ev) => {
      let bytes = 0;
      const data = ev.data;
      if (typeof data === 'string') {
        bytes = data.length;
      } else if (data && typeof data.byteLength === 'number') {
        bytes = data.byteLength;
      } else if (data && data.size) {
        bytes = data.size;
      }
      window.dispatchEvent(new CustomEvent(WS_EVENT, { detail: { bytes, ts: Date.now() } }));
    });
    return ws;
  }

  Patched.prototype = Original.prototype;
  Patched.CONNECTING = Original.CONNECTING;
  Patched.OPEN = Original.OPEN;
  Patched.CLOSING = Original.CLOSING;
  Patched.CLOSED = Original.CLOSED;
  Patched[WS_PATCH_FLAG] = true;

  window.WebSocket = Patched;
  return () => {
    if (window.WebSocket === Patched) window.WebSocket = Original;
  };
}

function approxBytes(value) {
  if (!value) return 0;
  try {
    return JSON.stringify(value).length;
  } catch (_) {
    return 0;
  }
}

function humanBytes(n) {
  if (!n) return '0';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function useEnabled() {
  const [enabled, setEnabled] = useState(isEnabledInitially);
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        setEnabled((prev) => {
          const next = !prev;
          try {
            if (next) window.localStorage.setItem(LS_KEY, '1');
            else window.localStorage.removeItem(LS_KEY);
          } catch (_) {}
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [enabled, setEnabled];
}

function useLongTasks(enabled) {
  const [longTasks, setLongTasks] = useState({ count: 0, maxMs: 0 });
  useEffect(() => {
    if (!enabled || typeof PerformanceObserver === 'undefined') return;
    let supported = true;
    const obs = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      setLongTasks((prev) => {
        let maxMs = prev.maxMs;
        for (const e of entries) if (e.duration > maxMs) maxMs = e.duration;
        return { count: prev.count + entries.length, maxMs };
      });
    });
    try {
      obs.observe({ type: 'longtask', buffered: true });
    } catch (_) {
      supported = false;
    }
    return () => {
      if (supported) obs.disconnect();
    };
  }, [enabled]);
  return longTasks;
}

function useWsStats(enabled) {
  const [stats, setStats] = useState({ msgs: 0, bytes: 0, lastBytes: 0, lastTs: 0 });
  useEffect(() => {
    if (!enabled) return;
    const teardown = patchWebSocket();
    const onMsg = (ev) => {
      const { bytes, ts } = ev.detail || {};
      setStats((prev) => ({
        msgs: prev.msgs + 1,
        bytes: prev.bytes + (bytes || 0),
        lastBytes: bytes || 0,
        lastTs: ts || Date.now(),
      }));
    };
    window.addEventListener(WS_EVENT, onMsg);
    return () => {
      window.removeEventListener(WS_EVENT, onMsg);
      teardown();
    };
  }, [enabled]);
  return stats;
}

function useHeap(enabled) {
  const [heap, setHeap] = useState(null);
  useEffect(() => {
    if (!enabled) return;
    const mem = typeof performance !== 'undefined' && performance.memory;
    if (!mem) return;
    const tick = () => setHeap(mem.usedJSHeapSize);
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [enabled]);
  return heap;
}

export default function ScaleDebugOverlay() {
  const [enabled, setEnabled] = useEnabled();
  const [collapsed, setCollapsed] = useState(false);

  const pods = useSelector((s) => s.appStatus?.pods || []);
  const services = useSelector((s) => s.appStatus?.services || []);
  const deployments = useSelector((s) => s.appStatus?.deployments || []);
  const trainingJobs = useSelector((s) => s.appStatus?.trainingJobs || []);
  const rayJobs = useSelector((s) => s.appStatus?.rayJobs || []);
  const inferenceEndpoints = useSelector((s) => s.appStatus?.inferenceEndpoints || []);
  const bindingServices = useSelector((s) => s.appStatus?.bindingServices || []);
  const nodes = useSelector((s) => s.clusterStatus?.nodes || []);

  const wsStats = useWsStats(enabled);
  const longTasks = useLongTasks(enabled);
  const heap = useHeap(enabled);

  const sizes = useMemo(() => {
    if (!enabled) return null;
    return {
      pods: approxBytes(pods),
      services: approxBytes(services),
      deployments: approxBytes(deployments),
      trainingJobs: approxBytes(trainingJobs),
      rayJobs: approxBytes(rayJobs),
      inferenceEndpoints: approxBytes(inferenceEndpoints),
      bindingServices: approxBytes(bindingServices),
      nodes: approxBytes(nodes),
    };
  }, [enabled, pods, services, deployments, trainingJobs, rayJobs, inferenceEndpoints, bindingServices, nodes]);

  const totalStateBytes = useMemo(() => {
    if (!sizes) return 0;
    return Object.values(sizes).reduce((a, b) => a + b, 0);
  }, [sizes]);

  const lastPodsUpdateRef = useRef({ len: 0, ts: 0 });
  const [podsRenderMs, setPodsRenderMs] = useState(null);
  useEffect(() => {
    if (!enabled) return;
    const t0 = performance.now();
    if (pods.length !== lastPodsUpdateRef.current.len) {
      requestAnimationFrame(() => {
        const dt = performance.now() - t0;
        setPodsRenderMs(dt);
        lastPodsUpdateRef.current = { len: pods.length, ts: Date.now() };
      });
    }
  }, [enabled, pods]);

  const copySnapshot = useCallback(() => {
    const snap = {
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      counts: {
        pods: pods.length,
        services: services.length,
        deployments: deployments.length,
        trainingJobs: trainingJobs.length,
        rayJobs: rayJobs.length,
        inferenceEndpoints: inferenceEndpoints.length,
        bindingServices: bindingServices.length,
        nodes: nodes.length,
      },
      bytes: sizes,
      totalStateBytes,
      ws: wsStats,
      longTasks,
      heap,
      podsRenderMs,
    };
    try {
      navigator.clipboard.writeText(JSON.stringify(snap, null, 2));
    } catch (_) {
      console.log('[ScaleDebug]', snap);
    }
  }, [pods, services, deployments, trainingJobs, rayJobs, inferenceEndpoints, bindingServices, nodes, sizes, totalStateBytes, wsStats, longTasks, heap, podsRenderMs]);

  if (!enabled) return null;

  const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, fontVariantNumeric: 'tabular-nums' };
  const labelStyle = { color: '#94a3b8' };
  const valStyle = { color: '#f8fafc', fontWeight: 600 };

  return (
    <div
      style={{
        position: 'fixed',
        right: 12,
        bottom: 12,
        zIndex: 99999,
        minWidth: collapsed ? 0 : 260,
        maxWidth: 320,
        background: 'rgba(15, 23, 42, 0.92)',
        color: '#f8fafc',
        borderRadius: 8,
        padding: collapsed ? '6px 10px' : '10px 12px',
        fontSize: 12,
        lineHeight: 1.5,
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        pointerEvents: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, letterSpacing: 0.3 }}>
          {collapsed ? '🔬' : '🔬 Scale Debug'}
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          {!collapsed && (
            <button
              onClick={copySnapshot}
              style={{ background: 'transparent', color: '#93c5fd', border: '1px solid #334155', borderRadius: 4, cursor: 'pointer', fontSize: 11, padding: '0 6px' }}
              title="Copy JSON snapshot to clipboard"
            >copy</button>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            style={{ background: 'transparent', color: '#cbd5e1', border: '1px solid #334155', borderRadius: 4, cursor: 'pointer', fontSize: 11, padding: '0 6px' }}
          >{collapsed ? '▸' : '▾'}</button>
          <button
            onClick={() => {
              try { window.localStorage.removeItem(LS_KEY); } catch (_) {}
              setEnabled(false);
            }}
            style={{ background: 'transparent', color: '#cbd5e1', border: '1px solid #334155', borderRadius: 4, cursor: 'pointer', fontSize: 11, padding: '0 6px' }}
            title="Hide overlay (Ctrl+Shift+D to reopen)"
          >×</button>
        </span>
      </div>

      {!collapsed && (
        <>
          <div style={{ marginTop: 8, borderTop: '1px dashed #334155', paddingTop: 6 }}>
            <div style={rowStyle}><span style={labelStyle}>pods</span><span style={valStyle}>{pods.length}</span></div>
            <div style={rowStyle}><span style={labelStyle}>services</span><span style={valStyle}>{services.length}</span></div>
            <div style={rowStyle}><span style={labelStyle}>deployments</span><span style={valStyle}>{deployments.length}</span></div>
            <div style={rowStyle}><span style={labelStyle}>training jobs</span><span style={valStyle}>{trainingJobs.length}</span></div>
            <div style={rowStyle}><span style={labelStyle}>ray jobs</span><span style={valStyle}>{rayJobs.length}</span></div>
            <div style={rowStyle}><span style={labelStyle}>inf endpoints</span><span style={valStyle}>{inferenceEndpoints.length}</span></div>
            <div style={rowStyle}><span style={labelStyle}>binding svcs</span><span style={valStyle}>{bindingServices.length}</span></div>
            <div style={rowStyle}><span style={labelStyle}>nodes</span><span style={valStyle}>{nodes.length}</span></div>
          </div>

          <div style={{ marginTop: 6, borderTop: '1px dashed #334155', paddingTop: 6 }}>
            <div style={rowStyle}><span style={labelStyle}>state size</span><span style={valStyle}>{humanBytes(totalStateBytes)}</span></div>
            <div style={rowStyle}><span style={labelStyle}>pods bytes</span><span style={valStyle}>{humanBytes(sizes?.pods || 0)}</span></div>
            {heap != null && (
              <div style={rowStyle}><span style={labelStyle}>js heap</span><span style={valStyle}>{humanBytes(heap)}</span></div>
            )}
          </div>

          <div style={{ marginTop: 6, borderTop: '1px dashed #334155', paddingTop: 6 }}>
            <div style={rowStyle}><span style={labelStyle}>ws msgs</span><span style={valStyle}>{wsStats.msgs}</span></div>
            <div style={rowStyle}><span style={labelStyle}>ws total</span><span style={valStyle}>{humanBytes(wsStats.bytes)}</span></div>
            <div style={rowStyle}><span style={labelStyle}>ws last</span><span style={valStyle}>{humanBytes(wsStats.lastBytes)}</span></div>
          </div>

          <div style={{ marginTop: 6, borderTop: '1px dashed #334155', paddingTop: 6 }}>
            <div style={rowStyle}><span style={labelStyle}>longtasks</span><span style={valStyle}>{longTasks.count}</span></div>
            <div style={rowStyle}><span style={labelStyle}>longest</span><span style={valStyle}>{longTasks.maxMs ? `${longTasks.maxMs.toFixed(0)} ms` : '–'}</span></div>
            {podsRenderMs != null && (
              <div style={rowStyle}><span style={labelStyle}>pods Δ→paint</span><span style={valStyle}>{podsRenderMs.toFixed(1)} ms</span></div>
            )}
          </div>

          <div style={{ marginTop: 8, fontSize: 10, color: '#64748b' }}>
            Ctrl+Shift+D toggles. WS counters reflect messages since overlay mount — refresh the page to catch the first status_update.
          </div>
        </>
      )}
    </div>
  );
}
