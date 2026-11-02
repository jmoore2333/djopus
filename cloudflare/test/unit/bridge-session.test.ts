import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeSessionId, SESSION_ID_RE } from '../../src/core/session-id';
import { FakeWebSocket, makeEnv, type BridgeModule, type EnvOptions } from './helpers/fake-env';

// Which session a page belongs to. The player URL is /s/<id>, and the bridge in the page reads the id from the path.
// A page opened at / (or at /s/ with something that is not an id) gets a new id of its own, puts it in the address
// bar and keeps it across a reload. The widget of the ChatGPT host sets DJOPUS_CONFIG.sessionId instead, which wins.
// ?session= is not read any more. bridge.test.ts covers the connection itself.

const loadCjs = createRequire(import.meta.url);
const { createBridge, resolveSessionId, mintSessionId, SESSION_ID_PATTERN } = loadCjs('../../client/strudel-ws-bridge.js') as BridgeModule;

const ID = 'abcdefghjkmnpqrstvwxyz0123';
const MINTED = '0123456789abcdefghjkmnpqrs';
const SHAPE = /^\/s\/[0-9a-hjkmnp-tv-z]{26}$/;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A bridge on a page with these options, connecting. */
function open(options: EnvOptions = {}) {
  const env = makeEnv(options);
  const bridge = createBridge(env.deps);
  bridge.connect();
  return { ...env, bridge, socket: FakeWebSocket.last() };
}

describe('resolveSessionId', () => {
  it('uses /s/<id> from the path', () => {
    const mint = vi.fn(() => MINTED);
    expect(resolveSessionId({ pathname: `/s/${ID}` }, undefined, mint)).toEqual({ id: ID, rewriteTo: null });
    expect(resolveSessionId({ pathname: `/s/${ID}` }, {}, mint)).toEqual({ id: ID, rewriteTo: null });
    expect(mint).not.toHaveBeenCalled();
  });

  it('takes a trailing slash for the same page, so that the session of a link is not lost to a typo', () => {
    const mint = vi.fn(() => MINTED);
    expect(resolveSessionId({ pathname: `/s/${ID}/` }, undefined, mint)).toEqual({ id: ID, rewriteTo: null });
    expect(mint).not.toHaveBeenCalled();
  });

  it('mints and rewrites on / and on /s/<invalid>', () => {
    const notIds = [
      '/', '', '/index.html', '/s', '/s/', '/ws', '/api/health',
      `/s/${ID.slice(1)}`, // 25 characters
      `/s/${ID}0`, // 27
      `/s/${ID.toUpperCase()}`,
      `/s/${ID.slice(0, 25)}i`, // a letter Crockford leaves out
      `/s/${ID.slice(0, 25)}u`,
      `/S/${ID}`,
      `/s/${ID}/extra`,
      `/s//${ID}`,
      `/x/s/${ID}`,
      '/s/opus-ab12', '/s/default', '/s/chatgpt-conv-0123456789abcdef',
    ];
    for (const pathname of notIds) {
      const mint = vi.fn(() => MINTED);
      const resolved = resolveSessionId({ pathname }, undefined, mint);
      expect(resolved, pathname).toEqual({ id: MINTED, rewriteTo: `/s/${MINTED}` });
      expect(resolved.rewriteTo, pathname).toMatch(SHAPE);
      expect(mint, pathname).toHaveBeenCalledTimes(1);
    }
  });

  it('prefers the widget config session', () => {
    const mint = vi.fn(() => MINTED);
    const config = { sessionId: 'chatgpt-conv-0123456789abcdef', mode: 'widget' };
    expect(resolveSessionId({ pathname: '/' }, config, mint)).toEqual({ id: 'chatgpt-conv-0123456789abcdef', rewriteTo: null });
    // The address of a widget is no business of the bridge: it rewrites nothing, and the path has no say either.
    expect(resolveSessionId({ pathname: `/s/${ID}` }, config, mint)).toEqual({ id: 'chatgpt-conv-0123456789abcdef', rewriteTo: null });
    expect(mint).not.toHaveBeenCalled();
  });

  it('does not take a config session that is not a non-empty string', () => {
    for (const sessionId of ['', undefined, null, 0, 42, {}, ['x']]) {
      const mint = vi.fn(() => MINTED);
      expect(resolveSessionId({ pathname: `/s/${ID}` }, { sessionId }, mint), String(sessionId)).toEqual({ id: ID, rewriteTo: null });
      expect(resolveSessionId({ pathname: '/' }, { sessionId }, mint), String(sessionId)).toEqual({ id: MINTED, rewriteTo: `/s/${MINTED}` });
    }
  });
});

describe('SESSION_ID_PATTERN', () => {
  it('the bridge pattern matches SESSION_ID_RE', () => expect(SESSION_ID_PATTERN.source).toBe(SESSION_ID_RE.source));

  it('takes the same ids as the server does', () => {
    for (const id of [ID, MINTED, '0'.repeat(26), 'z'.repeat(26), ID.slice(1), ID + '0', ID.toUpperCase(), 'opus-ab12', '']) {
      expect(SESSION_ID_PATTERN.test(id), id).toBe(SESSION_ID_RE.test(id));
    }
  });
});

