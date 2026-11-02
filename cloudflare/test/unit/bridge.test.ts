import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  FakeWebSocket, makeEnv, makeMirror, makeProtoMirror, type BridgeModule, type EnvOptions, type FakeMirror,
} from './helpers/fake-env';

// The bridge is a classic browser script. Loaded under CommonJS (client/package.json says so) it
// exports its core and does not boot.
const loadCjs = createRequire(import.meta.url);
const { createBridge, nextReconnectDelay, LOCAL_KEYS } = loadCjs('../../client/strudel-ws-bridge.js') as BridgeModule;

const sockets = () => FakeWebSocket.instances;
const last = () => FakeWebSocket.last();

function start(options: EnvOptions = {}) {
  const env = makeEnv(options);
  const bridge = createBridge(env.deps);
  bridge.connect();
  return { ...env, bridge };
}

/** start(), and the first socket opens. */
function startOpen(options: EnvOptions = {}) {
  const started = start(options);
  last().open();
  return started;
}

/** A session id, as the page's address names it. */
const SESSION = 'abcdefghjkmnpqrstvwxyz0123';

const sessionState = (currentPattern: string, rev?: number) => ({
  type: 'session_state',
  payload: rev === undefined ? { currentPattern } : { currentPattern, rev },
});

/** The current socket drops, and the page reconnects at once, as it does when the tab becomes visible. */
function reconnect(bridge: { onVisible(): void }) {
  last().drop();
  bridge.onVisible();
  last().open();
}

/** The code of every write that reached the editor, in order. */
const written = (mirror: { writes: { mock: { calls: Array<[string]> } } }) => mirror.writes.mock.calls.map(([code]) => code);

/** More than the server's 65,536 UTF-8 bytes, in fewer than 65,536 UTF-16 units. */
const oversized = () => String.fromCharCode(0x20ac).repeat(30_000);

let errorSpy: MockInstance;
let warnSpy: MockInstance;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reconnecting', () => {
  it('nextReconnectDelay doubles with jitter and caps at 30s', () => {
    expect(nextReconnectDelay(0, () => 0)).toBe(500);
    expect(nextReconnectDelay(0, () => 1)).toBe(1000);
    expect(nextReconnectDelay(3, () => 1)).toBe(8000);
    expect(nextReconnectDelay(10, () => 1)).toBe(30_000);
    expect(nextReconnectDelay(10, () => 0)).toBe(15_000);
  });

  it('keeps reconnecting after 50 closes', () => {
    start();
    for (let i = 0; i < 50; i++) {
      last().drop();
      vi.runOnlyPendingTimers(); // the reconnect, and not the connect timeout of the socket it makes
    }
    expect(sockets()).toHaveLength(51);
  });

  it('backs off between failed attempts and starts over after a successful open', () => {
    start(); // random() is 1, so the delays are 1 s, 2 s, 4 s, ...
    last().drop();
    vi.advanceTimersByTime(999);
    expect(sockets()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets()).toHaveLength(2);

    last().drop();
    vi.advanceTimersByTime(1999);
    expect(sockets()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets()).toHaveLength(3);

    last().drop();
    vi.advanceTimersByTime(4000);
    expect(sockets()).toHaveLength(4);

    last().open();
    last().drop();
    vi.advanceTimersByTime(999);
    expect(sockets()).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(sockets()).toHaveLength(5);
  });

  it('reconnects immediately on visibility or online', () => {
    const { bridge } = startOpen();
    last().drop();
    expect(sockets()).toHaveLength(1);

    bridge.onVisible();
    expect(sockets()).toHaveLength(2);
    // the timer that was pending is gone: nothing else connects
    vi.advanceTimersByTime(9_000);
    expect(sockets()).toHaveLength(2);

    last().drop();
    bridge.onOnline();
    expect(sockets()).toHaveLength(3);
  });

  it('leaves a live socket alone on visibility or online', () => {
    const { bridge } = startOpen();
    bridge.onVisible();
    bridge.onOnline();
    expect(sockets()).toHaveLength(1);
    expect(last().closeCalls).toBe(0);
  });

  it('keeps retrying when the socket cannot even be constructed', () => {
    const { deps } = makeEnv();
    let attempts = 0;
    class Throwing {
      constructor() {
        attempts++;
        throw new SyntaxError('bad url');
      }
    }
    const bridge = createBridge({ ...deps, WebSocketImpl: Throwing as never });
    bridge.connect();
    vi.advanceTimersByTime(60_000); // attempts at 0 s, 1 s, 3 s, 7 s, 15 s and 31 s
    expect(attempts).toBe(6);
    expect(bridge.status).toBe('reconnecting');
  });

  it('closes a socket that is still connecting after 10s, and goes through the backoff', () => {
    const { bridge } = start();
    const stuck = last();
    vi.advanceTimersByTime(9_999);
    expect(stuck.closeCalls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(stuck.closeCalls).toBe(1);
    expect(bridge.status).toBe('reconnecting');
    expect(sockets()).toHaveLength(1);

    vi.advanceTimersByTime(1_000); // random() is 1, so the first backoff is 1 s
    expect(sockets()).toHaveLength(2);

    stuck.open(); // the abandoned socket opens after all: that changes nothing
    expect(bridge.status).toBe('reconnecting');
    expect(stuck.sent).toEqual([]);
  });

  it('keeps going when every socket gets stuck', () => {
    start();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10_000); // the socket is given up on
      vi.advanceTimersByTime(30_000); // the backoff passes and the next socket is made
    }
    expect(sockets().length).toBeGreaterThanOrEqual(6);
  });

  it('does not time out a socket that opened in time', () => {
    start();
    vi.advanceTimersByTime(9_000);
    last().open();
    FakeWebSocket.autoPong = true;
    vi.advanceTimersByTime(60_000);
    expect(last().closeCalls).toBe(0);
    expect(sockets()).toHaveLength(1);
  });

  it('lets visibility and online reconnect at once after a stuck socket was given up on', () => {
    const { bridge } = start();
    vi.advanceTimersByTime(10_000);
    expect(sockets()).toHaveLength(1);
    bridge.onVisible(); // the backoff has not run out
    expect(sockets()).toHaveLength(2);

    vi.advanceTimersByTime(10_000);
    expect(sockets()).toHaveLength(2);
    bridge.onOnline();
    expect(sockets()).toHaveLength(3);
  });

  it('ignores the events of a socket it has replaced', () => {
    const { bridge, statuses } = startOpen();
    const old = last();
    old.drop();
    bridge.onVisible();
    last().open();
    expect(sockets()).toHaveLength(2);

    old.drop(); // a late close for the first socket
    old.receive(sessionState('stale', 99));
    vi.advanceTimersByTime(5_000); // a reconnect, if the late close started one, would be due after 1 s
    expect(sockets()).toHaveLength(2);
    expect(bridge.status).toBe('connected');
    expect(statuses).toEqual(['connected', 'reconnecting', 'connected']);
  });
});

