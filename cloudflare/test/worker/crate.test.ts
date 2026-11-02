import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, expect, it, vi, type Mock } from 'vitest';
import { CRATE_MAX_ENTRIES, createCrateLibraryStore } from '../../src/core/crate-store';
import { LIBRARY, type LibraryEntry } from '../../src/core/library';
import { newSessionId } from '../../src/core/session-id';
import { HttpError } from '../../src/http';
import { checkCode, checkName, checkTags } from '../../src/limits';
import { SESSION_TTL_MS } from '../../src/session-bridge';
import { captureLogs, hashOf } from './helpers/logs';
import { openSession } from './helpers/sockets';

// The crate is the saves of one session: up to 50 entries kept in the session's own Durable Object, private to it,
// gone with it after 30 idle days. The library is the curated patterns of patterns/, the same for every session and
// read-only. createCrateLibraryStore is the PatternStore the generic MCP's tools (save, load, list, delete) run on.
//
// A clock set with vi.setSystemTime must never be in the past: the runtime runs an alarm that is due at once, and
// every alarm these calls set would be (see session-bridge.expiry.test.ts).

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.now() + HOUR;

/** Sets the clock `offset` ms after T0. */
function at(offset: number): void {
  vi.setSystemTime(T0 + offset);
}

function crateStub(session: string) {
  return env.SESSION_BRIDGE.get(env.SESSION_BRIDGE.idFromName(session));
}

const entry = (name: string, content = 's("bd*4")', tags: string[] = []) => ({ name, content, tags });

/** A crate holding CRATE_MAX_ENTRIES entries, "pattern 0" to "pattern 49". */
async function filledCrate() {
  const stub = crateStub(newSessionId());
  for (let i = 0; i < CRATE_MAX_ENTRIES; i++) {
    expect(await stub.crateSave(entry(`pattern ${i}`)), `pattern ${i}`).toMatchObject({ ok: true });
  }
  return stub;
}

/** The keys in storage, and the alarm. */
function inStorage(stub: ReturnType<typeof crateStub>): Promise<{ keys: string[]; alarm: number | null }> {
  return runInDurableObject(stub, async (_instance, state) => ({
    keys: [...(await state.storage.list()).keys()].sort(),
    alarm: await state.storage.getAlarm(),
  }));
}

// --- the limits ---

it('saves up to 50 and refuses the 51st new name', async () => {
  expect(CRATE_MAX_ENTRIES).toBe(50);
  const stub = crateStub(newSessionId());
  for (let i = 0; i < 50; i++) {
    expect(await stub.crateSave(entry(`pattern ${i}`)), `pattern ${i}`).toEqual({
      ok: true,
      value: { saved: `pattern ${i}`, overwritten: false },
    });
  }
  expect(await stub.crateSave(entry('pattern 50'))).toEqual({ ok: false, error: 'crate_full' });
  expect(await stub.crateGet('pattern 50')).toBeNull();
  expect(await stub.crateList()).toHaveLength(50);
});

it('overwrites an existing name even when full', async () => {
  const stub = await filledCrate();
  expect(await stub.crateSave(entry('pattern 7', 's("hh*8")', ['v2']))).toEqual({
    ok: true,
    value: { saved: 'pattern 7', overwritten: true },
  });
  expect(await stub.crateGet('pattern 7')).toMatchObject({ content: 's("hh*8")', tags: ['v2'] });
  expect(await stub.crateList()).toHaveLength(50);
  expect(await stub.crateSave(entry('pattern 50'))).toEqual({ ok: false, error: 'crate_full' }); // still full
});

it('gives the last place to exactly one of the saves that arrive together, and one entry to a name saved twice at once', async () => {
  // A check of the count and the write that follows it are not one step unless nothing runs between them.
  const stub = crateStub(newSessionId());
  for (let i = 0; i < CRATE_MAX_ENTRIES - 1; i++) await stub.crateSave(entry(`pattern ${i}`));

  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => stub.crateSave(entry(`late ${i}`))));
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok)).toEqual(Array(7).fill({ ok: false, error: 'crate_full' }));
  expect(await stub.crateList()).toHaveLength(CRATE_MAX_ENTRIES);

  const fresh = crateStub(newSessionId());
  const twice = await Promise.all([fresh.crateSave(entry('same', 's("a")')), fresh.crateSave(entry('same', 's("b")'))]);
  expect(twice.map((r) => r.ok && r.value.overwritten).sort()).toEqual([false, true]);
  expect(await fresh.crateList()).toHaveLength(1);
});

it('accepts names with spaces, unicode and slashes', async () => {
  const stub = crateStub(newSessionId());
  // Opaque names: nothing in one is special to the crate, the longest allowed included. __proto__ and constructor
  // are here for a store that would keep its entries in a plain object.
  const names = ['Acid Groove — v2', 'set/one', 'ünï-cødé 🎛️', '  padded  ', 'a/b/../c', '__proto__', 'constructor', 'n'.repeat(128)];
  for (const name of names) {
    expect(await stub.crateSave(entry(name, `s("${name.length}")`)), name).toMatchObject({ ok: true, value: { saved: name } });
  }
  for (const name of names) {
    expect(await stub.crateGet(name), name).toMatchObject({ content: `s("${name.length}")` });
  }
  expect((await stub.crateList()).map((e) => e.name).sort()).toEqual([...names].sort());
});

