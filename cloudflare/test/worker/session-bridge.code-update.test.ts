import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { MAX_CODE_BYTES } from '../../src/limits';
import { captureLogs, hashOf, type CapturedLogs } from './helpers/logs';
import { bridgeStub, openSession, type TestSocket } from './helpers/sockets';

// A code_update is how a browser tells the session what the user played by hand: the bridge in the page sends one when
// Ctrl+Enter (or the play button) evaluates text the session does not hold (test/unit/bridge-manual-edit.test.ts). The
// session takes it for its code, as it takes the editor's text from an ack or a get_code answer, so that
// currentPattern, rev and the undo history are what is playing. It is a message of a browser: a controller that sent one
// would be putting code into the session without any page having played it, so that is dropped. Which sockets may send
// what is the same rule as for the rest of the protocol (session-bridge.commands.test.ts).

afterEach(() => {
  vi.restoreAllMocks();
});

let requests = 0;

/** Asks for the session state and resolves with the payload that answers that request. */
async function stateOf(socket: TestSocket): Promise<Record<string, unknown>> {
  const request_id = `state-${++requests}`;
  socket.send({ type: 'get_state', request_id });
  const reply = await socket.next((m) => m.type === 'session_state' && m.request_id === request_id);
  return reply.payload as Record<string, unknown>;
}

/** The fields a code_update would change. (lastActivity is not one of them: any message moves it.) */
const sessionOf = (state: Record<string, unknown>) =>
  ({ currentPattern: state.currentPattern, isPlaying: state.isPlaying, rev: state.rev, historySize: state.historySize, historyIndex: state.historyIndex });

/** A browser and a controller on one session, with the welcome frames taken off the sockets and `code` playing. */
async function playing(session: string, code = 's("bd*4")') {
  const browser = await openSession(session, 'browser');
  const controller = await openSession(session, 'controller');
  await browser.next('session_state');
  await controller.next('session_state');
  controller.send({ type: 'evaluate', request_id: 'e1', payload: { code } });
  await browser.next('evaluate');
  browser.send({ type: 'ack', request_id: 'e1', status: 'playing' });
  await controller.next((m) => m.type === 'ack' && m.request_id === 'e1');
  return { browser, controller };
}

/** The controller stops the session, and the browser acks it, as the page does. Resolves once the controller has that ack. */
async function stopSession(browser: TestSocket, controller: TestSocket, request_id: string): Promise<void> {
  controller.send({ type: 'stop', request_id });
  await browser.next((m) => m.type === 'stop' && m.request_id === request_id);
  browser.send({ type: 'ack', request_id, status: 'stopped' });
  await controller.next((m) => m.type === 'ack' && m.request_id === request_id && m.status === 'stopped');
}

const statusReport = (isPlaying: boolean) => ({
  type: 'status_report',
  payload: { isPlaying, codeLength: 7, hasErrors: false, bpm: null, errorMessage: null },
});

let syncs = 0;

/**
 * Resolves once the session has handled everything the browser sent before: it sends an error, which the session
 * relays to the controllers, and a socket's messages are handled in the order they were sent.
 */
async function handled(browser: TestSocket, controller: TestSocket): Promise<void> {
  const request_id = `sync-${++syncs}`;
  browser.send({ type: 'error', request_id, payload: { message: 'sync' } });
  await controller.next((m) => m.type === 'pattern_error' && m.request_id === request_id);
}

/** Resolves when none of the sockets hears a frame that matches within 300 ms. */
async function hearNothing(match: Parameters<TestSocket['next']>[0], ...sockets: TestSocket[]): Promise<void> {
  await Promise.all(sockets.map((socket) => expect(socket.next(match, 300)).rejects.toThrow()));
}

const dropsOf = (logs: CapturedLogs) => logs.events().filter((event) => event.event === 'drop');

// --- a browser's code_update ---