describe('the connection', () => {
  // Which session a page belongs to is bridge-session.test.ts. A socket is the id in the query and nothing else: the
  // app's /ws takes browsers only, and the Durable Object takes a socket with no role for a browser.
  it('connects to /ws on the page host with the session from the path', () => {
    start({ protocol: 'https:', host: 'djopus.test', pathname: `/s/${SESSION}` });
    expect(last().url).toBe(`wss://djopus.test/ws?session=${SESSION}`);
  });

  it('uses ws: on http pages', () => {
    const { bridge } = start({ protocol: 'http:', host: 'localhost:8787', pathname: `/s/${SESSION}` });
    expect(last().url).toBe(`ws://localhost:8787/ws?session=${SESSION}`);
    expect(bridge.sessionId).toBe(SESSION);
  });

  it('lets DJOPUS_CONFIG win over the path, and wsUrl win over the page host', () => {
    const { bridge } = start({
      pathname: `/s/${SESSION}`,
      config: { sessionId: 'widget-7', mode: 'widget', wsUrl: 'wss://chatgpt.example/ws' },
      host: '',
    });
    expect(bridge.sessionId).toBe('widget-7');
    expect(last().url).toBe('wss://chatgpt.example/ws?session=widget-7');
  });

  it('keeps a session id from adding query parameters', () => {
    start({ config: { sessionId: 'a&role=controller' } });
    expect(last().url).toBe('wss://djopus.test/ws?session=a%26role%3Dcontroller');
  });

  it('asks for no role: the app takes browsers only', () => {
    start({ pathname: `/s/${SESSION}` });
    expect(new URL(last().url).searchParams.has('role')).toBe(false);
  });

  it('reports connecting, connected, reconnecting and offline', () => {
    const { bridge, statuses } = start();
    expect(bridge.status).toBe('connecting');

    last().open();
    expect(bridge.status).toBe('connected');

    last().drop();
    expect(bridge.status).toBe('reconnecting');

    bridge.onVisible();
    expect(bridge.status).toBe('reconnecting'); // still trying
    last().open();
    expect(bridge.status).toBe('connected');

    bridge.onOffline();
    expect(bridge.status).toBe('offline');
    last().drop();
    expect(bridge.status).toBe('offline'); // a close while the browser is offline stays offline

    bridge.onOnline(); // reconnects at once
    expect(sockets()).toHaveLength(3);
    expect(bridge.status).toBe('reconnecting');
    last().open();
    expect(bridge.status).toBe('connected');

    expect(statuses).toEqual(['connected', 'reconnecting', 'connected', 'offline', 'reconnecting', 'connected']);
  });

  it('goes back to connected when online returns on a socket that never closed', () => {
    const { bridge } = startOpen();
    bridge.onOffline();
    expect(bridge.status).toBe('offline');
    bridge.onOnline();
    expect(bridge.status).toBe('connected');
    expect(sockets()).toHaveLength(1);
  });
});

