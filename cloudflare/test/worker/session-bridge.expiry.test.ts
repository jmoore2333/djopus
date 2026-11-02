import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi, type Mock } from 'vitest';
import { newSessionId } from '../../src/core/session-id';
import { SESSION_TTL_MS, SessionBridge } from '../../src/session-bridge';
import { captureLogs, hashOf } from './helpers/logs';
import { bridgeStub, openSession } from './helpers/sockets';

// A session that has seen no message for 30 days and has no socket open is deleted by its own alarm. The alarm is
// set when a session is first used and moved only when it is more than a day off, so a busy session writes it about
// once a day. A tab that is left open keeps its session however quiet it is.
//
// These tests set the alarm by hand to a time an hour from now, and then run it: runDurableObjectAlarm only runs an
// alarm that exists, and the runtime runs one that is due by itself, at a moment of its own choosing. For the same
// reason a clock that vi.setSystemTime sets must never be in the past, or every alarm set by it would be due at once.

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The 'session' record of a session whose last message was at `lastActivity` (ms). */
function record(lastActivity: number) {
  return {
    currentPattern: 's("bd*4")',
    patternHistory: ['', 's("bd*4")'],
    historyIndex: 1,
    createdAt: new Date(lastActivity - DAY).toISOString(),
    isPlaying: false,
    lastActivity: new Date(lastActivity).toISOString(),
    rev: 1,
  };
}

/** What a session whose last message was at `lastActivity` leaves in storage, with an entry of its crate. */
async function seed(stub: DurableObjectStub, lastActivity: number): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('session', record(lastActivity));
    await state.storage.put('crate:x', { content: 's("bd")' });
    await state.storage.setAlarm(Date.now() + HOUR);
  });
}

/** The keys in storage, and the alarm. */
function inStorage(stub: DurableObjectStub): Promise<{ keys: string[]; alarm: number | null }> {
  return runInDurableObject(stub, async (_instance, state) => ({
    keys: [...(await state.storage.list()).keys()].sort(),
    alarm: await state.storage.getAlarm(),
  }));
}

it('SESSION_TTL_MS is 30 days', () => {
  expect(SESSION_TTL_MS).toBe(30 * DAY);
});

// --- when the alarm goes off ---

it.each([
  ['in memory', false],
  ['woken by the alarm', true],
])('alarm deletes an idle session with no sockets (%s)', async (_how, evicted) => {
  const stub = bridgeStub(newSessionId());
  await seed(stub, Date.now() - 31 * DAY);
  if (evicted) await evictDurableObject(stub);

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await inStorage(stub)).toEqual({ keys: [], alarm: null }); // the record, the crate entry, and the alarm itself
});

it('alarm keeps a session with a connected socket', async () => {
  const id = newSessionId();
  const browser = await openSession(id, 'browser');
  const stub = bridgeStub(id);
  await seed(stub, Date.now() - 31 * DAY);

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const kept = await inStorage(stub);
  expect(kept.keys).toEqual(['crate:x', 'session', 'sessionHash']);
  expect(kept.alarm).toBeGreaterThan(Date.now());
  // Thirty days from now. Thirty days from the old lastActivity would be yesterday.
  expect(Math.abs((kept.alarm as number) - (Date.now() + SESSION_TTL_MS))).toBeLessThan(60_000);
  await browser.close();
});