it('treats names that differ only in case or form as different names', async () => {
  const stub = crateStub(newSessionId());
  // Written as escapes: the last two look the same, é in one piece and e with an accent after it.
  for (const name of ['Acid', 'acid', 'caf\u00e9', 'cafe\u0301']) {
    expect(await stub.crateSave(entry(name, `s("${name}")`)), name).toMatchObject({ ok: true, value: { overwritten: false } });
  }
  expect(await stub.crateList()).toHaveLength(4);
});

it('rejects a 129-char name and 65,537-byte content', async () => {
  const stub = crateStub(newSessionId());
  expect(await stub.crateSave(entry('n'.repeat(129)))).toEqual({ ok: false, error: 'invalid_name' });
  expect(await stub.crateSave(entry('big', 'a'.repeat(65_537)))).toEqual({ ok: false, error: 'too_large' });
  expect(await stub.crateGet('big')).toBeNull();
  expect(await stub.crateList()).toEqual([]);

  // The limits themselves are allowed. Content counts bytes: 21,845 euro signs are 65,535 of them, 21,846 are 65,538.
  expect(await stub.crateSave(entry('n'.repeat(128), 'a'.repeat(65_536)))).toMatchObject({ ok: true });
  expect(await stub.crateSave(entry('euros', '€'.repeat(21_845)))).toMatchObject({ ok: true });
  expect(await stub.crateSave(entry('too many euros', '€'.repeat(21_846)))).toEqual({ ok: false, error: 'too_large' });
  expect((await stub.crateGet('euros'))?.content).toBe('€'.repeat(21_845));
});

it('rejects an empty name, and a name that is not a string', async () => {
  const stub = crateStub(newSessionId());
  for (const name of ['', undefined, null, 7, ['a']]) {
    expect(await stub.crateSave({ ...entry('x'), name: name as never }), String(name)).toEqual({ ok: false, error: 'invalid_name' });
  }
  expect(await stub.crateList()).toEqual([]);
});

it('rejects a name that is not well-formed text, so that no two names are one key and the listing counts every entry', async () => {
  // A lone surrogate (an emoji cut in half, say) is a name storage keeps apart but lists as one: several of them are
  // different keys that a listing folds together, which would let a crate hold more than 50 and show fewer.
  const stub = crateStub(newSessionId());
  for (const name of ['a\ud800', 'a\udfff', '\ud83c', '\udf9b', 'x\ud83c y', 'x\udf9b\ud83c']) {
    // Only the verdict is compared: a failure prints what it compared, and a lone surrogate in that text is not valid
    // UTF-8, which the test pool cannot carry back to the runner.
    const saved = await stub.crateSave(entry(name));
    expect(saved.ok ? 'saved' : saved.error, JSON.stringify(name)).toBe('invalid_name');
    expect(await stub.crateGet(name), JSON.stringify(name)).toBeNull();
    expect(await stub.crateDelete(name), JSON.stringify(name)).toBe(false);
  }
  expect((await stub.crateList()).length).toBe(0);
  // A pair is a character, and fine, with the other characters that need two code units.
  for (const name of ['\ud83c\udf9b', 'a\ud83c\udf9bb', '\u{1d11e} clef']) {
    expect(await stub.crateSave(entry(name)), name).toMatchObject({ ok: true });
    expect(await stub.crateGet(name), name).toMatchObject({ content: 's("bd*4")' });
  }
});

it('rejects more than 10 tags, a tag over 32 characters, and tags that are not an array of strings', async () => {
  const stub = crateStub(newSessionId());
  const refused: unknown[] = [
    Array.from({ length: 11 }, (_, i) => `t${i}`),
    ['t'.repeat(33)],
    'techno',
    ['ok', 7],
    [['nested']],
    {},
    7,
  ];
  for (const tags of refused) {
    expect(await stub.crateSave({ ...entry('tagged'), tags: tags as never }), JSON.stringify(tags)).toEqual({ ok: false, error: 'invalid_tags' });
  }
  expect(await stub.crateGet('tagged')).toBeNull();

  const allowed = Array.from({ length: 10 }, (_, i) => String(i).padEnd(32, 't'));
  expect(await stub.crateSave(entry('tagged', 's("bd")', allowed))).toMatchObject({ ok: true });
  expect((await stub.crateGet('tagged'))?.tags).toEqual(allowed);
});

