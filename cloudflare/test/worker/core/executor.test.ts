import { describe, expect, it } from 'vitest';
import { createExecutor, type ExecutorDeps } from '../../../src/core/executor';
import type { DOMessage, PatternEntry, PatternStore, SendCommand } from '../../../src/core/ports';

// The executor core (src/core/executor.ts) on fake ports: a SendCommand that answers the way the session's Durable
// Object and a browser behind it do, and an in-memory PatternStore. test/worker/core/do-command.test.ts covers the real
// SendCommand, and the ChatGPT tests (test/chatgpt) run the core behind the ChatGPT adapter.

type Command = { type: string; payload?: Record<string, unknown> };

const NO_BROWSER = (action: string) => `Open the player, then run ${action} again.`;

/** A session_state as the Durable Object sends it (SessionState in src/protocol.ts). */
function sessionState(fields: { browsers?: number; code?: string; isPlaying?: boolean } = {}): DOMessage {
  return {
    type: 'session_state',
    request_id: 'req',
    payload: {
      currentPattern: fields.code ?? '',
      isPlaying: fields.isPlaying ?? false,
      rev: 3,
      createdAt: '2026-11-01T10:00:00.000Z',
      lastActivity: '2026-11-01T10:05:00.000Z',
      connectedClients: fields.browsers ?? 1,
      connectedControllers: 1,
      historySize: 4,
      historyIndex: 3,
    },
  };
}

/** The browser's ack of an evaluate it played, as client/strudel-ws-bridge.js sends it. */
function playing(code: string): DOMessage {
  return { type: 'ack', request_id: 'req', status: 'playing', payload: { codeLength: code.length, audioContextState: 'running' } };
}

/** What the real SendCommand resolves an undo or redo with once the browser has acked the code the history moved to. */
function undoResult(code: string, direction: 'undo' | 'redo', ack: DOMessage = playing(code)): DOMessage {
  return {
    type: 'undo_result',
    request_id: 'req',
    status: ack.status,
    payload: { ...ack.payload, code, historyIndex: direction === 'undo' ? 1 : 2, direction },
  };
}

interface FakeSession {
  sendCommand: SendCommand;
  sent: Command[];
  types(): string[];
}

/**
 * A session whose Durable Object answers each command through `answer`, which returns the message that settles it or
 * throws, as the real SendCommand rejects. Every command sent is recorded.
 */
function fakeSession(answer: (command: Command, waitForType?: string) => DOMessage): FakeSession {
  const sent: Command[] = [];
  return {
    sent,
    types: () => sent.map((command) => command.type),
    sendCommand: async (command, waitForType) => {
      sent.push(command);
      return answer(command, waitForType);
    },
  };
}

/** A session with `browsers` browsers open on `code`, which play what they are sent. `answers` replaces the answer to a command type. */
function browserSession(
  fields: { browsers?: number; code?: string; isPlaying?: boolean } = {},
  answers: Partial<Record<string, (command: Command) => DOMessage>> = {},
): FakeSession {
  return fakeSession((command, waitForType) => {
    const own = answers[command.type];
    if (own) return own(command);
    switch (command.type) {
      case 'get_state':
        expect(waitForType).toBe('session_state');
        return sessionState(fields);
      case 'get_code':
        expect(waitForType).toBe('code_response');
        return { type: 'code_response', request_id: 'req', payload: { code: fields.code ?? '' } };
      case 'evaluate':
        return playing((command.payload as { code: string }).code);
      case 'set_code':
        return { type: 'ack', request_id: 'req', status: 'code_set', payload: { codeLength: (command.payload as { code: string }).code.length } };
      default:
        throw new Error(`the fake session has no answer to ${command.type}`);
    }
  });
}

/** A PatternStore in memory. `saves` records what save was given. */
function memoryStore(entries: PatternEntry[] = []): PatternStore & { saves: Array<{ name: string; content: string; tags: string[] }> } {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const saves: Array<{ name: string; content: string; tags: string[] }> = [];
  return {
    saves,
    async save(entry) {
      saves.push(entry);
      byName.set(entry.name, { ...entry, source: 'crate' });
      return { saved: entry.name };
    },
    async load(name) {
      return byName.get(name) ?? null;
    },
    async list(tag) {
      return [...byName.values()]
        .filter((entry) => tag === undefined || entry.tags.includes(tag))
        .map(({ name, tags, source }) => ({ name, tags, source }));
    },
    async delete(name) {
      if (!byName.delete(name)) throw new Error(`Pattern "${name}" not found`);
      return { deleted: name };
    },
  };
}

function executorFor(session: FakeSession, deps: Partial<ExecutorDeps> = {}) {
  return createExecutor({
    sessionId: 'core-session',
    sendCommand: session.sendCommand,
    store: memoryStore(),
    browserWaitMs: 0,
    noBrowserMessage: NO_BROWSER,
    ...deps,
  });
}

