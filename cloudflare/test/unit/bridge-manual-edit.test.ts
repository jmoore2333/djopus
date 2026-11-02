import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { FakeWebSocket, makeEnv, makeMirror, makeProtoMirror, type BridgeModule, type EnvOptions } from './helpers/fake-env';

// Manual edits reach the session. When the user plays the editor's text by hand (Ctrl+Enter, the play button), the
// bridge tells the session with a code_update, so that the session's code, rev and undo history are what is playing
// and not what the agent last sent. The status pill, which this file also covers, says "Waiting for your agent" until
// an agent's command has reached the page, and carries the links of the AGPL source offer. bridge.test.ts covers the
// connection and the commands, and the DOM of the pill is the boot layer's, which holds no logic.

const loadCjs = createRequire(import.meta.url);
const { createBridge, pillState, SOURCE_LINKS } = loadCjs('../../client/strudel-ws-bridge.js') as BridgeModule;

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

/** startOpen(), and the session's first state has been taken into the editor. */
function startSynced(code = 'x', rev = 3, options: EnvOptions = {}) {
  const started = startOpen(options);
  last().receive(sessionState(code, rev));
  vi.advanceTimersByTime(1500);
  return started;
}

const sessionState = (currentPattern: string, rev: number) => ({ type: 'session_state', payload: { currentPattern, rev } });

/** The current socket drops, and the page reconnects at once, as it does when the tab becomes visible. */
function reconnect(bridge: { onVisible(): void }) {
  last().drop();
  bridge.onVisible();
  last().open();
}

/** Every code_update that went out, on every socket the page has had. */
const codeUpdates = () => FakeWebSocket.instances.flatMap((socket) => socket.jsonOfType('code_update'));
const codeUpdate = (code: string) => ({ type: 'code_update', payload: { code } });

/** The code of every write that reached the editor, in order. */
const written = (mirror: { writes: { mock: { calls: Array<[string]> } } }) => mirror.writes.mock.calls.map(([code]) => code);

/** More than the server's 65,536 UTF-8 bytes, in fewer than 65,536 UTF-16 units. */
const oversized = () => String.fromCharCode(0x20ac).repeat(30_000);

/** What a controller can send the page through the session, each with a payload the page can use. */
const AGENT_COMMANDS: Array<[type: string, rest: object]> = [
  ['evaluate', { payload: { code: 's("bd")' } }],
  ['stop', {}],
  ['set_code', { payload: { code: 's("bd")' } }],
  ['set_tempo', { payload: { bpm: 120 } }],
  ['get_code', {}],
  ['append_code', { payload: { code: 's("hh")' } }],
  ['replace_code', { payload: { search: 'a', replace: 'b' } }],
  ['add_effect', { payload: { effect: 'lpf', params: { cutoff: 800 } } }],
  ['recover_audio', {}],
  ['reset_session', { payload: { code: '' } }],
];

