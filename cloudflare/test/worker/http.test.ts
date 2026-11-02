import { createExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { newSessionId } from '../../src/core/session-id';
import { HttpError, jsonError, readBoundedText, readJsonBody, withErrorHandling } from '../../src/http';
import worker from '../../src/index';
import { captureLogs } from './helpers/logs';
import { openWorkerSocket } from './helpers/sockets';

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE = 'https://djopus.test';

function post(path: string, body: string): Promise<Response> {
  return exports.default.fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}

/** A body of exactly `bytes` bytes of valid JSON that /api/generate/pattern accepts (it ignores the padding). */
function jsonBodyOf(bytes: number): string {
  const overhead = JSON.stringify({ style: 'techno', pad: '' }).length;
  return JSON.stringify({ style: 'techno', pad: 'a'.repeat(bytes - overhead) });
}

// --- session ids on /ws ---

it('rejects an invalid session on /ws with 400', async () => {
  await expect(openWorkerSocket('/ws?session=bad%20id&role=controller')).rejects.toMatchObject({ status: 400 });
  await expect(openWorkerSocket(`/ws?session=${'x'.repeat(65)}&role=browser`)).rejects.toMatchObject({ status: 400 });
  await expect(openWorkerSocket(`/ws?session=${encodeURIComponent("a'</script>")}`)).rejects.toMatchObject({ status: 400 });
});

it('answers an invalid session on /ws with a JSON error', async () => {
  const res = await exports.default.fetch(`${BASE}/ws?session=bad%20id`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'Invalid session id' });
});

// What the app takes on /ws (128-bit ids from its own page, no agents) is ws-rules.test.ts. The plain ids of the first
// hosts, the default session included, are the ChatGPT Worker's: test/chatgpt/entry.test.ts.

// --- static assets ---

// A session id travels in the URL of the page (/s/<id>; the first hosts used /?session=...), and a browser's default
// is to send that whole URL as the Referer of the same-origin requests the page makes. strict-origin cuts it down
// to the origin. redact_query_string covers the URL Cloudflare records, not request headers.