describe('mintSessionId', () => {
  it('writes 16 random bytes as the same 26 characters as the server writes them', () => {
    const samples = [
      new Uint8Array(16),
      new Uint8Array(16).fill(0xff),
      Uint8Array.from({ length: 16 }, (_, i) => i),
      ...Array.from({ length: 50 }, () => crypto.getRandomValues(new Uint8Array(16))),
    ];
    for (const bytes of samples) {
      const asked: number[] = [];
      const id = mintSessionId((buffer) => {
        asked.push(buffer.length);
        buffer.set(bytes);
        return buffer;
      });
      expect(asked).toEqual([16]);
      expect(id).toBe(encodeSessionId(bytes));
      expect(id).toMatch(SESSION_ID_RE);
    }
  });

  it('never repeats', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => mintSessionId((bytes) => crypto.getRandomValues(bytes))));
    expect(ids.size).toBe(1000);
  });

  it('has no random source of its own to fall back on', () => {
    const random = vi.spyOn(Math, 'random');
    expect(() => mintSessionId(undefined as never)).toThrow();
    expect(random).not.toHaveBeenCalled();
  });
});

describe('the bridge on a page', () => {
  it('takes the session from the path and connects to /ws with the id in the query and no role', () => {
    const { bridge, socket, replaced } = open({ pathname: `/s/${ID}` });
    expect(bridge.sessionId).toBe(ID);
    expect(socket.url).toBe(`wss://djopus.test/ws?session=${ID}`);
    expect(replaced).toEqual([]);
  });

  it('ignores ?session= when building the bridge', () => {
    const { bridge, socket, replaced } = open({ pathname: '/', search: '?session=opus-ab12' });
    expect(bridge.sessionId).toMatch(SESSION_ID_RE);
    expect(bridge.sessionId).not.toBe('opus-ab12');
    expect(socket.url).toBe(`wss://djopus.test/ws?session=${bridge.sessionId}`);
    expect(replaced).toEqual([`/s/${bridge.sessionId}`]);

    // On a player URL the path decides, whatever the query says.
    const onPath = open({ pathname: `/s/${ID}`, search: '?session=opus-ab12' });
    expect(onPath.bridge.sessionId).toBe(ID);
    expect(onPath.socket.url).toBe(`wss://djopus.test/ws?session=${ID}`);
  });

  it('puts the id it mints in the address bar, once, and a reload of that address keeps the session', () => {
    const first = open({ pathname: '/' });
    expect(first.replaced).toEqual([`/s/${first.bridge.sessionId}`]);
    expect(first.replaced[0]).toMatch(SHAPE);

    const reloaded = open({ pathname: first.replaced[0] });
    expect(reloaded.bridge.sessionId).toBe(first.bridge.sessionId);
    expect(reloaded.replaced).toEqual([]);
  });

  it('mints a different session for every page that opens at /', () => {
    const ids = new Set(Array.from({ length: 50 }, () => open({ pathname: '/' }).bridge.sessionId));
    expect(ids.size).toBe(50);
  });

  it('replaces a /s/ path that holds no id, and says nothing of the old one', () => {
    const { bridge, replaced } = open({ pathname: '/s/opus-ab12' });
    expect(bridge.sessionId).toMatch(SESSION_ID_RE);
    expect(replaced).toEqual([`/s/${bridge.sessionId}`]);
  });

  it('leaves the address alone in widget mode, and the config session wins', () => {
    const { bridge, socket, replaced } = open({
      pathname: '/',
      host: '',
      config: { sessionId: 'chatgpt-conv-0123456789abcdef', mode: 'widget', wsUrl: 'wss://chatgpt.example/ws' },
    });
    expect(bridge.sessionId).toBe('chatgpt-conv-0123456789abcdef');
    expect(socket.url).toBe('wss://chatgpt.example/ws?session=chatgpt-conv-0123456789abcdef');
    expect(replaced).toEqual([]);
  });

  it('still connects when the address cannot be rewritten, and says so', () => {
    const warn = vi.mocked(console.warn);
    const { bridge, socket } = open({ pathname: '/', replaceUrlError: new DOMException('sandboxed', 'SecurityError') });
    expect(bridge.sessionId).toMatch(SESSION_ID_RE);
    expect(socket.url).toBe(`wss://djopus.test/ws?session=${bridge.sessionId}`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('address');
  });

  it('asks the platform for the bytes of the id it mints', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i * 3 + 1);
    const asked: number[] = [];
    const { bridge } = open({
      pathname: '/',
      getRandomValues: (buffer) => {
        asked.push(buffer.length);
        buffer.set(bytes);
        return buffer;
      },
    });
    expect(asked).toEqual([16]);
    expect(bridge.sessionId).toBe(encodeSessionId(bytes));
  });

  it('does not ask for any bytes when the path or the config names the session', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes);
    open({ pathname: `/s/${ID}`, getRandomValues });
    open({ pathname: '/', config: { sessionId: 'widget-7' }, getRandomValues });
    expect(getRandomValues).not.toHaveBeenCalled();
  });
});

describe('the link to the session', () => {
  it('is the player URL of the page: origin, /s/ and the id, with no query', () => {
    const { bridge } = open({ pathname: `/s/${ID}` });
    expect(bridge.playerUrl()).toBe(`https://djopus.test/s/${ID}`);

    const local = open({ protocol: 'http:', host: 'localhost:8787', pathname: `/s/${ID}`, search: '?x=1' });
    expect(local.bridge.playerUrl()).toBe(`http://localhost:8787/s/${ID}`);
  });

  it('is the link of the id that was minted, and not the link the page was opened with', () => {
    const { bridge, replaced } = open({ pathname: '/', search: '?session=opus-ab12' });
    expect(bridge.playerUrl()).toBe(`https://djopus.test${replaced[0]}`);
    expect(bridge.playerUrl()).toBe(`https://djopus.test/s/${bridge.sessionId}`);
  });
});