// --- playback ---

describe('playback', () => {
  it('write auto_play reports the browser ack', async () => {
    const session = browserSession();
    const result = await executorFor(session).executeTool('write', { pattern: 's("bd")', auto_play: true });
    expect(result).toMatchObject({ status: 'playing', length: 7 });
    expect(session.sent).toContainEqual({ type: 'evaluate', payload: { code: 's("bd")' } });
  });

  it('write without auto_play puts the code in the editor and plays nothing', async () => {
    const session = browserSession();
    expect(await executorFor(session).executeTool('write', { pattern: 's("bd")' })).toEqual({ status: 'written', length: 7 });
    expect(session.sent).toContainEqual({ type: 'set_code', payload: { code: 's("bd")' } });
    expect(session.types()).not.toContain('evaluate');
  });

  it('waits browserWaitMs for a browser, then fails with noBrowserMessage', async () => {
    const session = browserSession({ browsers: 0 });
    const started = Date.now();
    await expect(executorFor(session, { browserWaitMs: 600 }).executeTool('write', { pattern: 's("bd")', auto_play: true }))
      .rejects.toThrow(NO_BROWSER('write'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(session.types().filter((type) => type === 'get_state').length).toBeGreaterThan(1); // it kept looking
    expect(session.types()).toEqual(session.types().filter((type) => type === 'get_state')); // and sent nothing else
  });

  it('uses a browser that connects while it waits', async () => {
    let looks = 0;
    const session = browserSession({}, { get_state: () => sessionState({ browsers: ++looks < 3 ? 0 : 1 }) });
    const result = await executorFor(session, { browserWaitMs: 5_000 }).executeTool('write', { pattern: 's("bd")', auto_play: true });
    expect(result).toMatchObject({ status: 'playing' });
    expect(looks).toBe(3);
  });

  it('passes needs_user_gesture through', async () => {
    const gesture: DOMessage = {
      type: 'ack', request_id: 'req', status: 'needs_user_gesture',
      payload: { codeLength: 7, audioContextState: 'suspended', message: 'Tap the player to unlock audio.' },
    };
    const session = browserSession({}, { evaluate: () => gesture });
    expect(await executorFor(session).executeTool('write', { pattern: 's("bd")', auto_play: true })).toEqual({
      status: 'needs_user_gesture', length: 7, needsUserGesture: true, audioContextState: 'suspended',
      message: 'Tap the player to unlock audio.',
    });
  });

  it('rejects an oversized pattern before sending anything', async () => {
    // 65,537 bytes, and 65,538 bytes in 32,769 characters: the schema's character limit lets the second one through.
    for (const pattern of ['a'.repeat(65_537), 'é'.repeat(32_769)]) {
      const session = browserSession();
      await expect(executorFor(session).executeTool('write', { pattern, auto_play: true })).rejects.toThrow(/too large/);
      expect(session.sent).toEqual([]);
    }
  });

  it('validates a pattern before playback, and plays nothing it rejects', async () => {
    const session = browserSession();
    await expect(executorFor(session).executeTool('write', { pattern: 's("bd"', auto_play: true }))
      .rejects.toThrow(/^DJ Opus write rejected the pattern before playback: Unbalanced parentheses/);
    await expect(executorFor(session).executeTool('write', { pattern: 's("bd").nosuchfn()', auto_play: true }))
      .rejects.toThrow('Unknown function: nosuchfn');
    expect(session.types()).not.toContain('evaluate');
    expect(session.types()).not.toContain('set_code');
  });

  it('plays a pattern that calls Strudel controls and widgets, and comments that say anything', async () => {
    // Refused before the names came from the Strudel build: lpq, size, delaytime, delayfeedback and pianoroll were not on
    // a hand-written list, a comment's "chaos (" read as a call and its apostrophe as an open quote.
    const pattern = [
      "// the lead's gaps leave room for chaos (on purpose)",
      'note("<a3 f3>").s("supersaw").lpq(8).room(0.7).size(0.9)',
      '  .delay(0.5).delaytime(3/8).delayfeedback(0.45).degradeBy(0.1).pianoroll()',
    ].join('\n');
    const session = browserSession();
    expect(await executorFor(session).executeTool('write', { pattern, auto_play: true })).toMatchObject({ status: 'playing' });
    expect(session.sent).toContainEqual({ type: 'evaluate', payload: { code: pattern } });
  });

  it('play evaluates what the editor holds', async () => {
    const session = browserSession({ code: 's("hh*8")' });
    expect(await executorFor(session).executeTool('play', {})).toMatchObject({ status: 'playing', length: 9 });
    expect(session.sent).toContainEqual({ type: 'evaluate', payload: { code: 's("hh*8")' } });
  });

  it('stop sends the stop command to a browser, and reports what the session confirmed', async () => {
    const session = browserSession({}, { stop: () => ({ type: 'ack', request_id: 'req', status: 'stopped' }) });
    expect(await executorFor(session).executeTool('stop', {})).toEqual({ status: 'stopped' });
    expect(session.sent).toContainEqual({ type: 'stop' });
  });

  it('stop fails with noBrowserMessage when no browser connects, and sends no stop', async () => {
    // Like play: nothing was stopped, because no browser was there to stop.
    const session = browserSession({ browsers: 0 });
    await expect(executorFor(session).executeTool('stop', {})).rejects.toThrow(NO_BROWSER('stop'));
    expect(session.types()).not.toContain('stop');
  });

  it('get_state merges describeSession()', async () => {
    const session = browserSession({ code: 's("bd")' });
    const state = await executorFor(session, { describeSession: () => ({ playerUrl: 'u' }) }).executeTool('get_state', {});
    expect(state).toMatchObject({ currentPattern: 's("bd")', connectedClients: 1, playerUrl: 'u' });
    expect(await executorFor(session).executeTool('get_state', {})).not.toHaveProperty('playerUrl');
  });
});

// --- editing ---

describe('editing', () => {
  it('append_code while playing evaluates the current code + "\\n\\n" + the new code', async () => {
    const session = browserSession({ code: 's("bd")', isPlaying: true });
    const result = await executorFor(session).executeTool('append_code', { code: 's("hh")' });
    expect(result).toEqual({ status: 'appended', changed: true, liveUpdated: true, length: 16 });
    expect(session.sent).toContainEqual({ type: 'evaluate', payload: { code: 's("bd")\n\ns("hh")' } });
  });

  it('append_code while stopped writes the new code without playing it', async () => {
    const session = browserSession({ code: 's("bd")', isPlaying: false });
    expect(await executorFor(session).executeTool('append_code', { code: 's("hh")' }))
      .toEqual({ status: 'appended', changed: true, liveUpdated: false, length: 16 });
    expect(session.sent).toContainEqual({ type: 'set_code', payload: { code: 's("bd")\n\ns("hh")' } });
    expect(session.types()).not.toContain('evaluate');
  });

  it('replace_code that matches nothing changes nothing', async () => {
    const session = browserSession({ code: 's("bd")', isPlaying: true });
    expect(await executorFor(session).executeTool('replace_code', { search: 'sd', replace: 'cp' }))
      .toEqual({ status: 'replaced', changed: false, liveUpdated: false, length: 7 });
    expect(session.types()).toEqual(['get_state', 'get_code']);
  });
});

// --- storage ---

describe('storage', () => {
  it('save stores the editor code, and load evaluates the stored content', async () => {
    const store = memoryStore();
    const saving = browserSession({ code: 's("bd*2")' });
    expect(await executorFor(saving, { store }).executeTool('save', { name: 'groove', tags: ['techno'] })).toEqual({ saved: 'groove' });
    expect(await executorFor(saving, { store }).executeTool('save', { name: 'untagged' })).toEqual({ saved: 'untagged' });
    expect(store.saves).toEqual([
      { name: 'groove', content: 's("bd*2")', tags: ['techno'] },
      { name: 'untagged', content: 's("bd*2")', tags: [] },
    ]);

    const loading = browserSession({ code: 's("other")' });
    expect(await executorFor(loading, { store }).executeTool('load', { name: 'groove', auto_play: true }))
      .toMatchObject({ loaded: 'groove', status: 'playing', length: 9 });
    expect(loading.sent).toContainEqual({ type: 'evaluate', payload: { code: 's("bd*2")' } });
  });

  it('load without auto_play writes the stored content, and a name the store lacks is not found', async () => {
    const store = memoryStore([{ name: 'groove', content: 's("bd*2")', tags: [], source: 'library' }]);
    const session = browserSession();
    expect(await executorFor(session, { store }).executeTool('load', { name: 'groove' })).toEqual({ loaded: 'groove', length: 9 });
    expect(session.sent).toContainEqual({ type: 'set_code', payload: { code: 's("bd*2")' } });

    await expect(executorFor(session, { store }).executeTool('load', { name: 'ghost', auto_play: true }))
      .rejects.toThrow('Pattern "ghost" not found');
    expect(session.types().filter((type) => type === 'evaluate')).toEqual([]);
  });

  it('list and delete go to the store', async () => {
    const store = memoryStore([
      { name: 'a', content: 's("a")', tags: ['acid'], source: 'crate' },
      { name: 'b', content: 's("b")', tags: [], source: 'library' },
    ]);
    const session = browserSession();
    expect(await executorFor(session, { store }).executeTool('list', { tag: 'acid' }))
      .toEqual({ patterns: [{ name: 'a', tags: ['acid'], source: 'crate' }] });
    expect(await executorFor(session, { store }).executeTool('delete', { name: 'a' })).toEqual({ deleted: 'a' });
    expect(await executorFor(session, { store }).executeTool('list', {}))
      .toEqual({ patterns: [{ name: 'b', tags: [], source: 'library' }] });
    expect(session.sent).toEqual([]); // the session is not involved
  });
});

// --- generation and validation, which call the generator and the validator directly ---

describe('generation and validation', () => {
  const noSession = () => fakeSession(() => { throw new Error('generation needs no session'); });

  it('generate_pattern fills in the defaults the REST route uses', async () => {
    const result = (await executorFor(noSession()).executeTool('generate_pattern', { style: 'techno' })) as { pattern: string };
    expect(result.pattern.split('\n')[0]).toBe('// techno pattern in C at 130 BPM');
    expect(Object.keys(result)).toEqual(['pattern']);
  });

  it('rejects a root MusicTheory does not know with its message', async () => {
    await expect(executorFor(noSession()).executeTool('generate_pattern', { style: 'techno', key: 'H' }))
      .rejects.toThrow(/^Invalid root note: H\b/);
    const session = browserSession();
    await expect(executorFor(session).executeTool('compose', { style: 'house', key: 'H' })).rejects.toThrow(/^Invalid root note: H\b/);
    expect(session.types()).not.toContain('evaluate');
  });

  it('validate returns the validator result, within the code limit', async () => {
    expect(await executorFor(noSession()).executeTool('validate', { pattern: 's("bd"' })).toMatchObject({
      valid: false, errors: ["Unbalanced parentheses: Unclosed '('"],
    });
    await expect(executorFor(noSession()).executeTool('validate', { pattern: '€'.repeat(21_846) })).rejects.toThrow(/too large/);
  });

  it('compose plays the pattern it generated and hands it back', async () => {
    const session = browserSession();
    const result = (await executorFor(session).executeTool('compose', { style: 'techno', bpm: 128 })) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'playing', pattern: expect.stringMatching(/^\/\/ techno pattern in C at 128 BPM/) });
    expect(session.sent).toContainEqual({ type: 'evaluate', payload: { code: result.pattern } });
  });
});