it('reports the first thing wrong with a save in the order the REST route checked: name, then content, then tags', async () => {
  const stub = crateStub(newSessionId());
  const verdict = async (input: { name: unknown; content: unknown; tags: unknown }) => {
    const saved = await stub.crateSave(input as never);
    return saved.ok ? 'saved' : saved.error;
  };
  const bad = { name: 'n'.repeat(129), content: { x: 'a'.repeat(100_000) }, tags: 'techno' };
  expect(await verdict(bad)).toBe('invalid_name');
  expect(await verdict({ ...bad, name: 'fine' })).toBe('too_large');
  expect(await verdict({ ...bad, name: 'fine', content: 's("bd")' })).toBe('invalid_tags');
  expect(await verdict({ ...bad, name: 'fine', content: 's("bd")', tags: ['techno'] })).toBe('saved');
  expect(await stub.crateList()).toHaveLength(1);
});

it('takes no tags, undefined or null, as checkTags does: the entry has none', async () => {
  // checkTags(undefined) and checkTags(null) are []: a save that names no tags has none, on every surface.
  expect(checkTags(undefined)).toEqual([]);
  expect(checkTags(null)).toEqual([]);
  const stub = crateStub(newSessionId());
  for (const [i, tags] of ([undefined, null] as const).entries()) {
    expect(await stub.crateSave({ ...entry(`no tags ${i}`), tags: tags as never }), String(tags)).toEqual({
      ok: true,
      value: { saved: `no tags ${i}`, overwritten: false },
    });
    expect((await stub.crateGet(`no tags ${i}`))?.tags, String(tags)).toEqual([]);
  }
  expect((await stub.crateList()).map((e) => e.tags)).toEqual([[], []]);
});

it('refuses content that is not a string, and stores nothing: an object that is 15 bytes as text is not 100,000 bytes of code', async () => {
  // TextEncoder turns anything it is given into text first, so { x: 'aaa…' } is "[object Object]", 15 bytes, and
  // a size check on bytes alone lets it through. It would be kept, and handed back by load as a pattern's content.
  const stub = crateStub(newSessionId());
  const notText: unknown[] = [{ x: 'a'.repeat(100_000) }, ['s("bd")'], 7, 0, true, null, undefined];
  for (const [i, content] of notText.entries()) {
    const saved = await stub.crateSave({ ...entry(`not text ${i}`), content: content as never });
    expect(saved.ok ? 'saved' : saved.error, `#${i}: ${typeof content}`).toBe('too_large');
    expect(await stub.crateGet(`not text ${i}`), `#${i}`).toBeNull();
  }
  expect(await stub.crateList()).toEqual([]);

  // An overwrite with such content leaves the entry as it was.
  await stub.crateSave(entry('kept', 's("kept")'));
  expect((await stub.crateSave({ ...entry('kept'), content: { x: 'a'.repeat(100_000) } as never })).ok).toBe(false);
  expect((await stub.crateGet('kept'))?.content).toBe('s("kept")');
});

// The crate takes what the Phase 1 checks of src/limits.ts take and refuses what they refuse, the one thing more being
// a name of text that is not well-formed. These put the same inputs to both, so that the crate cannot drift from them
// again (it did once, by checking the size of content without checking that it was content).
const VERDICTS = { name: 'invalid_name', content: 'too_large', tags: 'invalid_tags' } as const;

function checkVerdict(check: () => unknown): 'ok' | 'refused' {
  try {
    check();
    return 'ok';
  } catch (error) {
    if (error instanceof HttpError) return 'refused';
    throw error;
  }
}

it('agrees with checkName on every name: the same names are kept and refused', async () => {
  const names: unknown[] = ['', 'a', 'Acid Groove — v2', 'n'.repeat(128), 'n'.repeat(129), 7, null, undefined, ['a'], {}, true];
  const stub = crateStub(newSessionId());
  for (const [i, name] of names.entries()) {
    const expected = checkVerdict(() => checkName(name));
    const saved = await stub.crateSave({ ...entry('x'), name: name as never });
    expect(saved.ok ? 'ok' : saved.error, `#${i}: ${JSON.stringify(name)?.slice(0, 20)}`).toBe(expected === 'ok' ? 'ok' : VERDICTS.name);
  }
});

it('agrees with checkCode on every content: the same contents are kept and refused', async () => {
  const contents: unknown[] = [
    '', 's("bd")', 'a'.repeat(65_536), 'a'.repeat(65_537), '€'.repeat(21_845), '€'.repeat(21_846),
    7, 0, true, null, undefined, ['s("bd")'], { x: 'a'.repeat(100_000) }, new Date(0),
  ];
  const stub = crateStub(newSessionId());
  for (const [i, content] of contents.entries()) {
    const expected = checkVerdict(() => checkCode(content, 'content'));
    const saved = await stub.crateSave({ ...entry(`content ${i}`), content: content as never });
    expect(saved.ok ? 'ok' : saved.error, `#${i}: ${typeof content}`).toBe(expected === 'ok' ? 'ok' : VERDICTS.content);
  }
});