describe('liveness', () => {
  it('pings every 25s and reconnects when no pong arrives in 10s', () => {
    const { statuses } = startOpen();
    const first = last();

    vi.advanceTimersByTime(24_999);
    expect(first.sent).not.toContain('ping');
    vi.advanceTimersByTime(1);
    expect(first.sent[first.sent.length - 1]).toBe('ping');

    vi.advanceTimersByTime(9_999);
    expect(first.closeCalls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(first.closeCalls).toBe(1);
    expect(sockets()).toHaveLength(1); // the reconnect is scheduled, not made yet

    vi.advanceTimersByTime(1_000);
    expect(sockets()).toHaveLength(2);
    expect(statuses).toEqual(['connected', 'reconnecting']);
  });

  it('keeps the socket when each pong arrives in time', () => {
    startOpen();
    const socket = last();
    const pings = () => socket.sent.filter((frame) => frame === 'ping').length;

    vi.advanceTimersByTime(25_000);
    for (let round = 1; round <= 3; round++) {
      expect(pings()).toBe(round);
      vi.advanceTimersByTime(5_000); // the answer takes 5 s
      socket.receive('pong');
      vi.advanceTimersByTime(20_000); // on to the next ping, well past the first deadline
    }
    expect(pings()).toBe(4);
    expect(socket.closeCalls).toBe(0);
    expect(sockets()).toHaveLength(1);
  });

  it('pings only the socket that is current', () => {
    const { bridge } = startOpen();
    reconnect(bridge);
    reconnect(bridge);
    const [first, second, third] = sockets();

    vi.advanceTimersByTime(25_000);
    expect(first.sent).not.toContain('ping');
    expect(second.sent).not.toContain('ping');
    expect(third.sent.filter((frame) => frame === 'ping')).toHaveLength(1);
  });

  it.each(['onVisible', 'onOnline'] as const)('probes a socket that looks open on %s, and finds a dead one within 10s', (event) => {
    const { bridge } = startOpen();
    const first = last();
    vi.advanceTimersByTime(5_000); // well before the regular ping at 25 s
    expect(first.sent).not.toContain('ping');

    bridge[event]();
    expect(first.sent[first.sent.length - 1]).toBe('ping');
    vi.advanceTimersByTime(9_999);
    expect(first.closeCalls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(first.closeCalls).toBe(1);

    vi.advanceTimersByTime(1_000);
    expect(sockets()).toHaveLength(2);
  });

  it('keeps the socket when the probe is answered', () => {
    const { bridge } = startOpen();
    bridge.onVisible();
    vi.advanceTimersByTime(2_000);
    last().receive('pong');
    vi.advanceTimersByTime(20_000);
    expect(last().closeCalls).toBe(0);
    expect(sockets()).toHaveLength(1);
  });

  it('does not start a second clock for a probe while a ping is still waiting', () => {
    const { bridge } = startOpen();
    bridge.onVisible(); // the deadline is 10 s from now
    vi.advanceTimersByTime(5_000);
    bridge.onVisible(); // asks again, but the first deadline stands
    vi.advanceTimersByTime(4_999);
    expect(last().closeCalls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(last().closeCalls).toBe(1);
  });

  it('does not probe a socket that is not open yet', () => {
    const { bridge } = start();
    bridge.onVisible();
    bridge.onOnline();
    expect(last().sent).toEqual([]);
    expect(last().closeCalls).toBe(0);
  });

  it('reconnects after a missing pong even when the dead socket never reports its close', () => {
    startOpen();
    const dead = last();
    FakeWebSocket.silentClose = true; // from here on close() raises no event, like a peer that is gone

    vi.advanceTimersByTime(35_000);
    expect(dead.closeCalls).toBe(1);
    expect(dead.readyState).toBe(2);

    vi.advanceTimersByTime(1_000);
    expect(sockets()).toHaveLength(2);

    dead.drop(); // if the close ever does arrive, it changes nothing
    vi.advanceTimersByTime(5_000);
    expect(sockets()).toHaveLength(2);
  });

  it('stops pinging and reporting once the socket closes', () => {
    startOpen();
    const socket = last();
    socket.drop();
    expect(vi.getTimerCount()).toBe(2); // the reconnect, and the end of the restore guard
    const sent = socket.sent.length;
    vi.advanceTimersByTime(24_000);
    expect(socket.sent).toHaveLength(sent);
  });

  it('ignores non-JSON frames', () => {
    startOpen();
    const socket = last();
    for (const frame of ['pong', 'garbage', '', '{', 'null', '123', '"text"', '[1,2]', '{"no":"type"}', 'ping']) {
      expect(() => socket.receive(frame)).not.toThrow();
    }
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(socket.closeCalls).toBe(0);
  });
});

describe('session_state', () => {
  it('applies the first session_state after 1.5s', () => {
    const { mirror } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1499);
    expect(mirror.writes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mirror.writes).toHaveBeenCalledTimes(1);
    expect(mirror.writes).toHaveBeenCalledWith('x');
  });

  it('does not reapply the same rev on reconnect', () => {
    const { mirror, bridge } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1500);
    expect(mirror.writes).toHaveBeenCalledTimes(1);

    mirror.code = 'typed by hand';
    reconnect(bridge);
    last().receive(sessionState('x', 3));
    last().receive(sessionState('something else', 3)); // made up, with the same rev: only the rev keeps it out
    vi.advanceTimersByTime(5_000);
    expect(mirror.writes).toHaveBeenCalledTimes(1);
    expect(mirror.code).toBe('typed by hand');
  });

  it('applies a newer rev on reconnect immediately', () => {
    const { mirror, bridge } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1500);

    reconnect(bridge);
    last().receive(sessionState('y', 4));
    expect(mirror.writes).toHaveBeenCalledTimes(2);
    expect(mirror.writes).toHaveBeenLastCalledWith('y');
    expect(mirror.code).toBe('y');
  });

  it('leaves the editor alone when a newer rev holds the code it already shows', () => {
    const { mirror, bridge } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1500);

    mirror.code = 'y'; // the same text as the server's next state
    reconnect(bridge);
    last().receive(sessionState('y', 4));
    expect(mirror.writes).toHaveBeenCalledTimes(1);

    mirror.code = 'y and then some';
    reconnect(bridge);
    last().receive(sessionState('y', 4)); // rev 4 has been seen
    expect(mirror.writes).toHaveBeenCalledTimes(1);
  });

  it('never stops playback because of session_state', () => {
    const { mirror, bridge } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1500);
    const applied = mirror.writes.mock.calls.length;

    // A DO that lost its state, an old DO and a stale one all send an empty pattern.
    for (const state of [sessionState('', 0), sessionState(''), sessionState('', 2)]) {
      reconnect(bridge);
      last().receive(state);
      vi.advanceTimersByTime(5_000);
    }
    expect(mirror.writes).toHaveBeenCalledTimes(applied);
    expect(mirror.code).toBe('x');

    // Even a newer empty state only sets the editor. It never stops what is playing.
    reconnect(bridge);
    last().receive(sessionState('', 9));
    expect(mirror.code).toBe('');
    expect(mirror.stop).not.toHaveBeenCalled();
  });

  it('clears the editor and Strudel restore keys on first connect to an empty session', () => {
    const { mirror, localStorage, sessionStorage } = startOpen();
    localStorage.setItem('strudel-settingslatestCode', 's("bd")');
    localStorage.setItem('unrelated', 'kept');
    sessionStorage.setItem('viewingPatternData', '{}');
    sessionStorage.setItem('activePattern', 'p');
    mirror.code = 's("bd")'; // what Strudel restored

    last().receive(sessionState('', 0));
    expect(mirror.writes).toHaveBeenCalledWith('');
    expect(mirror.code).toBe('');
    expect(localStorage.getItem('strudel-settingslatestCode')).toBeNull();
    expect(sessionStorage.getItem('viewingPatternData')).toBeNull();
    expect(sessionStorage.getItem('activePattern')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('kept');
    expect(mirror.stop).not.toHaveBeenCalled();
  });

  it('clears an empty session again after Strudel has had time to restore its own code', () => {
    const { mirror } = startOpen();
    last().receive(sessionState('', 0));
    vi.advanceTimersByTime(700);
    mirror.code = 'restored late by strudel';
    vi.advanceTimersByTime(800);
    expect(mirror.code).toBe('');
    expect(mirror.stop).not.toHaveBeenCalled();
  });

  it('treats an empty session without a rev as a new one', () => {
    const { mirror, localStorage } = startOpen();
    localStorage.setItem('strudel-settingslatestCode', 'old');
    mirror.code = 'restored';
    last().receive(sessionState(''));
    expect(mirror.code).toBe('');
    expect(localStorage.getItem('strudel-settingslatestCode')).toBeNull();
  });

  it('treats an empty session with a rev as a pattern to restore, not as a new session', () => {
    const { mirror, localStorage } = startOpen();
    localStorage.setItem('strudel-settingslatestCode', 'old');
    mirror.code = 'restored';
    last().receive(sessionState('', 5)); // somebody reset a session that had history
    expect(mirror.writes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(mirror.writes).toHaveBeenCalledWith('');
    expect(localStorage.getItem('strudel-settingslatestCode')).toBe('old');
  });

  it('applies a rev-less session_state only on first connect', () => {
    const { mirror, bridge } = startOpen();
    last().receive(sessionState('old do code'));
    vi.advanceTimersByTime(1500);
    expect(mirror.writes).toHaveBeenCalledTimes(1);
    expect(mirror.writes).toHaveBeenCalledWith('old do code');

    reconnect(bridge);
    last().receive(sessionState('different code'));
    vi.advanceTimersByTime(5_000);
    expect(mirror.writes).toHaveBeenCalledTimes(1);
    expect(mirror.code).toBe('old do code');
  });

  it('brings the waiting first state in before an append edits the editor', () => {
    const mirror = makeMirror('STALE_LOCAL'); // what Strudel restored
    startOpen({ mirror });
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(300);
    last().receive({ type: 'append_code', request_id: 'a1', payload: { code: 'f' } });

    expect(last().jsonOfType('ack')).toEqual([
      { type: 'ack', request_id: 'a1', status: 'appended', payload: { code: 'x\nf' } },
    ]);
    expect(mirror.code).toBe('x\nf');
    vi.advanceTimersByTime(5_000); // the first state is not applied a second time
    expect(mirror.code).toBe('x\nf');
    expect(written(mirror)).toEqual(['x', 'x\nf']);
  });

  it('brings the waiting first state in before a replace that matches nothing', () => {
    const mirror = makeMirror('STALE_LOCAL');
    startOpen({ mirror });
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(300);
    last().receive({ type: 'replace_code', request_id: 'r1', payload: { search: 'nothing', replace: 'q' } });

    expect(last().jsonOfType('ack')).toEqual([
      { type: 'ack', request_id: 'r1', status: 'replaced', payload: { changed: false, code: 'x' } },
    ]);
    expect(mirror.code).toBe('x');
  });

  it('brings the waiting first state in before an effect is added', () => {
    const mirror = makeMirror('STALE_LOCAL');
    startOpen({ mirror });
    last().receive(sessionState('s("bd")', 3));
    vi.advanceTimersByTime(300);
    last().receive({ type: 'add_effect', request_id: 'f1', payload: { effect: 'lpf', params: { cutoff: 800 } } });

    expect(last().jsonOfType('ack')).toEqual([
      { type: 'ack', request_id: 'f1', status: 'effect_added', payload: { code: 's("bd").lpf(800)' } },
    ]);
  });

  it('brings the waiting first state in before it answers get_code', () => {
    const mirror = makeMirror('STALE_LOCAL');
    startOpen({ mirror });
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(300);
    last().receive({ type: 'get_code', request_id: 'g0' });

    expect(last().jsonOfType('code_response')).toEqual([
      { type: 'code_response', request_id: 'g0', payload: { code: 'x' } },
    ]);
    expect(mirror.code).toBe('x');
  });

  it('brings the waiting first state in before recover_audio plays the editor', async () => {
    const mirror = makeMirror('STALE_LOCAL');
    let played = '';
    mirror.evaluations.mockImplementation(() => {
      played = mirror.code;
      return Promise.resolve();
    });
    mirror.repl.audioContext.state = 'suspended';
    mirror.repl.audioContext.resume.mockImplementation(() => {
      mirror.repl.audioContext.state = 'running';
      return Promise.resolve();
    });
    startOpen({ mirror });
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(300);
    last().receive({ type: 'recover_audio', request_id: 'ra1' });
    await vi.advanceTimersByTimeAsync(10);
    expect(played).toBe('x');
  });

  it('brings a waiting first state in when a reconnect inside the wait carries a newer rev with the same code', () => {
    const mirror = makeMirror('STALE_LOCAL');
    const { bridge } = startOpen({ mirror });
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(200);

    reconnect(bridge);
    last().receive(sessionState('x', 4)); // the server re-evaluated the same code meanwhile
    expect(mirror.code).toBe('x');
    vi.advanceTimersByTime(5_000);
    expect(written(mirror)).toEqual(['x']);
  });

  it('remembers the code a get_code gave the server, so a later edit survives a reconnect and a server restart', () => {
    const { mirror, bridge } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1500);
    last().receive({ type: 'evaluate', request_id: 'e1', payload: { code: 'A' } }); // the DO is at rev 4
    mirror.code = 'A2'; // the user edits
    last().receive({ type: 'get_code', request_id: 'g1' }); // the DO adopts A2, counts it in rev (5) and writes it out
    expect(last().jsonOfType('code_response')[0].payload.code).toBe('A2');
    mirror.code = 'A3'; // and edits again

    // The DO is evicted, or restarted by a deploy, and comes back from storage: A2 at rev 5.
    reconnect(bridge);
    last().receive(sessionState('A2', 5));
    expect(mirror.code).toBe('A3');
  });

  it('does not remember a get_code answer the server refuses for its size', () => {
    const { mirror, bridge } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1500);
    last().receive({ type: 'evaluate', request_id: 'e1', payload: { code: 'A' } }); // the DO is at rev 4, holding A
    mirror.code = oversized(); // the user pastes something huge
    last().receive({ type: 'get_code', request_id: 'g2' }); // the server refuses it and keeps A
    mirror.code = oversized() + '!';

    reconnect(bridge);
    last().receive(sessionState('A', 4));
    expect(mirror.code).toBe(oversized() + '!');
  });

  it('does not remember an edit result the server refuses for its size', () => {
    const { mirror, bridge } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1500);
    mirror.code = oversized();
    last().receive({ type: 'append_code', request_id: 'a9', payload: { code: 'y' } }); // the server will not adopt the ack
    mirror.code = oversized() + '!';

    reconnect(bridge);
    last().receive(sessionState('x', 4)); // still the code the page last synced
    expect(mirror.code).toBe(oversized() + '!');
  });

  it('does not take a frame without a payload for a new, empty session', () => {
    const { mirror } = startOpen();
    mirror.code = 'restored by strudel';
    last().receive({ type: 'session_state' });
    last().receive({ type: 'session_state', payload: null });
    last().receive({ type: 'session_state', payload: 'nope' });
    vi.advanceTimersByTime(5_000);
    expect(mirror.writes).not.toHaveBeenCalled();
    expect(mirror.code).toBe('restored by strudel');

    last().receive(sessionState('x', 3)); // the real state is still the first one
    vi.advanceTimersByTime(1500);
    expect(mirror.writes).toHaveBeenCalledWith('x');
  });

  it('follows a DO that gains a rev after a deploy', () => {
    const { mirror, bridge } = startOpen();
    last().receive(sessionState('before deploy'));
    vi.advanceTimersByTime(1500);

    reconnect(bridge);
    last().receive(sessionState('after deploy', 1));
    expect(mirror.writes).toHaveBeenLastCalledWith('after deploy');
  });

  it('lets a newer state replace the first one that is still waiting', () => {
    const { mirror, bridge } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(500);

    reconnect(bridge);
    last().receive(sessionState('y', 4));
    expect(mirror.writes).toHaveBeenCalledTimes(1);
    expect(mirror.writes).toHaveBeenCalledWith('y');

    vi.advanceTimersByTime(5_000);
    expect(mirror.writes).toHaveBeenCalledTimes(1);
    expect(mirror.code).toBe('y');
  });

  it('lets a command replace the first state that is still waiting', () => {
    const { mirror } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(300);
    last().receive({ type: 'set_code', request_id: 's1', payload: { code: 'from the agent' } });

    vi.advanceTimersByTime(5_000);
    expect(mirror.writes).toHaveBeenCalledTimes(1);
    expect(mirror.code).toBe('from the agent');
  });

  it('keeps the editor the agent last set and the user has changed since', () => {
    const { mirror, bridge } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1500);
    last().receive({ type: 'set_code', request_id: 's1', payload: { code: 'agent code' } }); // the DO is at rev 4 now
    mirror.code = 'agent code, tweaked by the user';

    reconnect(bridge);
    last().receive(sessionState('agent code', 4));
    expect(mirror.code).toBe('agent code, tweaked by the user');

    // The agent changes the code while the page is away: that one still lands.
    reconnect(bridge);
    last().receive(sessionState('agent code v2', 6));
    expect(mirror.code).toBe('agent code v2');
  });

  it('keeps the user edit after an append the agent made and the page acked', () => {
    const { mirror, bridge } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1500);
    last().receive({ type: 'append_code', request_id: 'a1', payload: { code: 'y' } });
    const ackedCode = last().jsonOfType('ack')[0].payload.code;
    mirror.code = ackedCode + ' // mine';

    reconnect(bridge);
    last().receive(sessionState(ackedCode, 5)); // the DO adopted the acked code
    expect(mirror.code).toBe(ackedCode + ' // mine');
  });
});

