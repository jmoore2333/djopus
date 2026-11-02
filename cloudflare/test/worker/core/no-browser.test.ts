import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createDoCommandSender } from '../../../src/core/do-command';
import { createExecutor } from '../../../src/core/executor';
import { type DOMessage, NoBrowserError, type PatternStore, type SendCommand } from '../../../src/core/ports';
import { openSession } from '../helpers/sockets';

// When the session has no browser to give a command to, its Durable Object acks the command `no_browser`, with a
// warning written for ChatGPT ("Call openDJOpus first"). The SendCommand of the Worker turns that ack into a
// NoBrowserError, and the executor answers it with the surface's own noBrowserMessage, so each surface tells the user
// how to open its player and the generic one never sends an agent to openDJOpus (P2-R19).

const NO_BROWSER = (action: string) => `Open the player at https://djopus.test/s/x, then run ${action} again.`;
const DO_WARNING = 'No DJ Opus browser session is connected. Call openDJOpus first and wait for the REPL to load.';

describe('createDoCommandSender', () => {
  it('rejects a no_browser ack with a NoBrowserError that carries the warning', async () => {
    const send = createDoCommandSender(env.SESSION_BRIDGE, 'nb-set-tempo');
    const error = await send({ type: 'set_tempo', payload: { bpm: 120 } }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(NoBrowserError);
    expect(error).toMatchObject({ name: 'NoBrowserError', message: DO_WARNING });
  });

  it('also for an undo that has a history to move but no browser to play it', async () => {
    const controller = await openSession('nb-undo', 'controller');
    controller.send({ type: 'set_code', request_id: 'seed', payload: { code: 's("a")' } });
    await controller.next((m) => m.request_id === 'seed'); // no_browser: the code is the session's, with nobody to show it
    await expect(createDoCommandSender(env.SESSION_BRIDGE, 'nb-undo')({ type: 'undo' })).rejects.toBeInstanceOf(NoBrowserError);
    await controller.close();
  });

  it('still answers get_code from the session pattern when there is no browser, rather than failing', async () => {
    const result = await createDoCommandSender(env.SESSION_BRIDGE, 'nb-get-code')({ type: 'get_code' }, 'code_response');
    expect(result).toMatchObject({ type: 'code_response', payload: { code: '' } });
  });
});

describe('the executor on a real session', () => {
  const store: PatternStore = {
    save: async () => { throw new Error('unused'); },
    load: async () => null,
    list: async () => [],
    delete: async () => { throw new Error('unused'); },
  };

  // The anti-goal of the spec: no tool reports a success the browser did not confirm. A stop with nobody to stop used to
  // answer {"status":"stopped"} in a few milliseconds, while play named the player URL.
  it('fails stop, like play, with the message that names the player URL', async () => {
    const executor = createExecutor({
      sessionId: 'nb-real-stop',
      sendCommand: createDoCommandSender(env.SESSION_BRIDGE, 'nb-real-stop'),
      store,
      browserWaitMs: 0,
      noBrowserMessage: NO_BROWSER,
    });
    for (const tool of ['play', 'stop'] as const) {
      const error = await executor.executeTool(tool, {}).then(() => null, (e: Error) => e);
      expect(error?.message, tool).toBe(NO_BROWSER(tool));
    }
  });

  it('reports a stop only after the browser acked it', async () => {
    const browser = await openSession('nb-real-stop-ack', 'browser');
    const executor = createExecutor({
      sessionId: 'nb-real-stop-ack',
      sendCommand: createDoCommandSender(env.SESSION_BRIDGE, 'nb-real-stop-ack'),
      store,
      browserWaitMs: 0,
      noBrowserMessage: NO_BROWSER,
    });
    let outcome = 'pending';
    const stopping = executor.executeTool('stop', {}).then((r) => { outcome = 'resolved'; return r; }, () => { outcome = 'rejected'; });
    const stop = await browser.next('stop');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(outcome).toBe('pending');
    browser.send({ type: 'ack', request_id: stop.request_id, status: 'stopped' });
    expect(await stopping).toEqual({ status: 'stopped' });
    await browser.close();
  });
});

describe('the executor', () => {
  const store: PatternStore = {
    save: async () => { throw new Error('unused'); },
    load: async () => null,
    list: async () => [],
    delete: async () => { throw new Error('unused'); },
  };

  /** A session with one browser, as get_state sees it, whose Durable Object answers every other command with `answer`. */
  function executorFor(answer: (command: { type: string }) => DOMessage) {
    const sendCommand: SendCommand = async (command) => {
      if (command.type === 'get_state') {
        return { type: 'session_state', payload: { connectedClients: 1, isPlaying: true, currentPattern: 's("bd")' } };
      }
      if (command.type === 'get_code') return { type: 'code_response', payload: { code: 's("bd")' } };
      return answer(command);
    };
    return createExecutor({ sessionId: 's', sendCommand, store, browserWaitMs: 0, noBrowserMessage: NO_BROWSER });
  }

  it('answers a NoBrowserError with noBrowserMessage(action), never with the warning of the Durable Object', async () => {
    // The browser was there when the tool looked, and gone when the command reached the session.
    const gone = executorFor(() => { throw new NoBrowserError(DO_WARNING); });
    const calls: Array<[Parameters<typeof gone.executeTool>[0], Record<string, unknown>]> = [
      ['write', { pattern: 's("hh")', auto_play: true }],
      ['write', { pattern: 's("hh")' }],
      ['play', {}],
      ['set_tempo', { bpm: 120 }],
      ['recover_audio', {}],
      ['stop', {}],
      ['append_code', { code: 's("hh")' }],
      ['add_effect', { effect: 'room', params: { size: 0.5 } }],
      ['undo', {}],
      ['redo', {}],
      ['compose', { style: 'techno' }],
    ];
    for (const [name, args] of calls) {
      const error = await gone.executeTool(name, args).then(() => null, (e: Error) => e);
      expect(error?.message, name).toBe(NO_BROWSER(name));
      expect(error?.message, name).not.toContain('openDJOpus');
    }
  });

  it('lets any other failure of the session through as it is', async () => {
    const failing = executorFor(() => { throw new Error('sound "nope" not found'); });
    await expect(failing.executeTool('write', { pattern: 's("nope")', auto_play: true })).rejects.toThrow('sound "nope" not found');
  });

  it('undo and redo accept nothing_to_undo and nothing_to_redo, each for its own command', async () => {
    const nothing = executorFor((command) => ({ type: 'ack', status: command.type === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo' }));
    expect(await nothing.executeTool('undo', {})).toEqual({ status: 'nothing_to_undo' });
    expect(await nothing.executeTool('redo', {})).toEqual({ status: 'nothing_to_redo' });
  });

  it('undo and redo fail on any other answer than an undo_result, rather than reporting it as a status', async () => {
    const answers: DOMessage[] = [
      { type: 'ack', status: 'undone' }, // what the Durable Object of Phase 1 answered, before any browser played the code
      { type: 'ack', status: 'playing' },
      { type: 'ack' },
      { type: 'session_state', payload: {} },
    ];
    for (const answer of answers) {
      const odd = executorFor(() => answer);
      await expect(odd.executeTool('undo', {}), JSON.stringify(answer)).rejects.toThrow(/undo/);
      await expect(odd.executeTool('redo', {}), JSON.stringify(answer)).rejects.toThrow(/redo/);
    }
    // And the one for the other command is not an answer to this one.
    await expect(executorFor(() => ({ type: 'ack', status: 'nothing_to_redo' })).executeTool('undo', {})).rejects.toThrow(/undo/);
    await expect(executorFor(() => ({ type: 'ack', status: 'nothing_to_undo' })).executeTool('redo', {})).rejects.toThrow(/redo/);
  });
});
