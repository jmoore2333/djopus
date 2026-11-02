import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

// The entry of the app Worker (src/index.ts, wrangler.toml). The entry of the ChatGPT Worker is tested in
// test/chatgpt/entry.test.ts. The app has no D1 and no pattern routes: crate.test.ts pins that, next to the crate
// that took the place of the table. Its own MCP at /mcp is remote-mcp.test.ts.

const BASE = 'https://djopus.test';

it('the app does not serve the ChatGPT widget', async () => {
  // Past the entry these paths would reach the assets binding, which answers an unknown path with index.html and 200.
  for (const path of ['/widget', '/widget?session=abc', '/widget?session=opus-ab12']) {
    const res = await exports.default.fetch(BASE + path);
    expect(res.status, path).toBe(404);
    expect(await res.json(), path).toEqual({ error: 'Not found' });
  }
});

it('serves its own MCP at /mcp, and answers every path under it with a JSON 404', async () => {
  // A POST that is not an MCP request is McpAgent's to refuse: it is no longer the 404 of a path the app lacks.
  const plain = await exports.default.fetch(`${BASE}/mcp`, { method: 'POST' });
  expect(plain.status).toBe(406);
  await plain.arrayBuffer();

  for (const [method, path] of [['GET', '/mcp/anything'], ['POST', '/mcp/'], ['DELETE', '/mcp/x/y'], ['GET', '/mcp/message']]) {
    const res = await exports.default.fetch(BASE + path, { method });
    expect(res.status, `${method} ${path}`).toBe(404);
    expect(await res.json(), `${method} ${path}`).toEqual({ error: 'Not found' });
  }
});

it('answers every path under /.well-known/ with a JSON 404, not the single-page app', async () => {
  // An MCP client may probe OAuth metadata before it connects. The assets would answer such a path with index.html and
  // 200, which a client takes for metadata it cannot parse. This app has no OAuth, so there is none to serve.
  const paths = [
    '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp',
    '/.well-known/openid-configuration', '/.well-known/anything/deep/down', '/.well-known/',
  ];
  for (const path of paths) {
    const direct = await env.ASSETS.fetch(new Request(BASE + path));
    expect(direct.headers.get('content-type'), `${path} from the assets alone`).toMatch(/text\/html/); // what the fix is for
    for (const method of ['GET', 'POST']) {
      const res = await exports.default.fetch(BASE + path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.headers.get('content-type'), `${method} ${path}`).toMatch(/application\/json/);
      expect(await res.json(), `${method} ${path}`).toEqual({ error: 'Not found' });
    }
  }
});

it('leaves a path that only starts with /mcp to the assets: wrangler.toml sends this Worker /mcp and /mcp/*, no more', async () => {
  // In production the asset router answers /mcpx or /mcp.json itself: it is a page of the single-page app, like any path
  // run_worker_first does not name, and this Worker never sees it. The pool calls the Worker for every path, so what
  // shows here is that the entry does not answer such a path with a 404 of its own that the config does not route to it.
  for (const path of ['/mcpx', '/mcp.json', '/mcp-docs']) {
    const direct = await env.ASSETS.fetch(new Request(BASE + path));
    expect(direct.status, `${path} from the assets`).toBe(200);
    const res = await exports.default.fetch(BASE + path);
    expect(res.status, path).toBe(200);
    expect(await res.text(), path).toBe(await direct.text());
  }
});
