import { createExecutionContext, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newSessionId, SESSION_ID_RE } from '../../src/core/session-id';
import { getTools, TOOL_DEFS, TOOL_NAMES } from '../../src/core/tools';
import worker from '../../src/index';
import { captureLogs, hashOf } from './helpers/logs';
import { bridgeStub, openWorkerSocket, type TestSocket } from './helpers/sockets';

// The generic remote MCP of the app (src/remote-mcp/, /mcp of src/index.ts): one McpAgent Durable Object per MCP
// session, each bound to one DJ Opus session, which the tools drive through the executor core. Everything here goes
// over HTTP, in-process: the SDK client's fetch is exports.default.fetch, as an agent's would be the network.

type Json = Record<string, any>;

const BASE = 'https://djopus.test';
const MCP_URL = `${BASE}/mcp`;
const PLAYER_URL_RE = /https:\/\/djopus\.test\/s\/[0-9a-hjkmnp-tv-z]{26}/;
const DAY = 24 * 60 * 60 * 1000;
const TTL_MS = 30 * DAY;

const clients: Client[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
});

/** An MCP client with its own MCP session. */
async function connectClient(): Promise<{ client: Client; mcpSessionId: string }> {
  const client = new Client({ name: 'remote-mcp-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: (input, init) => exports.default.fetch(input, init) });
  await client.connect(transport);
  clients.push(client);
  return { client, mcpSessionId: transport.sessionId! };
}

/** One POST to /mcp, and the JSON-RPC messages of its answer (a JSON body or an SSE stream). */
async function postMcp(body: Json, mcpSessionId?: string): Promise<{ res: Response; messages: Json[] }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (mcpSessionId) Object.assign(headers, { 'mcp-session-id': mcpSessionId, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION });
  const res = await exports.default.fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  const messages = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5).trim()) as Json)
    : text ? [JSON.parse(text) as Json] : [];
  return { res, messages };
}

/**
 * An MCP session driven with plain POSTs, by a client that opens no SSE stream: each request's connection to the
 * session's object closes with its answer, so the object has none open between requests, and the ones it has are its
 * requests. (The SDK client also keeps an SSE GET stream open, which is a connection but no request: the expiry does
 * not count it, ruling P2-R27.)
 */
async function rawSession() {
  const init = await postMcp({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw-client', version: '0' } },
  });
  const mcpSessionId = init.res.headers.get('mcp-session-id')!;
  expect(mcpSessionId).toMatch(/^[0-9a-f]{64}$/);
  expect((await postMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, mcpSessionId)).res.status).toBe(202);
  let nextId = 2;
  /** A tools/call, and the HTTP answer it got. */
  const send = (name: string, args: Json = {}) =>
    postMcp({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }, mcpSessionId);
  return {
    mcpSessionId,
    send,
    /** The JSON a tool answered with. */
    async call(name: string, args: Json = {}): Promise<Json> {
      const { messages } = await send(name, args);
      return jsonOf(messages.find((message) => message.result)!.result as object);
    },
  };
}

/** How many connections the MCP session's object has open: McpAgent bridges each request, and an SSE stream, over one. */
function openConnections(stub: DurableObjectStub): Promise<number> {
  return runInDurableObject(stub, (instance: AgentInstance) => [...instance.getConnections()].length);
}

/** The state McpAgent's transport keeps on each open connection: a request's ids, or the mark of the SSE stream. */
function connectionStates(stub: DurableObjectStub): Promise<unknown[]> {
  return runInDurableObject(stub, (instance: AgentInstance) => [...instance.getConnections()].map((connection) => connection.state));
}

