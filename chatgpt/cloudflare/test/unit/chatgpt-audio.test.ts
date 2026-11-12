import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket, makeEnv, type BridgeModule } from './helpers/fake-env';

// ChatGPT's player uses its own bridge. These tests model the real Strudel REPL,
// which does not expose an AudioContext on repl, and a browser whose first audio
// context cannot run until the listener receives an in-player gesture.
const require = createRequire(import.meta.url);
const { createBridge } = require('../../client/strudel-ws-bridge-chatgpt.js') as BridgeModule;
const SESSION = 'abcdefghjkmnpqrstvwxyz0123';
const socket = () => FakeWebSocket.last();

function start(context: { state: string; resume: () => Promise<void> } | null) {
  const env = makeEnv({
    config: { mode: 'widget', sessionId: SESSION, wsUrl: 'wss://chatgpt.example/ws' },
  });
  // The pinned Strudel build exposes getAudioContext through its module scope,
  // not as repl.audioContext. Do not accidentally test the old fictional API.
  delete (env.mirror.repl as { audioContext?: unknown }).audioContext;
  const startPlayback = vi.fn(() => { env.mirror.repl.scheduler.started = true; });
  Object.assign(env.mirror.repl, { start: startPlayback });
  env.mirror.stop.mockImplementation(() => { env.mirror.repl.scheduler.started = false; });
  Object.assign(env.deps, { getAudioContext: () => context });
  const bridge = createBridge(env.deps);
  bridge.connect();
  socket().open();
  return { ...env, bridge, startPlayback };
}

