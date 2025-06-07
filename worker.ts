// cloudflare_worker.ts

import { ethers } from 'ethers';
import { Monitor } from './monitor';
import { uxBus } from './uxBus';
import { RealTimeErrorHandler, safeAsyncExecute, errorHandler } from './error';
import { QuantumStateManager } from './QuantumStateManager';
import { RecursiveForgeOrchestrator } from './RecursiveForgeOrchestrator';
import { MonetizationEngine } from './MonetizationEngine';
import { AnalyticsDashboard } from './AnalyticsDashboard';

// ---- SSE Streaming Setup ----
const sseClients = new Set<WritableStreamDefaultWriter<Uint8Array>>();

uxBus.sub(evt => {
  const msg = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
  const buf = new TextEncoder().encode(msg);
  for (const w of sseClients) {
    w.write(buf).catch(() => sseClients.delete(w));
  }
});

async function handleStream(req: Request): Promise<Response> {
  if (req.headers.get('accept') !== 'text/event-stream') {
    return new Response('Expected SSE', { status: 400 });
  }
  const stream = new ReadableStream({
    start(ctrl) {
      const writer = ctrl.writable.getWriter();
      const hb = setInterval(() => {
        writer.write(new TextEncoder().encode(':heartbeat\n\n')).catch(() => {});
      }, 15000);
      sseClients.add(writer);
      ctrl.signal.addEventListener('abort', () => {
        clearInterval(hb);
        sseClients.delete(writer);
        writer.close();
      });
    }
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    }
  });
}

// ---- KV-backed Helpers ----
async function handleDashboardRequest(req: Request, env: any): Promise<Response> {
  const kv = env.METAFORGE_KV;
  const url = new URL(req.url);
  const ts = url.searchParams.get('timestamp');
  if (ts) {
    const snap = await kv.get(`dashboard:${ts}`, 'json');
    if (!snap) return new Response(`No snapshot for ${ts}`, { status: 404 });
    return new Response(JSON.stringify(snap), { headers: { 'Content-Type': 'application/json' } });
  }
  const list = await kv.list({ prefix: 'dashboard:', limit: 50 });
  if (!list.keys.length) return new Response('No snapshots', { status: 404 });
  const latest = list.keys.map(k => k.name).sort().pop()!;
  const snap = await kv.get(latest, 'json');
  return new Response(JSON.stringify(snap), { headers: { 'Content-Type': 'application/json' } });
}

async function handleErrorsRequest(req: Request, env: any): Promise<Response> {
  const kv = env.METAFORGE_KV;
  const list = await kv.list({ prefix: 'error:', limit: 50 });
  const keys = list.keys.map(k => k.name).sort().reverse();
  const events = await Promise.all(keys.map(k => kv.get(k, 'json')));
  return new Response(JSON.stringify(events), { headers: { 'Content-Type': 'application/json' } });
}

// ---- Route Definitions ----
const ROUTES: Record<string, (req: Request, env: any, ...params: string[]) => Promise<Response>> = {
  '/api/events':            async (req, env) => handleStream(req),
  '/api/dashboard':         async (req, env) => handleDashboardRequest(req, env),
  '/api/errors':            async (req, env) => handleErrorsRequest(req, env),

  '/api/factory/{address}': async (req, env, address) => {
    const qsm = new QuantumStateManager(env);
    const res = await safeAsyncExecute(
      () => qsm.getFactoryState(address),
      'getFactoryState',
      { address }
    );
    if (res && 'status' in res) {
      const code = res.status === 'circuit_breaker_open' ? 503 : 500;
      return new Response(JSON.stringify(res), {
        status: code,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify(res), {
      headers: { 'Content-Type': 'application/json' }
    });
  },

  '/api/forge/recursive':   async (req, env) => {
    const { factoryAddr, depth } = await req.json();
    const provider = new ethers.providers.JsonRpcProvider(CONFIG.SEPOLIA_RPC);
    const qsm = new QuantumStateManager(env);
    const orchestrator = new RecursiveForgeOrchestrator(provider, qsm);

    const res = await safeAsyncExecute(
      () => orchestrator.forgeRecursive(factoryAddr, depth),
      'forgeRecursive',
      { factoryAddr, depth }
    );
    if (res && 'status' in res) {
      const code = res.status === 'circuit_breaker_open' ? 503 : 500;
      return new Response(JSON.stringify(res), {
        status: code,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify(res), {
      headers: { 'Content-Type': 'application/json' }
    });
  },

  '/api/revenue/projection':async (req, env) => {
    const { factoryAddr, projectedForges } = await req.json();
    const qsm = new QuantumStateManager(env);
    const me  = new MonetizationEngine(qsm);

    const res = await safeAsyncExecute(
      () => me.getRevenueProjection(factoryAddr, projectedForges),
      'getRevenueProjection',
      { factoryAddr, projectedForges }
    );
    if (res && 'status' in res) {
      const code = res.status === 'circuit_breaker_open' ? 503 : 500;
      return new Response(JSON.stringify(res), {
        status: code,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify(res), {
      headers: { 'Content-Type': 'application/json' }
    });
  },

  '/api/analytics/dashboard':async (req, env) =>
    handleDashboardRequest(req, env),
};

// ---- Top-level Fetch Handler ----
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, (event as any).env));
});

async function handleRequest(request: Request, env: any): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    for (const pattern of Object.keys(ROUTES)) {
      const regex = new RegExp('^' + pattern.replace(/\{[^/]+\}/g, '([^/]+)') + '$');
      const m = path.match(regex);
      if (m) {
        return await ROUTES[pattern](request, env, ...m.slice(1));
      }
    }
    return new Response('Not found', { status: 404 });
  } catch (err) {
    const res = await errorHandler.handleError(err as Error, { url: request.url });
    const status = res.status === 'circuit_breaker_open' ? 503 : 500;
    return new Response(JSON.stringify(res), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ---- Configuration ----
const CONFIG = {
  SEPOLIA_RPC:           'https://sepolia.infura.io/v3/demo',
  CACHE_TTL:             3600,
  DASHBOARD_CACHE_TTL:   3600,
  RATE_LIMIT:            1000
};
