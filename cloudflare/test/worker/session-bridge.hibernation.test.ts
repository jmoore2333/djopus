import { evictDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { resolveRole } from '../../src/session-bridge';
import { bridgeStub, openSession } from './helpers/sockets';

it('routes evaluate and the browser ack after the DO is evicted', async () => {
  const browser = await openSession('hib-route', 'browser');
  const controller = await openSession('hib-route', 'controller');
  await evictDurableObject(bridgeStub('hib-route'));
  controller.send({ type: 'evaluate', request_id: 'r1', payload: { code: 's("bd")' } });
  expect(await browser.next('evaluate')).toMatchObject({ request_id: 'r1', payload: { code: 's("bd")' } });
  browser.send({ type: 'ack', request_id: 'r1', status: 'playing' });
  expect(await controller.next('ack')).toMatchObject({ request_id: 'r1', status: 'playing' });
});

it('get_state counts sockets after eviction', async () => {
  const browser = await openSession('hib-count', 'browser');
  const controller = await openSession('hib-count', 'controller');
  await evictDurableObject(bridgeStub('hib-count'));
  controller.send({ type: 'get_state', request_id: 'r2' });
  expect(await controller.next((m) => m.request_id === 'r2')).toMatchObject({
    type: 'session_state', payload: { connectedClients: 1, connectedControllers: 1 },
  });
});

it('delivers to every browser on the session after eviction', async () => {
  const [a, b] = [await openSession('hib-two', 'browser'), await openSession('hib-two', 'browser')];
  const controller = await openSession('hib-two', 'controller');
  await evictDurableObject(bridgeStub('hib-two'));
  controller.send({ type: 'evaluate', request_id: 'r3', payload: { code: 's("hh")' } });
  expect(await a.next('evaluate')).toMatchObject({ request_id: 'r3' });
  expect(await b.next('evaluate')).toMatchObject({ request_id: 'r3' });
});

it('resolveRole falls back to tags for sockets accepted by the old code', () => {
  expect(resolveRole(null, ['controller'])).toBe('controller');
  expect(resolveRole(null, ['browser'])).toBe('browser');
  expect(resolveRole({ role: 'controller', connectedAt: 'x' }, ['browser'])).toBe('controller');
  expect(resolveRole(null, [])).toBe('browser');
});