it('agrees with checkTags on every list of tags: the same lists are kept and refused', async () => {
  const lists: unknown[] = [
    undefined, null, [], ['a'], ['a', 'b'], [''], ['t'.repeat(32)], ['t'.repeat(33)],
    Array.from({ length: 10 }, (_, i) => `t${i}`), Array.from({ length: 11 }, (_, i) => `t${i}`),
    'techno', 7, true, {}, ['ok', 7], ['ok', null], [['nested']], [undefined],
  ];
  const stub = crateStub(newSessionId());
  for (const [i, tags] of lists.entries()) {
    const expected = checkVerdict(() => checkTags(tags));
    const saved = await stub.crateSave({ ...entry(`tags ${i}`), tags: tags as never });
    expect(saved.ok ? 'ok' : saved.error, `#${i}: ${JSON.stringify(tags)}`).toBe(expected === 'ok' ? 'ok' : VERDICTS.tags);
  }
});

it('does not report a failure of a check as a refusal: only what the checks refuse is refused', async () => {
  // A tags value that is an array to Array.isArray and throws when it is used gets into checkTags and breaks it. Nothing
  // like that can arrive over RPC, so this calls the object itself. It has to come out as the failure it is.
  const stub = crateStub(newSessionId());
  const broken = new Proxy([], {
    get() {
      throw new TypeError('the check broke');
    },
  });
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.crateSave({ name: 'x', content: 's("bd")', tags: broken as never })).rejects.toThrow('the check broke');
  });
  expect(await stub.crateGet('x')).toBeNull();
});

it('refuses what is wrong with a save before it says the crate is full, and stores nothing for it', async () => {
  const stub = await filledCrate();
  expect(await stub.crateSave(entry('n'.repeat(129)))).toEqual({ ok: false, error: 'invalid_name' });
  expect(await stub.crateSave(entry('new', 'a'.repeat(65_537)))).toEqual({ ok: false, error: 'too_large' });
  expect(await stub.crateSave(entry('new', 's("bd")', ['t'.repeat(33)]))).toEqual({ ok: false, error: 'invalid_tags' });
  // A refused overwrite leaves the entry as it was.
  expect(await stub.crateSave(entry('pattern 3', 'a'.repeat(65_537)))).toEqual({ ok: false, error: 'too_large' });
  expect(await stub.crateGet('pattern 3')).toMatchObject({ content: 's("bd*4")' });
  expect(await stub.crateList()).toHaveLength(50);
});

// --- reading, listing, deleting ---

it('gives an entry back as it was saved, with the time it was saved', async () => {
  const stub = crateStub(newSessionId());
  at(0);
  await stub.crateSave(entry('round trip', 's("bd")\n// ünï\t"quoted"', ['a', 'b']));
  expect(await stub.crateGet('round trip')).toEqual({
    content: 's("bd")\n// ünï\t"quoted"',
    tags: ['a', 'b'],
    savedAt: new Date(T0).toISOString(),
  });
  expect(await stub.crateGet('another name')).toBeNull();
});

it('lists name, tags and savedAt without the content, the newest save first', async () => {
  const stub = crateStub(newSessionId());
  expect(await stub.crateList()).toEqual([]);
  at(0);
  await stub.crateSave(entry('old', 's("1")', ['a']));
  at(1000);
  await stub.crateSave(entry('mid', 's("2")', ['b']));
  at(2000);
  await stub.crateSave(entry('new', 's("3")', []));
  expect(await stub.crateList()).toEqual([
    { name: 'new', tags: [], savedAt: new Date(T0 + 2000).toISOString() },
    { name: 'mid', tags: ['b'], savedAt: new Date(T0 + 1000).toISOString() },
    { name: 'old', tags: ['a'], savedAt: new Date(T0).toISOString() },
  ]);

  // Saving a name again saves it again: its time moves, and it is the newest.
  at(3000);
  expect(await stub.crateSave(entry('old', 's("4")', ['a2']))).toMatchObject({ ok: true, value: { overwritten: true } });
  expect(await stub.crateList()).toEqual([
    { name: 'old', tags: ['a2'], savedAt: new Date(T0 + 3000).toISOString() },
    { name: 'new', tags: [], savedAt: new Date(T0 + 2000).toISOString() },
    { name: 'mid', tags: ['b'], savedAt: new Date(T0 + 1000).toISOString() },
  ]);
});

it('lists saves of the same millisecond by name, so that the order is the same each time', async () => {
  const stub = crateStub(newSessionId());
  at(0); // the clock stands still
  for (const name of ['b', 'C', 'a', 'B']) await stub.crateSave(entry(name));
  expect((await stub.crateList()).map((e) => e.name)).toEqual(['B', 'C', 'a', 'b']); // by code unit, as everywhere else
});

it('deletes an entry, says whether there was one, and gives its place to a new name', async () => {
  const stub = await filledCrate();
  expect(await stub.crateSave(entry('extra'))).toEqual({ ok: false, error: 'crate_full' });

  expect(await stub.crateDelete('pattern 3')).toBe(true);
  expect(await stub.crateDelete('pattern 3')).toBe(false);
  expect(await stub.crateDelete('never saved')).toBe(false);
  expect(await stub.crateGet('pattern 3')).toBeNull();

  expect(await stub.crateSave(entry('extra'))).toMatchObject({ ok: true, value: { overwritten: false } });
  expect(await stub.crateList()).toHaveLength(50);
});