describe('the restore guard', () => {
  it('ignores a setCode call the page makes after the first state', () => {
    const { mirror } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(2_500); // Strudel's own restore lands about now, seconds late
    mirror.setCode('restored late by strudel');
    expect(mirror.code).toBe('x');
    expect(written(mirror)).toEqual(['x']);
  });

  it('keeps a late restore out of the next edit and the next get_code', () => {
    const { mirror } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(2_500);
    mirror.setCode('restored late by strudel');
    last().receive({ type: 'append_code', request_id: 'a1', payload: { code: 'f' } });
    last().receive({ type: 'get_code', request_id: 'g1' });

    expect(last().jsonOfType('ack')[0].payload.code).toBe('x\nf');
    expect(last().jsonOfType('code_response')[0].payload.code).toBe('x\nf');
  });

  it('keeps a new, empty session empty when a late restore lands', () => {
    const { mirror } = startOpen();
    last().receive(sessionState('', 0));
    vi.advanceTimersByTime(2_500);
    mirror.setCode('restored late by strudel');
    expect(mirror.code).toBe('');
  });

  it('lets the bridge write the editor while the guard is on', () => {
    const { mirror } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1500);
    last().receive({ type: 'set_code', request_id: 's1', payload: { code: 'from the agent' } });
    last().receive({ type: 'append_code', request_id: 'a1', payload: { code: 'more' } });
    last().receive({ type: 'reset_session', payload: { code: '' } });
    expect(written(mirror)).toEqual(['x', 'from the agent', 'from the agent\nmore', '']);
  });

  it('lets the page write the editor before the first state has arrived, as when the server is out of reach', () => {
    const { mirror } = startOpen();
    vi.advanceTimersByTime(2_500);
    mirror.setCode('restored by strudel');
    expect(mirror.code).toBe('restored by strudel');
  });

  it('lets the page write the editor once the window is over, and puts setCode back', () => {
    const mirror = makeMirror();
    const original = mirror.setCode;
    startOpen({ mirror });
    expect(mirror.setCode).not.toBe(original);
    last().receive(sessionState('x', 3));
    FakeWebSocket.autoPong = true;

    vi.advanceTimersByTime(9_999);
    mirror.setCode('too early');
    expect(mirror.code).not.toBe('too early');

    vi.advanceTimersByTime(1);
    expect(mirror.setCode).toBe(original);
    mirror.setCode('the user loads a pattern');
    expect(mirror.code).toBe('the user loads a pattern');
  });

  it('lets every call through once its window is over, also through a wrapper somebody still holds', () => {
    const { mirror } = startOpen();
    const guardWrapper = mirror.setCode; // somebody takes hold of the guard's wrapper during the window ...
    const theirs = function (this: FakeMirror, code: string) {
      guardWrapper.call(this, code); // ... and puts a wrapper of their own over it
    };
    mirror.setCode = theirs;
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1500);
    expect(mirror.code).toBe('x');

    mirror.setCode('restored late by strudel'); // inside the window, through both wrappers
    expect(mirror.code).toBe('x');

    vi.advanceTimersByTime(8_500); // the window ends. setCode is not the guard's own any more, so it is left in place
    expect(mirror.setCode).toBe(theirs);
    mirror.setCode('the user loads a pattern');
    expect(mirror.code).toBe('the user loads a pattern');

    // The bridge's own write goes through the held wrapper too, and must not be dropped.
    last().receive({ type: 'set_code', request_id: 's1', payload: { code: 'from the agent' } });
    expect(mirror.code).toBe('from the agent');
    expect(last().jsonOfType('ack').at(-1)).toMatchObject({ request_id: 's1', status: 'code_set' });
  });

  it('takes its own property off a mirror whose setCode is on the prototype', () => {
    const mirror = makeProtoMirror();
    const prototypeSetCode = Object.getPrototypeOf(mirror).setCode;
    startOpen({ mirror });
    expect(Object.prototype.hasOwnProperty.call(mirror, 'setCode')).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(Object.prototype.hasOwnProperty.call(mirror, 'setCode')).toBe(false);
    expect(mirror.setCode).toBe(prototypeSetCode);
  });

  it('leaves a setCode that somebody else put in its place', () => {
    const { mirror } = startOpen();
    const theirs = vi.fn();
    mirror.setCode = theirs;
    vi.advanceTimersByTime(10_000);
    expect(mirror.setCode).toBe(theirs);
  });

  it('still connects and works when the editor does not allow the guard', () => {
    const mirror = makeMirror();
    Object.defineProperty(mirror, 'setCode', { value: mirror.setCode, writable: false, configurable: false });
    const { bridge } = startOpen({ mirror });
    expect(bridge.status).toBe('connected');
    expect(warnSpy).toHaveBeenCalledWith('[strudel-ws] could not guard the editor against a late restore:', expect.any(TypeError));

    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1500);
    expect(mirror.code).toBe('x');
    mirror.setCode('restored late by strudel'); // nothing guards the editor, so this one is not ignored
    expect(mirror.code).toBe('restored late by strudel');
  });

  it('goes on the editor once there is one', () => {
    const { deps, mirror } = makeEnv({ noMirror: true });
    const original = mirror.setCode;
    let ready = false;
    const bridge = createBridge({ ...deps, getMirror: () => (ready ? mirror : null) });
    bridge.connect();
    last().open();
    expect(mirror.setCode).toBe(original);

    ready = true;
    vi.advanceTimersByTime(5_000); // the next look at the editor
    expect(mirror.setCode).not.toBe(original);
  });
});