let warnSpy: MockInstance;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a manual evaluation', () => {
  it('reports a manual evaluation once', async () => {
    const { mirror } = startSynced();

    mirror.code = 's("hh*8")';
    await mirror.evaluate(); // Ctrl+Enter
    expect(codeUpdates()).toEqual([codeUpdate('s("hh*8")')]);

    await mirror.evaluate(); // Ctrl+Enter again on the same text: the session has it
    expect(codeUpdates()).toHaveLength(1);

    mirror.code = 's("hh*8").fast(2)';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([codeUpdate('s("hh*8")'), codeUpdate('s("hh*8").fast(2)')]);
  });

  it('sends the text the evaluation ran on, not what has been typed since', async () => {
    const { mirror } = startSynced();
    mirror.code = 's("bd")';
    let finish!: () => void;
    mirror.evaluations.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));

    const evaluating = mirror.evaluate(); // reads the text as it starts
    mirror.code = 's("bd") // and then I typed on';
    finish();
    await evaluating;
    expect(codeUpdates()).toEqual([codeUpdate('s("bd")')]);
  });

  it('does not report the code the session already holds', async () => {
    const { mirror } = startSynced('x');
    await mirror.evaluate(); // the editor shows the session's code
    expect(codeUpdates()).toEqual([]);
  });

  it('sends nothing before the first state has come: until then the editor holds Strudel\'s own restore', async () => {
    const { mirror } = startOpen(); // connected, and the welcome frame is not in yet
    mirror.code = 's("strudels.own.restore")';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([]);

    last().receive(sessionState('x', 3)); // from here the page knows what the session holds
    vi.advanceTimersByTime(1500);
    mirror.code = 'mine';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([codeUpdate('mine')]);
  });

  // The session takes the editor's text from a get_code answer, and from the ack of an edit, only if it is still waiting
  // for it: a second tab's answer, an answer that a newer command passed, and an answer with no request_id are not taken.
  // So the page cannot count that text as the session's: the user's play of it is still news.
  it('reports a play of the text that a get_code answered with', async () => {
    const { mirror } = startSynced('x');
    mirror.code = 'B'; // the user types B
    last().receive({ type: 'get_code', request_id: 'g1' }); // an agent asks for the code, and the page answers B
    expect(last().jsonOfType('code_response')).toEqual([{ type: 'code_response', request_id: 'g1', payload: { code: 'B' } }]);

    await mirror.evaluate(); // the user plays B
    expect(codeUpdates()).toEqual([codeUpdate('B')]);

    await mirror.evaluate(); // and the report itself is known to the session
    expect(codeUpdates()).toHaveLength(1);
  });

  it('reports a play of the text that an edit left in the editor', async () => {
    const { mirror } = startSynced('x');
    last().receive({ type: 'append_code', request_id: 'a1', payload: { code: 'y' } }); // the editor holds 'x\ny', and the ack tells the session
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([codeUpdate('x\ny')]);
  });

  // And when the session did take the answer, the text the page knew it held before is not what it holds any more, so the
  // play of that text (a revert) is news as well. The page cannot tell whether the session took an answer, so after one it
  // does not say what the session holds, until a state, a command or a report of its own does.
  it('reports a play that reverts to the previous code after a get_code answer the session took', async () => {
    const { mirror } = startSynced('A');
    mirror.code = 'B';
    last().receive({ type: 'get_code', request_id: 'g1' }); // the session is waiting for the answer, so it takes B
    mirror.code = 'A'; // the user reverts, and plays
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([codeUpdate('A')]);
  });

  it.each([
    ['append_code', 'A', { code: 'x' }, 'A\nx'],
    ['replace_code', 'a b', { search: 'b', replace: 'c' }, 'a c'],
    ['add_effect', 's("bd")', { effect: 'lpf', params: { cutoff: 800 } }, 's("bd").lpf(800)'],
  ] as Array<[type: string, before: string, payload: object, after: string]>)('reports a play that reverts to the previous code after %s, which the session took', async (type, before, payload, after) => {
    const { mirror } = startSynced(before);
    last().receive({ type, request_id: 'e1', payload }); // the session is waiting for the ack, so it takes the result
    expect(mirror.code).toBe(after);
    mirror.code = before; // the user reverts the edit, and plays
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([codeUpdate(before)]);
  });

  it('knows what the session holds again once a command or a state says so', async () => {
    const { mirror, bridge } = startSynced('A');
    last().receive({ type: 'get_code', request_id: 'g1' }); // what the session holds is not known now
    last().receive({ type: 'set_code', request_id: 's1', payload: { code: 'S' } }); // a command: the session holds S
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([]);

    last().receive({ type: 'get_code', request_id: 'g2' }); // not known again ...
    reconnect(bridge);
    last().receive(sessionState('S', 4)); // ... until the server says what it holds
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([]);
  });

  it('still keeps the user\'s typing over a reconnect after a get_code answered with it', async () => {
    const { mirror, bridge } = startSynced('x', 3);
    mirror.code = 'B';
    last().receive({ type: 'get_code', request_id: 'g1' }); // the session takes B at rev 4
    mirror.code = 'B, and then some';

    reconnect(bridge);
    last().receive(sessionState('B', 4));
    expect(mirror.code).toBe('B, and then some');
    expect(written(mirror)).toEqual(['x']);
  });

  it('takes the server\'s word for what it holds at every connect, also when the state is not applied', async () => {
    const { mirror, bridge } = startSynced('x', 3);
    last().receive({ type: 'set_code', request_id: 's1', payload: { code: 'y' } }); // the session holds y, and so does the editor
    reconnect(bridge);
    last().receive(sessionState('', 3)); // a server that lost its state: the same rev as before, and nothing in it
    expect(mirror.code).toBe('y'); // the editor is left alone, and never stopped for an empty state ...
    await mirror.evaluate(); // ... and the user's next play puts the code back into the session
    expect(codeUpdates()).toEqual([codeUpdate('y')]);
  });

  it('leaves what the editor does alone: the arguments, the result and the failure reach the caller', async () => {
    const { mirror } = startSynced();
    mirror.code = 's("bd")';
    mirror.evaluations.mockResolvedValueOnce(undefined);
    await expect(mirror.evaluate(true)).resolves.toBeUndefined();
    expect(mirror.evaluations).toHaveBeenLastCalledWith(true);

    mirror.evaluations.mockRejectedValueOnce(new Error('no code to evaluate'));
    await expect(mirror.evaluate()).rejects.toThrow('no code to evaluate');
  });

  it('does not report command-driven evaluations', async () => {
    const { mirror } = startSynced();

    // An evaluate (an undo or a redo reaches the page as one too).
    last().receive({ type: 'evaluate', request_id: 'e1', payload: { code: 's("bd")' } });
    await vi.advanceTimersByTimeAsync(200);
    expect(mirror.evaluations).toHaveBeenCalledTimes(1);

    // recover_audio evaluates whatever the editor holds, once the audio context runs: later, and not in the call.
    mirror.code = 'typed, and never evaluated';
    mirror.repl.audioContext.state = 'suspended';
    mirror.repl.audioContext.resume.mockImplementation(() => {
      mirror.repl.audioContext.state = 'running';
      return Promise.resolve();
    });
    last().receive({ type: 'recover_audio', request_id: 'r1' });
    await vi.advanceTimersByTimeAsync(200);
    expect(mirror.evaluations).toHaveBeenCalledTimes(2);

    // set_code and the edits change the editor and play nothing.
    last().receive({ type: 'set_code', request_id: 's1', payload: { code: 's("hh")' } });
    last().receive({ type: 'append_code', request_id: 'a1', payload: { code: 's("sd")' } });
    last().receive({ type: 'replace_code', request_id: 'p1', payload: { search: 'sd', replace: 'cp' } });
    last().receive({ type: 'add_effect', request_id: 'f1', payload: { effect: 'lpf', params: { cutoff: 800 } } });
    await vi.advanceTimersByTimeAsync(200);

    expect(codeUpdates()).toEqual([]);
  });

  it('reports a manual evaluation after a command, once the text is new', async () => {
    const { mirror } = startSynced();
    last().receive({ type: 'evaluate', request_id: 'e1', payload: { code: 's("bd")' } });
    await vi.advanceTimersByTimeAsync(200);

    await mirror.evaluate(); // the agent's text, played again by hand
    expect(codeUpdates()).toEqual([]);

    mirror.code = 's("bd").fast(2)';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([codeUpdate('s("bd").fast(2)')]);
  });

  it('still reports a manual evaluation that starts while a command\'s evaluation is running', async () => {
    const { mirror } = startSynced();
    let finish!: () => void;
    mirror.evaluations.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    last().receive({ type: 'evaluate', request_id: 'e1', payload: { code: 's("bd")' } }); // the agent's evaluation hangs

    mirror.code = 's("hh")';
    await mirror.evaluate(); // the user is quicker
    expect(codeUpdates()).toEqual([codeUpdate('s("hh")')]);

    finish();
    await vi.advanceTimersByTimeAsync(200);
    expect(codeUpdates()).toHaveLength(1);
  });

  it('does not report a failed evaluation', async () => {
    const { mirror } = startSynced();
    mirror.code = 'oops(';
    // Strudel does not reject for code that is wrong: it sets evalError on the repl's state and resolves.
    mirror.evaluations.mockImplementationOnce(() => {
      mirror.repl.state.evalError = new Error('oops is not defined');
      return Promise.resolve();
    });
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([]);

    // It does reject for an empty editor. The caller sees that, and the session hears nothing.
    mirror.evaluations.mockRejectedValueOnce(new Error('no code to evaluate'));
    await expect(mirror.evaluate()).rejects.toThrow('no code to evaluate');
    expect(codeUpdates()).toEqual([]);

    // A failure is not a code the session has: the same text, once it runs, is news.
    mirror.repl.state.evalError = undefined; // what the next good evaluation does
    mirror.code = 's("bd")';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([codeUpdate('s("bd")')]);
  });

  it('does not report an evaluation that does not start playback (the export renders audio this way)', async () => {
    const { mirror } = startSynced();
    mirror.code = 's("bd")';
    await mirror.evaluate(false);
    expect(mirror.evaluations).toHaveBeenLastCalledWith(false);
    expect(codeUpdates()).toEqual([]);

    await mirror.evaluate(); // by default it starts
    expect(codeUpdates()).toEqual([codeUpdate('s("bd")')]);
  });

  it('does not take unsent code for sent: with no connection the session hears it with the next evaluation', async () => {
    const { mirror, bridge } = startSynced();
    last().drop();
    mirror.code = 'edited offline';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([]);

    bridge.onVisible();
    last().open();
    await mirror.evaluate(); // the text is still not the session's
    expect(codeUpdates()).toEqual([codeUpdate('edited offline')]);
  });

  it('does not send code the server would refuse for its size, and says so', async () => {
    const { mirror } = startSynced();
    mirror.code = oversized();
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[strudel-ws]'));
    expect(warnSpy.mock.calls.flat().join('\n')).not.toContain('€'); // the code stays out of the console

    mirror.code = 's("bd")'; // it is not remembered as synced either
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([codeUpdate('s("bd")')]);
  });

  it('remembers what it sent as the session\'s code, so a reconnect does not put older text over the user\'s typing', async () => {
    const { mirror, bridge } = startSynced('x', 3);
    mirror.code = 'mine';
    await mirror.evaluate(); // the session is at rev 4 now
    mirror.code = 'mine, and then some';

    reconnect(bridge);
    last().receive(sessionState('mine', 4));
    expect(mirror.code).toBe('mine, and then some');
    expect(written(mirror)).toEqual(['x']);

    // What the agent does meanwhile still lands.
    reconnect(bridge);
    last().receive(sessionState('agent code', 6));
    expect(mirror.code).toBe('agent code');
  });

  it('lets a manual evaluation replace the first state of a new session that is still waiting, as a command does', async () => {
    const { mirror } = startOpen();
    last().receive(sessionState('', 0)); // nothing to restore: the editor is cleared at once, so it holds the user's text
    vi.advanceTimersByTime(300);
    mirror.code = 'typed';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([codeUpdate('typed')]);

    vi.advanceTimersByTime(5_000); // and the second clearing, after Strudel's own restore had time to land, does not wipe it
    expect(mirror.code).toBe('typed');
    expect(written(mirror)).toEqual(['']);
  });
});