it('alarm keeps a session whose socket is hibernated', async () => {
  const id = newSessionId();
  const browser = await openSession(id, 'browser');
  const stub = bridgeStub(id);
  await evictDurableObject(stub); // the socket belongs to the runtime, which keeps it while the object is gone
  await seed(stub, Date.now() - 31 * DAY);
  await evictDurableObject(stub);

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const kept = await inStorage(stub);
  expect(kept.keys).toEqual(['crate:x', 'session', 'sessionHash']);
  expect(Math.abs((kept.alarm as number) - (Date.now() + SESSION_TTL_MS))).toBeLessThan(60_000);

  // And it is still the session of the socket that waited: a controller finds the browser on it.
  const alarmRuns = vi.spyOn(SessionBridge.prototype, 'alarm');
  const controller = await openSession(id, 'controller');
  expect((await controller.next('session_state')).payload).toMatchObject({ connectedClients: 1, currentPattern: 's("bd*4")' });

  // A connect is not a message: it leaves the alarm where the alarm put it, 30 days out. lastActivity + 30 days is
  // yesterday for this session, and an alarm set for that would run again at once.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(alarmRuns).not.toHaveBeenCalled();
  expect(Math.abs(((await inStorage(stub)).alarm as number) - (Date.now() + SESSION_TTL_MS))).toBeLessThan(60_000);
  await browser.close();
});

it('alarm deletes a session whose socket has closed', async () => {
  const id = newSessionId();
  const browser = await openSession(id, 'browser');
  await browser.close();
  const stub = bridgeStub(id);
  await seed(stub, Date.now() - 31 * DAY);

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await inStorage(stub)).toEqual({ keys: [], alarm: null });
});

it('alarm reschedules a recently active session', async () => {
  const stub = bridgeStub(newSessionId());
  const lastActivity = Date.now() - DAY;
  await seed(stub, lastActivity);

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await inStorage(stub)).toEqual({ keys: ['crate:x', 'session'], alarm: lastActivity + SESSION_TTL_MS });
});

it('deletes at exactly 30 days of idleness, and keeps the session one millisecond short of that', async () => {
  const now = Date.now() + HOUR; // a clock in the future: an alarm it sets is not due in real time
  vi.setSystemTime(now);
  const short = bridgeStub(newSessionId());
  const exact = bridgeStub(newSessionId());
  await seed(short, now - SESSION_TTL_MS + 1);
  await seed(exact, now - SESSION_TTL_MS);

  expect(await runDurableObjectAlarm(short)).toBe(true);
  expect(await runDurableObjectAlarm(exact)).toBe(true);
  expect(await inStorage(short)).toEqual({ keys: ['crate:x', 'session'], alarm: now + 1 });
  expect(await inStorage(exact)).toEqual({ keys: [], alarm: null });
});

