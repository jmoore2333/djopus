import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unstable_readConfig } from 'wrangler';
import { expect, it } from 'vitest';

// The vitest pool answers requests by calling the Worker's fetch directly: it never goes through Cloudflare's asset
// router, so no workerd test can tell which paths the router sends to the Worker. These tests read the configs the way
// wrangler does and apply the router's rule to them instead.
const readConfig = (file: string) => unstable_readConfig({ config: fileURLToPath(new URL(`../../${file}`, import.meta.url)) });

/**
 * Whether the asset router runs the Worker before the assets for `path`, by the router's own rule (miniflare's router
 * worker, generateStaticRoutingRuleMatcher). A pattern is a glob over the whole path: `*` matches any run of characters
 * and nothing else is special. A pattern that starts with `!` is a negative one, and a path that matches any of them goes
 * to the assets, whatever the other patterns say.
 */
function runsWorkerFirst(patterns: string[], path: string): boolean {
  const matches = (glob: string) =>
    new RegExp(`^${glob.split('*').map((part) => part.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('.*')}$`).test(path);
  if (patterns.some((pattern) => pattern.startsWith('!') && matches(pattern.slice(1)))) return false;
  return patterns.some((pattern) => !pattern.startsWith('!') && matches(pattern));
}

it('the app Worker runs first for every path it answers itself, and for no page', () => {
  const runWorkerFirst = readConfig('wrangler.toml').assets?.run_worker_first;
  if (!Array.isArray(runWorkerFirst)) throw new Error(`run_worker_first has to be a list of paths, got ${JSON.stringify(runWorkerFirst)}`);

  // src/index.ts answers these itself: the API, the browser socket, the generic MCP, and a 404 for /mcp/<anything>, for
  // /widget and for everything under /.well-known/. Left out of the list, those would reach the assets, which answer a
  // path they do not have with the single-page app: index.html with a 200. For /.well-known/ that is what an MCP client
  // that probes OAuth metadata (oauth-protected-resource, oauth-authorization-server) up front would get, and fail on.
  for (const path of [
    '/api/health', '/api/generate/pattern', '/ws', '/mcp', '/mcp/anything', '/widget',
    '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/.well-known/a/b/c',
  ]) {
    expect(runsWorkerFirst(runWorkerFirst, path), `${path} reaches the Worker first`).toBe(true);
  }

  // Pages and files come from the assets alone: no Worker invocation, so no request log or trace carries the id of
  // /s/<id>, and static/_headers is what gives them their Referrer-Policy. So does a path that only starts like one of the
  // above: the list names /mcp and /mcp/*, not /mcp*, and /.well-known/*, not /.well-known*, and the entry answers no more than the list sends it.
  for (const path of ['/', '/s/abcdefghijklmnopqrstuvwxyz', '/sw.js', '/strudel-ws-bridge.js', '/some/page', '/mcpx', '/mcp.json', '/.well-known', '/.well-knownx']) {
    expect(runsWorkerFirst(runWorkerFirst, path), `${path} is served by the assets alone`).toBe(false);
  }
});

it('applies the router rule to the list: a path that matches a negative pattern goes to the assets whatever the others say', () => {
  const list = ['/api/*', '/widget', '!/api/docs/*', '!/widget'];
  expect(runsWorkerFirst(list, '/api/health')).toBe(true);
  expect(runsWorkerFirst(list, '/api/docs/intro')).toBe(false);
  expect(runsWorkerFirst(list, '/widget')).toBe(false);
  expect(runsWorkerFirst(list, '/some/page')).toBe(false);
  // The pattern is a glob over the whole path: * is the only wildcard, and nothing else in it is special.
  expect(runsWorkerFirst(['/a.b', '/m*x'], '/a.b')).toBe(true);
  expect(runsWorkerFirst(['/a.b', '/m*x'], '/aXb')).toBe(false);
  expect(runsWorkerFirst(['/a.b', '/m*x'], '/mcpx')).toBe(true);
  expect(runsWorkerFirst(['/a.b', '/m*x'], '/mcpxy')).toBe(false);
});

// wrangler.chatgpt.toml is not in a release without the ChatGPT Worker (scripts/publish.sh), so this one skips there.
const hasChatgptConfig = existsSync(fileURLToPath(new URL('../../wrangler.chatgpt.toml', import.meta.url)));

it.skipIf(!hasChatgptConfig)('the ChatGPT Worker runs first for every request: its assets need the Worker to add CORS headers, and the widget is its own page', () => {
  expect(readConfig('wrangler.chatgpt.toml').assets?.run_worker_first).toBe(true);
});
