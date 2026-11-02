import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { captureLogs, hashOf, type CapturedLogs } from './helpers/logs';
import { bridgeStub, openSession, type TestSocket } from './helpers/sockets';

// Only a controller commands a session. A browser is sent commands, and reports back with ack, error, code_response
// and status_report; one that sends a command itself is not obeyed. Without that, the page of anybody who holds the
// session id could run code in the other tabs, and the ban on role=controller at the app's /ws would mean little.
// (The app's /ws never makes a controller: test/worker/ws-rules.test.ts. The executor's own sockets are controllers.)

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every type of message that drives a session, each with a payload that would be valid from a controller. */
const COMMANDS: Array<{ type: string; payload?: object }> = [
  { type: 'evaluate', payload: { code: 's("hh*8")' } },
  { type: 'stop' },
  { type: 'set_code', payload: { code: 's("hh*8")' } },
  { type: 'set_tempo', payload: { bpm: 90 } },
  { type: 'get_code' },
  { type: 'append_code', payload: { code: 's("hh")' } },
  { type: 'replace_code', payload: { search: 'bd', replace: 'sd' } },
  { type: 'add_effect', payload: { effect: 'lpf', params: { cutoff: 800 } } },
  { type: 'recover_audio' },
  { type: 'reset_session' },
  { type: 'undo' },
  { type: 'redo' },
  { type: 'get_state' },
];

let requests = 0;

/** Asks for the session state and resolves with the payload that answers that request. */
async function stateOf(socket: TestSocket): Promise<Record<string, unknown>> {
  const request_id = `state-${++requests}`;
  socket.send({ type: 'get_state', request_id });
  const reply = await socket.next((m) => m.type === 'session_state' && m.request_id === request_id);
  return reply.payload as Record<string, unknown>;
}

/** Resolves when none of the sockets hears a frame that matches within 300 ms. */
async function hearNothing(match: Parameters<TestSocket['next']>[0], ...sockets: TestSocket[]): Promise<void> {
  await Promise.all(sockets.map((socket) => expect(socket.next(match, 300)).rejects.toThrow()));
}

const browserCommandDrops = (logs: CapturedLogs) =>
  logs.events().filter((event) => event.event === 'drop' && event.reason === 'browser_sent_command');

/** The fields a command would change. (lastActivity is not one of them: any message moves it.) */
const sessionOf = (state: Record<string, unknown>) =>
  ({ currentPattern: state.currentPattern, isPlaying: state.isPlaying, rev: state.rev, historySize: state.historySize, historyIndex: state.historyIndex });

/**
 * Two browsers and a controller on one session, with the welcome frames taken off the sockets, and a pattern playing
 * so that there is something for a command to change.
 */
async function sessionPlaying(session: string) {
  const sender = await openSession(session, 'browser');
  const other = await openSession(session, 'browser');
  const controller = await openSession(session, 'controller');
  for (const socket of [sender, other, controller]) await socket.next('session_state');

  controller.send({ type: 'evaluate', request_id: 'e1', payload: { code: 's("bd*4")' } });
  await sender.next('evaluate');
  await other.next('evaluate');
  other.send({ type: 'ack', request_id: 'e1', status: 'playing' });
  await controller.next((m) => m.type === 'ack' && m.request_id === 'e1');
  return { sender, other, controller };
}

// --- a browser may not command ---

it('refuses every command from a browser socket: nothing reaches the other sockets, and the session is unchanged', async () => {
  const logs = captureLogs();
  const { sender, other, controller } = await sessionPlaying('cmd-browser');
  const before = await stateOf(controller);
  expect(sessionOf(before)).toEqual({ currentPattern: 's("bd*4")', isPlaying: true, rev: 1, historySize: 2, historyIndex: 1 });

  for (const command of COMMANDS) sender.send({ ...command, request_id: `x-${command.type}` });
  await vi.waitFor(() => expect(browserCommandDrops(logs)).toHaveLength(COMMANDS.length));

  // Not forwarded to the other browser, not answered to the controller, not answered to the sender.
  await hearNothing(() => true, sender, other, controller);
  expect(sessionOf(await stateOf(controller))).toEqual(sessionOf(before));
  // Nor is it routed: a route is a command that is obeyed.
  expect(logs.events().filter((event) => event.event === 'route').map((event) => event.type)).toEqual(['evaluate', 'get_state', 'get_state']);
});

it('answers a get_state from a browser socket with nothing, and logs the drop with the reason only', async () => {
  const logs = captureLogs();
  const session = 'cmd-browser-state';
  const browser = await openSession(session, 'browser');
  await browser.next('session_state');

  browser.send({ type: 'get_state', request_id: 'g1' });
  await vi.waitFor(() => expect(browserCommandDrops(logs)).toHaveLength(1));
  await hearNothing((m) => m.request_id === 'g1', browser);

  expect(browserCommandDrops(logs)).toEqual([{ event: 'drop', sessionHash: await hashOf(session), reason: 'browser_sent_command' }]);
  expect(logs.lines().join('\n')).not.toContain(session);
});

it('writes nothing for a command from a browser: a session that only ever hears one has no record', async () => {
  const logs = captureLogs();
  const session = 'cmd-browser-bare';
  const browser = await openSession(session, 'browser');
  await browser.next('session_state');
  for (const command of COMMANDS) browser.send({ ...command, request_id: `x-${command.type}` });
  await vi.waitFor(() => expect(browserCommandDrops(logs)).toHaveLength(COMMANDS.length));

  const keys = await runInDurableObject(bridgeStub(session), async (_instance, state) => [...(await state.storage.list()).keys()]);
  expect(keys).toEqual(['sessionHash']); // who it is, from the connect; no session record, so nothing was changed or persisted
});

