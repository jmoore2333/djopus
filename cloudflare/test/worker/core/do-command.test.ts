import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { createDoCommandSender } from '../../../src/core/do-command';
import { type DOMessage, NoBrowserError } from '../../../src/core/ports';
import { captureLogs, hashOf } from '../helpers/logs';
import { openSession, type TestSocket } from '../helpers/sockets';

// The SendCommand of the Worker (src/core/do-command.ts) against the real SessionBridge, with a test socket as the
// browser. The ChatGPT tests in test/chatgpt cover the rest of it through the ChatGPT adapter: no_browser, rejected,
// and get_code answered from the session's pattern.

afterEach(() => {
  vi.useRealTimers();
});

const realSetTimeout = globalThis.setTimeout;

/** Lets frames travel through the Durable Object while setTimeout is faked. */
function letFramesArrive(): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, 50));
}

function sender(session: string, opts?: { timeoutMs?: number; lateErrorMs?: number }) {
  return createDoCommandSender(env.SESSION_BRIDGE, session, opts);
}

/** Tracks a promise, so a test can tell whether it has settled yet. */
function track(promise: Promise<DOMessage>) {
  const state: { outcome: 'pending' | 'resolved' | 'rejected'; value?: DOMessage; error?: Error } = { outcome: 'pending' };
  promise.then(
    (value) => Object.assign(state, { outcome: 'resolved', value }),
    (error: Error) => Object.assign(state, { outcome: 'rejected', error }),
  );
  return state;
}

/** A session whose history is ['', s("a"), s("b")], at s("b"), with a browser (when asked for) that has seen it all. */
async function sessionWithHistory(session: string, withBrowser: boolean): Promise<{ browser?: TestSocket; controller: TestSocket }> {
  const browser = withBrowser ? await openSession(session, 'browser') : undefined;
  const controller = await openSession(session, 'controller');
  for (const code of ['s("a")', 's("b")']) controller.send({ type: 'set_code', payload: { code } });
  controller.send({ type: 'get_state', request_id: 'seeded' });
  expect((await controller.next((m) => m.request_id === 'seeded')).payload).toMatchObject({ historySize: 3, historyIndex: 2 });
  if (browser) {
    await browser.next('set_code');
    await browser.next('set_code');
  }
  return { browser, controller };
}

async function historyIndexOf(controller: TestSocket, request_id: string): Promise<unknown> {
  controller.send({ type: 'get_state', request_id });
  return ((await controller.next((m) => m.type === 'session_state' && m.request_id === request_id)).payload as { historyIndex: number }).historyIndex;
}

// --- the late-error window (P2-R6a) ---

it('still fails an evaluate whose pattern error comes 1,499 ms after the ack', async () => {
  // The bridge attributes a page error to the evaluate it is playing for 1,500 ms (client/strudel-ws-bridge.js).
  const browser = await openSession('dc-late-error', 'browser');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const sent = track(sender('dc-late-error')({ type: 'evaluate', payload: { code: 's("nope")' } }));
  const evaluate = await browser.next('evaluate');
  browser.send({ type: 'ack', request_id: evaluate.request_id, status: 'playing', payload: { codeLength: 9, audioContextState: 'running' } });
  await letFramesArrive();
  await vi.advanceTimersByTimeAsync(1_499);
  expect(sent.outcome).toBe('pending');

  browser.send({ type: 'error', request_id: evaluate.request_id, payload: { message: 'sound "nope" not found', code: 's("nope")' } });
  await letFramesArrive();
  expect(sent.outcome).toBe('rejected');
  expect(sent.error?.message).toBe('sound "nope" not found');
});

it('resolves an evaluate with the browser ack once 1,500 ms have passed without an error', async () => {
  const browser = await openSession('dc-late-quiet', 'browser');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const sent = track(sender('dc-late-quiet')({ type: 'evaluate', payload: { code: 's("bd")' } }));
  const evaluate = await browser.next('evaluate');
  const ack = { type: 'ack', request_id: evaluate.request_id, status: 'playing', payload: { codeLength: 7, audioContextState: 'running' } };
  browser.send(ack);
  await letFramesArrive();
  await vi.advanceTimersByTimeAsync(1_499);
  expect(sent.outcome).toBe('pending');
  await vi.advanceTimersByTimeAsync(1);
  expect(sent.outcome).toBe('resolved');
  expect(sent.value).toEqual(ack);
});

it('does not time out a command whose ack came in before the timeout, while it waits for a late error', async () => {
  const browser = await openSession('dc-late-timeout', 'browser');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const sent = track(sender('dc-late-timeout', { timeoutMs: 1_000, lateErrorMs: 500 })({ type: 'evaluate', payload: { code: 's("bd")' } }));
  const evaluate = await browser.next('evaluate');
  await vi.advanceTimersByTimeAsync(900);
  browser.send({ type: 'ack', request_id: evaluate.request_id, status: 'playing', payload: { codeLength: 7, audioContextState: 'running' } });
  await letFramesArrive();
  await vi.advanceTimersByTimeAsync(300); // past the command timeout, inside the window
  expect(sent.outcome).toBe('pending');
  await vi.advanceTimersByTimeAsync(200);
  expect(sent.outcome).toBe('resolved');
  expect(sent.value).toMatchObject({ type: 'ack', status: 'playing' });
});

// --- the internal URL carries no session id ---