function textOf(result: object): string {
  const { content } = result as { content?: { type: string; text?: string }[] };
  return (content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

/** The JSON a tool answered with. A tool that failed throws its own message. */
function jsonOf(result: object): Json {
  if ((result as { isError?: boolean }).isError) throw new Error(`the tool failed: ${textOf(result)}`);
  return JSON.parse(textOf(result)) as Json;
}

async function callJson(client: Client, name: string, args: Json = {}): Promise<Json> {
  return jsonOf(await client.callTool({ name, arguments: args }));
}

/** The text of a tool call that has to fail. */
async function callError(client: Client, name: string, args: Json = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, `${name} should fail`).toBe(true);
  return textOf(result);
}

/** The McpAgent Durable Object of an MCP session: McpAgent.serve() names it streamable-http:<Mcp-Session-Id>. */
function agentStub(mcpSessionId: string): DurableObjectStub {
  return env.DJOPUS_MCP.get(env.DJOPUS_MCP.idFromName(`streamable-http:${mcpSessionId}`));
}

type Schedule = { callback: string; id: string; time: number; type: string };
type AgentInstance = DurableObject & {
  expireIfIdle(): Promise<void>;
  listSchedules(): Promise<Schedule[]>;
  getConnections(): Iterable<{ state: unknown }>;
};

/** The pending expireIfIdle schedules of an MCP session's object. */
function expirySchedules(stub: DurableObjectStub): Promise<Schedule[]> {
  return runInDurableObject(stub, async (instance: AgentInstance) =>
    (await instance.listSchedules()).filter((schedule) => schedule.callback === 'expireIfIdle'));
}

/** What the app keeps in an MCP session's object, next to the agent's own keys. */
function appKeys(stub: DurableObjectStub): Promise<Json> {
  return runInDurableObject(stub, async (_instance, state) => ({
    djSessionId: await state.storage.get('djSessionId'),
    lastActivity: await state.storage.get('lastActivity'),
    initializeRequest: await state.storage.get('initializeRequest'),
    props: await state.storage.get('props'),
  }));
}

const GONE = { djSessionId: undefined, lastActivity: undefined, initializeRequest: undefined, props: undefined };

/**
 * appKeys of an MCP session's object after destroy(), read through new stubs: destroy() aborts the object, a stub to
 * it fails with "destroyed" from then on, and the next instance takes a moment to come. That instance stores its
 * schema version as any new one does, so this looks at the app's keys and the agent's session keys only.
 */
async function appKeysAfterDestroy(mcpSessionId: string): Promise<Json> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await appKeys(agentStub(mcpSessionId));
    } catch (error) {
      if (attempt >= 50 || !String(error).includes('destroyed')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/**
 * Runs `call`, which ends in destroy(): that aborts the object on its next tick, so the call may come back or fail
 * with the abort. Either is fine; any other failure is not.
 */
async function destroying(call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (error) {
    expect(String(error)).toMatch(/destroyed|abort|reset/i);
  }
}

/** The browser's ack of code it played, as client/strudel-ws-bridge.js sends it. */
function ack(browser: TestSocket, command: Json, status = 'playing', extra: Json = {}): void {
  const code = (command.payload as { code: string }).code;
  browser.send({ type: 'ack', request_id: command.request_id, status, payload: { codeLength: code.length, audioContextState: 'running', ...extra } });
}

/** A browser on the player page of `session`, as /s/<id> opens it. */
async function openPlayer(session: string): Promise<TestSocket> {
  const browser = await openWorkerSocket(`/ws?session=${session}`, { headers: { Origin: BASE } });
  await browser.next('session_state');
  return browser;
}

// --- the brief's tests ---

it('initialize returns a session id and lists the 23 tools', async () => {
  const { client, mcpSessionId } = await connectClient();
  expect(mcpSessionId).toMatch(/^[0-9a-f]{64}$/);
  expect(client.getServerVersion()).toMatchObject({ name: 'djopus', version: '1.0.0' });

  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
  // As the registry defines them: the same descriptions, schemas and annotations.
  expect(tools.map((tool) => [tool.name, tool.description, tool.inputSchema]))
    .toEqual(getTools().map((tool) => [tool.name, tool.description, tool.inputSchema]));
  for (const def of TOOL_DEFS) {
    expect(tools.find((tool) => tool.name === def.name)?.annotations, def.name).toEqual(def.annotations);
  }
});

it('the first playback tool with no player names the player URL', async () => {
  const { client } = await connectClient();
  const text = await callError(client, 'write', { pattern: 's("bd")', auto_play: true });
  expect(text).toMatch(PLAYER_URL_RE);

  // The URL of this MCP session's own DJ Opus session, which get_state reports.
  const { sessionId, playerUrl } = await callJson(client, 'get_state');
  expect(playerUrl).toBe(`${BASE}/s/${sessionId}`);
  expect(text).toBe(`No player is open for this session yet. Open ${playerUrl} in your browser, click once to enable audio, then run write again.`);
}, 15_000);

it('keeps its DJ Opus session across calls and evictions', async () => {
  const { client, mcpSessionId } = await connectClient();
  const first = await callJson(client, 'get_state');
  expect(first.sessionId).toMatch(SESSION_ID_RE);
  expect((await callJson(client, 'get_state')).sessionId).toBe(first.sessionId);

  await evictDurableObject(agentStub(mcpSessionId));
  await evictDurableObject(bridgeStub(first.sessionId));
  const after = await callJson(client, 'get_state');
  expect(after.sessionId).toBe(first.sessionId);
  expect(after.playerUrl).toBe(first.playerUrl); // the origin came back with the props the agent stored
});

it('connect binds an existing player-first session', async () => {
  const id = newSessionId();
  const browser = await openPlayer(id);
  const { client, mcpSessionId } = await connectClient();

  expect(await callJson(client, 'connect', { session: id })).toEqual({ session: id, playerUrl: `${BASE}/s/${id}`, browserConnected: true });

  const writing = client.callTool({ name: 'write', arguments: { pattern: 's("bd*4")', auto_play: true } });
  const evaluate = await browser.next('evaluate', 5_000);
  expect(evaluate.payload).toEqual({ code: 's("bd*4")' });
  ack(browser, evaluate);
  expect(jsonOf(await writing)).toMatchObject({ status: 'playing', length: 9 });

  // The binding is the MCP session's, and outlives its object.
  await evictDurableObject(agentStub(mcpSessionId));
  expect((await callJson(client, 'get_state')).sessionId).toBe(id);
  await browser.close();
});

it('restart: a new MCP session is told its own player URL, and connect reattaches the tab that is still open', async () => {
  // The plan's Review Focus #1. An agent's MCP session A is in use, with its player tab open.
  const a = await connectClient();
  const { sessionId: idA } = await callJson(a.client, 'get_state');
  const tab = await openPlayer(idA);
  const writingA = a.client.callTool({ name: 'write', arguments: { pattern: 's("a")', auto_play: true } });
  ack(tab, await tab.next('evaluate', 5_000));
  expect(jsonOf(await writingA)).toMatchObject({ status: 'playing' });

  // The agent restarts: its client is a new MCP session, B. B's first playback call finds no player of its own, and
  // names B's player URL, not A's.
  const b = await connectClient();
  const text = await callError(b.client, 'write', { pattern: 's("b")', auto_play: true });
  const { sessionId: idB, playerUrl: urlB } = await callJson(b.client, 'get_state');
  expect(idB).not.toBe(idA);
  expect(urlB).toBe(`${BASE}/s/${idB}`);
  expect(text).toBe(`No player is open for this session yet. Open ${urlB} in your browser, click once to enable audio, then run write again.`);

  // B connects to the session of the tab, and its next write plays there.
  expect(await callJson(b.client, 'connect', { session: idA })).toEqual({ session: idA, playerUrl: `${BASE}/s/${idA}`, browserConnected: true });
  const writingB = b.client.callTool({ name: 'write', arguments: { pattern: 's("b")', auto_play: true } });
  const evaluate = await tab.next('evaluate', 5_000);
  expect(evaluate.payload).toEqual({ code: 's("b")' });
  ack(tab, evaluate);
  expect(jsonOf(await writingB)).toMatchObject({ status: 'playing' });
  await tab.close();
}, 20_000);

it('connect to a session with no player open says so', async () => {
  const { client } = await connectClient();
  const id = newSessionId();
  expect(await callJson(client, 'connect', { session: id })).toEqual({ session: id, playerUrl: `${BASE}/s/${id}`, browserConnected: false });
  expect((await callJson(client, 'get_state')).sessionId).toBe(id);
});

it('connect rejects a legacy id', async () => {
  const { client } = await connectClient();
  const { sessionId } = await callJson(client, 'get_state');
  for (const session of ['opus-ab12', 'chatgpt-conv-0123456789abcdef', 'default', '', sessionId.toUpperCase(), `${sessionId}0`, `${BASE}/s/${sessionId}`]) {
    const text = await callError(client, 'connect', { session });
    expect(text, session).toContain('/s/');
  }
  expect((await callJson(client, 'get_state')).sessionId).toBe(sessionId); // the binding did not move
});

it('separate MCP sessions get separate DJ Opus sessions', async () => {
  const a = await connectClient();
  const b = await connectClient();
  expect(a.mcpSessionId).not.toBe(b.mcpSessionId);
  const [stateA, stateB] = [await callJson(a.client, 'get_state'), await callJson(b.client, 'get_state')];
  expect(stateA.sessionId).not.toBe(stateB.sessionId);
  expect((await callJson(a.client, 'get_state')).sessionId).toBe(stateA.sessionId);
});

it('expireIfIdle destroys an MCP session idle for 30 days', async () => {
  const logs = captureLogs();
  // A client with no connection open between its requests, so nothing but the expiry is going on in the object. A
  // request in flight would keep the session (see expiry, below).
  const raw = await rawSession();
  const { sessionId } = await raw.call('get_state'); // binds a DJ Opus session and records activity
  const stub = agentStub(raw.mcpSessionId);
  expect(await appKeys(stub)).toMatchObject({ djSessionId: sessionId, lastActivity: expect.any(Number) });
  expect(await openConnections(stub)).toBe(0);

  await destroying(() => runInDurableObject(stub, async (instance: AgentInstance, state) => {
    await state.storage.put('lastActivity', Date.now() - 31 * DAY);
    await instance.expireIfIdle();
  }));

  // destroy() aborted that object, so a second one reads what is left.
  expect(await appKeysAfterDestroy(raw.mcpSessionId)).toEqual(GONE);
  // The log line names the DJ Opus session it was bound to by its keyed hash, and nothing else.
  expect(logs.events().filter((event) => event.event === 'mcp_session_expired'))
    .toEqual([{ event: 'mcp_session_expired', sessionHash: await hashOf(sessionId) }]);
  for (const id of [sessionId, raw.mcpSessionId]) expect(logs.lines().join('\n'), id).not.toContain(id);
  // And the MCP session is over: its next request is answered 404.
  expect((await raw.send('get_state')).res.status).toBe(404);
});

// --- the guards in front of McpAgent (P2-R5, P2-R16) ---

describe('guards', () => {
  const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const toolsList = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list' });

  /**
   * The app's env, but every Durable Object binding throws when it is touched, and the /mcp limiter records what it
   * is asked. A request a guard refuses never gets that far.
   */
  function guardedEnv() {
    const touched: string[] = [];
    const trap = (name: string) => new Proxy({}, {
      get(_target, property) {
        touched.push(`${name}.${String(property)}`);
        throw new Error(`${name} was touched`);
      },
    });
    const limited: RateLimitOptions[] = [];
    const guarded = {
      ...env,
      DJOPUS_MCP: trap('DJOPUS_MCP'),
      SESSION_BRIDGE: trap('SESSION_BRIDGE'),
      MCP_RATE_LIMITER: { limit: async (options: RateLimitOptions) => (limited.push(options), { success: true }) },
    } as unknown as Env;
    return { env: guarded, touched, limited };
  }

  function mcpRequest(init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Request {
    return new Request(MCP_URL, { method: init.method ?? 'POST', headers: { ...MCP_HEADERS, ...init.headers }, body: init.body });
  }

  /** A JSON-RPC notification of exactly `bytes` bytes, which McpAgent answers without a Durable Object (no session). */
  function notificationOf(bytes: number): string {
    const overhead = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: { pad: '' } }).length;
    return JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: { pad: 'a'.repeat(bytes - overhead) } });
  }

  it('refuses a body over 128 KB with 413, and lets 128 KB through', async () => {
    const res = await exports.default.fetch(mcpRequest({ body: notificationOf(131_073) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request body too large' });

    // At the limit the request reaches McpAgent, which wants a session for anything but initialize.
    const atLimit = await exports.default.fetch(mcpRequest({ body: notificationOf(131_072) }));
    expect(atLimit.status).toBe(400);
    expect(await atLimit.text()).toContain('Mcp-Session-Id header is required');
  });

  it('refuses a JSON-RPC batch of more than 16 messages with 400', async () => {
    const res = await exports.default.fetch(mcpRequest({ body: JSON.stringify(Array.from({ length: 17 }, (_, i) => toolsList(i))) }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('{"jsonrpc":"2.0","error":{"code":-32600,"message":"Batch too large"},"id":null}');

    const sixteen = await exports.default.fetch(mcpRequest({ body: JSON.stringify(Array.from({ length: 16 }, (_, i) => toolsList(i))) }));
    expect(sixteen.status).toBe(400);
    expect(await sixteen.text()).toContain('Mcp-Session-Id header is required'); // McpAgent's answer, not the guard's
  });

  it('answers a malformed mcp-session-id with 404, whatever the method', async () => {
    const malformed = ['f'.repeat(63), 'f'.repeat(65), 'F'.repeat(64), 'g'.repeat(64), `streamable-http:${'a'.repeat(48)}`, '', newSessionId()];
    for (const header of malformed) {
      for (const method of ['POST', 'GET', 'DELETE']) {
        const res = await exports.default.fetch(mcpRequest({
          method,
          body: method === 'POST' ? JSON.stringify(toolsList(1)) : undefined,
          headers: { 'mcp-session-id': header, ...(method === 'GET' ? { Accept: 'text/event-stream' } : {}) },
        }));
        expect(res.status, `${method} ${header}`).toBe(404);
        expect(await res.json(), `${method} ${header}`).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
      }
    }
  });

  it('turns these away before the rate limit, and without touching a Durable Object', async () => {
    const { env: guarded, touched, limited } = guardedEnv();
    const refused = [
      mcpRequest({ body: notificationOf(131_073) }),
      mcpRequest({ body: JSON.stringify(Array.from({ length: 17 }, (_, i) => toolsList(i))) }),
      mcpRequest({ body: JSON.stringify(toolsList(1)), headers: { 'mcp-session-id': 'not-a-session' } }),
      mcpRequest({ method: 'DELETE', headers: { 'mcp-session-id': 'F'.repeat(64) } }),
    ];
    for (const request of refused) {
      const res = await worker.fetch(request, guarded, createExecutionContext());
      expect([413, 400, 404], `${request.method} ${res.status}`).toContain(res.status);
      await res.arrayBuffer();
    }
    expect(touched).toEqual([]);
    expect(limited).toEqual([]);
  });

  it('logs mcp_reject with the reason only, never the session header it refused', async () => {
    const logs = captureLogs();
    const bogus = 'bogus-session-marker-91c2';
    for (const request of [
      mcpRequest({ body: notificationOf(131_073) }),
      mcpRequest({ body: JSON.stringify(Array.from({ length: 17 }, (_, i) => toolsList(i))) }),
      mcpRequest({ body: JSON.stringify(toolsList(1)), headers: { 'mcp-session-id': bogus } }),
    ]) {
      await (await exports.default.fetch(request)).arrayBuffer();
    }
    expect(logs.events().filter((event) => event.event === 'mcp_reject')).toEqual([
      { event: 'mcp_reject', reason: 'body_too_large' },
      { event: 'mcp_reject', reason: 'batch_too_large' },
      { event: 'mcp_reject', reason: 'invalid_session' },
    ]);
    expect(logs.lines().join('\n')).not.toContain(bogus);
  });

  it('a request that passes the guards is counted against the /mcp limit, by CF-Connecting-IP', async () => {
    const limited: RateLimitOptions[] = [];
    const counting = { ...env, MCP_RATE_LIMITER: { limit: async (options: RateLimitOptions) => (limited.push(options), { success: true }) } } as unknown as Env;
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'guards', version: '0' } } };
    const res = await worker.fetch(mcpRequest({ body: JSON.stringify(init), headers: { 'CF-Connecting-IP': '198.51.100.23' } }), counting, createExecutionContext());
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toMatch(/^[0-9a-f]{64}$/);
    await res.body?.cancel();
    expect(limited).toEqual([{ key: '198.51.100.23' }]);
  });
});

// --- expiry of MCP sessions (P2-R17) ---

describe('expiry', () => {
  it('schedules expireIfIdle when the session starts, and keeps exactly one through tool calls and restarts', async () => {
    const started = Date.now();
    const { client, mcpSessionId } = await connectClient();
    const stub = agentStub(mcpSessionId);

    // initialize alone started the object: one schedule, 30 days out, and no activity yet (that is a tool call).
    const atStart = await expirySchedules(stub);
    expect(atStart).toHaveLength(1);
    expect(atStart[0].time * 1000).toBeGreaterThanOrEqual(started + TTL_MS - 2_000);
    expect(atStart[0].time * 1000).toBeLessThanOrEqual(Date.now() + TTL_MS);
    expect((await appKeys(stub)).lastActivity).toBeUndefined();

    await callJson(client, 'get_state');
    await callJson(client, 'validate', { pattern: 's("bd")' });
    const { lastActivity } = await appKeys(stub);
    expect(lastActivity).toBeGreaterThanOrEqual(started);
    expect(lastActivity).toBeLessThanOrEqual(Date.now());
    expect(await expirySchedules(stub)).toEqual(atStart); // the same row, not a new one

    await evictDurableObject(stub);
    await callJson(client, 'get_state'); // a new instance: init() ran again
    expect(await expirySchedules(stub)).toEqual(atStart);
  });

  it('an MCP session that never ran a tool expires too: no lastActivity counts as idle', async () => {
    const { mcpSessionId } = await rawSession();
    const stub = agentStub(mcpSessionId);
    expect(await appKeys(stub)).toMatchObject({ lastActivity: undefined, initializeRequest: expect.anything() });
    await destroying(() => runInDurableObject(stub, (instance: AgentInstance) => instance.expireIfIdle()));
    expect(await appKeysAfterDestroy(mcpSessionId)).toEqual(GONE);
  });

  it('when it goes off for a session used since, the expiry re-arms for 30 days after the last tool call, as the only schedule', async () => {
    const raw = await rawSession();
    await raw.call('get_state');
    const stub = agentStub(raw.mcpSessionId);
    const [scheduled] = await expirySchedules(stub);
    const due = scheduled.time * 1000;

    // Ten days before it is due, the session was used again.
    const usedAt = due - 10 * DAY;
    await runInDurableObject(stub, (_instance, state) => state.storage.put('lastActivity', usedAt));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(due + 60_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const after = await expirySchedules(stub);
    expect(after).toHaveLength(1); // the row that ran is gone, and its re-arm is the one schedule
    expect(Math.abs(after[0].time * 1000 - (usedAt + TTL_MS))).toBeLessThan(2_000);
    expect((await appKeys(stub)).djSessionId).toMatch(SESSION_ID_RE);
  });

  it('when it goes off for a session idle for 30 days, the expiry destroys it', async () => {
    const raw = await rawSession();
    await raw.call('get_state');
    const stub = agentStub(raw.mcpSessionId);
    const [scheduled] = await expirySchedules(stub);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(scheduled.time * 1000 + 60_000); // 30 days and a minute after the one tool call
    await destroying(() => runDurableObjectAlarm(stub));
    vi.useRealTimers();
    expect(await appKeysAfterDestroy(raw.mcpSessionId)).toEqual(GONE);
  });

  it('when it goes off for a session idle for 30 days with only its SSE stream open, the expiry destroys it', async () => {
    // P2-R27. The SDK client keeps an SSE GET stream open for the server's own messages: a connection to the session's
    // object, but no request. A stream can outlive its client (the Worker that holds it learns the client has gone
    // only when it writes to it), so it does not keep a session past 30 idle days.
    const { client, mcpSessionId } = await connectClient();
    await callJson(client, 'get_state');
    const stub = agentStub(mcpSessionId);
    await vi.waitFor(async () => expect(await connectionStates(stub)).toEqual([{ streamId: '_GET_stream', _standaloneSse: true }]));
    const [scheduled] = await expirySchedules(stub);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(scheduled.time * 1000 + 60_000); // 30 days and a minute after the one tool call
    await destroying(() => runDurableObjectAlarm(stub));
    vi.useRealTimers();
    expect(await appKeysAfterDestroy(mcpSessionId)).toEqual(GONE);
    // The client finds its MCP session gone, and would start a new one.
    await expect(client.callTool({ name: 'get_state', arguments: {} })).rejects.toThrow(/Session not found/);
  });

  it('when it goes off in the middle of a request, the expiry keeps the session 30 days more, and the request gets its answer', async () => {
    const raw = await rawSession();
    const { sessionId } = await raw.call('get_state');
    const stub = agentStub(raw.mcpSessionId);
    const [scheduled] = await expirySchedules(stub);
    // The player holds back its ack, so the write stays in flight, on a connection of its own to the object, until the
    // test answers for it. What it waits on is a timer, not the clock, so the clock can move meanwhile.
    const player = await openPlayer(sessionId);
    const writing = raw.send('write', { pattern: 's("bd")', auto_play: true });
    const evaluate = await player.next('evaluate', 5_000);
    expect(await openConnections(stub)).toBe(1);

    // 30 days and a minute after the last tool call, the write that is still in flight: the expiry is due, and idle.
    const now = scheduled.time * 1000 + 60_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const after = await expirySchedules(stub);
    expect(after).toHaveLength(1); // the row that ran is gone: its re-arm is the one schedule, 30 days from now
    expect(after[0].id).not.toBe(scheduled.id);
    expect(Math.abs(after[0].time * 1000 - (now + TTL_MS))).toBeLessThan(2_000);
    vi.useRealTimers();

    ack(player, evaluate);
    const { res, messages } = await writing;
    expect(res.status).toBe(200);
    expect(jsonOf(messages.find((message) => message.result)!.result as object)).toMatchObject({ status: 'playing' });
    expect(await appKeys(stub)).toMatchObject({ djSessionId: sessionId, initializeRequest: expect.anything() });
    await player.close();
  }, 15_000);

  it('an unknown but well-formed session id gets 404, and the object it started expires on its own', async () => {
    const forged = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const res = await exports.default.fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': forged },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    await res.arrayBuffer();

    // McpAgent started that session's object to find out it does not know it. The object scheduled its expiry
    // when it started, and has no activity, so it goes when that is due.
    const stub = agentStub(forged);
    expect(await expirySchedules(stub)).toHaveLength(1);
    await destroying(() => runInDurableObject(stub, (instance: AgentInstance) => instance.expireIfIdle()));
    expect(await appKeysAfterDestroy(forged)).toEqual(GONE);
  });
});

// --- undo through every layer (the Task 3 hand-off) ---

it('undo and redo run from the MCP tool through the executor and the session to the browser, and report its playback', async () => {
  const { client } = await connectClient();
  const { sessionId } = await callJson(client, 'get_state');
  const browser = await openPlayer(sessionId);

  for (const code of ['s("a")', 's("b")']) {
    const writing = client.callTool({ name: 'write', arguments: { pattern: code } });
    const setCode = await browser.next('set_code', 5_000);
    browser.send({ type: 'ack', request_id: setCode.request_id, status: 'code_set', payload: { codeLength: code.length } });
    expect(jsonOf(await writing)).toEqual({ status: 'written', length: code.length });
  }

  const undoing = client.callTool({ name: 'undo', arguments: {} });
  const undoEvaluate = await browser.next('evaluate', 5_000);
  expect(undoEvaluate.payload).toEqual({ code: 's("a")' });
  ack(browser, undoEvaluate);
  expect(jsonOf(await undoing)).toEqual({ status: 'undone', code: 's("a")', playback: 'playing' });

  const redoing = client.callTool({ name: 'redo', arguments: {} });
  const redoEvaluate = await browser.next('evaluate', 5_000);
  expect(redoEvaluate.payload).toEqual({ code: 's("b")' });
  ack(browser, redoEvaluate, 'needs_user_gesture', { audioContextState: 'suspended', message: 'Click once in the player to enable audio.' });
  expect(jsonOf(await redoing)).toEqual({
    status: 'redone', code: 's("b")', playback: 'needs_user_gesture', message: 'Click once in the player to enable audio.',
  });
  await browser.close();
}, 20_000);

// --- logging ---

it('logs keyed session hashes only: never an MCP session id, a DJ Opus session id, a player URL or code', async () => {
  const lines: string[] = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
  }
  const events = () => lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Json];
    } catch {
      return [];
    }
  });

  const { client, mcpSessionId } = await connectClient();
  const own = await callJson(client, 'get_state');
  const id = newSessionId();
  const browser = await openPlayer(id);
  await callJson(client, 'connect', { session: id });
  const code = 's("secret-marker-5c1e")';
  const writing = client.callTool({ name: 'write', arguments: { pattern: code, auto_play: true } });
  ack(browser, await browser.next('evaluate', 5_000));
  await writing;
  await callError(client, 'connect', { session: 'opus-ab12' });
  // save reads the editor: the browser answers get_code.
  const saving = client.callTool({ name: 'save', arguments: { name: 'secret-name-77a0' } });
  const asked = await browser.next('get_code', 5_000);
  browser.send({ type: 'code_response', request_id: asked.request_id, payload: { code } });
  expect(jsonOf(await saving)).toEqual({ saved: 'secret-name-77a0' });
  await browser.close();

  expect(events()).toContainEqual({ event: 'mcp_session_new', sessionHash: await hashOf(own.sessionId) });
  expect(events()).toContainEqual({ event: 'mcp_connect', sessionHash: await hashOf(id), browserConnected: true });
  const everything = lines.join('\n');
  for (const secret of [mcpSessionId, own.sessionId, id, own.playerUrl, `${BASE}/s/`, 'secret-marker-5c1e', 'secret-name-77a0']) {
    expect(everything, secret).not.toContain(secret);
  }
});