describe('acks', () => {
  it('includes the new editor code in append acks', () => {
    const { mirror } = startOpen();
    mirror.code = 's("bd")';
    last().receive({ type: 'append_code', request_id: 'r1', payload: { code: 's("hh")' } });

    expect(mirror.code).toBe('s("bd")\ns("hh")');
    expect(last().jsonOfType('ack')).toEqual([
      { type: 'ack', request_id: 'r1', status: 'appended', payload: { code: mirror.code } },
    ]);
  });

  it('includes the new editor code in replace and effect acks', () => {
    const { mirror } = startOpen();
    mirror.code = 'a b a';
    last().receive({ type: 'replace_code', request_id: 'r2', payload: { search: 'a', replace: 'z' } });
    last().receive({ type: 'replace_code', request_id: 'r3', payload: { search: 'nothing', replace: 'q' } });
    mirror.code = 's("bd")';
    last().receive({ type: 'add_effect', request_id: 'r4', payload: { effect: 'lpf', params: { cutoff: 800 } } });

    expect(last().jsonOfType('ack')).toEqual([
      { type: 'ack', request_id: 'r2', status: 'replaced', payload: { changed: true, code: 'z b z' } },
      { type: 'ack', request_id: 'r3', status: 'replaced', payload: { changed: false, code: 'z b z' } },
      { type: 'ack', request_id: 'r4', status: 'effect_added', payload: { code: 's("bd").lpf(800)' } },
    ]);
  });

  it('answers an edit with an error when the editor is not ready', () => {
    const mirror = makeMirror();
    (mirror as { setCode?: unknown }).setCode = undefined; // the editor exists but cannot take code yet
    startOpen({ mirror });
    last().receive({ type: 'append_code', request_id: 'r5', payload: { code: 'x' } });
    expect(last().jsonOfType('error')).toEqual([
      { type: 'error', request_id: 'r5', payload: { message: 'Strudel editor is not ready yet.' } },
    ]);
  });
});