/** A namespace that hands out the real stubs and records the URL of each fetch to them. */
function recordingNamespace(urls: string[]): typeof env.SESSION_BRIDGE {
  const ns = env.SESSION_BRIDGE;
  return {
    idFromName: (name: string) => ns.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = ns.get(id);
      return {
        fetch: (input: string, init?: RequestInit) => {
          urls.push(input);
          return stub.fetch(input, init);
        },
      };
    },
  } as unknown as typeof env.SESSION_BRIDGE;
}

it('opens the controller socket without the session id in the URL, and the session keeps the hash the logs carry', async () => {
  const session = 'dc-url-session-0123456789abcdef';
  const logs = captureLogs();
  const urls: string[] = [];
  const state = await createDoCommandSender(recordingNamespace(urls), session)({ type: 'get_state' }, 'session_state');
  expect(state.type).toBe('session_state');

  expect(urls).toHaveLength(1);
  expect(urls[0]).not.toContain(session);
  expect(urls[0]).not.toContain('session=');
  expect(new URL(urls[0]).searchParams.get('role')).toBe('controller');
  // The hash is made from the object's own name, as it was from ?session=.
  expect(logs.events()).toContainEqual({ event: 'ws_connect', sessionHash: await hashOf(session), role: 'controller' });
});

// --- stop: settled by the browser's ack (P2-R44) ---

it('resolves a stop only when the browser has acked it', async () => {
  const browser = await openSession('dc-stop', 'browser');
  const stopping = track(sender('dc-stop')({ type: 'stop' }));
  const stop = await browser.next('stop');
  expect(stop).toEqual({ type: 'stop', request_id: expect.any(String) });
  await letFramesArrive();
  expect(stopping.outcome).toBe('pending'); // the session has stopped, but no browser has said it did

  const ack = { type: 'ack', request_id: stop.request_id, status: 'stopped' };
  browser.send(ack);
  await vi.waitFor(() => expect(stopping.outcome).toBe('resolved'));
  expect(stopping.value).toEqual(ack);
});

it('fails a stop with a NoBrowserError when no browser is connected', async () => {
  await expect(sender('dc-stop-nobrowser')({ type: 'stop' })).rejects.toBeInstanceOf(NoBrowserError);
});

it('times out a stop that no browser acks', async () => {
  const browser = await openSession('dc-stop-silent', 'browser');
  const stopping = sender('dc-stop-silent', { timeoutMs: 100 })({ type: 'stop' });
  await browser.next('stop');
  await expect(stopping).rejects.toThrow('Timeout waiting for response to stop');
});

// --- undo and redo: settled by the browser (P2-R6c) ---

it('resolves an undo only once the browser has played the code it went back to', async () => {
  const { browser } = await sessionWithHistory('dc-undo', true);
  const undoing = track(sender('dc-undo', { lateErrorMs: 50 })({ type: 'undo' }));

  const evaluate = await browser!.next('evaluate');
  expect(evaluate).toEqual({ type: 'evaluate', request_id: expect.any(String), payload: { code: 's("a")' } });
  await letFramesArrive();
  expect(undoing.outcome).toBe('pending'); // the undo_result came in, and it settles nothing

  browser!.send({ type: 'ack', request_id: evaluate.request_id, status: 'playing', payload: { codeLength: 6, audioContextState: 'running' } });
  await vi.waitFor(() => expect(undoing.outcome).toBe('resolved'));
  expect(undoing.value).toEqual({
    type: 'undo_result',
    request_id: evaluate.request_id,
    status: 'playing',
    payload: { codeLength: 6, audioContextState: 'running', code: 's("a")', historyIndex: 1, direction: 'undo' },
  });
});

it('waits the late-error window after the browser acks an undo, and fails on the error', async () => {
  const { browser, controller } = await sessionWithHistory('dc-undo-error', true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const undoing = track(sender('dc-undo-error')({ type: 'undo' }));
  const evaluate = await browser!.next('evaluate');
  browser!.send({ type: 'ack', request_id: evaluate.request_id, status: 'playing', payload: { codeLength: 6, audioContextState: 'running' } });
  await letFramesArrive();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(undoing.outcome).toBe('pending');

  browser!.send({ type: 'error', request_id: evaluate.request_id, payload: { message: 'sample "a" not found', code: 's("a")' } });
  await letFramesArrive();
  expect(undoing.outcome).toBe('rejected');
  expect(undoing.error?.message).toBe('sample "a" not found');
  vi.useRealTimers();
  expect(await historyIndexOf(controller, 'after')).toBe(1); // the history did move: the browser was given the code
});

it('fails an undo with no browser at once, and the history stays where it was', async () => {
  const { controller } = await sessionWithHistory('dc-undo-alone', false);
  const started = Date.now();
  await expect(sender('dc-undo-alone')({ type: 'undo' })).rejects.toThrow('No DJ Opus browser session is connected');
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(await historyIndexOf(controller, 'after')).toBe(2);
});

it('resolves at once with the ack when there is nothing to undo or redo', async () => {
  await openSession('dc-undo-nothing', 'browser');
  const started = Date.now();
  expect(await sender('dc-undo-nothing')({ type: 'undo' })).toMatchObject({ type: 'ack', status: 'nothing_to_undo' });
  expect(await sender('dc-undo-nothing')({ type: 'redo' })).toMatchObject({ type: 'ack', status: 'nothing_to_redo' });
  expect(Date.now() - started).toBeLessThan(1_000); // no late-error window: nothing was played
});