it('answers a get or a delete of a name that cannot be an entry with null and false', async () => {
  const stub = crateStub(newSessionId());
  for (const name of ['', 'n'.repeat(129), 'n'.repeat(100_000), undefined as never, 7 as never]) {
    expect(await stub.crateGet(name), String(name).slice(0, 10)).toBeNull();
    expect(await stub.crateDelete(name), String(name).slice(0, 10)).toBe(false);
  }
});

it('keeps one key per entry, crate:<name>, and no name reaches another key', async () => {
  const stub = crateStub(newSessionId());
  for (const name of ['Acid Groove — v2', 'set/one', 'session', 'sessionHash', 'crate:x']) await stub.crateSave(entry(name));
  const { keys } = await inStorage(stub);
  expect(keys).toEqual([
    'crate:Acid Groove — v2',
    'crate:crate:x',
    'crate:session',
    'crate:sessionHash',
    'crate:set/one',
    'session', // the session's own record, written by the activity the saves count as (see below)
    'sessionHash', // what the crate's log lines carry (see the logging tests)
  ]);
  const session = await runInDurableObject(stub, (_instance, state) => state.storage.get('session'));
  expect(session).toMatchObject({ currentPattern: '', patternHistory: [''], rev: 0 });
});

it('keeps its entries when the object is evicted', async () => {
  const id = newSessionId();
  const stub = crateStub(id);
  await stub.crateSave(entry('kept', 's("kept")', ['x']));
  await evictDurableObject(stub);
  expect(await crateStub(id).crateGet('kept')).toMatchObject({ content: 's("kept")', tags: ['x'] });
  expect(await crateStub(id).crateList()).toHaveLength(1);
});

it('keeps each session\'s crate to itself', async () => {
  const a = crateStub(newSessionId());
  const b = crateStub(newSessionId());
  await a.crateSave(entry('mine', 's("a")'));
  expect(await b.crateGet('mine')).toBeNull();
  expect(await b.crateList()).toEqual([]);
  expect(await b.crateDelete('mine')).toBe(false);
  // The same name in two crates is two entries.
  await b.crateSave(entry('mine', 's("b")'));
  expect((await a.crateGet('mine'))?.content).toBe('s("a")');
  expect((await b.crateGet('mine'))?.content).toBe('s("b")');
  // And a full crate is full for its own session.
  const full = await filledCrate();
  expect(await full.crateSave(entry('one more'))).toEqual({ ok: false, error: 'crate_full' });
  expect(await a.crateSave(entry('one more'))).toMatchObject({ ok: true });
});

// --- using the crate is activity ---

it('keeps a session whose only activity is a crateSave when its alarm goes off', async () => {
  const stub = crateStub(newSessionId());
  expect(await stub.crateSave(entry('keep me', 's("kept")'))).toMatchObject({ ok: true });

  // The save set the alarm, 30 days out, and wrote the session record the alarm reads lastActivity from.
  const { alarm } = await inStorage(stub);
  expect(Math.abs((alarm as number) - (Date.now() + SESSION_TTL_MS))).toBeLessThan(60_000);

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await stub.crateGet('keep me')).toMatchObject({ content: 's("kept")' });
  const kept = await inStorage(stub);
  expect(kept.keys).toEqual(['crate:keep me', 'session', 'sessionHash']);
  expect(Math.abs((kept.alarm as number) - (Date.now() + SESSION_TTL_MS))).toBeLessThan(60_000);
});

/** A session idle for 31 days: its record, two crate entries as crateSave stores them, and an alarm due in an hour. */
async function seedIdle(stub: ReturnType<typeof crateStub>): Promise<void> {
  const lastActivity = Date.now() - 31 * DAY;
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('session', {
      currentPattern: '',
      patternHistory: [''],
      historyIndex: 0,
      createdAt: new Date(lastActivity - DAY).toISOString(),
      isPlaying: false,
      lastActivity: new Date(lastActivity).toISOString(),
      rev: 0,
    });
    for (const name of ['x', 'y']) {
      await state.storage.put(`crate:${name}`, { content: 's("bd")', tags: [], savedAt: new Date(lastActivity).toISOString() });
    }
    await state.storage.setAlarm(Date.now() + HOUR);
  });
}

it.each<[string, (stub: ReturnType<typeof crateStub>) => Promise<unknown>]>([
  ['crateSave', (stub) => stub.crateSave(entry('new'))],
  ['crateDelete', (stub) => stub.crateDelete('y')],
  ['crateGet', (stub) => stub.crateGet('x')],
  ['crateList', (stub) => stub.crateList()],
])('counts %s as activity: a session idle for 31 days is kept once it is used', async (_rpc, call) => {
  const stub = crateStub(newSessionId());
  await seedIdle(stub);
  await evictDurableObject(stub); // the object that takes the call loads the stale record, as one woken after weeks would

  await call(stub);

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const kept = await inStorage(stub);
  expect(kept.keys).toContain('session');
  expect(kept.keys.some((key) => key.startsWith('crate:'))).toBe(true);
  expect(Math.abs((kept.alarm as number) - (Date.now() + SESSION_TTL_MS))).toBeLessThan(60_000);
});