describe('status reports', () => {
  it('reports status once on open and then only on change', () => {
    const mirror = makeMirror('s("bd")');
    startOpen({ mirror });
    FakeWebSocket.autoPong = true; // this test runs for 40 s, and the socket must stay up
    expect(last().jsonOfType('status_report')).toEqual([
      {
        type: 'status_report',
        payload: { isPlaying: false, codeLength: 7, hasErrors: false, bpm: 120, errorMessage: null },
      },
    ]);

    vi.advanceTimersByTime(15_000);
    expect(last().jsonOfType('status_report')).toHaveLength(1);

    mirror.repl.scheduler.started = true;
    vi.advanceTimersByTime(5_000);
    expect(last().jsonOfType('status_report')).toHaveLength(2);
    expect(last().jsonOfType('status_report')[1].payload).toMatchObject({ isPlaying: true, codeLength: 7 });

    vi.advanceTimersByTime(15_000);
    expect(last().jsonOfType('status_report')).toHaveLength(2);

    mirror.code = 's("bd").fast(2)';
    mirror.repl.scheduler.cps = 0.6;
    vi.advanceTimersByTime(5_000);
    expect(last().jsonOfType('status_report')).toHaveLength(3);
    expect(last().jsonOfType('status_report')[2].payload).toMatchObject({ codeLength: 15, bpm: 144 });
  });

  it('reports again on every new connection', () => {
    const { bridge } = startOpen();
    reconnect(bridge);
    expect(last().jsonOfType('status_report')).toHaveLength(1);
  });

  it('waits for the editor before reporting', () => {
    const { deps, mirror } = makeEnv({ noMirror: true });
    let ready = false;
    const bridge = createBridge({ ...deps, getMirror: () => (ready ? mirror : null) });
    bridge.connect();
    last().open();
    vi.advanceTimersByTime(5_000);
    expect(last().jsonOfType('status_report')).toHaveLength(0);

    ready = true;
    vi.advanceTimersByTime(5_000);
    expect(last().jsonOfType('status_report')).toHaveLength(1);
  });
});

