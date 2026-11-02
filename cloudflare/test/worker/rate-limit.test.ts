import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { newSessionId } from '../../src/core/session-id';
import worker from '../../src/index';
import { checkRateLimit } from '../../src/routes/rate-limit';
import { captureLogs } from './helpers/logs';

// The app limits each client IP: /mcp requests with MCP_RATE_LIMITER (120 a minute) and /ws upgrades with
// WS_RATE_LIMITER (30 a minute), both [[ratelimits]] bindings of wrangler.toml. vitest.config.ts raises both limits
// for the tests, which all come from one address; these tests give the entry limiters of their own.

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE = 'https://djopus.test';

/** A limiter that records what it is asked, and answers `success`. */
function limiter(success: boolean): RateLimit & { calls: RateLimitOptions[] } {
  const calls: RateLimitOptions[] = [];
  return {
    calls,
    async limit(options) {
      calls.push(options);
      return { success };
    },
  };
}

function envWith(bindings: Partial<Record<'MCP_RATE_LIMITER' | 'WS_RATE_LIMITER', RateLimit>>): Env {
  return { ...env, ...bindings } as unknown as Env;
}

// --- checkRateLimit ---

it('a failed rate limit returns 429', async () => {
  const res = await checkRateLimit({ limit: async () => ({ success: false }) }, new Request(`${BASE}/mcp`));
  expect(res?.status).toBe(429);
  expect(res?.headers.get('Retry-After')).toBe('60');
  expect(await res?.json()).toEqual({ error: 'Too many requests' });
});

it('lets a request under the limit through, keyed on CF-Connecting-IP', async () => {
  const open = limiter(true);
  expect(await checkRateLimit(open, new Request(`${BASE}/mcp`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } }))).toBeNull();
  expect(open.calls).toEqual([{ key: '203.0.113.9' }]);
});

it('keys a request without CF-Connecting-IP as unknown', async () => {
  const closed = limiter(false);
  expect((await checkRateLimit(closed, new Request(`${BASE}/ws`)))?.status).toBe(429);
  expect(closed.calls).toEqual([{ key: 'unknown' }]);
});

it('the app has both limiters bound', () => {
  expect(typeof env.MCP_RATE_LIMITER.limit).toBe('function');
  expect(typeof env.WS_RATE_LIMITER.limit).toBe('function');
});

// --- /ws ---

function wsUpgrade(headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/ws?session=${newSessionId()}`, { headers: { Upgrade: 'websocket', Origin: BASE, ...headers } });
}

it('refuses a /ws upgrade over the limit with 429 and logs ws_reject rate_limited, and nothing else', async () => {
  const logs = captureLogs();
  const ws = limiter(false);
  const mcp = limiter(true);
  const res = await worker.fetch(wsUpgrade({ 'CF-Connecting-IP': '203.0.113.7' }), envWith({ WS_RATE_LIMITER: ws, MCP_RATE_LIMITER: mcp }), createExecutionContext());
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe('60');
  expect(await res.json()).toEqual({ error: 'Too many requests' });
  expect(ws.calls).toEqual([{ key: '203.0.113.7' }]);
  expect(mcp.calls).toEqual([]); // /ws has a limiter of its own
  expect(logs.events()).toEqual([{ event: 'ws_reject', reason: 'rate_limited' }]);
  expect(logs.lines().join('\n')).not.toContain('203.0.113.7');
});

it('lets a /ws upgrade under the limit go on to the rules', async () => {
  const ws = limiter(true);
  const res = await worker.fetch(wsUpgrade({ 'CF-Connecting-IP': '203.0.113.8' }), envWith({ WS_RATE_LIMITER: ws }), createExecutionContext());
  expect(res.status).toBe(101);
  res.webSocket?.accept();
  res.webSocket?.close(1000);
  expect(ws.calls).toEqual([{ key: '203.0.113.8' }]);

  // A refusal by the rules still counts: the limit is on attempts.
  const legacy = await worker.fetch(new Request(`${BASE}/ws?session=opus-ab12`, { headers: { Upgrade: 'websocket', Origin: BASE } }), envWith({ WS_RATE_LIMITER: ws }), createExecutionContext());
  expect(legacy.status).toBe(400);
  expect(ws.calls).toHaveLength(2);
});

it('does not count a /ws request that is not an upgrade', async () => {
  const ws = limiter(false);
  const res = await worker.fetch(new Request(`${BASE}/ws?session=${newSessionId()}`), envWith({ WS_RATE_LIMITER: ws }), createExecutionContext());
  expect(res.status).toBe(426);
  await res.arrayBuffer();
  expect(ws.calls).toEqual([]);
});

// --- /mcp ---

it('refuses an /mcp request over the limit with 429 before McpAgent sees it', async () => {
  const logs = captureLogs();
  const mcp = limiter(false);
  const ws = limiter(true);
  const request = new Request(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': '198.51.100.4' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'limits', version: '0' } } }),
  });
  const res = await worker.fetch(request, envWith({ MCP_RATE_LIMITER: mcp, WS_RATE_LIMITER: ws }), createExecutionContext());
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe('60');
  expect(res.headers.get('mcp-session-id')).toBeNull(); // no session was made
  expect(await res.json()).toEqual({ error: 'Too many requests' });
  expect(mcp.calls).toEqual([{ key: '198.51.100.4' }]);
  expect(ws.calls).toEqual([]);
  expect(logs.events()).toEqual([{ event: 'mcp_reject', reason: 'rate_limited' }]);
  expect(logs.lines().join('\n')).not.toContain('198.51.100.4');
});

it('counts every /mcp method: GET and DELETE as well as POST', async () => {
  const mcp = limiter(false);
  for (const method of ['GET', 'DELETE', 'POST']) {
    const res = await worker.fetch(new Request(`${BASE}/mcp`, { method, headers: { Accept: 'application/json, text/event-stream' } }), envWith({ MCP_RATE_LIMITER: mcp }), createExecutionContext());
    expect(res.status, method).toBe(429);
    await res.arrayBuffer();
  }
  expect(mcp.calls).toHaveLength(3);
});