it('still deletes a session with a crate that nobody has used for 31 days', async () => {
  const stub = crateStub(newSessionId());
  await seedIdle(stub);
  await evictDurableObject(stub);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await inStorage(stub)).toEqual({ keys: [], alarm: null }); // the record, both entries and the alarm
});

it('writes the session record once a minute at most, however many crate calls come', async () => {
  const stub = crateStub(newSessionId());
  await runInDurableObject(stub, (_instance, state) => {
    vi.spyOn(state.storage, 'put');
  });
  const sessionWrites = () =>
    runInDurableObject(stub, (_instance, state) =>
      (state.storage.put as unknown as Mock).mock.calls.filter(([key]) => key === 'session').length,
    );

  at(0);
  await stub.crateSave(entry('a'));
  await stub.crateGet('a');
  await stub.crateList();
  await stub.crateSave(entry('b'));
  await stub.crateDelete('a');
  expect(await sessionWrites()).toBe(1);

  at(59_000);
  await stub.crateList();
  expect(await sessionWrites()).toBe(1);

  at(61_000); // a minute after the record was written
  await stub.crateList();
  expect(await sessionWrites()).toBe(2);
});

// --- logging ---

it('logs the session hash and what happened, and never the name, the content, the tags or the session id', async () => {
  const logs = captureLogs();
  const id = newSessionId();
  const controller = await openSession(id, 'controller'); // a connect is where the object learns its session hash
  const stub = crateStub(id);

  await stub.crateSave(entry('Secret Name', 's("secret content")', ['secret-tag']));
  await stub.crateSave(entry('Secret Name', 's("secret content 2")', []));
  await stub.crateSave(entry('n'.repeat(129), 's("secret content 3")', []));
  await stub.crateDelete('Secret Name');
  await stub.crateDelete('Secret Name');
  const full = await filledCrate();
  await full.crateSave(entry('Secret Overflow'));

  const hash = await hashOf(id);
  const crateEvents = logs.events().filter((event) => String(event.event).startsWith('crate_'));
  expect(crateEvents.slice(0, 4)).toEqual([
    { event: 'crate_save', sessionHash: hash, overwritten: false },
    { event: 'crate_save', sessionHash: hash, overwritten: true },
    { event: 'crate_refused', sessionHash: hash, reason: 'invalid_name' },
    { event: 'crate_delete', sessionHash: hash },
  ]); // the second delete found nothing to delete, which is not an event
  expect(crateEvents.filter((event) => event.reason === 'crate_full')).toHaveLength(1);

  const everything = logs.lines().join('\n');
  for (const secret of ['Secret Name', 'Secret Overflow', 'secret content', 'secret-tag', id]) {
    expect(everything, secret).not.toContain(secret);
  }
  await controller.close();
});

it('logs the keyed session hash for a crate that is used before any socket connected', async () => {
  // The generic MCP can save to a session's crate before the player is ever opened. The object then has no socket to
  // learn its session from, and takes it from its own name, which is the session id the Worker addresses it by.
  const logs = captureLogs();
  const id = newSessionId();
  const stub = crateStub(id);
  await stub.crateSave(entry('Secret Name'));
  await stub.crateSave(entry('n'.repeat(129)));
  await stub.crateDelete('Secret Name');

  const hash = await hashOf(id);
  expect(logs.events().filter((event) => String(event.event).startsWith('crate_'))).toEqual([
    { event: 'crate_save', sessionHash: hash, overwritten: false },
    { event: 'crate_refused', sessionHash: hash, reason: 'invalid_name' },
    { event: 'crate_delete', sessionHash: hash },
  ]);

  // A socket that connects later is tagged with the same hash, and so is the crate after the object is evicted.
  await evictDurableObject(stub);
  const browser = await openSession(id, 'browser');
  await browser.next('session_state');
  await crateStub(id).crateSave(entry('again'));
  expect(logs.events()).toContainEqual({ event: 'ws_connect', sessionHash: hash, role: 'browser' });
  expect(logs.events().filter((event) => event.event === 'crate_save').map((event) => event.sessionHash)).toEqual([hash, hash]);
  expect(logs.lines().join('\n')).not.toContain(id);
  await browser.close();
});

// --- the store the tools run on ---

const LIB: readonly LibraryEntry[] = [
  { name: 'lib-acid-bass', content: 's("lib acid")', tags: ['trance', 'acid'] },
  { name: 'lib-dub', content: 's("lib dub")', tags: ['dub'] },
];

function newStore(library: readonly LibraryEntry[] = LIB) {
  const stub = crateStub(newSessionId());
  return { stub, store: createCrateLibraryStore(stub, library) };
}