describe('commands', () => {
  it('warns about a command it does not know', () => {
    startOpen();
    last().receive({ type: 'frobnicate' });
    expect(warnSpy).toHaveBeenCalledWith('[strudel-ws] unknown command:', 'frobnicate');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('warns about a command that arrives before the editor has started', () => {
    startOpen({ noMirror: true });
    last().receive({ type: 'stop' });
    expect(warnSpy).toHaveBeenCalledWith('[strudel-ws] strudelMirror not ready');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a command that throws and carries on', () => {
    const { mirror } = startOpen();
    last().receive({ type: 'evaluate' }); // no payload
    expect(errorSpy).toHaveBeenCalled();
    last().receive({ type: 'stop' });
    expect(mirror.stop).toHaveBeenCalledTimes(1);
    expect(sockets()).toHaveLength(1);
  });

  it('stops, sets code, answers get_code and sets the tempo', () => {
    const { mirror, prompts } = startOpen();
    mirror.code = 's("bd")';

    last().receive({ type: 'stop', request_id: 'c0' });
    expect(mirror.stop).toHaveBeenCalledTimes(1);
    expect(prompts).toEqual([null]);

    last().receive({ type: 'set_code', request_id: 'c1', payload: { code: 's("sd")' } });
    last().receive({ type: 'get_code', request_id: 'c2' });
    last().receive({ type: 'set_tempo', request_id: 'c3', payload: { bpm: 140 } });

    expect(mirror.repl.evaluate).toHaveBeenCalledWith(`setcps(${140 / 60 / 4})`, false);
    expect(last().json().filter((frame) => frame.type !== 'status_report')).toEqual([
      { type: 'ack', request_id: 'c0', status: 'stopped' },
      { type: 'ack', request_id: 'c1', status: 'code_set', payload: { codeLength: 's("sd")'.length } },
      { type: 'code_response', request_id: 'c2', payload: { code: 's("sd")' } },
      { type: 'ack', request_id: 'c3', status: 'tempo_set', payload: { bpm: 140 } },
    ]);
  });

  it('acks a stop as stopped, with its request_id, once the editor has been stopped', () => {
    // The session reports a stop to the agent only on this ack: without it the agent cannot tell a page that stopped
    // from a tab that never heard the command.
    const { mirror } = startOpen();
    mirror.stop.mockImplementation(() => {
      expect(last().jsonOfType('ack')).toEqual([]); // the ack follows sm.stop(), it does not precede it
    });
    last().receive({ type: 'stop', request_id: 's1' });
    expect(mirror.stop).toHaveBeenCalledTimes(1);
    expect(last().jsonOfType('ack')).toEqual([{ type: 'ack', request_id: 's1', status: 'stopped' }]);
  });

  it('answers a stop the editor could not run with an error, not an ack', () => {
    const { mirror } = startOpen();
    mirror.stop.mockImplementation(() => { throw new Error('stop failed'); });
    last().receive({ type: 'stop', request_id: 's2' });
    expect(last().jsonOfType('ack')).toEqual([]);
    expect(last().jsonOfType('error')).toEqual([{ type: 'error', request_id: 's2', payload: { message: 'stop failed' } }]);
  });

  it('evaluates and acks playing once audio runs', async () => {
    const { mirror } = startOpen();
    last().receive({ type: 'evaluate', request_id: 'e1', payload: { code: 's("bd")' } });
    expect(mirror.writes).toHaveBeenCalledWith('s("bd")');
    expect(mirror.evaluations).toHaveBeenCalledWith(true);

    await vi.advanceTimersByTimeAsync(130);
    expect(last().jsonOfType('ack')).toEqual([
      { type: 'ack', request_id: 'e1', status: 'playing', payload: { codeLength: 's("bd")'.length, audioContextState: 'running' } },
    ]);
  });

  it('acks needs_user_gesture, and shows the prompt, while audio is suspended', async () => {
    const { mirror, prompts } = startOpen();
    mirror.repl.audioContext.state = 'suspended';
    last().receive({ type: 'evaluate', request_id: 'e2', payload: { code: 's("bd")' } });

    await vi.advanceTimersByTimeAsync(130);
    const [ack] = last().jsonOfType('ack');
    expect(ack).toMatchObject({
      request_id: 'e2',
      status: 'needs_user_gesture',
      payload: { codeLength: 's("bd")'.length, audioContextState: 'suspended' },
    });
    expect(prompts).toEqual(['default']);
  });

  it('answers a failing evaluate with an error that carries the code', async () => {
    const { mirror } = startOpen();
    mirror.evaluations.mockRejectedValueOnce(new Error('boom'));
    last().receive({ type: 'evaluate', request_id: 'e3', payload: { code: 'bad(' } });
    await vi.advanceTimersByTimeAsync(130);
    expect(last().jsonOfType('error')).toEqual([
      { type: 'error', request_id: 'e3', payload: { message: 'boom', code: 'bad(' } },
    ]);
  });

  it('reports a page error to the evaluation that is still pending', () => {
    const { mirror, bridge } = startOpen();
    expect(bridge.reportPendingEvalError('nobody is waiting')).toBe(false);

    last().receive({ type: 'evaluate', request_id: 'e4', payload: { code: 'oops' } });
    expect(mirror.evaluations).toHaveBeenCalled();
    expect(bridge.reportPendingEvalError('ReferenceError: oops is not defined')).toBe(true);
    expect(last().jsonOfType('error')).toEqual([
      { type: 'error', request_id: 'e4', payload: { message: 'ReferenceError: oops is not defined', code: 'oops' } },
    ]);
  });

  it('recovers audio by resuming the context and evaluating again', async () => {
    const { mirror, prompts } = startOpen();
    mirror.code = 's("bd")';
    mirror.repl.audioContext.state = 'suspended';
    mirror.repl.audioContext.resume.mockImplementation(() => {
      mirror.repl.audioContext.state = 'running';
      return Promise.resolve();
    });

    last().receive({ type: 'recover_audio', request_id: 'a1' });
    await vi.advanceTimersByTimeAsync(10);
    expect(mirror.evaluations).toHaveBeenCalledWith(true);
    expect(last().jsonOfType('ack')).toEqual([
      {
        type: 'ack',
        request_id: 'a1',
        status: 'audio_recovered',
        payload: { audioContextState: 'running', wasPlaying: false, codeLength: 7, recovered: true },
      },
    ]);
    expect(prompts).toEqual([null]);
  });

  it('asks for a tap when recovering cannot start audio', async () => {
    const { mirror, prompts } = startOpen();
    mirror.repl.audioContext.state = 'suspended';
    last().receive({ type: 'recover_audio', request_id: 'a2' });
    await vi.advanceTimersByTimeAsync(10);
    expect(last().jsonOfType('ack')[0]).toMatchObject({ request_id: 'a2', status: 'needs_user_gesture' });
    expect(prompts).toEqual(['Tap here to enable audio in DJ Opus']);
  });

  it('resets the session: clears the restore keys, stops, and sets the code it was given', () => {
    const { mirror, bridge, localStorage, sessionStorage } = startOpen();
    last().receive(sessionState('old', 1));
    vi.advanceTimersByTime(1500);
    localStorage.setItem('strudel-settingslatestCode', 'old');
    sessionStorage.setItem('activePattern', 'p');

    last().receive({ type: 'reset_session', payload: { code: '' } });
    expect(mirror.stop).toHaveBeenCalledTimes(1);
    expect(mirror.code).toBe('');
    expect(localStorage.getItem('strudel-settingslatestCode')).toBeNull();
    expect(sessionStorage.getItem('activePattern')).toBeNull();

    // The state that follows the reset does not take the user's typing away when the page reconnects.
    mirror.code = 'typed after the reset';
    reconnect(bridge);
    last().receive(sessionState('', 2));
    expect(mirror.code).toBe('typed after the reset');
  });

  it('names the keys Strudel restores from', () => {
    expect(LOCAL_KEYS).toEqual({
      local: ['strudel-settingslatestCode'],
      session: ['viewingPatternData', 'activePattern'],
    });
  });

  it('resumes audio on a user gesture and drops the prompt once it runs', async () => {
    const { mirror, bridge, prompts } = startOpen();
    mirror.repl.audioContext.state = 'suspended';
    mirror.repl.audioContext.resume.mockImplementation(() => {
      mirror.repl.audioContext.state = 'running';
      return Promise.resolve();
    });

    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(100);
    expect(mirror.repl.audioContext.resume).toHaveBeenCalled();
    expect(prompts).toEqual([null]);
    await expect(bridge.resumeAudio()).resolves.toBe('running');
  });
});
