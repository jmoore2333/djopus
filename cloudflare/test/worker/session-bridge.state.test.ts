import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { MAX_CODE_BYTES } from '../../src/limits';
import { MAX_PENDING_REQUESTS, reciprocalCloseCode, type SessionBridge } from '../../src/session-bridge';
import { captureLogs, hashOf } from './helpers/logs';
import { bridgeStub, openSession, type TestSocket } from './helpers/sockets';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

interface Pair {
  browser: TestSocket;
  controller: TestSocket;
}

async function connect(session: string): Promise<Pair> {
  return { browser: await openSession(session, 'browser'), controller: await openSession(session, 'controller') };
}

let requests = 0;

/** Asks for the session state and resolves with the payload that answers that request. */
async function stateOf(socket: TestSocket): Promise<Record<string, unknown>> {
  const request_id = `state-${++requests}`;
  socket.send({ type: 'get_state', request_id });
  const reply = await socket.next((m) => m.type === 'session_state' && m.request_id === request_id);
  return reply.payload as Record<string, unknown>;
}

/** The controller evaluates `code` and the browser plays it. Resolves once the controller has the browser's ack. */
async function evaluate({ browser, controller }: Pair, code: string, request_id: string): Promise<void> {
  controller.send({ type: 'evaluate', request_id, payload: { code } });
  await browser.next('evaluate');
  browser.send({ type: 'ack', request_id, status: 'playing' });
  await controller.next((m) => m.type === 'ack' && m.request_id === request_id);
}