// For a session with code the editor holds Strudel's own restore (or nothing yet) until the first state is applied,
// 1.5 s after it arrived. What the user plays then is Strudel's text and not an edit of the session's code, and reporting
// it would replace the session's code with it (P2-R29). The first evaluation of a page waits for the samples to load, so
// it can end long after it started: the text is Strudel's if the call started before the session's code was in the editor.
describe('a manual evaluation while the first state of a session with code is waiting', () => {
  it('is not reported, and the session\'s code still comes into the editor', async () => {
    const { mirror } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(300);
    mirror.code = 's("strudels.own.restore")';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([]);

    vi.advanceTimersByTime(5_000);
    expect(mirror.code).toBe('x'); // not cancelled: the restore lands as it always did
    expect(written(mirror)).toEqual(['x']);
  });

  it('is reported once the first state has been applied', async () => {
    const { mirror } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(300);
    mirror.code = 's("strudels.own.restore")';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([]);

    vi.advanceTimersByTime(1_200); // 1.5 s since the state: the session's code is in the editor
    expect(mirror.code).toBe('x');
    mirror.code = 'mine';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([codeUpdate('mine')]);
  });

  it('is not reported on a reset session either: it has a rev, so the editor is restored and not cleared at once', async () => {
    const { mirror } = startOpen();
    last().receive(sessionState('', 5));
    vi.advanceTimersByTime(300);
    mirror.code = 's("strudels.own.restore")';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([]);
  });

  it('is not reported when it started in the wait and ends after the restore landed, as the first evaluation can', async () => {
    const { mirror } = startOpen();
    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(300);
    mirror.code = 's("strudels.own.restore")';
    let finish!: () => void;
    mirror.evaluations.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })); // loading samples
    const evaluating = mirror.evaluate();

    vi.advanceTimersByTime(5_000);
    expect(mirror.code).toBe('x'); // the session's code is in the editor, and the call is still running on Strudel's text
    finish();
    await evaluating;
    expect(codeUpdates()).toEqual([]);
  });

  it('is not reported when it started before the first state and ends after the restore landed', async () => {
    const { mirror } = startOpen(); // connected, and no state yet
    mirror.code = 's("strudels.own.restore")';
    let finish!: () => void;
    mirror.evaluations.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const evaluating = mirror.evaluate();

    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(5_000);
    expect(mirror.code).toBe('x');
    finish();
    await evaluating;
    expect(codeUpdates()).toEqual([]);
  });

  it('is not reported when it ends inside the wait, whenever it started', async () => {
    const { mirror } = startOpen();
    mirror.code = 's("strudels.own.restore")';
    let finish!: () => void;
    mirror.evaluations.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const evaluating = mirror.evaluate(); // started before the first state

    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(300);
    finish();
    await evaluating;
    expect(codeUpdates()).toEqual([]);
  });
});

