import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { handleWsUpgrade, LEGACY_WS_RULES, requestedSession, type WsRules } from '../../src/routes/ws';

// handleWsUpgrade is shared by the entries, each with its own rules: the app runs APP_WS_RULES (ws-rules.test.ts),
// the ChatGPT Worker LEGACY_WS_RULES (test/chatgpt/entry.test.ts). The settings of a WsRules are tried here, on the
// helper itself, with rules of its own.

const BASE = 'https://djopus.test';

const STRICT: WsRules = { isValidSession: (s) => s === 'strict-session', allowController: false, requireSameOrigin: true };

function upgrade(path: string, headers: Record<string, string> = {}): Request {
  return new Request(BASE + path, { headers: { Upgrade: 'websocket', ...headers } });
}

/** The answer's socket is of no use to these tests: close it. */
function hangUp(res: Response): void {
  const socket = res.webSocket;
  socket?.accept();
  socket?.close(1000);
}

it('LEGACY_WS_RULES take a plain session id, agents and browsers, from any origin', () => {
  for (const id of ['default', 'opus-ab12', 'chatgpt-conv-0123456789abcdef', 'My_Set-1', 'x'.repeat(64)]) {
    expect(LEGACY_WS_RULES.isValidSession(id), id).toBe(true);
  }
  for (const id of ['', 'bad id', 'x'.repeat(65), 'a/b', 'a.b', "a'b", '"><img src=x>']) {
    expect(LEGACY_WS_RULES.isValidSession(id), id).toBe(false);
  }
  expect(LEGACY_WS_RULES).toMatchObject({ allowController: true, requireSameOrigin: false });
});

it('requestedSession is the ?session= of the URL, and default when there is none or an empty one', () => {
  expect(requestedSession(new URL(`${BASE}/ws?session=opus-ab12&role=browser`))).toBe('opus-ab12');
  expect(requestedSession(new URL(`${BASE}/ws?role=browser`))).toBe('default');
  expect(requestedSession(new URL(`${BASE}/ws?session=&role=browser`))).toBe('default');
});

it('answers a request that is not an upgrade with 426, before it looks at anything else', async () => {
  const res = await handleWsUpgrade(new Request(`${BASE}/ws?session=bad%20id&role=controller`), env, STRICT);
  expect(res.status).toBe(426);
  await res.arrayBuffer();
});

it('refuses a session the rules do not accept with 400 and a JSON error', async () => {
  for (const path of ['/ws?session=other', '/ws', '/ws?session=']) {
    const res = await handleWsUpgrade(upgrade(path, { Origin: BASE }), env, STRICT);
    expect(res.status, path).toBe(400); // with no session the rules are asked about 'default'
    expect(await res.json(), path).toEqual({ error: 'Invalid session id' });
  }
});

it('turns a controller away with 403 when the rules do not allow one, and lets browsers in', async () => {
  const refused = await handleWsUpgrade(upgrade('/ws?session=strict-session&role=controller', { Origin: BASE }), env, STRICT);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: 'Agents connect through /mcp' });

  // The Durable Object takes anything but role=controller for a browser, and so does this check.
  for (const query of ['&role=browser', '', '&role=agent']) {
    const res = await handleWsUpgrade(upgrade(`/ws?session=strict-session${query}`, { Origin: BASE }), env, STRICT);
    expect(res.status, query).toBe(101);
    hangUp(res);
  }
});

it('lets a controller in when the rules allow one', async () => {
  const res = await handleWsUpgrade(upgrade('/ws?session=opus-ab12&role=controller'), env, LEGACY_WS_RULES);
  expect(res.status).toBe(101);
  hangUp(res);
});

it('requires the origin of the request itself when the rules say so: a missing or a different Origin is a 403', async () => {
  const path = '/ws?session=strict-session&role=browser';
  for (const origin of [undefined, 'https://evil.test', 'http://djopus.test', 'https://djopus.test:8443', 'https://djopus.test.evil.test', 'null']) {
    const headers: Record<string, string> = origin === undefined ? {} : { Origin: origin };
    const res = await handleWsUpgrade(upgrade(path, headers), env, STRICT);
    expect(res.status, String(origin)).toBe(403);
    expect(await res.json(), String(origin)).toEqual({ error: 'Origin not allowed' });
  }

  const same = await handleWsUpgrade(upgrade(path, { Origin: BASE }), env, STRICT);
  expect(same.status).toBe(101);
  hangUp(same);
});

it('asks nothing of the Origin when the rules do not require it', async () => {
  for (const headers of [{}, { Origin: 'https://evil.test' }] as Record<string, string>[]) {
    const res = await handleWsUpgrade(upgrade('/ws?session=opus-ab12&role=browser', headers), env, LEGACY_WS_RULES);
    expect(res.status, JSON.stringify(headers)).toBe(101);
    hangUp(res);
  }
});