/** The browser sends an ack. Resolves once the controller has the relayed ack, so the DO is done with it. */
async function browserAcks({ browser, controller }: Pair, request_id: string, status: string, payload?: unknown): Promise<void> {
  browser.send({ type: 'ack', request_id, status, payload });
  await controller.next((m) => m.type === 'ack' && m.request_id === request_id);
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

// --- durable state ---

it('restores pattern, history, isPlaying and rev after eviction', async () => {
  const pair = await connect('st-restore');
  await evaluate(pair, 's("bd")', 'r1');
  await evictDurableObject(bridgeStub('st-restore'));
  pair.controller.send({ type: 'get_state', request_id: 'r2' });
  expect((await pair.controller.next((m) => m.request_id === 'r2')).payload).toMatchObject({
    currentPattern: 's("bd")', isPlaying: true, rev: 1, historySize: 2,
  });
});

it('bumps rev on code changes only', async () => {
  const pair = await connect('st-rev');
  const { controller } = pair;
  expect((await stateOf(controller)).rev).toBe(0);
  await evaluate(pair, 's("bd")', 'r1');
  expect((await stateOf(controller)).rev).toBe(1);

  // None of these changes the code the session holds. The browser, which is
  // passive here, is what would report an edit.
  for (const command of [
    { type: 'set_tempo', payload: { bpm: 120 } },
    { type: 'stop' },
    { type: 'get_code' },
    { type: 'append_code', payload: { code: 's("hh")' } },
    { type: 'replace_code', payload: { search: 'bd', replace: 'sd' } },
    { type: 'add_effect', payload: { effect: 'lpf', params: { cutoff: 800 } } },
    { type: 'recover_audio' },
  ]) {
    controller.send(command);
  }
  expect((await stateOf(controller)).rev).toBe(1);

  controller.send({ type: 'set_code', payload: { code: 's("hh")' } });
  expect((await stateOf(controller)).rev).toBe(2);
  controller.send({ type: 'undo' });
  expect((await stateOf(controller)).rev).toBe(3);
  controller.send({ type: 'redo' });
  expect((await stateOf(controller)).rev).toBe(4);
  controller.send({ type: 'reset_session' });
  expect((await stateOf(controller)).rev).toBe(5);
  controller.send({ type: 'undo' }); // nothing left to undo
  expect((await stateOf(controller)).rev).toBe(5);
});

it('does not bump rev for an undo that lands on the code the session already shows', async () => {
  // A session stored by the code that took a code_response into the pattern but not into the history: the editor
  // was cleared by hand, so the pattern is '' while the history still ends in s("bd").
  const pair = await connect('st-rev-undo');
  const { controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  await runInDurableObject(bridgeStub('st-rev-undo'), async (_instance, state) => {
    const session = (await state.storage.get<{ currentPattern: string }>('session'))!;
    await state.storage.put('session', { ...session, currentPattern: '' });
  });
  await evictDurableObject(bridgeStub('st-rev-undo'));
  controller.send({ type: 'undo', request_id: 'r3' }); // history goes back to '', which is what the session shows
  expect(await controller.next((m) => m.request_id === 'r3')).toMatchObject({ type: 'undo_result', payload: { code: '' } });
  expect(await stateOf(controller)).toMatchObject({ currentPattern: '', rev: 1, historyIndex: 0 });
});

// --- stop: confirmed by a browser (P2-R44) ---

it('relays a stop with its request_id, and tells the controller it stopped only when a browser acks it', async () => {
  const pair = await connect('st-stop-ack');
  const { browser, controller } = pair;
  await evaluate(pair, 's("bd")', 'e1');

  controller.send({ type: 'stop', request_id: 's1' });
  expect(await browser.next('stop')).toEqual({ type: 'stop', request_id: 's1' });
  // The session is stopped as the command goes out (see the playing tests), but nothing has confirmed it to the controller.
  expect((await stateOf(controller)).isPlaying).toBe(false);
  await expect(controller.next((m) => m.type === 'ack' && m.request_id === 's1', 200)).rejects.toThrow(/Timed out/);

  browser.send({ type: 'ack', request_id: 's1', status: 'stopped' });
  expect(await controller.next((m) => m.type === 'ack' && m.request_id === 's1')).toMatchObject({ type: 'ack', request_id: 's1', status: 'stopped' });
});

it('answers a stop with no_browser when no browser is connected, and does not call that stopped', async () => {
  const controller = await openSession('st-stop-nobrowser', 'controller');
  controller.send({ type: 'stop', request_id: 's1' });
  const answer = await controller.next((m) => m.type === 'ack' && m.request_id === 's1');
  expect(answer).toMatchObject({ status: 'no_browser' });
  await expect(controller.next((m) => m.type === 'ack' && m.status === 'stopped', 200)).rejects.toThrow(/Timed out/);
});

it('persists isPlaying from stop and from a changed status_report', async () => {
  const pair = await connect('st-playing');
  const { browser, controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  await stopSession(browser, controller, 'r2');
  await evictDurableObject(bridgeStub('st-playing'));
  expect((await stateOf(controller)).isPlaying).toBe(false);

  browser.send(statusReport(true));
  await controller.next('client_status');
  await evictDurableObject(bridgeStub('st-playing'));
  expect((await stateOf(controller)).isPlaying).toBe(true);
});

it('ignores a status_report from a controller', async () => {
  const { controller } = await connect('st-forged-status');
  controller.send(statusReport(true));
  expect((await stateOf(controller)).isPlaying).toBe(false);
});

// --- isPlaying with several tabs ---

// Each browser socket keeps its own report in its attachment: its last status_report, or the evaluate, stop or
// reset_session that last told it to play or to stop. The session plays when any open browser's report says it does.
// With no open browser having a report, the stored value stands, which is what the last command set.

/** Two tabs and a controller on one session, with the welcome frames taken off the sockets. */
async function twoTabs(session: string) {
  const tabA = await openSession(session, 'browser');
  const tabB = await openSession(session, 'browser');
  const controller = await openSession(session, 'controller');
  for (const socket of [tabA, tabB, controller]) await socket.next('session_state');
  return { tabA, tabB, controller };
}

/** A tab reports whether it plays. Resolves once the controller has heard it, so the session has handled it. */
async function reports(tab: TestSocket, controller: TestSocket, isPlaying: boolean): Promise<void> {
  tab.send(statusReport(isPlaying));
  await controller.next('client_status');
}

it('keeps the session playing when a tab that opens later, and is idle, reports that it is not', async () => {
  const session = 'st-tabs-newcomer';
  const tabA = await openSession(session, 'browser');
  const controller = await openSession(session, 'controller');
  await evaluate({ browser: tabA, controller }, 's("bd")', 'e1'); // tab A plays
  expect((await stateOf(controller)).isPlaying).toBe(true);

  const tabB = await openSession(session, 'browser'); // the page that opens now has played nothing
  await reports(tabB, controller, false);
  expect((await stateOf(controller)).isPlaying).toBe(true);
  await evictDurableObject(bridgeStub(session));
  expect((await stateOf(controller)).isPlaying).toBe(true); // and it was stored so
});

it.each([
  ['the tab that plays reports first', [[true, 'A'], [false, 'B']]],
  ['the idle tab reports first', [[false, 'B'], [true, 'A']]],
] as Array<[string, Array<[boolean, 'A' | 'B']>]>)('keeps the session playing when one tab reports that it plays and another that it does not (%s)', async (name, order) => {
  const { tabA, tabB, controller } = await twoTabs(`st-tabs-reports-${name.replace(/\W+/g, '-')}`);
  for (const [isPlaying, tab] of order) await reports(tab === 'A' ? tabA : tabB, controller, isPlaying);
  expect((await stateOf(controller)).isPlaying).toBe(true);
});

it('stops the session only when no open browser reports that it plays', async () => {
  const session = 'st-tabs-stop';
  const { tabA, tabB, controller } = await twoTabs(session);
  await reports(tabA, controller, true);
  await reports(tabB, controller, false);
  expect((await stateOf(controller)).isPlaying).toBe(true);

  await reports(tabA, controller, false); // the last tab that played has stopped
  expect((await stateOf(controller)).isPlaying).toBe(false);
  await evictDurableObject(bridgeStub(session));
  expect((await stateOf(controller)).isPlaying).toBe(false);

  await reports(tabB, controller, true);
  expect((await stateOf(controller)).isPlaying).toBe(true);
});

it('lets a command settle what the tabs reported before it', async () => {
  const { tabA, tabB, controller } = await twoTabs('st-tabs-command');
  await reports(tabA, controller, false); // both tabs have reported that they are idle ...
  await reports(tabB, controller, false);
  await evaluate({ browser: tabA, controller }, 's("bd")', 'e1'); // ... and then the agent plays something on them
  expect((await stateOf(controller)).isPlaying).toBe(true); // not what they said before it

  await reports(tabA, controller, true);
  await stopSession(tabA, controller, 's1'); // both tabs are told to stop, whatever tab A said last
  await tabB.next('stop');
  expect((await stateOf(controller)).isPlaying).toBe(false);

  await evaluate({ browser: tabA, controller }, 's("hh")', 'e2');
  controller.send({ type: 'reset_session', request_id: 'x1' });
  await controller.next((m) => m.type === 'ack' && m.request_id === 'x1');
  expect((await stateOf(controller)).isPlaying).toBe(false);
});

it('stops counting a tab once it has closed', async () => {
  const session = 'st-tabs-close';
  const { tabA, tabB, controller } = await twoTabs(session);
  await reports(tabA, controller, true);
  await reports(tabB, controller, false);
  expect((await stateOf(controller)).isPlaying).toBe(true);

  await tabA.close(); // the tab that played has gone and the one that is left plays nothing
  await vi.waitFor(async () => expect((await stateOf(controller)).isPlaying).toBe(false));
  await evictDurableObject(bridgeStub(session));
  expect((await stateOf(controller)).isPlaying).toBe(false);
});

it.each([
  ['undo', []],
  ['redo', [{ type: 'undo' }]],
] as Array<[direction: string, before: object[]]>)('plays on an %s: the browsers are sent an evaluate, and each of them is told to play, as an evaluate command does', async (direction, before) => {
  const session = `st-tabs-play-${direction}`;
  const { tabA, tabB, controller } = await twoTabs(session);
  await evaluate({ browser: tabA, controller }, 's("bd")', 'e1');
  await evaluate({ browser: tabA, controller }, 's("hh")', 'e2');
  for (const step of before) controller.send(step); // so that a redo has somewhere to go
  await stopSession(tabA, controller, 's1');
  expect((await stateOf(controller)).isPlaying).toBe(false);

  controller.send({ type: direction, request_id: 'm1' });
  await controller.next((m) => m.type === 'undo_result' && m.request_id === 'm1');
  expect((await stateOf(controller)).isPlaying).toBe(true);

  await reports(tabB, controller, false); // an idle tab reports, and the tab that was told to play keeps the session playing
  expect((await stateOf(controller)).isPlaying).toBe(true);
  await evictDurableObject(bridgeStub(session));
  expect((await stateOf(controller)).isPlaying).toBe(true);
});

it('stops counting a tab that errors out, as it does one that closes', async () => {
  const session = 'st-tabs-error';
  const { tabA, tabB, controller } = await twoTabs(session);
  await reports(tabA, controller, true);
  await reports(tabB, controller, false);
  expect((await stateOf(controller)).isPlaying).toBe(true);

  await runInDurableObject(bridgeStub(session), async (instance: SessionBridge, state) => {
    const playing = state.getWebSockets('browser').find((ws) => (ws.deserializeAttachment() as { isPlaying?: boolean } | null)?.isPlaying === true);
    await instance.webSocketError(playing!); // the tab that plays errors out: it is closed with 1011
  });
  expect((await stateOf(controller)).isPlaying).toBe(false); // and the one that is left plays nothing
  await evictDurableObject(bridgeStub(session));
  expect((await stateOf(controller)).isPlaying).toBe(false);
});

it('keeps the stored value when the last tab closes: there is nobody left to report', async () => {
  const session = 'st-tabs-close-last';
  const tab = await openSession(session, 'browser');
  const controller = await openSession(session, 'controller');
  await evaluate({ browser: tab, controller }, 's("bd")', 'e1');
  await tab.close();
  expect((await stateOf(controller)).isPlaying).toBe(true);
  await evictDurableObject(bridgeStub(session));
  expect((await stateOf(controller)).isPlaying).toBe(true);
});

it('writes isPlaying out only when the session\'s answer changes', async () => {
  const session = 'st-tabs-writes';
  const { tabA, tabB, controller } = await twoTabs(session);
  await evaluate({ browser: tabA, controller }, 's("bd")', 'e1'); // writes the session, and the first activity with it
  await stateOf(controller);
  let persist!: MockInstance;
  await runInDurableObject(bridgeStub(session), (instance) => {
    persist = vi.spyOn(instance as unknown as { persistState(): Promise<void> }, 'persistState');
  });

  await reports(tabA, controller, true); // the same as the answer: playing
  await reports(tabB, controller, false); // another tab, idle: still playing
  await reports(tabB, controller, false);
  expect(persist).not.toHaveBeenCalled();

  await reports(tabA, controller, false); // now nothing plays
  expect(persist).toHaveBeenCalledTimes(1);
  await reports(tabB, controller, false);
  expect(persist).toHaveBeenCalledTimes(1);
});

it('gives a socket the previous code accepted no report: what it sends changes nothing, and it stays without an attachment', async () => {
  const session = 'st-tabs-old-code';
  const { browser, controller } = await oldCodeSockets(session, { storedHash: true });
  await evaluate({ browser, controller }, 's("bd")', 'e1');
  expect((await stateOf(controller)).isPlaying).toBe(true);

  await reports(browser, controller, false); // there is nowhere to keep it, and the report is still passed on
  expect((await stateOf(controller)).isPlaying).toBe(true);
  const attachments = await runInDurableObject(bridgeStub(session), (_instance, state) => state.getWebSockets().map((ws) => ws.deserializeAttachment()));
  expect(attachments.filter((attachment) => attachment != null)).toEqual([]);

  // A tab of the current code that joins does keep its reports, and the old socket's lack of one does not hold it back.
  const tab = await openSession(session, 'browser');
  await reports(tab, controller, false);
  expect((await stateOf(controller)).isPlaying).toBe(false);
  await reports(tab, controller, true);
  expect((await stateOf(controller)).isPlaying).toBe(true);
});

// The clock of these two tests starts at the real time and stands still there. A session sets an alarm 30 days past its
// last message, and a clock in the past would put that in the past of the real clock, which runs alarms: it would
// fire at once, and set itself again in the past, over and over.

it('persists lastActivity at most once a minute, and along with any other write', async () => {
  const t0 = Date.now();
  const at = (ms: number) => vi.setSystemTime(t0 + ms);
  const iso = (ms: number) => new Date(t0 + ms).toISOString();
  const stub = bridgeStub('st-activity');
  const stored = () =>
    runInDurableObject(stub, async (_instance, state) =>
      (await state.storage.get<{ lastActivity: string }>('session'))?.lastActivity);

  at(0);
  const { browser, controller } = await connect('st-activity');
  await stateOf(controller);
  expect(await stored()).toBe(iso(0)); // nothing was stored yet, so the first message is written

  at(30_000);
  browser.send(statusReport(false)); // the same isPlaying as stored: not a write
  await controller.next('client_status');
  expect(await stored()).toBe(iso(0));

  at(59_999);
  await stateOf(controller);
  expect(await stored()).toBe(iso(0));

  at(60_000);
  await stateOf(controller);
  expect(await stored()).toBe(iso(60_000));

  at(70_000);
  browser.send(statusReport(true)); // a changed isPlaying is written, and lastActivity goes with it
  await controller.next('client_status');
  expect(await stored()).toBe(iso(70_000));
});

it('reports the persisted lastActivity when it wakes', async () => {
  const t0 = Date.now();
  vi.setSystemTime(t0);
  const { controller } = await connect('st-wake');
  await stateOf(controller);
  vi.setSystemTime(t0 + 61_000);
  await stateOf(controller); // a minute on, so this one is written too
  await evictDurableObject(bridgeStub('st-wake'));

  vi.setSystemTime(t0 + 70_000);
  const late = await openSession('st-wake', 'controller'); // connecting is not a message
  expect((await late.next('session_state')).payload).toMatchObject({
    createdAt: new Date(t0).toISOString(), lastActivity: new Date(t0 + 61_000).toISOString(),
  });
});

// --- acks that carry the editor's code ---

it('adopts the editor code a browser reports in an append ack', async () => {
  const pair = await connect('st-adopt');
  const { controller, browser } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  controller.send({ type: 'append_code', request_id: 'r4', payload: { code: 's("hh")' } });
  await browser.next('append_code');
  await browserAcks(pair, 'r4', 'appended', { code: 's("bd")\ns("hh")' });
  await evictDurableObject(bridgeStub('st-adopt')); // what was adopted has to be in storage
  expect(await stateOf(controller)).toMatchObject({
    currentPattern: 's("bd")\ns("hh")', rev: 2, historySize: 3, historyIndex: 2,
  });

  controller.send({ type: 'undo', request_id: 'r5' }); // the history holds what played before the append
  expect(await controller.next((m) => m.request_id === 'r5')).toMatchObject({
    type: 'undo_result', payload: { code: 's("bd")' },
  });
});

/** The controller sends an edit command, and resolves once a browser has it: from then on the session waits for its ack. */
async function sendsEdit({ browser, controller }: Pair, request_id: string, command: object): Promise<void> {
  controller.send({ ...command, request_id });
  await browser.next((m) => m.request_id === request_id);
}

const append = (code: string) => ({ type: 'append_code', payload: { code } });

it('adopts ack code for append, replace and effect acks, up to the code limit in bytes', async () => {
  const pair = await connect('st-adopt-kinds');
  await evaluate(pair, 's("bd")', 'r1');
  const edits: Array<[command: object, status: string, code: string]> = [
    [append('s("hh")'), 'appended', 's("bd")\ns("hh")'],
    [{ type: 'replace_code', payload: { search: 'bd', replace: 'sd' } }, 'replaced', 's("sd")\ns("hh")'],
    [{ type: 'add_effect', payload: { effect: 'lpf', params: { cutoff: 800 } } }, 'effect_added', 's("sd")\ns("hh").lpf(800)'],
    [append('a'), 'appended', '€'.repeat(21_845) + 'a'], // exactly MAX_CODE_BYTES bytes
  ];
  for (const [i, [command, status, code]] of edits.entries()) {
    await sendsEdit(pair, `a${i}`, command);
    await browserAcks(pair, `a${i}`, status, { code });
    expect(await stateOf(pair.controller)).toMatchObject({ currentPattern: code, rev: i + 2 });
  }
});

it('ignores ack code that is not a browser reporting an edit within the limit', async () => {
  const pair = await connect('st-adopt-ignored');
  const { browser, controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  const ignored: Array<[from: TestSocket, status: string, code: unknown]> = [
    [browser, 'playing', 's("x")'], // not an append, replace or effect ack
    [browser, 'appended', 42], // not a string
    [browser, 'appended', 'a'.repeat(MAX_CODE_BYTES + 1)],
    [browser, 'appended', '€'.repeat(21_846)], // 21,846 characters but 65,538 bytes
    [controller, 'appended', 's("x")'], // only a browser reports the editor's text
  ];
  for (const [i, [from, status, code]] of ignored.entries()) {
    await sendsEdit(pair, `i${i}`, append('x')); // each of these answers an edit that is in flight, so they are ignored for what they hold
    from.send({ type: 'ack', request_id: `i${i}`, status, payload: { code } });
    if (from === browser) await controller.next((m) => m.type === 'ack' && m.request_id === `i${i}`);
  }
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd")', rev: 1, historySize: 2 });
});

// An ack holds the editor's text as it was when the browser handled the edit. The session takes it for its code only
// for an edit it is still waiting for: after an evaluate, a set_code, an undo, a redo or a reset the text of an ack that
// comes late is older than the session's code, and adopting it would put the older code back.

it('does not adopt the ack of an edit that a newer evaluate has passed', async () => {
  const pair = await connect('st-stale-ack');
  const { controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  await sendsEdit(pair, 'r2', append('s("hh")'));
  await evaluate(pair, 's("sd")', 'r3'); // the agent moves on before the page has answered the edit

  await browserAcks(pair, 'r2', 'appended', { code: 's("bd")\ns("hh")' }); // text from before the evaluate; the ack is still passed on
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("sd")', rev: 2, historySize: 3, historyIndex: 2 });
});

it.each([
  ['set_code', [], { type: 'set_code', payload: { code: 's("sd")' } }, 's("sd")'],
  ['undo', [], { type: 'undo' }, 's("bd")'],
  ['redo', [{ type: 'undo' }], { type: 'redo' }, 's("bd")\ns("hh")'],
  ['reset_session', [], { type: 'reset_session' }, ''],
] as Array<[name: string, before: object[], command: object, pattern: string]>)('does not adopt the ack of an edit that %s has passed', async (name, before, command, pattern) => {
  const pair = await connect(`st-stale-ack-${name}`);
  const { controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  await evaluate(pair, 's("bd")\ns("hh")', 'r2');
  for (const step of before) controller.send(step); // so that a redo has somewhere to go
  const start = await stateOf(controller);
  await sendsEdit(pair, 'edit', append('x'));

  controller.send(command);
  const moved = await stateOf(controller);
  expect(moved).toMatchObject({ currentPattern: pattern, rev: (start.rev as number) + 1 });

  await browserAcks(pair, 'edit', 'appended', { code: 'older text from before the session moved on' });
  expect(await stateOf(controller)).toMatchObject({ currentPattern: pattern, rev: moved.rev });
});

it('adopts the ack of an edit once: the request_id is spent', async () => {
  const pair = await connect('st-ack-once');
  const { controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  await sendsEdit(pair, 'r2', append('s("hh")'));

  await browserAcks(pair, 'r2', 'appended', { code: 's("bd")\ns("hh")' });
  await browserAcks(pair, 'r2', 'appended', { code: 'another answer to the same edit' }); // passed on, not adopted
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd")\ns("hh")', rev: 2, historySize: 3 });
});

it('does not adopt the ack of an edit nobody asked for', async () => {
  const pair = await connect('st-ack-unasked');
  await evaluate(pair, 's("bd")', 'r1');
  await browserAcks(pair, 'made-up', 'appended', { code: 's("pwned")' });
  await browserAcks(pair, 'r1', 'appended', { code: 's("pwned")' }); // the id of an evaluate is not an edit's
  expect(await stateOf(pair.controller)).toMatchObject({ currentPattern: 's("bd")', rev: 1, historySize: 2 });
});

it('does not wait for the ack of an edit that no browser received', async () => {
  const controller = await openSession('st-ack-no-browser', 'controller');
  controller.send({ type: 'set_code', payload: { code: 's("bd")' } });
  controller.send({ ...append('s("hh")'), request_id: 'n1' });
  expect(await controller.next((m) => m.request_id === 'n1')).toMatchObject({ type: 'ack', status: 'no_browser' });

  const browser = await openSession('st-ack-no-browser', 'browser'); // one comes, and answers an edit it never got
  await browserAcks({ browser, controller }, 'n1', 'appended', { code: 's("pwned")' });
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd")', rev: 1 });
});

it('stops waiting for an edit the browser answers with an error', async () => {
  const pair = await connect('st-ack-error');
  const { browser, controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  await sendsEdit(pair, 'r2', append('s("hh")'));
  browser.send({ type: 'error', request_id: 'r2', payload: { message: 'Strudel editor is not ready yet.' } });
  await controller.next('pattern_error');

  await browserAcks(pair, 'r2', 'appended', { code: 'a late answer to an edit that failed' });
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd")', rev: 1 });
});

it('waits for a bounded number of edits at once, forgetting the oldest', async () => {
  const pair = await connect('st-ack-cap');
  const { controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  for (let i = 0; i <= MAX_PENDING_REQUESTS; i++) controller.send({ ...append('x'), request_id: `p${i}` });
  await pair.browser.next((m) => m.request_id === `p${MAX_PENDING_REQUESTS}`); // the session has handled them all

  await browserAcks(pair, 'p0', 'appended', { code: 'oldest' }); // forgotten
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd")', rev: 1 });
  await browserAcks(pair, `p${MAX_PENDING_REQUESTS}`, 'appended', { code: 'newest' });
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 'newest', rev: 2 });
});

it('ignores acks without payload.code (old bridge)', async () => {
  const pair = await connect('st-old-bridge');
  await evaluate(pair, 's("bd")', 'r1');
  pair.controller.send({ type: 'append_code', request_id: 'r4', payload: { code: 's("hh")' } });
  await pair.browser.next('append_code');
  await browserAcks(pair, 'r4', 'appended'); // the ack is still relayed
  expect(await stateOf(pair.controller)).toMatchObject({ currentPattern: 's("bd")', rev: 1, historySize: 2 });
});

it('adopts the same ack code once when two tabs report it', async () => {
  const tabA = await openSession('st-two-tabs', 'browser');
  const tabB = await openSession('st-two-tabs', 'browser');
  const controller = await openSession('st-two-tabs', 'controller');
  await evaluate({ browser: tabA, controller }, 's("bd")', 'r1');
  controller.send({ type: 'append_code', request_id: 'r4', payload: { code: 's("hh")' } });
  const ack = { type: 'ack', request_id: 'r4', status: 'appended', payload: { code: 's("bd")\ns("hh")' } };
  tabA.send(ack);
  tabB.send(ack);
  await controller.next((m) => m.type === 'ack' && m.request_id === 'r4');
  await controller.next((m) => m.type === 'ack' && m.request_id === 'r4');
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd")\ns("hh")', rev: 2, historySize: 3 });
});

// --- get_code answers that carry the editor's code ---

it('adopts the code a browser answers get_code with, as it does the code in an ack', async () => {
  const pair = await connect('st-get-code-adopt');
  const { browser, controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  const before = await stateOf(controller);

  controller.send({ type: 'get_code', request_id: 'g1' });
  await browser.next('get_code');
  browser.send({ type: 'code_response', request_id: 'g1', payload: { code: 's("bd").fast(2)' } }); // edited by hand
  expect(await controller.next('code_response')).toMatchObject({ request_id: 'g1', payload: { code: 's("bd").fast(2)' } });

  const adopted = {
    currentPattern: 's("bd").fast(2)', rev: (before.rev as number) + 1, historySize: (before.historySize as number) + 1,
  };
  expect(await stateOf(controller)).toMatchObject(adopted);

  // It has to be in storage, with its rev: a session that comes back must not report an older pattern at this rev.
  await evictDurableObject(bridgeStub('st-get-code-adopt'));
  expect(await stateOf(controller)).toMatchObject({ ...adopted, historyIndex: 2 });

  controller.send({ type: 'undo', request_id: 'u1' }); // what played before the edit by hand is in the history
  expect(await controller.next((m) => m.request_id === 'u1')).toMatchObject({
    type: 'undo_result', payload: { code: 's("bd")' },
  });
});

it('changes nothing when a browser answers get_code with the code the session already holds', async () => {
  const pair = await connect('st-get-code-same');
  const { browser, controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  const before = await stateOf(controller);

  controller.send({ type: 'get_code', request_id: 'g1' });
  await browser.next('get_code');
  browser.send({ type: 'code_response', request_id: 'g1', payload: { code: 's("bd")' } });
  expect(await controller.next('code_response')).toMatchObject({ request_id: 'g1', payload: { code: 's("bd")' } }); // still passed on

  const unchanged = {
    currentPattern: 's("bd")', rev: before.rev, historySize: before.historySize, historyIndex: before.historyIndex,
  };
  expect(await stateOf(controller)).toMatchObject(unchanged);
  await evictDurableObject(bridgeStub('st-get-code-same'));
  expect(await stateOf(controller)).toMatchObject(unchanged);
});

// The text of a code_response is the editor's as it was when the browser handled the get_code. Like the ack of an edit,
// the session takes it for its code only as the answer to a get_code it is still waiting for (P2-R28): one that nobody
// asked for, or that comes after an evaluate, set_code, undo, redo or reset_session has replaced the code, is stale or
// unasked text. Either way it is still passed on to the controllers, so that whoever asked gets its answer.

/** The controller sends a get_code, and resolves once a browser has it: from then on the session waits for the answer. */
async function sendsGetCode({ browser, controller }: Pair, request_id: string): Promise<void> {
  controller.send({ type: 'get_code', request_id });
  await browser.next((m) => m.type === 'get_code' && m.request_id === request_id);
}

/** A browser answers with `code`. Resolves once the controller has the answer passed on, so the session is done with it. */
async function browserAnswers({ browser, controller }: Pair, request_id: string, code: string): Promise<void> {
  browser.send({ type: 'code_response', request_id, payload: { code } });
  await controller.next((m) => m.type === 'code_response' && m.request_id === request_id);
}

it('adopts the code_response to a get_code it is waiting for, once', async () => {
  const pair = await connect('st-get-once');
  const { controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  await sendsGetCode(pair, 'g1');

  await browserAnswers(pair, 'g1', 's("bd").fast(2)');
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd").fast(2)', rev: 2, historySize: 3 });

  // A second tab answers the same get_code with its own text: passed on, and not taken, the request is answered.
  await browserAnswers(pair, 'g1', 'the editor of another tab');
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd").fast(2)', rev: 2, historySize: 3 });
});

it('does not adopt a code_response that nobody asked for, and still passes it on', async () => {
  const pair = await connect('st-get-unasked');
  const { browser, controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');

  await browserAnswers(pair, 'made-up', 's("pwned")');
  await browserAnswers(pair, 'r1', 's("pwned")'); // the id of an evaluate is not a get_code's
  browser.send({ type: 'code_response', payload: { code: 's("pwned")' } }); // no id to tell which request it answers
  expect(await controller.next('code_response')).toMatchObject({ payload: { code: 's("pwned")' } });
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd")', rev: 1, historySize: 2, historyIndex: 1 });
});

it.each([
  ['evaluate', [], { type: 'evaluate', payload: { code: 's("sd")' } }, 's("sd")'],
  ['set_code', [], { type: 'set_code', payload: { code: 's("sd")' } }, 's("sd")'],
  ['undo', [], { type: 'undo' }, 's("bd")'],
  ['redo', [{ type: 'undo' }], { type: 'redo' }, 's("bd")\ns("hh")'],
  ['reset_session', [], { type: 'reset_session' }, ''],
] as Array<[name: string, before: object[], command: object, pattern: string]>)('does not adopt the code_response to a get_code that %s has passed', async (name, before, command, pattern) => {
  const pair = await connect(`st-stale-get-${name}`);
  const { controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  await evaluate(pair, 's("bd")\ns("hh")', 'r2');
  for (const step of before) controller.send(step); // so that a redo has somewhere to go
  const start = await stateOf(controller);
  await sendsGetCode(pair, 'ask');

  controller.send(command);
  const moved = await stateOf(controller);
  expect(moved).toMatchObject({ currentPattern: pattern, rev: (start.rev as number) + 1 });

  await browserAnswers(pair, 'ask', 'older text from before the session moved on'); // the requester still gets it
  expect(await stateOf(controller)).toMatchObject({ currentPattern: pattern, rev: moved.rev });
});

it('does not wait for the answer to a get_code that no browser received', async () => {
  const controller = await openSession('st-get-no-browser', 'controller');
  controller.send({ type: 'set_code', payload: { code: 's("bd")' } });
  controller.send({ type: 'get_code', request_id: 'n1' });
  expect(await controller.next((m) => m.request_id === 'n1')).toMatchObject({ type: 'ack', status: 'no_browser' });

  const browser = await openSession('st-get-no-browser', 'browser'); // one comes, and answers a get_code it never got
  await browserAnswers({ browser, controller }, 'n1', 's("pwned")');
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd")', rev: 1 });
});

it('stops waiting for a get_code the browser answers with an error', async () => {
  const pair = await connect('st-get-error');
  const { browser, controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  await sendsGetCode(pair, 'g1');
  browser.send({ type: 'error', request_id: 'g1', payload: { message: 'Strudel editor is not ready yet.' } });
  await controller.next('pattern_error');

  await browserAnswers(pair, 'g1', 'a late answer to a get_code that failed');
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd")', rev: 1 });
});

it('waits for a bounded number of get_codes at once, forgetting the oldest', async () => {
  const pair = await connect('st-get-cap');
  const { controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  for (let i = 0; i <= MAX_PENDING_REQUESTS; i++) controller.send({ type: 'get_code', request_id: `q${i}` });
  await pair.browser.next((m) => m.request_id === `q${MAX_PENDING_REQUESTS}`); // the session has handled them all

  await browserAnswers(pair, 'q0', 'oldest'); // forgotten
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd")', rev: 1 });
  await browserAnswers(pair, `q${MAX_PENDING_REQUESTS}`, 'newest');
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 'newest', rev: 2 });
});

it('keeps the edits in flight and the get_codes in flight apart, each bounded by itself', async () => {
  const pair = await connect('st-pending-apart');
  const { controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');
  await sendsGetCode(pair, 'g1');
  for (let i = 0; i <= MAX_PENDING_REQUESTS; i++) controller.send({ ...append('x'), request_id: `e${i}` });
  await pair.browser.next((m) => m.request_id === `e${MAX_PENDING_REQUESTS}`); // more edits than fit: the oldest edit is forgotten ...

  await browserAnswers(pair, 'g1', 's("bd").fast(2)'); // ... and the get_code is not
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd").fast(2)', rev: 2 });
});

// --- get_code, ping, close ---

it('acks get_code with no_browser when no browser is connected', async () => {
  const controller = await openSession('st-get-code', 'controller');
  controller.send({ type: 'get_code', request_id: 'r5' });
  const ack = await controller.next((m) => m.request_id === 'r5');
  expect(ack).toMatchObject({
    type: 'ack', request_id: 'r5', status: 'no_browser',
    payload: { warning: expect.stringContaining('No DJ Opus browser session is connected') },
  });

  controller.send({ type: 'set_tempo', request_id: 'r6', payload: { bpm: 90 } });
  const other = await controller.next((m) => m.request_id === 'r6');
  expect(ack.payload).toEqual(other.payload); // the same warning as the other commands
});

it('answers ping with pong, also after eviction', async () => {
  const controller = await openSession('st-ping', 'controller');
  controller.send('ping');
  expect(await controller.nextRaw('pong')).toBe('pong');
  await evictDurableObject(bridgeStub('st-ping'));
  controller.send('ping');
  expect(await controller.nextRaw('pong')).toBe('pong');
});

it('completes the close handshake', async () => {
  const browser = await openSession('st-close', 'browser');
  expect(await browser.close(1000, 'done')).toBe(1000);
});

it('answers a close without a code with 1000 and echoes an application code', async () => {
  const noCode = await openSession('st-close-codes', 'browser');
  const custom = await openSession('st-close-codes', 'controller');
  expect(await noCode.close()).toBe(1000);
  expect(await custom.close(4001, 'custom')).toBe(4001);
});

it('closes with 1011 when a socket errors', async () => {
  const browser = await openSession('st-error', 'browser');
  await runInDurableObject(bridgeStub('st-error'), async (instance: SessionBridge, state) => {
    const [server] = state.getWebSockets('browser');
    await instance.webSocketError(server);
  });
  expect(await browser.close()).toBe(1011);
});

it('reciprocalCloseCode maps reserved codes to 1000', () => {
  for (const reserved of [1004, 1005, 1006, 1015]) expect(reciprocalCloseCode(reserved)).toBe(1000);
  expect(reciprocalCloseCode(1000)).toBe(1000);
  expect(reciprocalCloseCode(1001)).toBe(1001);
  expect(reciprocalCloseCode(4001)).toBe(4001);
});

// --- sockets ---

it('records the session hash on each socket and in storage', async () => {
  await connect('st-hash');
  const hash = await hashOf('st-hash');
  const recorded = await runInDurableObject(bridgeStub('st-hash'), async (_instance, state) => ({
    attachments: state.getWebSockets().map((ws) => ws.deserializeAttachment()),
    stored: await state.storage.get('sessionHash'),
  }));
  expect(recorded.stored).toBe(hash);
  expect(recorded.attachments).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'browser', sessionHash: hash }),
    expect.objectContaining({ role: 'controller', sessionHash: hash }),
  ]));
});

it('tags later sockets with the hash it stored instead of hashing again', async () => {
  // The key a Worker falls back to changes whenever its isolate restarts, so a
  // session's hash is made once and kept. A value left by "another isolate" must win.
  const stub = bridgeStub('st-keep-hash');
  await openSession('st-keep-hash', 'browser');
  await runInDurableObject(stub, (_instance, state) => state.storage.put('sessionHash', 'cafe0123'));
  await evictDurableObject(stub);

  const logs = captureLogs();
  await openSession('st-keep-hash', 'controller');
  expect(logs.events()).toContainEqual({ event: 'ws_connect', sessionHash: 'cafe0123', role: 'controller' });
  const attachments = await runInDurableObject(stub, (_instance, state) =>
    state.getWebSockets('controller').map((ws) => ws.deserializeAttachment()));
  expect(attachments).toEqual([expect.objectContaining({ role: 'controller', sessionHash: 'cafe0123' })]);
});

/**
 * A browser and a controller that look like sockets the previous code accepted:
 * role tags only, no attachment. With `storedHash: false` the object has no stored
 * session hash either, which is how a session that predates this code looks until
 * a socket connects to it again.
 */
async function oldCodeSockets(session: string, { storedHash }: { storedHash: boolean }): Promise<Pair> {
  const pair = await connect(session);
  const stub = bridgeStub(session);
  await runInDurableObject(stub, async (_instance, state) => {
    for (const ws of state.getWebSockets()) ws.serializeAttachment(null);
    if (!storedHash) await state.storage.delete('sessionHash');
  });
  await evictDurableObject(stub);
  return pair;
}

/** Takes the sockets through an evaluate, an ack, a forged ack and both closes. They must work as they did before. */
async function useOldCodeSockets(session: string, { browser, controller }: Pair): Promise<void> {
  controller.send({ type: 'evaluate', request_id: 'o1', payload: { code: 's("bd")' } });
  expect(await browser.next('evaluate')).toMatchObject({ request_id: 'o1' });
  browser.send({ type: 'ack', request_id: 'o1', status: 'playing' });
  expect(await controller.next((m) => m.type === 'ack' && m.request_id === 'o1')).toMatchObject({ status: 'playing' });
  expect(await stateOf(controller)).toMatchObject({ connectedClients: 1, connectedControllers: 1 });
  controller.send({ type: 'ack', request_id: 'o2', status: 'appended', payload: { code: 's("x")' } });
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd")', rev: 1 }); // still a controller

  // Nothing above gave the sockets an attachment back, so all of it ran on tags alone.
  const attachments = await runInDurableObject(bridgeStub(session), (_instance, state) =>
    state.getWebSockets().map((ws) => ws.deserializeAttachment()));
  expect(attachments).toHaveLength(2);
  expect(attachments.filter((attachment) => attachment != null)).toEqual([]);

  expect(await browser.close(1000, 'bye')).toBe(1000);
  expect(await controller.close()).toBe(1000);
}

it('keeps working for sockets accepted by the old code (tags, no attachment)', async () => {
  const pair = await oldCodeSockets('st-old-sockets', { storedHash: true });
  const logs = captureLogs();
  await useOldCodeSockets('st-old-sockets', pair);

  // The role comes from the tag, and the session from storage.
  const hash = await hashOf('st-old-sockets');
  expect(logs.events()).toEqual(expect.arrayContaining([
    { event: 'ws_close', sessionHash: hash, role: 'browser', code: 1000 },
    { event: 'ws_close', sessionHash: hash, role: 'controller', code: 1005 },
  ]));
});

it('keeps working, and logs no session, for old-code sockets on an object with no stored hash', async () => {
  const pair = await oldCodeSockets('st-old-sockets-bare', { storedHash: false });
  const logs = captureLogs();
  await useOldCodeSockets('st-old-sockets-bare', pair);

  // There is no id to hash, so these events have no sessionHash. They are still valid JSON lines with no raw id.
  expect(logs.lines().length).toBeGreaterThan(0);
  for (const line of logs.lines()) expect(() => JSON.parse(line)).not.toThrow();
  expect(logs.lines().join('\n')).not.toContain('st-old-sockets-bare');
  expect(logs.events()).toEqual(expect.arrayContaining([
    { event: 'route', type: 'evaluate', browsers: 1 },
    { event: 'ws_close', role: 'browser', code: 1000 },
    { event: 'ws_close', role: 'controller', code: 1005 },
  ]));
});

// --- size limits ---

/** Resolves when none of the sockets hears a frame that matches within 300 ms. */
async function hearNothing(match: Parameters<TestSocket['next']>[0], ...sockets: TestSocket[]): Promise<void> {
  await Promise.all(sockets.map((socket) => expect(socket.next(match, 300)).rejects.toThrow()));
}

it('answers an oversized frame with an error and keeps the socket', async () => {
  const logs = captureLogs();
  const { controller } = await connect('st-big-frame');
  controller.send('x'.repeat(131_073));
  expect(await controller.next('error')).toEqual({ type: 'error', payload: { message: 'Message too large' } });
  expect(await stateOf(controller)).toMatchObject({ rev: 0, connectedControllers: 1 }); // the same socket still gets answers
  expect(logs.events()).toContainEqual({ event: 'drop', sessionHash: await hashOf('st-big-frame'), reason: 'frame_too_large' });
});

it('measures a frame in bytes, up to 131,072 of them', async () => {
  const { controller } = await connect('st-frame-edge');
  const frame = (pad: number) => JSON.stringify({ type: 'get_state', request_id: 'edge', pad: 'a'.repeat(pad) });
  const room = 131_072 - frame(0).length;

  controller.send(frame(room)); // exactly 131,072 bytes: handled
  expect(await controller.next((m) => m.request_id === 'edge')).toMatchObject({ type: 'session_state' });

  controller.send(frame(room + 1)); // one byte more
  expect(await controller.next('error')).toMatchObject({ payload: { message: 'Message too large' } });
  await hearNothing((m) => m.request_id === 'edge', controller); // valid JSON, but never handled

  controller.send('€'.repeat(43_691)); // 43,691 characters, 131,073 bytes
  expect(await controller.next('error')).toMatchObject({ payload: { message: 'Message too large' } });
});

it('sends the oversized-frame error to the sender only', async () => {
  const { browser, controller } = await connect('st-big-frame-only');
  const bystander = await openSession('st-big-frame-only', 'controller');
  controller.send('x'.repeat(131_073));
  await controller.next('error');
  await hearNothing('error', bystander, browser);
});

it('rejects oversized code without forwarding it', async () => {
  const logs = captureLogs();
  const { browser, controller } = await connect('st-big-code');
  for (const type of ['evaluate', 'set_code']) {
    const request_id = `big-${type}`;
    controller.send({ type, request_id, payload: { code: 'a'.repeat(65_537) } });
    expect(await controller.next((m) => m.request_id === request_id)).toEqual({
      type: 'ack', request_id, status: 'rejected', payload: { reason: 'code_too_large' },
    });
  }
  await hearNothing('evaluate', browser);
  await hearNothing('set_code', browser);

  // Neither the session nor its history saw the code.
  expect(await stateOf(controller)).toMatchObject({ currentPattern: '', isPlaying: false, rev: 0, historySize: 1, historyIndex: 0 });
  const hash = await hashOf('st-big-code');
  expect(logs.events().filter((e) => e.event === 'drop' && e.sessionHash === hash)).toEqual([
    { event: 'drop', sessionHash: hash, reason: 'code_too_large' },
    { event: 'drop', sessionHash: hash, reason: 'code_too_large' },
  ]);
});

it('counts code in bytes, up to 65,536 of them', async () => {
  const { browser, controller } = await connect('st-code-edge');
  const edge = '€'.repeat(21_845) + 'a'; // exactly 65,536 bytes
  controller.send({ type: 'evaluate', request_id: 'ok', payload: { code: edge } });
  expect((await browser.next('evaluate')).payload).toEqual({ code: edge });

  controller.send({ type: 'set_code', request_id: 'bytes', payload: { code: '€'.repeat(21_846) } }); // 21,846 characters, 65,538 bytes
  expect(await controller.next((m) => m.request_id === 'bytes')).toMatchObject({ status: 'rejected' });
  expect(await stateOf(controller)).toMatchObject({ currentPattern: edge, rev: 1 });
});

it('sends the rejection to the sender only', async () => {
  const { browser, controller } = await connect('st-big-code-only');
  const bystander = await openSession('st-big-code-only', 'controller');
  controller.send({ type: 'evaluate', request_id: 'mine', payload: { code: 'a'.repeat(65_537) } });
  await controller.next((m) => m.request_id === 'mine');
  await hearNothing('ack', bystander, browser);
});

// --- payload shapes ---

/** The drop lines the Durable Object logged for a session. */
async function dropsOf(logs: ReturnType<typeof captureLogs>, session: string) {
  const hash = await hashOf(session);
  return logs.events().filter((e) => e.event === 'drop' && e.sessionHash === hash);
}

it('rejects an evaluate with no payload, to the sender only, and keeps answering', async () => {
  const logs = captureLogs();
  const { browser, controller } = await connect('st-no-payload');
  const bystander = await openSession('st-no-payload', 'controller');
  controller.send({ type: 'evaluate', request_id: 'np' });
  expect(await controller.next((m) => m.request_id === 'np')).toEqual({
    type: 'ack', request_id: 'np', status: 'rejected', payload: { reason: 'invalid_payload' },
  });
  expect(await stateOf(controller)).toMatchObject({ currentPattern: '', rev: 0, historySize: 1 }); // a later get_state still answers
  await hearNothing('evaluate', browser);
  await hearNothing('ack', bystander);
  expect(await dropsOf(logs, 'st-no-payload')).toEqual([
    { event: 'drop', sessionHash: await hashOf('st-no-payload'), reason: 'invalid_payload' },
  ]);
});

it('rejects an evaluate whose code is a number with the same ack', async () => {
  const { browser, controller } = await connect('st-number-code');
  controller.send({ type: 'evaluate', request_id: 'n1', payload: { code: 123 } });
  expect(await controller.next((m) => m.request_id === 'n1')).toEqual({
    type: 'ack', request_id: 'n1', status: 'rejected', payload: { reason: 'invalid_payload' },
  });
  await hearNothing('evaluate', browser);
  expect(await stateOf(controller)).toMatchObject({ currentPattern: '', isPlaying: false, rev: 0 });
});

it('rejects evaluate and set_code unless the payload holds a string code, and stores and forwards nothing', async () => {
  const { browser, controller } = await connect('st-bad-code');
  const frames: Array<[label: string, frame: object]> = [
    ['no payload', {}],
    ['payload null', { payload: null }],
    ['payload a string', { payload: 'code' }],
    ['payload a list', { payload: ['code'] }],
    ['no code', { payload: {} }],
    ['code null', { payload: { code: null } }],
    ['code a number', { payload: { code: 123 } }],
    ['code a list', { payload: { code: ['s("bd")'] } }],
    ['code an object', { payload: { code: { text: 's("bd")' } } }],
  ];
  for (const type of ['evaluate', 'set_code']) {
    for (const [label, frame] of frames) {
      const request_id = `${type}: ${label}`;
      controller.send({ type, request_id, ...frame });
      expect(await controller.next((m) => m.request_id === request_id), request_id).toMatchObject({
        status: 'rejected', payload: { reason: 'invalid_payload' },
      });
    }
  }
  await hearNothing((m) => m.type === 'evaluate' || m.type === 'set_code', browser);
  expect(await stateOf(controller)).toMatchObject({ currentPattern: '', isPlaying: false, rev: 0, historySize: 1, historyIndex: 0 });
});

it('adopts and forwards a browser code_response only when its code is a string within the limit', async () => {
  const logs = captureLogs();
  const pair = await connect('st-code-response');
  const { browser, controller } = pair;
  await evaluate(pair, 's("bd")', 'r1');

  // Whoever asked for the code hears the refusal at once, as a rejected ack for the request_id of the response.
  const refused: Array<[payload: unknown, reason: string]> = [
    [undefined, 'invalid_payload'], [null, 'invalid_payload'], ['text', 'invalid_payload'], [{}, 'invalid_payload'],
    [{ code: 42 }, 'invalid_payload'], [{ code: null }, 'invalid_payload'], [{ code: ['s("hh")'] }, 'invalid_payload'],
    [{ code: 'a'.repeat(65_537) }, 'code_too_large'], [{ code: '€'.repeat(21_846) }, 'code_too_large'], // over the limit in bytes
  ];
  for (const [i, [payload, reason]] of refused.entries()) {
    const request_id = `cr-${i}`;
    browser.send({ type: 'code_response', request_id, ...(payload === undefined ? {} : { payload }) });
    expect(await controller.next((m) => m.request_id === request_id), request_id).toEqual({
      type: 'ack', request_id, status: 'rejected', payload: { reason },
    });
  }
  await hearNothing('code_response', controller); // the code itself is neither forwarded nor adopted
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("bd")', rev: 1 });
  const hash = await hashOf('st-code-response');
  expect(await dropsOf(logs, 'st-code-response')).toEqual(
    refused.map(() => ({ event: 'drop', sessionHash: hash, reason: 'invalid_payload' })),
  );

  // Within the limit to the byte, it is adopted and passed on, as the answer to a get_code. A controller's is ignored.
  const edge = '€'.repeat(21_845) + 'a';
  await sendsGetCode(pair, 'cr-ok');
  await browserAnswers(pair, 'cr-ok', edge);
  controller.send({ type: 'code_response', request_id: 'forged', payload: { code: 's("forged")' } });
  expect(await stateOf(controller)).toMatchObject({ currentPattern: edge, rev: 2, historySize: 3 });
});

it('fails a get_code at once, with a rejected ack, when the browser answers with code over the limit', async () => {
  const { browser, controller } = await connect('st-get-code-refused');
  controller.send({ type: 'get_code', request_id: 'g1' });
  expect((await browser.next('get_code')).request_id).toBe('g1');
  browser.send({ type: 'code_response', request_id: 'g1', payload: { code: 'a'.repeat(65_537) } });
  expect(await controller.next((m) => m.request_id === 'g1', 2000)).toEqual({
    type: 'ack', request_id: 'g1', status: 'rejected', payload: { reason: 'code_too_large' },
  });
  await hearNothing('code_response', controller);
  expect(await stateOf(controller)).toMatchObject({ currentPattern: '', rev: 0 });
});

it('relays a browser status_report or error only when its payload is an object', async () => {
  const logs = captureLogs();
  const { browser, controller } = await connect('st-report-shapes');
  for (const type of ['status_report', 'error']) {
    browser.send({ type, request_id: 'x' }); // no payload
    for (const payload of [null, 'text', 42, true, ['a']]) browser.send({ type, request_id: 'x', payload });
  }
  await hearNothing((m) => m.type === 'client_status' || m.type === 'pattern_error', controller);
  expect(await dropsOf(logs, 'st-report-shapes')).toHaveLength(12);
  expect(new Set((await dropsOf(logs, 'st-report-shapes')).map((e) => e.reason))).toEqual(new Set(['invalid_payload']));

  browser.send(statusReport(true));
  expect(await controller.next('client_status')).toMatchObject({ payload: { isPlaying: true } });
  browser.send({ type: 'error', request_id: 'e1', payload: { message: 'boom' } });
  expect(await controller.next('pattern_error')).toMatchObject({ request_id: 'e1', payload: { message: 'boom' } });
});

it('never throws on a malformed frame, whoever sent it', async () => {
  captureLogs(); // silences the log lines of the 540 frames below
  const { controller } = await connect('st-never-throws');
  const types = [
    'evaluate', 'stop', 'set_code', 'set_tempo', 'get_code', 'append_code', 'replace_code', 'add_effect', 'recover_audio',
    'reset_session', 'undo', 'redo', 'get_state', 'status_report', 'error', 'code_response', 'ack', 'no_such_type',
  ];
  const payloads: unknown[] = [
    undefined, null, 0, 'text', true, [], [1], {}, { code: 1 }, { code: null }, { code: {} },
    { isPlaying: 'yes' }, { bpm: 'fast' }, { search: 1, replace: 2 }, { effect: 5, params: 'x' },
  ];
  let frames = 0;
  await runInDurableObject(bridgeStub('st-never-throws'), async (instance: SessionBridge, state) => {
    for (const ws of [...state.getWebSockets('browser'), ...state.getWebSockets('controller')]) {
      for (const type of types) {
        for (const payload of payloads) {
          const frame = payload === undefined ? { type, request_id: 'f' } : { type, request_id: 'f', payload };
          await instance.webSocketMessage(ws, JSON.stringify(frame)); // a throw fails the test
          frames++;
        }
      }
    }
  });
  expect(frames).toBe(2 * types.length * payloads.length);
  expect(typeof (await stateOf(controller)).currentPattern).toBe('string'); // no code that was not a string got in
});

// --- history budget ---

// The budget counts every character as two bytes, which is the most the storage can need for a string:
// one with a character above U+00FF is kept at two bytes a character (UTF-16), any other at one.

/** A code of 65,536 ASCII characters that differs from every other `i`: 131,072 bytes, counted as UTF-16. */
const bigCode = (i: number) => String(i).padEnd(65_536, 'x');

/**
 * ASCII and one euro sign: 65,536 UTF-8 bytes (the most a code may be) in 65,534 characters, so 131,068 bytes as
 * UTF-16. One character above U+00FF is all it takes for the storage to keep the whole string at two bytes each.
 */
const euroSignCode = (i: number) => String(i).padEnd(65_533, 'x') + '€';

it('keeps the stored history within 1 MiB of UTF-16 by dropping the oldest entries', async () => {
  const { controller } = await connect('st-history-cap');
  for (let i = 1; i <= 20; i++) controller.send({ type: 'set_code', payload: { code: euroSignCode(i) } });
  // 1 MiB holds eight of them (a ninth makes 1,179,612 bytes), so 20 pushes leave entries 13 to 20.
  const state = await stateOf(controller);
  expect(state.historySize).toBeLessThanOrEqual(8);
  expect(state).toMatchObject({ rev: 20, currentPattern: euroSignCode(20), historySize: 8, historyIndex: 7 });

  const stored = await runInDurableObject(bridgeStub('st-history-cap'), async (_instance, durable) =>
    (await durable.storage.get<{ patternHistory: string[] }>('session'))!.patternHistory);
  expect(stored.reduce((total, entry) => total + 2 * entry.length, 0)).toBeLessThanOrEqual(1_048_576);
  expect([stored[0], stored.at(-1)]).toEqual([euroSignCode(13), euroSignCode(20)]);

  controller.send({ type: 'undo', request_id: 'u1' }); // undo still walks back through what is kept
  expect(await controller.next((m) => m.request_id === 'u1')).toMatchObject({
    type: 'undo_result', payload: { code: euroSignCode(19), historyIndex: 6, direction: 'undo' },
  });
  const before = await stateOf(controller);
  await evictDurableObject(bridgeStub('st-history-cap'));
  expect(await stateOf(controller)).toMatchObject({
    rev: before.rev, historySize: 8, historyIndex: 6, currentPattern: euroSignCode(19), // what was persisted, not just what was in memory
  });
});

it('counts two bytes for every character, whatever the string holds', async () => {
  // Plain ASCII counts double too: eight entries of 65,536 characters fill 1 MiB, not sixteen.
  const ascii = await connect('st-history-ascii');
  for (let i = 1; i <= 20; i++) ascii.controller.send({ type: 'set_code', payload: { code: bigCode(i) } });
  expect(await stateOf(ascii.controller)).toMatchObject({ rev: 20, currentPattern: bigCode(20), historySize: 8, historyIndex: 7 });

  // Euro signs are three UTF-8 bytes but one character: 21,845 of them and a letter (65,536 bytes) count 43,692, so all 20 fit.
  const euros = await connect('st-history-euros');
  const euroCode = (i: number) => '€'.repeat(21_845) + String.fromCharCode(96 + i);
  for (let i = 1; i <= 20; i++) euros.controller.send({ type: 'set_code', payload: { code: euroCode(i) } });
  expect(await stateOf(euros.controller)).toMatchObject({ rev: 20, currentPattern: euroCode(20), historySize: 21, historyIndex: 20 });
});

it('keeps the newest history entry even when it alone is over the budget', async () => {
  await connect('st-history-newest');
  const kept = await runInDurableObject(bridgeStub('st-history-newest'), async (instance: SessionBridge) => {
    const bridge = instance as unknown as { pushHistory(code: string): void; patternHistory: string[]; historyIndex: number };
    bridge.pushHistory('a'.repeat(100_000));
    bridge.pushHistory('b'.repeat(1_100_000)); // not reachable through a socket (code is limited to 64 KiB), but the newest is never dropped
    return { lengths: bridge.patternHistory.map((entry) => entry.length), index: bridge.historyIndex };
  });
  expect(kept).toEqual({ lengths: [1_100_000], index: 0 });
});

it('still keeps at most 50 history entries when they are small', async () => {
  const { controller } = await connect('st-history-count');
  for (let i = 1; i <= 60; i++) controller.send({ type: 'set_code', payload: { code: `s("bd${i}")` } });
  expect(await stateOf(controller)).toMatchObject({ rev: 60, historySize: 50, historyIndex: 49 });
});

// --- other routes ---

it('keeps the /alias route working', async () => {
  const stub = bridgeStub('alias:st-alias');
  expect(await (await stub.fetch('https://internal/alias')).json()).toEqual({ sessionId: null });
  const saved = await stub.fetch('https://internal/alias', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'opus-1234' }),
  });
  expect(saved.status).toBe(200);
  expect(await (await stub.fetch('https://internal/alias')).json()).toEqual({ sessionId: 'opus-1234' });
});