it('sends Referrer-Policy strict-origin with the REPL page', async () => {
  const res = await exports.default.fetch(`${BASE}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get('Referrer-Policy')).toBe('strict-origin');
  await res.arrayBuffer();
});

it('sends it with the other assets too, the bridge script and the page with a session in its URL included', async () => {
  for (const path of ['/strudel-ws-bridge.js', '/sw.js', '/?session=opus-ab12', `/s/${newSessionId()}`, '/some/page']) {
    const res = await exports.default.fetch(BASE + path);
    expect(res.status, path).toBe(200);
    expect(res.headers.get('Referrer-Policy'), path).toBe('strict-origin');
    await res.arrayBuffer();
  }
});

it('serves the REPL page at the player URL /s/<id>, whatever follows /s/: the page itself works out which session it is', async () => {
  const home = await exports.default.fetch(`${BASE}/`);
  const page = await home.text();
  expect(page).toContain('strudel-ws-bridge.js');
  for (const id of [newSessionId(), 'opus-ab12', 'not-an-id']) {
    const res = await exports.default.fetch(`${BASE}/s/${id}`);
    expect(res.status, id).toBe(200);
    expect(res.headers.get('Referrer-Policy'), id).toBe('strict-origin');
    expect(await res.text(), id).toBe(page);
  }
});

it('has the assets layer send it too: the app Worker does not run for a page, so static/_headers is what puts it there', async () => {
  // env.ASSETS is the assets alone, without the Worker in front: the layer that answers / and /s/<id> in production.
  for (const path of ['/', `/s/${newSessionId()}`]) {
    const res = await env.ASSETS.fetch(new Request(BASE + path));
    expect(res.status, path).toBe(200);
    expect(res.headers.get('Referrer-Policy'), path).toBe('strict-origin');
    await res.arrayBuffer();
  }

  // A browser revalidates the page on every load, and the 304 has to carry it as well.
  const first = await env.ASSETS.fetch(new Request(`${BASE}/`));
  const etag = first.headers.get('ETag');
  await first.arrayBuffer();
  expect(etag).toBeTruthy();
  const revalidated = await env.ASSETS.fetch(new Request(`${BASE}/`, { headers: { 'If-None-Match': etag as string } }));
  expect(revalidated.status).toBe(304);
  expect(revalidated.headers.get('Referrer-Policy')).toBe('strict-origin');
});

it('sends it with a 304 as well: the browser revalidates the page on every load', async () => {
  const first = await exports.default.fetch(`${BASE}/`);
  const etag = first.headers.get('ETag');
  await first.arrayBuffer();
  expect(etag).toBeTruthy();
  const res = await exports.default.fetch(`${BASE}/`, { headers: { 'If-None-Match': etag as string } });
  expect(res.status).toBe(304);
  expect(res.headers.get('Referrer-Policy')).toBe('strict-origin');
});

it('changes nothing else about what the assets answer with: status, body and every other header', async () => {
  // The one header the Worker sets itself; all the rest must be what the assets binding returned.
  const setByWorker = ['referrer-policy'];
  const otherHeaders = (res: Response) =>
    Object.fromEntries(Array.from(res.headers.entries()).filter(([name]) => !setByWorker.includes(name)));

  for (const path of ['/', '/strudel-ws-bridge.js']) {
    const direct = await env.ASSETS.fetch(new Request(BASE + path));
    const res = await exports.default.fetch(BASE + path);
    expect(res.status, path).toBe(direct.status);
    expect(otherHeaders(res), path).toEqual(otherHeaders(direct));
    expect(await res.text(), path).toBe(await direct.text());
  }
});

it('sends no CORS headers with its assets: only the ChatGPT widget loads them from another origin', async () => {
  for (const path of ['/', '/strudel-ws-bridge.js', '/some/page']) {
    const res = await exports.default.fetch(BASE + path);
    expect(res.status, path).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin'), path).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Methods'), path).toBeNull();
    await res.arrayBuffer();
  }
});

// --- JSON request bodies ---

it('returns 400 for an empty body and for a body that is not a JSON object', async () => {
  for (const body of ['', 'null', '[]', '"text"', '42']) {
    const res = await post('/api/validate', body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/JSON/) });
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*'); // an API error carries the CORS headers like any other API answer
  }
});

it('returns 413 for an oversized body', async () => {
  const res = await post('/api/validate', 'x'.repeat(200_000));
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: 'Request body too large' });
});

it('accepts a body of exactly 131,072 bytes and rejects one byte more', async () => {
  expect((await post('/api/generate/pattern', jsonBodyOf(131_072))).status).toBe(200);
  expect((await post('/api/generate/pattern', jsonBodyOf(131_073))).status).toBe(413);
});

it('counts the body in bytes, not characters', async () => {
  const body = JSON.stringify({ pad: '€'.repeat(43_700) }); // 43,710 characters, but 131,110 bytes
  expect((await post('/api/generate/pattern', body)).status).toBe(413);
});

it('applies the code limit to the pattern a client validates', async () => {
  const res = await post('/api/validate', JSON.stringify({ pattern: 'a'.repeat(65_537) }));
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: expect.stringMatching(/^pattern is too large/) });
  expect((await post('/api/validate', JSON.stringify({ pattern: 's("bd*4")' }))).status).toBe(200);
});

it('still answers a missing pattern with 400 pattern is required', async () => {
  const res = await post('/api/validate', '{}');
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'pattern is required' });
});

// --- readJsonBody ---

function requestWith(body: BodyInit | ReadableStream<Uint8Array>): Request {
  return new Request(`${BASE}/api/x`, { method: 'POST', body });
}

/** A stream of the given chunks, read lazily, and a record of what the reader did to it. */
function chunkStream(chunks: Uint8Array[]) {
  const seen = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.pulled++;
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

it('readBoundedText returns the text of a body within the limit and refuses more with 413', async () => {
  expect(await readBoundedText(requestWith('héllo'), 6)).toBe('héllo'); // 5 characters, 6 bytes
  await expect(readBoundedText(requestWith('héllo!'), 6)).rejects.toMatchObject({ status: 413, message: 'Request body too large' });
  expect(await readBoundedText(new Request(`${BASE}/api/x`))).toBe(''); // no body at all
});

it('readBoundedText reads a clone and leaves the original body for its next reader', async () => {
  const request = requestWith('{"a":1}');
  expect(await readBoundedText(request.clone())).toBe('{"a":1}');
  expect(await request.text()).toBe('{"a":1}');
});

it('readBoundedText stops at the limit on a clone too, and the original is still readable', async () => {
  const { stream, seen } = chunkStream(Array.from({ length: 100 }, () => new Uint8Array(16_384).fill(0x61)));
  const request = requestWith(stream);
  await expect(readBoundedText(request.clone())).rejects.toMatchObject({ status: 413 });
  expect(seen.pulled).toBeLessThan(20);
  const first = await request.body!.getReader().read();
  expect(first.value).toHaveLength(16_384);
});

it('readJsonBody parses the body', async () => {
  expect(await readJsonBody<{ a: number }>(requestWith('{"a":1}'))).toEqual({ a: 1 });
});

it('readJsonBody decodes a character that is split across two chunks', async () => {
  const bytes = new TextEncoder().encode('{"name":"€uro"}');
  const cut = bytes.indexOf(0xe2) + 1; // inside the 3 bytes of €
  const { stream } = chunkStream([bytes.slice(0, cut), bytes.slice(cut)]);
  expect(await readJsonBody(requestWith(stream))).toEqual({ name: '€uro' });
});

it('readJsonBody stops reading once the body passes the limit, and cancels it', async () => {
  // 100 chunks of 16,384 bytes: 1.6 MB, of which 131,072 bytes (8 chunks) are allowed.
  const { stream, seen } = chunkStream(Array.from({ length: 100 }, () => new Uint8Array(16_384).fill(0x61)));
  await expect(readJsonBody(requestWith(stream))).rejects.toMatchObject({ status: 413, message: 'Request body too large' });
  expect(seen.cancelled).toBe(true);
  expect(seen.pulled).toBeLessThan(20);
});

it('readJsonBody takes the limit as an argument', async () => {
  expect(await readJsonBody(requestWith('{"a":1}'), 7)).toEqual({ a: 1 });
  await expect(readJsonBody(requestWith('{"a":12}'), 7)).rejects.toMatchObject({ status: 413 });
});

// --- jsonError and withErrorHandling ---

it('jsonError answers with the status and an error field', async () => {
  const res = jsonError(418, 'short and stout');
  expect(res.status).toBe(418);
  expect(res.headers.get('Content-Type')).toContain('application/json');
  expect(await res.json()).toEqual({ error: 'short and stout' });
});

it('withErrorHandling hides internals and logs', async () => {
  const logs = captureLogs();
  const handler = withErrorHandling(async () => {
    throw new Error('boom');
  });
  const res = await handler(new Request(`${BASE}/boom?session=secret-name`), {}, createExecutionContext());
  expect(res.status).toBe(500);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ error: 'Internal error' });
  expect(text).not.toContain('boom');
  expect(logs.events()).toEqual([{ event: 'unhandled', path: '/boom', message: 'boom' }]); // the path only, not the query
});

it('withErrorHandling keeps the id of a player URL out of the log: the path is where a session id is now', async () => {
  const logs = captureLogs();
  const handler = withErrorHandling(async () => {
    throw new Error('boom');
  });
  const id = newSessionId();
  for (const path of [`/s/${id}`, `/s/${id}/`, '/s/not-an-id']) {
    await handler(new Request(`${BASE}${path}`), {}, createExecutionContext());
  }
  await handler(new Request(`${BASE}/api/health`), {}, createExecutionContext());
  expect(logs.events()).toEqual([
    { event: 'unhandled', path: '/s/:id', message: 'boom' },
    { event: 'unhandled', path: '/s/:id', message: 'boom' },
    { event: 'unhandled', path: '/s/:id', message: 'boom' },
    { event: 'unhandled', path: '/api/health', message: 'boom' },
  ]);
  expect(logs.lines().join('\n')).not.toContain(id);
});

it('withErrorHandling logs something that is not an Error too', async () => {
  const logs = captureLogs();
  const handler = withErrorHandling(async () => {
    throw 'just a string';
  });
  const res = await handler(new Request(`${BASE}/thrown`), {}, createExecutionContext());
  expect(res.status).toBe(500);
  expect(logs.events()).toEqual([{ event: 'unhandled', path: '/thrown', message: 'just a string' }]);
});

it('withErrorHandling logs at most 200 characters of the error message', async () => {
  const logs = captureLogs();
  for (const length of [5, 200, 201, 5_000]) {
    const handler = withErrorHandling(async () => {
      throw new Error('x'.repeat(length));
    });
    const res = await handler(new Request(`${BASE}/long`), {}, createExecutionContext());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal error' });
  }
  expect(logs.events().map((e) => (e.message as string).length)).toEqual([5, 200, 200, 200]);
  expect(logs.events()[3]).toEqual({ event: 'unhandled', path: '/long', message: 'x'.repeat(200) });
});

it('withErrorHandling turns an HttpError into its own status and message, without a log', async () => {
  const logs = captureLogs();
  const handler = withErrorHandling(async () => {
    throw new HttpError(418, 'short and stout');
  });
  const res = await handler(new Request(`${BASE}/teapot`), {}, createExecutionContext());
  expect(res.status).toBe(418);
  expect(await res.json()).toEqual({ error: 'short and stout' });
  expect(logs.lines()).toEqual([]);
});

it('withErrorHandling passes the handler its arguments and returns its response untouched', async () => {
  const request = new Request(`${BASE}/ok`);
  const ctx = createExecutionContext();
  const answer = new Response('fine', { status: 202 });
  const handler = withErrorHandling<{ id: number }>(async (req, e, c) => {
    expect(req).toBe(request);
    expect(e.id).toBe(7);
    expect(c).toBe(ctx);
    return answer;
  });
  expect(await handler(request, { id: 7 }, ctx)).toBe(answer);
});

it('wraps the Worker: a failing binding gives a JSON 500 and one log line', async () => {
  const logs = captureLogs();
  const broken = {
    SESSION_BRIDGE: env.SESSION_BRIDGE,
    APP_NAME: env.APP_NAME,
    ASSETS: { fetch: () => Promise.reject(new Error('assets are down')) },
  } as unknown as Env;
  const res = await worker.fetch(new Request(`${BASE}/some/page`), broken, createExecutionContext());
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: 'Internal error' });
  expect(logs.events()).toEqual([{ event: 'unhandled', path: '/some/page', message: 'assets are down' }]);
});