it('adopts a browser code_update: the code, rev, history and playing state follow what was played by hand', async () => {
  const { browser, controller } = await playing('cu-adopt');
  expect(sessionOf(await stateOf(controller))).toEqual({ currentPattern: 's("bd*4")', isPlaying: true, rev: 1, historySize: 2, historyIndex: 1 });

  browser.send({ type: 'code_update', payload: { code: 's("hh*8")' } });
  await handled(browser, controller);
  expect(sessionOf(await stateOf(controller))).toEqual({ currentPattern: 's("hh*8")', isPlaying: true, rev: 2, historySize: 3, historyIndex: 2 });

  // It is in storage, with its rev.
  await evictDurableObject(bridgeStub('cu-adopt'));
  expect(sessionOf(await stateOf(controller))).toEqual({ currentPattern: 's("hh*8")', isPlaying: true, rev: 2, historySize: 3, historyIndex: 2 });

  // A tab that joins now is welcomed with it, at that rev.
  const late = await openSession('cu-adopt', 'browser');
  expect((await late.next('session_state')).payload).toMatchObject({ currentPattern: 's("hh*8")', rev: 2 });

  // The history holds what played before it.
  controller.send({ type: 'undo', request_id: 'u1' });
  expect(await controller.next((m) => m.request_id === 'u1')).toMatchObject({ type: 'undo_result', payload: { code: 's("bd*4")', historyIndex: 1 } });
});

it('keeps the session playing when another tab, idle, reports after a tab played by hand', async () => {
  const session = 'cu-two-tabs';
  const tabA = await openSession(session, 'browser');
  const tabB = await openSession(session, 'browser');
  const controller = await openSession(session, 'controller');
  for (const socket of [tabA, tabB, controller]) await socket.next('session_state');

  tabA.send({ type: 'code_update', payload: { code: 's("hh*8")' } }); // tab A plays by hand: it is the one that plays
  await handled(tabA, controller);
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("hh*8")', isPlaying: true });

  tabB.send(statusReport(false)); // tab B has played nothing, and says so ...
  await controller.next('client_status');
  expect((await stateOf(controller)).isPlaying).toBe(true); // ... which does not stop what tab A plays
  await evictDurableObject(bridgeStub(session));
  expect((await stateOf(controller)).isPlaying).toBe(true);

  tabA.send(statusReport(false)); // when tab A is the one that stops, nothing plays
  await controller.next('client_status');
  expect((await stateOf(controller)).isPlaying).toBe(false);
});

it('sets the session playing, also when it was stopped', async () => {
  const { browser, controller } = await playing('cu-stopped');
  await stopSession(browser, controller, 's1');
  expect((await stateOf(controller)).isPlaying).toBe(false);

  browser.send({ type: 'code_update', payload: { code: 's("hh*8")' } });
  await handled(browser, controller);
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("hh*8")', isPlaying: true });
  await evictDurableObject(bridgeStub('cu-stopped'));
  expect((await stateOf(controller)).isPlaying).toBe(true);
});

it('adopts it only when the code differs from the session\'s', async () => {
  const { browser, controller } = await playing('cu-same');
  await stopSession(browser, controller, 's1');
  const before = sessionOf(await stateOf(controller));
  expect(before).toMatchObject({ currentPattern: 's("bd*4")', isPlaying: false, rev: 1 });

  browser.send({ type: 'code_update', payload: { code: 's("bd*4")' } }); // what the session already holds
  await handled(browser, controller);
  expect(sessionOf(await stateOf(controller))).toEqual(before); // no rev, no history entry, and the session stays stopped
});

it('takes code up to the limit, counted in bytes, and drops code over it', async () => {
  const logs = captureLogs();
  const { browser, controller } = await playing('cu-limit');
  const edge = '€'.repeat(21_845) + 'a'; // exactly MAX_CODE_BYTES bytes
  expect(new TextEncoder().encode(edge).length).toBe(MAX_CODE_BYTES);

  browser.send({ type: 'code_update', payload: { code: edge } });
  await handled(browser, controller);
  expect(await stateOf(controller)).toMatchObject({ currentPattern: edge, rev: 2 });

  for (const code of ['a'.repeat(MAX_CODE_BYTES + 1), '€'.repeat(21_846)]) { // the second is 21,846 characters but 65,538 bytes
    browser.send({ type: 'code_update', payload: { code } });
  }
  await handled(browser, controller);
  expect(await stateOf(controller)).toMatchObject({ currentPattern: edge, rev: 2, historySize: 3 });
  const hash = await hashOf('cu-limit');
  expect(dropsOf(logs)).toEqual([
    { event: 'drop', sessionHash: hash, reason: 'invalid_payload' },
    { event: 'drop', sessionHash: hash, reason: 'invalid_payload' },
  ]);
});