function evaluate(requestId: string, code = 's("bd*4")') {
  socket().receive({ type: 'evaluate', request_id: requestId, payload: { code } });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ChatGPT audio: first player gesture', () => {
  it('queues the pattern, shows a prompt and responds promptly while audio needs a gesture', async () => {
    const context = { state: 'suspended', resume: vi.fn(async () => {}) };
    const { mirror, prompts } = start(context);
    // Real Strudel evaluation waits for a document mousedown. A pending promise
    // must not prevent the tool response or the user-facing prompt.
    mirror.evaluations.mockImplementation(() => new Promise<void>(() => {}));
    evaluate('before-click');
    await vi.advanceTimersByTimeAsync(250);

    expect(mirror.code).toBe('s("bd*4")');
    expect(prompts.some(Boolean)).toBe(true);
    expect(socket().jsonOfType('ack')).toContainEqual(expect.objectContaining({
      request_id: 'before-click', status: 'needs_user_gesture',
    }));
    expect(socket().jsonOfType('ack')).not.toContainEqual(expect.objectContaining({ status: 'playing' }));
  });

  it('does not hang when the audio context runs but Strudel still awaits its first document mousedown', async () => {
    const context = { state: 'running', resume: vi.fn(async () => {}) };
    const { mirror, prompts } = start(context);
    // Strudel's beforeEval waits for a document mousedown independently of the
    // AudioContext's state, even when autoplay policies let that context run.
    mirror.evaluations.mockImplementation(() => new Promise<void>(() => {}));
    evaluate('running-before-mousedown');
    await vi.advanceTimersByTimeAsync(250);

    expect(prompts.some(Boolean)).toBe(true);
    expect(socket().jsonOfType('ack')).toContainEqual(expect.objectContaining({
      request_id: 'running-before-mousedown', status: 'needs_user_gesture',
    }));
    expect(socket().jsonOfType('ack')).not.toContainEqual(expect.objectContaining({ status: 'playing' }));
  });

  it('never calls unknown audio state playing or recovered', async () => {
    const { prompts } = start(null);
    evaluate('unknown');
    await vi.advanceTimersByTimeAsync(250);
    socket().receive({ type: 'recover_audio', request_id: 'recover-unknown' });
    await vi.advanceTimersByTimeAsync(250);

    const acknowledgements = socket().jsonOfType('ack');
    expect(acknowledgements).toContainEqual(expect.objectContaining({ request_id: 'unknown', status: 'needs_user_gesture' }));
    expect(acknowledgements).toContainEqual(expect.objectContaining({ request_id: 'recover-unknown', status: 'needs_user_gesture' }));
    expect(acknowledgements).not.toContainEqual(expect.objectContaining({ status: 'playing' }));
    expect(acknowledgements).not.toContainEqual(expect.objectContaining({ status: 'audio_recovered' }));
    expect(prompts.some(Boolean)).toBe(true);
  });

  it('plays a queued pattern after a real in-player gesture makes the actual context run', async () => {
    const context = { state: 'suspended', resume: vi.fn(async () => { context.state = 'running'; }) };
    const { mirror, bridge, startPlayback } = start(context);
    evaluate('queued');
    await vi.advanceTimersByTimeAsync(250);
    expect(mirror.evaluations).not.toHaveBeenCalled();

    bridge.unlockAudio(); // invoked synchronously by the inner document gesture
    await vi.advanceTimersByTimeAsync(250);
    expect(context.resume).toHaveBeenCalled();
    expect(mirror.evaluations).toHaveBeenCalledWith(false);
    expect(startPlayback).toHaveBeenCalledTimes(1);
    expect(mirror.code).toBe('s("bd*4")');
  });

  it('plays the latest queued pattern when several arrive before the first gesture', async () => {
    const context = { state: 'suspended', resume: vi.fn(async () => { context.state = 'running'; }) };
    const { mirror, bridge, startPlayback } = start(context);
    evaluate('first', 's("bd")');
    evaluate('second', 's("hh*8")');
    await vi.advanceTimersByTimeAsync(250);
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(250);

    expect(mirror.code).toBe('s("hh*8")');
    expect(mirror.evaluations).toHaveBeenCalledTimes(1);
    expect(startPlayback).toHaveBeenCalledTimes(1);
  });

  it('plays the latest editor code when set_code arrives while playback awaits a gesture', async () => {
    const context = { state: 'suspended', resume: vi.fn(async () => { context.state = 'running'; }) };
    const { mirror, bridge, startPlayback } = start(context);
    const evaluatedCode: string[] = [];
    mirror.evaluations.mockImplementation(async () => { evaluatedCode.push(mirror.code); });
    evaluate('queue-original', 's("bd")');
    socket().receive({ type: 'set_code', request_id: 'edit-waiting', payload: { code: 's("hh*8")' } });
    await vi.advanceTimersByTimeAsync(250);

    expect(mirror.code).toBe('s("hh*8")');
    expect(socket().jsonOfType('ack')).toContainEqual(expect.objectContaining({
      request_id: 'edit-waiting', status: 'code_set',
    }));
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(250);

    expect(evaluatedCode).toEqual(['s("hh*8")']);
    expect(startPlayback).toHaveBeenCalledTimes(1);
  });

  it('plays a code edit made while the pattern is waiting for a gesture', async () => {
    const context = { state: 'suspended', resume: vi.fn(async () => { context.state = 'running'; }) };
    const { mirror, bridge, startPlayback } = start(context);
    const evaluatedCode: string[] = [];
    mirror.evaluations.mockImplementation(async () => { evaluatedCode.push(mirror.code); });
    evaluate('queue-edit', 's("bd")');
    socket().receive({ type: 'append_code', request_id: 'append-waiting', payload: { code: 's("hh*8")' } });
    await vi.advanceTimersByTimeAsync(250);
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(250);

    expect(evaluatedCode).toEqual(['s("bd")\ns("hh*8")']);
    expect(startPlayback).toHaveBeenCalledTimes(1);
  });

  it('applies a tempo requested while waiting after the queued pattern is evaluated', async () => {
    const context = { state: 'suspended', resume: vi.fn(async () => { context.state = 'running'; }) };
    const { mirror, bridge } = start(context);
    const calls: string[] = [];
    mirror.evaluations.mockImplementation(async () => { calls.push('evaluate'); });
    const setCps = vi.fn((_cps: number) => { calls.push('setCps'); });
    Object.assign(mirror.repl, { setCps });
    evaluate('queue-before-tempo', 'setcps(120/60/4); s("bd")');
    socket().receive({ type: 'set_tempo', request_id: 'tempo-while-waiting', payload: { bpm: 132 } });
    await vi.advanceTimersByTimeAsync(250);
    expect(mirror.repl.evaluate).not.toHaveBeenCalled();
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(250);

    expect(setCps).toHaveBeenLastCalledWith(132 / 60 / 4);
    expect(calls.lastIndexOf('setCps')).toBeGreaterThan(calls.indexOf('evaluate'));
  });

  it('keeps live tempo after stop and replay without rewriting the pattern', async () => {
    const context = { state: 'running', resume: vi.fn(async () => {}) };
    const { mirror, bridge } = start(context);
    const code = 'setcps(120/60/4)\ns("bd*4")';
    // Model the pinned Strudel evaluator executing the pattern's setcps again.
    mirror.evaluations.mockImplementation(async () => { mirror.repl.scheduler.cps = 120 / 60 / 4; });
    Object.assign(mirror.repl, { setCps: (cps: number) => { mirror.repl.scheduler.cps = cps; } });
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(50);
    evaluate('first', code);
    await vi.advanceTimersByTimeAsync(50);
    socket().receive({ type: 'set_tempo', request_id: 'tempo', payload: { bpm: 110 } });
    expect(mirror.repl.scheduler.cps).toBe(110 / 60 / 4);
    expect(mirror.code).toBe(code);
    socket().receive({ type: 'stop', request_id: 'stop' });
    evaluate('replay', code);
    await vi.advanceTimersByTimeAsync(50);
    expect(mirror.repl.scheduler.cps).toBe(110 / 60 / 4);
    expect(mirror.code).toBe(code);
    expect(socket().jsonOfType('ack')).toContainEqual(expect.objectContaining({ request_id: 'replay', status: 'playing' }));
  });

  it('retains live tempo for a manual replay of unchanged code, but drops it after an edit or reset', async () => {
    const context = { state: 'running', resume: vi.fn(async () => {}) };
    const { mirror, bridge } = start(context);
    const original = 'setcps(120/60/4)\ns("bd")';
    const changed = 'setcps(140/60/4)\ns("hh")';
    mirror.evaluations.mockImplementation(async () => {
      mirror.repl.scheduler.cps = (mirror.code === changed ? 140 : 120) / 60 / 4;
    });
    Object.assign(mirror.repl, { setCps: (cps: number) => { mirror.repl.scheduler.cps = cps; } });
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(50);
    evaluate('first', original);
    await vi.advanceTimersByTimeAsync(50);
    socket().receive({ type: 'set_tempo', request_id: 'tempo', payload: { bpm: 110 } });
    await mirror.evaluate(); // the player Play/Update control
    expect(mirror.repl.scheduler.cps).toBe(110 / 60 / 4);

    socket().receive({ type: 'set_code', request_id: 'edit', payload: { code: changed } });
    evaluate('edited', changed);
    await vi.advanceTimersByTimeAsync(50);
    expect(mirror.repl.scheduler.cps).toBe(140 / 60 / 4);

    socket().receive({ type: 'set_tempo', request_id: 'tempo-again', payload: { bpm: 100 } });
    socket().receive({ type: 'reset_session', payload: { code: '' } });
    evaluate('after-reset', changed);
    await vi.advanceTimersByTimeAsync(50);
    expect(mirror.repl.scheduler.cps).toBe(140 / 60 / 4);
  });

  it('applies a tempo change to the playing pattern rather than unplayed editor changes', async () => {
    const context = { state: 'running', resume: vi.fn(async () => {}) };
    const { mirror, bridge } = start(context);
    const playing = 'setcps(120/60/4)\ns("bd")';
    const edited = 'setcps(140/60/4)\ns("hh")';
    mirror.evaluations.mockImplementation(async () => {
      mirror.repl.scheduler.cps = (mirror.code === edited ? 140 : 120) / 60 / 4;
    });
    Object.assign(mirror.repl, { setCps: (cps: number) => { mirror.repl.scheduler.cps = cps; } });
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(50);
    evaluate('playing', playing);
    await vi.advanceTimersByTimeAsync(50);
    mirror.code = edited; // The user typed a new pattern without evaluating it.
    socket().receive({ type: 'set_tempo', request_id: 'tempo', payload: { bpm: 110 } });
    expect(mirror.repl.scheduler.cps).toBe(110 / 60 / 4);
    await mirror.evaluate(); // Playing the user's new code must honor its own tempo.
    expect(mirror.repl.scheduler.cps).toBe(140 / 60 / 4);
  });

  it('keeps a newer tempo request when an older manual evaluation finishes', async () => {
    const context = { state: 'running', resume: vi.fn(async () => {}) };
    const { mirror, bridge } = start(context);
    const original = 'setcps(120/60/4)\ns("bd")';
    let finish: (() => void) | undefined;
    mirror.evaluations.mockImplementation(() => new Promise<void>(resolve => {
      finish = () => { mirror.repl.scheduler.cps = 120 / 60 / 4; resolve(); };
    }));
    Object.assign(mirror.repl, { setCps: (cps: number) => { mirror.repl.scheduler.cps = cps; } });
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(50);
    mirror.code = original;
    const evaluation = mirror.evaluate();
    expect(finish).toBeTypeOf('function');
    socket().receive({ type: 'set_tempo', request_id: 'tempo-during-evaluation', payload: { bpm: 110 } });
    finish!();
    await evaluation;
    expect(mirror.repl.scheduler.cps).toBe(110 / 60 / 4);
  });

  it('preserves the newer tempo when a superseded bridge evaluation finishes late', async () => {
    const context = { state: 'running', resume: vi.fn(async () => {}) };
    const { mirror, bridge } = start(context);
    const first = 'setcps(120/60/4)\ns("bd")';
    const next = 'setcps(140/60/4)\ns("hh")';
    let finishFirst: (() => void) | undefined;
    let calls = 0;
    mirror.evaluations.mockImplementation(() => {
      calls++;
      if (calls === 1) return new Promise<void>(resolve => {
        finishFirst = () => { mirror.repl.scheduler.cps = 120 / 60 / 4; resolve(); };
      });
      mirror.repl.scheduler.cps = 140 / 60 / 4;
      return Promise.resolve();
    });
    Object.assign(mirror.repl, { setCps: (cps: number) => { mirror.repl.scheduler.cps = cps; } });
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(50);
    evaluate('old', first);
    await vi.advanceTimersByTimeAsync(10);
    expect(finishFirst).toBeTypeOf('function');
    evaluate('new', next);
    socket().receive({ type: 'set_tempo', request_id: 'new-tempo', payload: { bpm: 110 } });
    finishFirst!();
    await vi.advanceTimersByTimeAsync(100);
    expect(mirror.code).toBe(next);
    expect(mirror.repl.scheduler.cps).toBe(110 / 60 / 4);
    expect(socket().jsonOfType('ack')).toContainEqual(expect.objectContaining({ request_id: 'new', status: 'playing' }));
  });

  it('reports playing for a new request only when the actual audio context is running', async () => {
    const context = { state: 'suspended', resume: vi.fn(async () => { context.state = 'running'; }) };
    const { bridge } = start(context);
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(250);
    evaluate('running');
    await vi.advanceTimersByTimeAsync(250);

    expect(socket().jsonOfType('ack')).toContainEqual(expect.objectContaining({
      request_id: 'running', status: 'playing', payload: expect.objectContaining({ audioContextState: 'running' }),
    }));
  });

  it('does not acknowledge an in-flight evaluation as playing after stop', async () => {
    const context = { state: 'suspended', resume: vi.fn(async () => { context.state = 'running'; }) };
    const { mirror, bridge, startPlayback } = start(context);
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(250);
    let finish: (() => void) | undefined;
    mirror.evaluations.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    evaluate('in-flight');
    await vi.advanceTimersByTimeAsync(10);
    expect(finish).toBeTypeOf('function');
    socket().receive({ type: 'stop', request_id: 'stop-now' });
    finish!();
    await vi.advanceTimersByTimeAsync(250);

    expect(mirror.stop).toHaveBeenCalled();
    expect(startPlayback).not.toHaveBeenCalled();
    expect(socket().jsonOfType('ack')).not.toContainEqual(expect.objectContaining({ request_id: 'in-flight', status: 'playing' }));
  });

  it('finishes an older evaluation before starting a newer pattern', async () => {
    const context = { state: 'suspended', resume: vi.fn(async () => { context.state = 'running'; }) };
    const { mirror, bridge, startPlayback } = start(context);
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(250);
    let finishFirst: (() => void) | undefined;
    const observed: string[] = [];
    mirror.evaluations.mockImplementation(() => {
      observed.push(mirror.code);
      if (observed.length === 1) return new Promise<void>((resolve) => { finishFirst = resolve; });
      return Promise.resolve();
    });
    evaluate('older', 's("bd")');
    await vi.advanceTimersByTimeAsync(10);
    evaluate('newer', 's("hh*8")');
    await vi.advanceTimersByTimeAsync(10);
    expect(observed).toEqual(['s("bd")']);
    expect(finishFirst).toBeTypeOf('function');
    finishFirst!();
    await vi.advanceTimersByTimeAsync(250);
    expect(observed).toEqual(['s("bd")', 's("hh*8")']);
    expect(startPlayback).toHaveBeenCalledTimes(1);
    expect(socket().jsonOfType('ack')).not.toContainEqual(expect.objectContaining({ request_id: 'older', status: 'playing' }));
    expect(socket().jsonOfType('ack')).toContainEqual(expect.objectContaining({ request_id: 'newer', status: 'playing' }));
  });

  it('stops audio if an asynchronous start settles after the stop command', async () => {
    const context = { state: 'suspended', resume: vi.fn(async () => { context.state = 'running'; }) };
    const { mirror, bridge, startPlayback } = start(context);
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(250);
    let finishStart: (() => void) | undefined;
    startPlayback.mockImplementation(() => new Promise<void>((resolve) => {
      finishStart = () => { mirror.repl.scheduler.started = true; resolve(); };
    }));
    evaluate('start-in-flight');
    await vi.advanceTimersByTimeAsync(20);
    expect(finishStart).toBeTypeOf('function');
    socket().receive({ type: 'stop', request_id: 'stop-during-start' });
    finishStart!();
    await vi.advanceTimersByTimeAsync(250);

    expect(mirror.repl.scheduler.started).toBe(false);
    expect(socket().jsonOfType('ack')).not.toContainEqual(expect.objectContaining({ request_id: 'start-in-flight', status: 'playing' }));
  });

  it.each(['stop', 'reset_session'])('%s cancels queued playback before the gesture', async (command) => {
    const context = { state: 'suspended', resume: vi.fn(async () => { context.state = 'running'; }) };
    const { mirror, bridge } = start(context);
    evaluate('to-cancel');
    await vi.advanceTimersByTimeAsync(250);
    socket().receive({ type: command, request_id: 'cancel', payload: { code: '' } });
    bridge.unlockAudio();
    await vi.advanceTimersByTimeAsync(250);

    expect(mirror.evaluations).not.toHaveBeenCalled();
    expect(socket().jsonOfType('ack')).not.toContainEqual(expect.objectContaining({ request_id: 'to-cancel', status: 'playing' }));
  });
});
