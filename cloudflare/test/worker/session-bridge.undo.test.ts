import { evictDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { bridgeStub, openSession, type TestSocket } from './helpers/sockets';

// Undo and redo in the SessionBridge (P2-R6c). The Durable Object moves the history, but only a browser can play the
// code it moved to, so the browser has the last word: the evaluate it is sent carries the command's request_id, and its
// ack or error settles the command. The controller that asked hears where the history went in an undo_result, which is
// not an ack. With no browser the history stays where it is.

let requests = 0;

async function stateOf(socket: TestSocket): Promise<Record<string, unknown>> {
  const request_id = `state-${++requests}`;
  socket.send({ type: 'get_state', request_id });
  return (await socket.next((m) => m.type === 'session_state' && m.request_id === request_id)).payload as Record<string, unknown>;
}

/** Sets the session's code to each of `codes` in turn, so its history is ['', ...codes]. */
async function setCodes(controller: TestSocket, codes: string[]): Promise<void> {
  for (const code of codes) controller.send({ type: 'set_code', payload: { code } });
  expect(await stateOf(controller)).toMatchObject({ historySize: codes.length + 1, historyIndex: codes.length });
}

it('acks undo and redo with no_browser when no browser is open, and leaves the history where it was', async () => {
  const controller = await openSession('un-alone', 'controller');
  await setCodes(controller, ['s("a")', 's("b")']);
  const before = await stateOf(controller);

  controller.send({ type: 'undo', request_id: 'u1' });
  const ack = await controller.next((m) => m.request_id === 'u1');
  controller.send({ type: 'set_tempo', request_id: 't1', payload: { bpm: 120 } });
  const other = await controller.next((m) => m.request_id === 't1');
  expect(ack).toEqual({ type: 'ack', request_id: 'u1', status: 'no_browser', payload: other.payload }); // the usual warning
  expect(await stateOf(controller)).toMatchObject({
    currentPattern: 's("b")', rev: before.rev, historySize: 3, historyIndex: 2,
  });

  // Back one step with a browser, which then goes: redo has somewhere to go, and still nothing moves.
  const browser = await openSession('un-alone', 'browser');
  controller.send({ type: 'undo', request_id: 'u2' });
  await controller.next((m) => m.type === 'undo_result' && m.request_id === 'u2');
  await browser.close();
  const undone = await stateOf(controller);
  expect(undone).toMatchObject({ currentPattern: 's("a")', historyIndex: 1, connectedClients: 0 });

  controller.send({ type: 'redo', request_id: 'r1' });
  expect(await controller.next((m) => m.request_id === 'r1')).toMatchObject({ type: 'ack', status: 'no_browser' });
  expect(await stateOf(controller)).toMatchObject({ currentPattern: 's("a")', rev: undone.rev, historyIndex: 1 });
});

it('answers the controller that asked with an undo_result and sends the browsers an evaluate with its request_id', async () => {
  const browser = await openSession('un-flow', 'browser');
  const controller = await openSession('un-flow', 'controller');
  const bystander = await openSession('un-flow', 'controller');
  await setCodes(controller, ['s("a")', 's("b")']);
  const before = await stateOf(controller);

  controller.send({ type: 'undo', request_id: 'u1' });
  expect(await controller.next((m) => m.request_id === 'u1')).toEqual({
    type: 'undo_result', request_id: 'u1', payload: { code: 's("a")', historyIndex: 1, direction: 'undo' },
  });
  expect(await browser.next('evaluate')).toEqual({ type: 'evaluate', request_id: 'u1', payload: { code: 's("a")' } });

  // The browser's ack is what the controllers hear next for u1: there is no 'undone' ack of the Durable Object's own.
  browser.send({ type: 'ack', request_id: 'u1', status: 'playing', payload: { codeLength: 6, audioContextState: 'running' } });
  expect(await controller.next((m) => m.request_id === 'u1')).toMatchObject({ type: 'ack', status: 'playing' });
  expect(await bystander.next((m) => m.request_id === 'u1')).toMatchObject({ type: 'ack', status: 'playing' });
  await expect(bystander.next('undo_result', 200)).rejects.toThrow(); // the undo_result went to the controller that asked

  // The move was stored before the browser was told, with rev moved as for any other change of the code.
  await evictDurableObject(bridgeStub('un-flow'));
  expect(await stateOf(controller)).toMatchObject({
    currentPattern: 's("a")', rev: (before.rev as number) + 1, historySize: 3, historyIndex: 1,
  });

  controller.send({ type: 'redo', request_id: 'r1' });
  expect(await controller.next((m) => m.request_id === 'r1')).toEqual({
    type: 'undo_result', request_id: 'r1', payload: { code: 's("b")', historyIndex: 2, direction: 'redo' },
  });
  expect(await browser.next('evaluate')).toEqual({ type: 'evaluate', request_id: 'r1', payload: { code: 's("b")' } });
});

it('relays the error a browser reports for the code an undo sent it, under the undo request_id', async () => {
  const browser = await openSession('un-error', 'browser');
  const controller = await openSession('un-error', 'controller');
  await setCodes(controller, ['s("a")', 's("b")']);

  controller.send({ type: 'undo', request_id: 'u1' });
  await controller.next('undo_result');
  await browser.next('evaluate');
  browser.send({ type: 'error', request_id: 'u1', payload: { message: 'sample "a" not found', code: 's("a")' } });
  expect(await controller.next((m) => m.request_id === 'u1')).toEqual({
    type: 'pattern_error', request_id: 'u1', payload: { message: 'sample "a" not found', code: 's("a")' },
  });
});

it('still acks nothing_to_undo and nothing_to_redo, with a browser open or not', async () => {
  for (const withBrowser of [false, true]) {
    const session = `un-nothing-${withBrowser}`;
    const browser = withBrowser ? await openSession(session, 'browser') : undefined;
    const controller = await openSession(session, 'controller');
    controller.send({ type: 'undo', request_id: 'u1' });
    expect(await controller.next((m) => m.request_id === 'u1')).toEqual({ type: 'ack', request_id: 'u1', status: 'nothing_to_undo' });
    controller.send({ type: 'redo', request_id: 'r1' });
    expect(await controller.next((m) => m.request_id === 'r1')).toEqual({ type: 'ack', request_id: 'r1', status: 'nothing_to_redo' });
    if (browser) await expect(browser.next('evaluate', 200)).rejects.toThrow(); // nothing to play
  }
});
