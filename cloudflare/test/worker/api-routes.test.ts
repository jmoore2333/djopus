import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { handleApiRoutes, type ApiOptions } from '../../src/routes/api';

// The `patterns: 'none'` option of handleApiRoutes, for a host with no pattern store: the app's entry passes it. The
// default, 'd1', is what the tests of the pattern routes run on (api-pattern-writes.test.ts in test/chatgpt passes no
// option, and the ChatGPT entry passes 'd1').

const BASE = 'https://djopus.test';

// Public writes on, and no database: anything that touches env.DB throws, so a 404 is not a swallowed failure.
const withoutDb = { ...env, DB: undefined, PUBLIC_PATTERN_WRITES: 'on' } as unknown as Env;

function api(e: Env, method: string, path: string, body?: string, opts?: ApiOptions): Promise<Response> {
  const url = new URL(BASE + path);
  const request = new Request(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body });
  return handleApiRoutes(request, e, url, opts);
}

it('patterns: none answers every pattern route with 404, and never touches env.DB', async () => {
  const requests: [string, string, string | undefined][] = [
    ['GET', '/api/patterns', undefined],
    ['GET', '/api/patterns?tag=techno', undefined],
    ['POST', '/api/patterns', JSON.stringify({ name: 'n', content: 's("bd")' })],
    ['POST', '/api/patterns', '{'], // not a 400: the route is not there to read the body
    ['GET', '/api/patterns/n', undefined],
    ['DELETE', '/api/patterns/n', undefined],
  ];
  for (const opts of [{ patterns: 'none' }, { patterns: 'none', trusted: true, sessionId: 'a-session' }] as const) {
    for (const [method, path, body] of requests) {
      const res = await api(withoutDb, method, path, body, opts);
      const label = `${method} ${path} ${JSON.stringify(opts)}`;
      expect(res.status, label).toBe(404);
      expect(await res.json(), label).toEqual({ error: 'Not found' });
      expect(res.headers.get('Access-Control-Allow-Origin'), label).toBe('*');
    }
  }
});

it('patterns: none leaves the rest of the API as it is', async () => {
  const none: ApiOptions = { patterns: 'none' };
  expect(await (await api(withoutDb, 'GET', '/api/health', undefined, none)).json()).toMatchObject({ ok: true });
  expect((await api(withoutDb, 'POST', '/api/validate', JSON.stringify({ pattern: 's("bd*4")' }), none)).status).toBe(200);
  expect((await api(withoutDb, 'POST', '/api/generate/pattern', JSON.stringify({ style: 'techno' }), none)).status).toBe(200);
  expect((await api(withoutDb, 'OPTIONS', '/api/patterns', undefined, none)).status).toBe(204);
  expect((await api(withoutDb, 'GET', '/api/nothing-here', undefined, none)).status).toBe(404);
});