it('takes the time a session was created for its last activity when the record is from before lastActivity was kept', async () => {
  const withoutLastActivity = async (createdAt: number) => {
    const stub = bridgeStub(newSessionId());
    await runInDurableObject(stub, async (_instance, state) => {
      const { lastActivity: _dropped, ...old } = record(0);
      await state.storage.put('session', { ...old, createdAt: new Date(createdAt).toISOString() });
      await state.storage.setAlarm(Date.now() + HOUR);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    return inStorage(stub);
  };
  expect((await withoutLastActivity(Date.now() - 2 * DAY)).keys).toEqual(['session']);
  expect((await withoutLastActivity(Date.now() - 40 * DAY)).keys).toEqual([]);
});

it('keeps a session whose record has a time it cannot read: it is the one deletion that cannot be undone', async () => {
  const stub = bridgeStub(newSessionId());
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('session', { ...record(Date.now() - 40 * DAY), lastActivity: 'yesterday-ish' });
    await state.storage.setAlarm(Date.now() + HOUR);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const kept = await inStorage(stub);
  expect(kept.keys).toEqual(['session']);
  expect(kept.alarm).toBeGreaterThan(Date.now());
});

// --- what the alarm leaves behind ---

it('logs session_expired with the session hash and nothing that names the session', async () => {
  const logs = captureLogs();
  const id = newSessionId();
  const browser = await openSession(id, 'browser');
  await browser.close();
  const stub = bridgeStub(id);
  await seed(stub, Date.now() - 31 * DAY);

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(logs.events().filter((event) => event.event === 'session_expired')).toEqual([
    { event: 'session_expired', sessionHash: await hashOf(id) },
  ]);
  expect(logs.lines().join('\n')).not.toContain(id);
});

it('logs nothing when the session is kept', async () => {
  const logs = captureLogs();
  const stub = bridgeStub(newSessionId());
  await seed(stub, Date.now() - DAY);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(logs.events().filter((event) => event.event === 'session_expired')).toEqual([]);
});

it('forgets what it held: the next visitor finds a new session, though the object was never evicted since', async () => {
  const id = newSessionId();
  const stub = bridgeStub(id);
  await seed(stub, Date.now() - 31 * DAY);
  await evictDurableObject(stub); // the object that runs the alarm loads the old session first
  expect(await runDurableObjectAlarm(stub)).toBe(true);

  const visitor = await openSession(id, 'controller');
  const welcome = (await visitor.next('session_state')).payload as Record<string, unknown>;
  expect(welcome).toMatchObject({ currentPattern: '', isPlaying: false, rev: 0, historySize: 1, historyIndex: 0 });
  expect(Date.parse(welcome.createdAt as string)).toBeGreaterThan(Date.now() - 60_000);

  // The first message writes the session out. What it writes is the new session, and the old crate is still gone.
  visitor.send({ type: 'get_state', request_id: 'x' });
  await visitor.next((m) => m.request_id === 'x');
  const after = await inStorage(stub);
  expect(after.keys).toEqual(['session', 'sessionHash']);
  expect(await runInDurableObject(stub, (_i, state) => state.storage.get('session'))).toMatchObject({ currentPattern: '', rev: 0 });
});

// --- when the alarm is set ---

it('sets the alarm when a socket first connects, so that a session nobody ever writes to expires too', async () => {
  const id = newSessionId();
  const before = Date.now();
  const socket = await openSession(id, 'browser');
  await socket.close();
  const stub = bridgeStub(id);

  const { keys, alarm } = await inStorage(stub);
  expect(keys).toEqual(['sessionHash']); // nothing is written but who it is
  expect(alarm).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
  expect(alarm).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS);

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await inStorage(stub)).toEqual({ keys: [], alarm: null });
});

it('arms a connect-time alarm 30 days from the connect, not from an old lastActivity: that day is long gone for a session from before alarms', async () => {
  const id = newSessionId();
  const stub = bridgeStub(id);
  // A session from before sessions had alarms: a record last active 40 days ago, and no alarm. lastActivity + 30 days
  // is 10 days ago, and an alarm set for it would be due at once.
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('session', record(Date.now() - 40 * DAY));
  });
  await evictDurableObject(stub); // so that the object that takes the connect has loaded that record
  await runInDurableObject(stub, (_instance, state) => {
    vi.spyOn(state.storage, 'setAlarm');
  });
  const alarmRuns = vi.spyOn(SessionBridge.prototype, 'alarm');

  const before = Date.now();
  const browser = await openSession(id, 'browser');
  try {
    const armed = await runInDurableObject(stub, (_instance, state) =>
      (state.storage.setAlarm as unknown as Mock).mock.calls.map(([when]) => when as number),
    );
    expect(armed).toHaveLength(1);
    expect(armed[0]).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
    expect(armed[0]).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alarmRuns).not.toHaveBeenCalled(); // an alarm in the past would have run by now
    expect(((await inStorage(stub)).alarm as number) - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 60_000);
  } finally {
    // An alarm that was set in the past runs on its own, and would run in the next test. Not this one's to leave behind.
    await browser.close();
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  }
});