it('load prefers the crate over the library', async () => {
  const { store } = newStore();
  expect(await store.load('lib-dub')).toEqual({ name: 'lib-dub', content: 's("lib dub")', tags: ['dub'], source: 'library' });
  await store.save({ name: 'lib-dub', content: 's("my dub")', tags: ['mine'] });
  expect(await store.load('lib-dub')).toEqual({ name: 'lib-dub', content: 's("my dub")', tags: ['mine'], source: 'crate' });
});

it('loads from the crate, then from the library, and gives null for a name it has in neither', async () => {
  const { store } = newStore();
  await store.save({ name: 'my set/one', content: 's("mine")', tags: ['x'] });
  expect(await store.load('my set/one')).toEqual({ name: 'my set/one', content: 's("mine")', tags: ['x'], source: 'crate' });
  expect(await store.load('lib-acid-bass')).toEqual({ name: 'lib-acid-bass', content: 's("lib acid")', tags: ['trance', 'acid'], source: 'library' });
  expect(await store.load('nothing by this name')).toBeNull();
  expect(await store.load('LIB-DUB')).toBeNull(); // names are exact
});

it('saves, and saves a name again, and says what was saved', async () => {
  const { store, stub } = newStore();
  expect(await store.save({ name: 'x', content: 's("a")', tags: ['t'] })).toEqual({ saved: 'x' });
  expect(await store.save({ name: 'x', content: 's("b")', tags: [] })).toEqual({ saved: 'x' });
  expect(await store.load('x')).toMatchObject({ content: 's("b")', tags: [], source: 'crate' });
  expect(await stub.crateList()).toHaveLength(1);
});

it('delete refuses library-only names', async () => {
  const { store } = newStore();
  await expect(store.delete('lib-dub')).rejects.toThrow('Library patterns are read-only');
  expect(await store.load('lib-dub')).toMatchObject({ source: 'library' });
});

it('delete says a name it has nowhere is not found, and deletes a crate entry', async () => {
  const { store } = newStore();
  await expect(store.delete('no-such')).rejects.toThrow('Pattern "no-such" not found');
  await store.save({ name: 'gone', content: 's("g")', tags: [] });
  expect(await store.delete('gone')).toEqual({ deleted: 'gone' });
  await expect(store.delete('gone')).rejects.toThrow('Pattern "gone" not found');
  expect(await store.load('gone')).toBeNull();
});

it('deletes the crate entry that hides a library pattern, and the library pattern shows through again', async () => {
  const { store } = newStore();
  await store.save({ name: 'lib-dub', content: 's("my dub")', tags: ['mine'] });
  expect(await store.delete('lib-dub')).toEqual({ deleted: 'lib-dub' });
  expect(await store.load('lib-dub')).toMatchObject({ content: 's("lib dub")', source: 'library' });
  await expect(store.delete('lib-dub')).rejects.toThrow('Library patterns are read-only');
});

it('list merges crate and library with sources and the tag filter', async () => {
  const { store } = newStore();
  at(0);
  await store.save({ name: 'my acid', content: 's("a")', tags: ['acid'] });
  at(1000);
  await store.save({ name: 'my techno', content: 's("t")', tags: ['techno'] });

  // The crate first, the newest save first, then the library in its own order.
  expect(await store.list()).toEqual([
    { name: 'my techno', tags: ['techno'], source: 'crate' },
    { name: 'my acid', tags: ['acid'], source: 'crate' },
    { name: 'lib-acid-bass', tags: ['trance', 'acid'], source: 'library' },
    { name: 'lib-dub', tags: ['dub'], source: 'library' },
  ]);
  expect(await store.list('acid')).toEqual([
    { name: 'my acid', tags: ['acid'], source: 'crate' },
    { name: 'lib-acid-bass', tags: ['trance', 'acid'], source: 'library' },
  ]);
  expect(await store.list('dub')).toEqual([{ name: 'lib-dub', tags: ['dub'], source: 'library' }]);
  expect(await store.list('no-such-tag')).toEqual([]);
  // An empty tag filters nothing, as in the list tool.
  expect(await store.list('')).toHaveLength(4);
  // The tag is the whole tag, however it is cased, as it was in the table.
  expect((await store.list('ACID')).map((e) => e.name)).toEqual(['my acid', 'lib-acid-bass']);
  expect(await store.list('aci')).toEqual([]);
});

it('lists the library alone for a session that has saved nothing, and nothing but name, tags and source of each', async () => {
  const { store } = newStore();
  const listed = await store.list();
  expect(listed.map((e) => [e.name, e.source])).toEqual([['lib-acid-bass', 'library'], ['lib-dub', 'library']]);
  for (const item of listed) expect(Object.keys(item).sort(), item.name).toEqual(['name', 'source', 'tags']);
});