describe('a manual evaluation while a command rewrites the editor', () => {
  it('is not reported when a command put the session\'s code in the editor while it ran', async () => {
    const { mirror } = startSynced();
    mirror.code = 'mine';
    let finish!: () => void;
    mirror.evaluations.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const evaluating = mirror.evaluate();

    last().receive({ type: 'set_code', request_id: 's1', payload: { code: 'the agent\'s code' } });
    expect(mirror.code).toBe('the agent\'s code');
    finish();
    await evaluating;
    expect(codeUpdates()).toEqual([]); // 'mine' is older than what the session holds now
  });
});

describe('the editor', () => {
  it('is wrapped once, however often the bridge looks at it', async () => {
    const { mirror, bridge } = startOpen();
    const wrapped = mirror.evaluate;
    reconnect(bridge);
    last().receive({ type: 'stop' });
    vi.advanceTimersByTime(20_000);
    expect(mirror.evaluate).toBe(wrapped);

    last().receive(sessionState('x', 3));
    vi.advanceTimersByTime(1500);
    mirror.code = 's("bd")';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([codeUpdate('s("bd")')]); // one frame, not one per wrapper
  });

  it('is wrapped with an own property when evaluate is on the prototype, as it is on StrudelMirror', async () => {
    const mirror = makeProtoMirror();
    const prototypeEvaluate = Object.getPrototypeOf(mirror).evaluate;
    startSynced('x', 3, { mirror });
    expect(Object.prototype.hasOwnProperty.call(mirror, 'evaluate')).toBe(true);
    expect(Object.getPrototypeOf(mirror).evaluate).toBe(prototypeEvaluate);

    mirror.code = 's("bd")';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([codeUpdate('s("bd")')]);
  });

  it('still connects and works when the editor does not allow it', async () => {
    const mirror = makeMirror();
    Object.defineProperty(mirror, 'evaluate', { value: mirror.evaluate, writable: false, configurable: false });
    const { bridge } = startOpen({ mirror });
    expect(bridge.status).toBe('connected');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[strudel-ws]'), expect.any(TypeError));

    last().receive({ type: 'evaluate', request_id: 'e1', payload: { code: 's("bd")' } }); // the agent's commands still run
    await vi.advanceTimersByTimeAsync(200);
    expect(mirror.evaluations).toHaveBeenCalledTimes(1);
    expect(last().jsonOfType('ack').at(-1)).toMatchObject({ request_id: 'e1', status: 'playing' });
  });

  it('is wrapped once there is an editor', async () => {
    const { deps, mirror } = makeEnv({ noMirror: true });
    const original = mirror.evaluate;
    let ready = false;
    const bridge = createBridge({ ...deps, getMirror: () => (ready ? mirror : null) });
    bridge.connect();
    last().open();
    expect(mirror.evaluate).toBe(original);

    ready = true;
    vi.advanceTimersByTime(5_000); // the next look at the editor
    expect(mirror.evaluate).not.toBe(original);

    last().receive(sessionState('x', 3)); // the session's state, which a report needs: see below
    vi.advanceTimersByTime(1500);
    mirror.code = 's("bd")';
    await mirror.evaluate();
    expect(codeUpdates()).toEqual([codeUpdate('s("bd")')]);
  });
});

