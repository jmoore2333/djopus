import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { logEvent, sessionHash } from '../../src/log';
import type { SessionBridge } from '../../src/session-bridge';
import { captureLogs, hashOf } from './helpers/logs';
import { bridgeStub, openSession } from './helpers/sockets';

afterEach(() => {
  vi.restoreAllMocks();
});

async function plainSha256Prefix(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest).subarray(0, 4)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// --- logEvent ---

it('logEvent writes one JSON object per line', () => {
  const logs = captureLogs();
  logEvent('probe', { count: 2, name: 'x' });
  logEvent('bare');
  expect(logs.lines()).toHaveLength(2);
  expect(logs.events()).toEqual([{ event: 'probe', count: 2, name: 'x' }, { event: 'bare' }]);
});

it('logEvent keeps its event name when a field is called event', () => {
  const logs = captureLogs();
  logEvent('real', { event: 'forged', count: 1 });
  expect(logs.events()).toEqual([{ event: 'real', count: 1 }]);
});

// --- sessionHash ---

it('sessionHash is the first 8 hex characters of HMAC-SHA256(key, id)', async () => {
  // RFC 4231, test case 2: HMAC-SHA256("Jefe", "what do ya want for nothing?") = 5bdcc146bf60754e...
  expect(await sessionHash('what do ya want for nothing?', 'Jefe')).toBe('5bdcc146');
});

it('sessionHash depends on the key: the same key agrees, another key differs', async () => {
  const hash = await sessionHash('opus-ab12', 'key-a');
  expect(await sessionHash('opus-ab12', 'key-a')).toBe(hash);
  expect(await sessionHash('opus-ab12', 'key-b')).not.toBe(hash);
  expect(await sessionHash('opus-cd34', 'key-a')).not.toBe(hash); // and it depends on the id
});

it('a keyed sessionHash is not the plain SHA-256 of the id', async () => {
  for (const id of ['opus-ab12', 'chatgpt-0123abcd', 'abc']) {
    expect(await sessionHash(id, 'key-a')).not.toBe(await plainSha256Prefix(id));
  }
});

it('sessionHash without a key uses one random key for the whole isolate', async () => {
  const hash = await sessionHash('opus-ab12');
  expect(await sessionHash('opus-ab12')).toBe(hash);
  expect(await sessionHash('opus-ab12', '')).toBe(hash); // an empty key counts as none
});

it('sessionHash is always 8 lowercase hex characters', async () => {
  for (const id of ['', 'opus-ab12', 'chatgpt-conv-0123456789abcdef', 'ünï-✓-😀', 'x'.repeat(10_000)]) {
    expect(await sessionHash(id, 'key-a')).toMatch(/^[0-9a-f]{8}$/);
    expect(await sessionHash(id)).toMatch(/^[0-9a-f]{8}$/);
  }
});

// --- what the Durable Object logs ---

it('never logs a raw session id', async () => {
  const logs = captureLogs();
  const browser = await openSession('secret-session-name-123', 'browser');
  const controller = await openSession('secret-session-name-123', 'controller');
  controller.send({ type: 'evaluate', request_id: 'l1', payload: { code: 's("bd")' } });
  await browser.next('evaluate');

  const text = logs.lines().join('\n');
  expect(text).not.toContain('secret-session-name-123');
  expect(text).not.toContain('s("bd")'); // nor any pattern code
  expect(logs.events()).toContainEqual(
    expect.objectContaining({ event: 'ws_connect', sessionHash: expect.stringMatching(/^[0-9a-f]{8}$/) }),
  );
});

it('tags a session with the keyed hash', async () => {
  const logs = captureLogs();
  await openSession('secret-session-name-123', 'browser');
  // HMAC-SHA256 under the key vitest.config.ts gives the Durable Object. The plain SHA-256 would give 1d7d1c3a.
  expect(logs.events()).toContainEqual({ event: 'ws_connect', sessionHash: '5577f405', role: 'browser' });
});

it('logs connect, route, drop and close with the documented fields', async () => {
  const logs = captureLogs();
  const session = 'log-events';
  const hash = await hashOf(session);
  const browser = await openSession(session, 'browser');
  const controller = await openSession(session, 'controller');

  controller.send({ type: 'evaluate', request_id: 'l1', payload: { code: 's("bd")' } });
  browser.send({ type: 'ack', request_id: 'l1', status: 'playing' }); // a report, not a command: no route line
  controller.send('this is not json');
  controller.send({ type: 'no_such_type' });
  controller.send({ type: 'get_state', request_id: 'l2' });
  await controller.next((m) => m.request_id === 'l2');

  await browser.close(1000, 'bye');
  controller.send({ type: 'set_tempo', request_id: 'l3', payload: { bpm: 90 } });
  await controller.next((m) => m.request_id === 'l3'); // no_browser

  expect(logs.events().filter((e) => e.sessionHash === hash)).toEqual([
    { event: 'ws_connect', sessionHash: hash, role: 'browser' },
    { event: 'ws_connect', sessionHash: hash, role: 'controller' },
    { event: 'route', sessionHash: hash, type: 'evaluate', browsers: 1 },
    { event: 'drop', sessionHash: hash, reason: 'invalid_json' },
    { event: 'drop', sessionHash: hash, reason: 'unknown_type' },
    { event: 'route', sessionHash: hash, type: 'get_state', browsers: 1 },
    { event: 'ws_close', sessionHash: hash, role: 'browser', code: 1000 },
    { event: 'route', sessionHash: hash, type: 'set_tempo', browsers: 0 },
  ]);
});

it('logs a dropped binary frame', async () => {
  const logs = captureLogs();
  await openSession('log-binary', 'controller');
  await runInDurableObject(bridgeStub('log-binary'), async (instance: SessionBridge, state) => {
    const [server] = state.getWebSockets('controller');
    await instance.webSocketMessage(server, new ArrayBuffer(4));
  });
  expect(logs.events()).toContainEqual({
    event: 'drop', sessionHash: await hashOf('log-binary'), reason: 'binary_frame',
  });
});