it('drops a code_update whose payload does not hold a string code, and says so without the code', async () => {
  const logs = captureLogs();
  const { browser, controller } = await playing('cu-invalid');
  const before = sessionOf(await stateOf(controller));
  const frames: Array<[label: string, frame: object]> = [
    ['no payload', {}],
    ['payload null', { payload: null }],
    ['payload a string', { payload: 's("pwned")' }],
    ['payload a list', { payload: ['s("pwned")'] }],
    ['no code', { payload: {} }],
    ['code null', { payload: { code: null } }],
    ['code a number', { payload: { code: 123 } }],
    ['code a list', { payload: { code: ['s("pwned")'] } }],
    ['code an object', { payload: { code: { text: 's("pwned")' } } }],
  ];
  for (const [, frame] of frames) browser.send({ type: 'code_update', ...frame });
  await handled(browser, controller);

  // Nothing was stored, forwarded or answered.
  expect(sessionOf(await stateOf(controller))).toEqual(before);
  await hearNothing((m) => m.type === 'code_update', controller);
  const hash = await hashOf('cu-invalid');
  expect(dropsOf(logs)).toEqual(frames.map(() => ({ event: 'drop', sessionHash: hash, reason: 'invalid_payload' })));
  expect(logs.lines().join('\n')).not.toContain('pwned');
});

// --- a controller's is not a thing ---

it('ignores a code_update from a controller and logs controller_code_update, with the reason only', async () => {
  const logs = captureLogs();
  const session = 'cu-controller';
  const { browser, controller } = await playing(session);
  const bystander = await openSession(session, 'controller');
  await bystander.next('session_state');
  const before = sessionOf(await stateOf(controller));

  controller.send({ type: 'code_update', request_id: 'c1', payload: { code: 's("pwned")' } });
  await vi.waitFor(() => expect(dropsOf(logs)).toHaveLength(1));

  expect(dropsOf(logs)).toEqual([{ event: 'drop', sessionHash: await hashOf(session), reason: 'controller_code_update' }]);
  expect(sessionOf(await stateOf(controller))).toEqual(before);
  // Not forwarded to a browser, not passed to another controller, not answered to the sender.
  await hearNothing((m) => m.type === 'code_update' || m.request_id === 'c1', browser, bystander, controller);
  expect(logs.events().filter((event) => event.event === 'route').map((event) => event.type)).toEqual(['evaluate', 'get_state', 'get_state']);
  expect(logs.lines().join('\n')).not.toContain('pwned');
});

it('keeps the roles of the sockets the previous code accepted (a tag, no attachment)', async () => {
  const logs = captureLogs();
  const session = 'cu-old-code';
  const browser = await openSession(session, 'browser');
  const controller = await openSession(session, 'controller');
  const stub = bridgeStub(session);
  await runInDurableObject(stub, (_instance, state) => {
    for (const ws of state.getWebSockets()) ws.serializeAttachment(null);
  });
  await evictDurableObject(stub); // from here the role of each socket is its tag, and nothing else

  controller.send({ type: 'code_update', payload: { code: 's("pwned")' } });
  await vi.waitFor(() => expect(dropsOf(logs).map((event) => event.reason)).toEqual(['controller_code_update']));
  expect(await stateOf(controller)).toMatchObject({ currentPattern: '', rev: 0 });

  browser.send({ type: 'code_update', payload: { code: 's("bd")' } });
  await handled(browser, controller);
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd")', isPlaying: true, rev: 1 });

  // Nothing above gave the sockets an attachment back: all of it ran on tags alone.
  const attachments = await runInDurableObject(stub, (_instance, state) => state.getWebSockets().map((ws) => ws.deserializeAttachment()));
  expect(attachments.filter((attachment) => attachment != null)).toEqual([]);
});