it('sets the alarm on the first activity, and moves it only when it is more than a day off lastActivity + 30 days', async () => {
  const t0 = Date.now();
  vi.setSystemTime(t0);
  const alarmRuns = vi.spyOn(SessionBridge.prototype, 'alarm');
  const id = newSessionId();
  const stub = bridgeStub(id);
  // Spies on the object's own storage, installed once it exists: what it loads when it starts is not counted.
  const spyOn = (name: 'setAlarm' | 'getAlarm') =>
    runInDurableObject(stub, (_instance, state) => {
      vi.spyOn(state.storage, name);
    });
  const calls = (name: 'setAlarm' | 'getAlarm') =>
    runInDurableObject(stub, (_instance, state) => (state.storage[name] as unknown as Mock).mock.calls.map(([when]) => when as number | undefined));
  await spyOn('setAlarm');

  const controller = await openSession(id, 'controller');
  let requests = 0;
  const messageAt = async (offset: number) => {
    vi.setSystemTime(t0 + offset);
    const request_id = `m${++requests}`;
    controller.send({ type: 'get_state', request_id });
    await controller.next((m) => m.request_id === request_id); // the object has handled it
  };

  await messageAt(0);
  expect(await calls('setAlarm')).toEqual([t0 + SESSION_TTL_MS]); // set once, at the first use: the connect, not the message
  expect((await inStorage(stub)).alarm).toBe(t0 + SESSION_TTL_MS);

  // From here on the alarm is not asked for. (inStorage asks, so it stays out of this stretch.)
  await spyOn('getAlarm');
  for (const offset of [1_000, HOUR, 23 * HOUR, DAY]) await messageAt(offset); // up to a day later: not more than a day off
  expect(await calls('setAlarm')).toEqual([t0 + SESSION_TTL_MS]);

  await messageAt(DAY + 1); // a millisecond over a day
  expect(await calls('setAlarm')).toEqual([t0 + SESSION_TTL_MS, t0 + DAY + 1 + SESSION_TTL_MS]);

  await messageAt(DAY + 2);
  await messageAt(DAY + HOUR);
  expect(await calls('setAlarm')).toHaveLength(2);
  expect(await calls('getAlarm')).toEqual([]); // known from what the object keeps in memory: a message does not ask

  expect((await inStorage(stub)).alarm).toBe(t0 + DAY + 1 + SESSION_TTL_MS);
  expect(alarmRuns).not.toHaveBeenCalled(); // 30 days out is not due: nothing about ordinary use runs the alarm
});

it('fails neither a connect nor a message over an alarm it could not set: it says so in the log, and tries again', async () => {
  const logs = captureLogs();
  const t0 = Date.now();
  vi.setSystemTime(t0);
  const id = newSessionId();
  const stub = bridgeStub(id);
  await runInDurableObject(stub, (_instance, state) => {
    vi.spyOn(state.storage, 'setAlarm').mockRejectedValueOnce(new Error('storage is busy'));
  });

  const controller = await openSession(id, 'controller'); // the connect tries to set the alarm, and cannot
  expect((await inStorage(stub)).alarm).toBeNull();

  controller.send({ type: 'get_state', request_id: 'a' }); // the message is answered all the same, and sets it
  expect(await controller.next((m) => m.request_id === 'a')).toMatchObject({ type: 'session_state' });
  expect((await inStorage(stub)).alarm).toBe(t0 + SESSION_TTL_MS);

  expect(logs.events().filter((event) => event.event === 'alarm_error')).toEqual([
    { event: 'alarm_error', sessionHash: await hashOf(id), message: 'storage is busy' },
  ]);
});

it('knows its alarm after it wakes: a message does not set it again', async () => {
  const t0 = Date.now();
  vi.setSystemTime(t0);
  const id = newSessionId();
  const stub = bridgeStub(id);
  const controller = await openSession(id, 'controller');
  controller.send({ type: 'get_state', request_id: 'a' });
  await controller.next((m) => m.request_id === 'a');
  expect((await inStorage(stub)).alarm).toBe(t0 + SESSION_TTL_MS);

  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, state) => {
    vi.spyOn(state.storage, 'setAlarm');
  });
  vi.setSystemTime(t0 + HOUR);
  controller.send({ type: 'get_state', request_id: 'b' });
  await controller.next((m) => m.request_id === 'b');
  expect(await runInDurableObject(stub, (_instance, state) => (state.storage.setAlarm as unknown as Mock).mock.calls.length)).toBe(0);
});