describe('the status pill', () => {
  it('pillState is the connection\'s status, except that an open connection no agent has used is waiting', () => {
    expect(pillState('connected', false)).toBe('waiting');
    expect(pillState('connected', true)).toBe('connected');
    for (const status of ['connecting', 'reconnecting', 'offline'] as const) {
      expect(pillState(status, false)).toBe(status);
      expect(pillState(status, true)).toBe(status);
    }
  });

  it('shows waiting for your agent from the moment it connects, and the Phase 1 states once the first command arrives', () => {
    const { bridge, pills, statuses } = start();
    expect(bridge.pill).toBe('connecting');

    last().open();
    expect(bridge.pill).toBe('waiting');
    last().receive(sessionState('x', 3)); // the server's welcome, not an agent
    vi.advanceTimersByTime(1500);
    expect(bridge.pill).toBe('waiting');

    last().receive({ type: 'get_code', request_id: 'g1' });
    expect(bridge.pill).toBe('connected');
    last().receive({ type: 'stop' });
    expect(pills).toEqual(['waiting', 'connected']); // told once per change
    expect(statuses).toEqual(['connected']); // the connection's status is as in Phase 1
  });

  it.each(AGENT_COMMANDS)('takes %s for the agent', (type, rest) => {
    const { bridge } = startOpen();
    last().receive({ type, request_id: 'c1', ...rest });
    expect(bridge.pill).toBe('connected');
  });

  it('does not take anything else for the agent', () => {
    const { bridge } = startOpen();
    for (const frame of [
      'pong', 'garbage', '', '{', 'null', '[1]', '{"no":"type"}',
      JSON.stringify({ type: 'session_state', payload: { currentPattern: 'x', rev: 3 } }),
      JSON.stringify({ type: 'session_state', payload: { currentPattern: '', rev: 0 } }),
      JSON.stringify({ type: 'frobnicate' }),
      JSON.stringify({ type: 'undo_result', payload: {} }),
      JSON.stringify({ type: 'ack', status: 'playing' }),
    ]) {
      last().receive(frame);
    }
    expect(bridge.pill).toBe('waiting');
  });

  it('counts a command that reaches the page before the editor is ready', () => {
    const { bridge } = startOpen({ noMirror: true });
    last().receive({ type: 'stop' });
    expect(bridge.pill).toBe('connected');
  });

  it('keeps showing the other states while no agent has come, and goes back to waiting when the connection does', () => {
    const { bridge, pills } = start();
    last().drop();
    expect(bridge.pill).toBe('reconnecting');
    bridge.onVisible();
    last().open();
    expect(bridge.pill).toBe('waiting');

    bridge.onOffline();
    expect(bridge.pill).toBe('offline');
    bridge.onOnline(); // the socket never closed
    expect(bridge.pill).toBe('waiting');
    expect(pills).toEqual(['reconnecting', 'waiting', 'offline', 'waiting']);
  });

  it('remembers the agent for as long as the page lives: a reconnect does not go back to waiting', () => {
    const { bridge, pills } = startOpen();
    last().receive({ type: 'stop' });
    reconnect(bridge);
    expect(bridge.pill).toBe('connected');
    bridge.onOffline();
    bridge.onOnline();
    expect(bridge.pill).toBe('connected');
    expect(pills).toEqual(['waiting', 'connected', 'reconnecting', 'connected', 'offline', 'connected']);
  });

  it('works without a pill: the widget has none', () => {
    const { deps } = makeEnv();
    const bridge = createBridge({ ...deps, onPill: undefined, onStatus: undefined });
    bridge.connect();
    last().open();
    last().receive({ type: 'stop' });
    expect(bridge.pill).toBe('connected');
  });

  it('survives a pill handler that throws', () => {
    const { deps } = makeEnv();
    const bridge = createBridge({ ...deps, onPill: () => { throw new Error('no DOM'); } });
    bridge.connect();
    expect(() => last().open()).not.toThrow();
    expect(bridge.status).toBe('connected');
    expect(bridge.pill).toBe('waiting');
  });

  it('links the source: the public repo and the pinned Strudel commit (the AGPL source offer)', () => {
    expect(SOURCE_LINKS.map(({ label, href }) => ({ label, href }))).toEqual([
      { label: 'Source', href: 'https://github.com/jmoore2333/djopus' },
      { label: 'Strudel', href: 'https://codeberg.org/uzu/strudel/src/commit/9f19e4616a358ad31032e0f9af82060d23bc0d70' },
    ]);
  });
});