it('refuses it after the object was evicted too: the role comes from the socket, not from memory', async () => {
  const logs = captureLogs();
  const { sender, other, controller } = await sessionPlaying('cmd-browser-evicted');
  const before = await stateOf(controller);
  await evictDurableObject(bridgeStub('cmd-browser-evicted'));

  sender.send({ type: 'evaluate', request_id: 'x1', payload: { code: 's("hh*8")' } });
  sender.send({ type: 'reset_session', request_id: 'x2' });
  await vi.waitFor(() => expect(browserCommandDrops(logs)).toHaveLength(2));
  await hearNothing(() => true, sender, other, controller);
  expect(sessionOf(await stateOf(controller))).toEqual(sessionOf(before));
});

// --- a controller may ---

it("still obeys a controller's evaluate: it reaches every browser, and the browser's ack settles it", async () => {
  const logs = captureLogs();
  const session = 'cmd-controller';
  const { sender, other, controller } = await sessionPlaying(session);

  controller.send({ type: 'evaluate', request_id: 'e2', payload: { code: 's("hh*8")' } });
  expect(await sender.next('evaluate')).toMatchObject({ request_id: 'e2', payload: { code: 's("hh*8")' } });
  expect(await other.next('evaluate')).toMatchObject({ request_id: 'e2', payload: { code: 's("hh*8")' } });
  sender.send({ type: 'ack', request_id: 'e2', status: 'playing' });
  expect(await controller.next((m) => m.type === 'ack' && m.request_id === 'e2')).toMatchObject({ status: 'playing' });

  expect(sessionOf(await stateOf(controller))).toEqual({ currentPattern: 's("hh*8")', isPlaying: true, rev: 2, historySize: 3, historyIndex: 2 });
  expect(browserCommandDrops(logs)).toEqual([]);
  expect(logs.events()).toContainEqual({ event: 'route', sessionHash: await hashOf(session), type: 'evaluate', browsers: 2 });
});

it('still obeys every command type from a controller', async () => {
  const logs = captureLogs();
  const { sender, other, controller } = await sessionPlaying('cmd-controller-all');
  for (const command of COMMANDS) controller.send({ ...command, request_id: `c-${command.type}` });

  // Each one is routed, none is dropped. (What each does is covered by the rest of the DO's tests.)
  await vi.waitFor(() => expect(logs.events().filter((event) => event.event === 'route')).toHaveLength(COMMANDS.length + 1)); // + the evaluate that set the scene
  expect(browserCommandDrops(logs)).toEqual([]);
  // The ones that go to the browsers got there.
  expect(await sender.next('set_tempo')).toMatchObject({ request_id: 'c-set_tempo', payload: { bpm: 90 } });
  expect(await other.next('append_code')).toMatchObject({ request_id: 'c-append_code' });
});

it('keeps the reports of a browser working: status_report, ack, error and code_response still reach the controller', async () => {
  const { sender, controller } = await sessionPlaying('cmd-reports');
  sender.send({ type: 'status_report', payload: { isPlaying: true, codeLength: 8, hasErrors: false, bpm: 120, errorMessage: null } });
  expect(await controller.next('client_status')).toMatchObject({ payload: { isPlaying: true, bpm: 120 } });
  sender.send({ type: 'error', request_id: 'r1', payload: { message: 'boom' } });
  expect(await controller.next('pattern_error')).toMatchObject({ request_id: 'r1', payload: { message: 'boom' } });
  sender.send({ type: 'code_response', request_id: 'r2', payload: { code: 's("bd*4")' } });
  expect(await controller.next('code_response')).toMatchObject({ request_id: 'r2' });
  sender.send({ type: 'ack', request_id: 'r3', status: 'tempo_set', payload: { bpm: 100 } });
  expect(await controller.next((m) => m.type === 'ack' && m.request_id === 'r3')).toMatchObject({ status: 'tempo_set' });
});

// --- sockets the previous code accepted ---

it('refuses commands from a browser socket the previous code accepted (a tag, no attachment), and obeys its controller', async () => {
  const logs = captureLogs();
  const session = 'cmd-old-code';
  const browser = await openSession(session, 'browser');
  const controller = await openSession(session, 'controller');
  const stub = bridgeStub(session);
  await runInDurableObject(stub, (_instance, state) => {
    for (const ws of state.getWebSockets()) ws.serializeAttachment(null);
  });
  await evictDurableObject(stub); // from here the role of each socket is its tag, and nothing else

  controller.send({ type: 'evaluate', request_id: 'o1', payload: { code: 's("bd")' } });
  expect(await browser.next('evaluate')).toMatchObject({ request_id: 'o1' });
  browser.send({ type: 'ack', request_id: 'o1', status: 'playing' });
  expect(await controller.next((m) => m.type === 'ack' && m.request_id === 'o1')).toMatchObject({ status: 'playing' });

  browser.send({ type: 'evaluate', request_id: 'o2', payload: { code: 's("hh")' } });
  browser.send({ type: 'get_state', request_id: 'o3' });
  await vi.waitFor(() => expect(browserCommandDrops(logs)).toHaveLength(2));
  await hearNothing((m) => m.request_id === 'o2' || m.request_id === 'o3', controller, browser);
  expect(sessionOf(await stateOf(controller))).toEqual({ currentPattern: 's("bd")', isPlaying: true, rev: 1, historySize: 2, historyIndex: 1 });

  // Nothing above gave the sockets an attachment back: all of it ran on tags alone.
  const attachments = await runInDurableObject(stub, (_instance, state) => state.getWebSockets().map((ws) => ws.deserializeAttachment()));
  expect(attachments.filter((attachment) => attachment != null)).toEqual([]);
});
