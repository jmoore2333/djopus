import { exports } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { isSessionId, newSessionId } from '../../src/core/session-id';
import { APP_WS_RULES } from '../../src/routes/ws';
import { captureLogs } from './helpers/logs';
import { openWorkerSocket } from './helpers/sockets';

// The /ws of the app Worker (src/index.ts) runs APP_WS_RULES: browsers only, joining a session by its 128-bit id,
// from the page the Worker itself serves. Agents reach a session through /mcp. The ChatGPT Worker keeps the first
// hosts' rules (test/chatgpt/entry.test.ts), and ws-upgrade.test.ts tries the other settings of a WsRules.

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE = 'https://djopus.test';

/** An upgrade request to the app. Unless the headers say otherwise it comes from the page the app serves. */
function upgrade(path: string, headers: Record<string, string> = { Origin: BASE }): Promise<Response> {
  return exports.default.fetch(BASE + path, { headers: { Upgrade: 'websocket', ...headers } });
}

it('APP_WS_RULES take session ids only, no controllers, and the origin of the request itself', () => {
  expect(APP_WS_RULES).toEqual({ isValidSession: isSessionId, allowController: false, requireSameOrigin: true });
});

it('/ws on the app rejects controllers, foreign or missing origins, and legacy ids', async () => {
  const id = newSessionId();

  // An agent is told where to go, whatever else is wrong with the request.
  for (const headers of [{ Origin: BASE }, {}, { Origin: 'https://evil.test' }] as Record<string, string>[]) {
    const res = await upgrade(`/ws?session=${id}&role=controller`, headers);
    expect(res.status, JSON.stringify(headers)).toBe(403);
    expect(await res.json(), JSON.stringify(headers)).toEqual({ error: 'Agents connect through /mcp' });
  }

  for (const origin of ['https://evil.test', 'http://djopus.test', 'https://djopus.test:8443', 'https://djopus.test.evil.test', 'null']) {
    const res = await upgrade(`/ws?session=${id}`, { Origin: origin });
    expect(res.status, origin).toBe(403);
    expect(await res.json(), origin).toEqual({ error: 'Origin not allowed' });
  }
  const noOrigin = await upgrade(`/ws?session=${id}`, {});
  expect(noOrigin.status).toBe(403);
  expect(await noOrigin.json()).toEqual({ error: 'Origin not allowed' });

  // Ids of the first hosts, and no id at all (the DO's default session), are not sessions of this one.
  for (const path of ['/ws?session=opus-ab12', '/ws?session=chatgpt-conv-0123456789abcdef', '/ws?session=default', '/ws', '/ws?session=', `/ws?session=${id.toUpperCase()}`, `/ws?session=${id}0`]) {
    const res = await upgrade(path);
    expect(res.status, path).toBe(400);
    expect(await res.json(), path).toEqual({ error: 'Invalid session id' });
  }

  const socket = await openWorkerSocket(`/ws?session=${id}`, { headers: { Origin: BASE } });
  await socket.close();
});

it('lets a browser in, as a browser, with no role or with the role=browser that cached pages still send', async () => {
  const id = newSessionId();
  const first = await openWorkerSocket(`/ws?session=${id}`, { headers: { Origin: BASE } });
  expect((await first.next('session_state')).payload).toMatchObject({ connectedClients: 1, connectedControllers: 0 });

  const second = await openWorkerSocket(`/ws?session=${id}&role=browser`, { headers: { Origin: BASE } });
  expect((await second.next('session_state')).payload).toMatchObject({ connectedClients: 2, connectedControllers: 0 });

  await first.close();
  await second.close();
});

it('puts every id in a session of its own', async () => {
  const a = await openWorkerSocket(`/ws?session=${newSessionId()}`, { headers: { Origin: BASE } });
  const b = await openWorkerSocket(`/ws?session=${newSessionId()}`, { headers: { Origin: BASE } });
  expect((await a.next('session_state')).payload).toMatchObject({ connectedClients: 1 });
  expect((await b.next('session_state')).payload).toMatchObject({ connectedClients: 1 });
  await a.close();
  await b.close();
});

// --- ws_reject ---

const rejections = (logs: ReturnType<typeof captureLogs>) => logs.events().filter((event) => event.event === 'ws_reject');

it('logs ws_reject with the reason, for each way a request is turned away', async () => {
  const logs = captureLogs();
  const id = newSessionId();
  const attempts: Array<[reason: string, path: string, headers: Record<string, string>]> = [
    ['invalid_session', '/ws?session=opus-ab12', { Origin: BASE }],
    ['invalid_session', '/ws', { Origin: BASE }],
    ['invalid_session', `/ws?session=${id}0`, {}],
    ['controller_role', `/ws?session=${id}&role=controller`, { Origin: BASE }],
    ['controller_role', `/ws?session=${id}&role=controller`, {}],
    ['bad_origin', `/ws?session=${id}`, { Origin: 'https://evil.test' }],
    ['bad_origin', `/ws?session=${id}`, {}],
  ];
  for (const [reason, path, headers] of attempts) {
    const before = rejections(logs).length;
    await upgrade(path, headers);
    // The reason and the event name, and no field that could say whose request it was.
    expect(rejections(logs).slice(before), `${reason} ${path}`).toEqual([{ event: 'ws_reject', reason }]);
  }
});

it('logs the first reason when a request breaks several rules', async () => {
  const logs = captureLogs();
  const id = newSessionId();
  await upgrade('/ws?session=opus-ab12&role=controller', { Origin: 'https://evil.test' });
  await upgrade(`/ws?session=${id}&role=controller`, { Origin: 'https://evil.test' });
  expect(rejections(logs)).toEqual([
    { event: 'ws_reject', reason: 'invalid_session' },
    { event: 'ws_reject', reason: 'controller_role' },
  ]);
});

it('never logs the session id or the Origin of a rejected request', async () => {
  const logs = captureLogs();
  const id = newSessionId();
  const origin = 'https://origin-marker-7f3a.test';
  const legacy = 'legacy-marker-91c2';
  await upgrade(`/ws?session=${legacy}`);
  await upgrade(`/ws?session=${id}&role=controller`, { Origin: origin });
  await upgrade(`/ws?session=${id}`, { Origin: origin });
  expect(rejections(logs)).toHaveLength(3);

  const everything = logs.lines().join('\n');
  for (const secret of [id, legacy, origin, 'origin-marker-7f3a']) expect(everything, secret).not.toContain(secret);
});

it('logs no ws_reject for a browser that is let in, nor for a request that is not an upgrade', async () => {
  const logs = captureLogs();
  const id = newSessionId();
  const socket = await openWorkerSocket(`/ws?session=${id}`, { headers: { Origin: BASE } });
  await socket.close();

  const plain = await exports.default.fetch(`${BASE}/ws?session=opus-ab12`);
  expect(plain.status).toBe(426);
  await plain.arrayBuffer();

  expect(rejections(logs)).toEqual([]);
});