it('lists a name once: a crate entry hides the library pattern of its name, tag filter included', async () => {
  const { store } = newStore();
  await store.save({ name: 'lib-dub', content: 's("my dub")', tags: ['mine'] });
  expect((await store.list()).filter((e) => e.name === 'lib-dub')).toEqual([{ name: 'lib-dub', tags: ['mine'], source: 'crate' }]);
  // What list shows under a tag is what load gives for it: the crate entry has no dub tag, so the name is not there.
  expect(await store.list('dub')).toEqual([]);
  expect((await store.list('mine')).map((e) => e.name)).toEqual(['lib-dub']);
});

it('hands out copies: changing what load or list returned does not change the library', async () => {
  const { store } = newStore();
  const loaded = await store.load('lib-acid-bass');
  loaded?.tags.push('tampered');
  (await store.list()).find((e) => e.name === 'lib-acid-bass')?.tags.push('tampered');
  expect((await store.load('lib-acid-bass'))?.tags).toEqual(['trance', 'acid']);
  expect(LIB[0].tags).toEqual(['trance', 'acid']);
});

it('says the crate is full in words the agent can act on', async () => {
  const stub = await filledCrate();
  const store = createCrateLibraryStore(stub, LIB);
  await expect(store.save({ name: 'one too many', content: 's("bd")', tags: [] })).rejects.toThrow(
    /^The crate is full \(50 patterns\)\. Delete one first\.$/,
  );
  // A name that is in the crate already is not one too many.
  await expect(store.save({ name: 'pattern 4', content: 's("hh")', tags: [] })).resolves.toEqual({ saved: 'pattern 4' });
});

it('says what is wrong with a name, content or tags it will not save, and stores nothing', async () => {
  const { store, stub } = newStore();
  const refused: Array<[{ name: string; content: string; tags: string[] }, RegExp]> = [
    [{ name: '', content: 's("bd")', tags: [] }, /^name must be 1 to 128 characters$/],
    [{ name: 'n'.repeat(129), content: 's("bd")', tags: [] }, /^name must be 1 to 128 characters$/],
    [{ name: 'big', content: '€'.repeat(21_846), tags: [] }, /^content is too large \(65538 bytes, the limit is 65536\)$/],
    [{ name: 'tags', content: 's("bd")', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, /^tags must be at most 10 strings of at most 32 characters each$/],
    [{ name: 'tag', content: 's("bd")', tags: ['t'.repeat(33)] }, /^tags must be at most 10 strings of at most 32 characters each$/],
    [{ name: 'empty', content: '', tags: [] }, /^The editor is empty, so there is nothing to save\./],
  ];
  for (const [input, message] of refused) {
    await expect(store.save(input), input.name.slice(0, 12)).rejects.toThrow(message);
  }
  expect(await stub.crateList()).toEqual([]);
});

it('tells content that is not a string so, and does not call it too large', async () => {
  const { store, stub } = newStore();
  for (const content of [{ x: 'a'.repeat(100_000) }, 7, 0, ['s("bd")'], null, undefined, true]) {
    await expect(store.save({ name: 'not text', content: content as never, tags: [] }), typeof content).rejects.toThrow(/^content must be a string$/);
  }
  expect(await stub.crateList()).toEqual([]);
  // The empty editor keeps its own message: only '' is that.
  await expect(store.save({ name: 'empty', content: '', tags: [] })).rejects.toThrow(/^The editor is empty/);
});

it('serves the real library: its patterns load with their source and tags, and the list shows them all', async () => {
  const stub = crateStub(newSessionId());
  const store = createCrateLibraryStore(stub, LIBRARY);
  expect(LIBRARY.length).toBeGreaterThan(0);
  const first = LIBRARY[0];
  expect(await store.load(first.name)).toEqual({ ...first, source: 'library' });
  const listed = await store.list();
  expect(listed.map((e) => e.name)).toEqual(LIBRARY.map((e) => e.name));
  expect(listed.every((e) => e.source === 'library')).toBe(true);
  expect((await store.list('acid')).length).toBeGreaterThan(0);
});

// --- the app has no D1 ---

it('the app no longer serves /api/patterns', async () => expect((await exports.default.fetch('https://djopus.test/api/patterns')).status).toBe(404));

it('answers every pattern route of the old API like any other path it does not have, and has no D1 binding', async () => {
  const requests = [
    ['GET', '/api/patterns'],
    ['GET', '/api/patterns?tag=techno'],
    ['POST', '/api/patterns'],
    ['GET', '/api/patterns/anything'],
    ['DELETE', '/api/patterns/anything'],
  ];
  for (const [method, path] of requests) {
    const res = await exports.default.fetch(`https://djopus.test${path}`, { method });
    expect(res.status, `${method} ${path}`).toBe(404);
    expect(await res.json(), `${method} ${path}`).toEqual({ error: 'Not found' });
  }
  // The rest of the API stays.
  expect((await exports.default.fetch('https://djopus.test/api/health')).status).toBe(200);
  // wrangler.toml no longer binds the database, so this Worker (and these tests) cannot reach it.
  expect((env as { DB?: unknown }).DB).toBeUndefined();
});