// --- undo and redo: settled by the browser, never by the history alone ---

describe('undo and redo', () => {
  it('report undone with the code once the browser has played it', async () => {
    const session = browserSession({}, { undo: () => undoResult('s("bd")', 'undo') });
    expect(await executorFor(session).executeTool('undo', {})).toEqual({ status: 'undone', code: 's("bd")', playback: 'playing' });
    expect(session.sent).toContainEqual({ type: 'undo' });
  });

  it('pass needs_user_gesture through as the playback, with its message', async () => {
    const gesture: DOMessage = {
      type: 'ack', request_id: 'req', status: 'needs_user_gesture',
      payload: { codeLength: 10, audioContextState: 'suspended', message: 'Tap the player to unlock audio.' },
    };
    const session = browserSession({}, { redo: () => undoResult('s("bd sd")', 'redo', gesture) });
    expect(await executorFor(session).executeTool('redo', {})).toEqual({
      status: 'redone', code: 's("bd sd")', playback: 'needs_user_gesture', message: 'Tap the player to unlock audio.',
    });
  });

  it('say when there is nothing to undo or redo', async () => {
    const session = browserSession({}, {
      undo: () => ({ type: 'ack', request_id: 'req', status: 'nothing_to_undo' }),
      redo: () => ({ type: 'ack', request_id: 'req', status: 'nothing_to_redo' }),
    });
    expect(await executorFor(session).executeTool('undo', {})).toEqual({ status: 'nothing_to_undo' });
    expect(await executorFor(session).executeTool('redo', {})).toEqual({ status: 'nothing_to_redo' });
  });

  it('fail when the browser reports an error for the code the history moved to', async () => {
    const session = browserSession({}, { undo: () => { throw new Error('sound "nope" not found'); } });
    await expect(executorFor(session).executeTool('undo', {})).rejects.toThrow('sound "nope" not found');
  });

  it('wait for a browser like the other playback tools, and move nothing without one', async () => {
    const session = browserSession({ browsers: 0 });
    await expect(executorFor(session).executeTool('undo', {})).rejects.toThrow(NO_BROWSER('undo'));
    await expect(executorFor(session).executeTool('redo', {})).rejects.toThrow(NO_BROWSER('redo'));
    expect(session.types()).toEqual(['get_state', 'get_state']);
  });
});
