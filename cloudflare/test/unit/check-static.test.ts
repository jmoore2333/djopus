import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

// scripts/check-static.mjs is the guard in front of `npm run deploy` and `npm run deploy:chatgpt`.
// These tests run it as the hooks do, against throwaway directories, so the real static/ (a
// gitignored build) is never read or touched, and the tests pass on a checkout that has none.
const repoPath = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const scriptPath = (name: string) => repoPath(`scripts/${name}`);
const checkStatic = scriptPath('check-static.mjs');

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-static-'));
  made.push(dir);
  return dir;
}

const INDEX = '<!doctype html><script src="/_astro/page.js"></script><script src="/strudel-ws-bridge.js"></script>';
// The two files that client/ holds and `npm run sync:static` copies into static/.
const BRIDGE = '// the bridge, as client/strudel-ws-bridge.js has it\n';
const HEADERS = '/*\n  Referrer-Policy: strict-origin\n';
// The route of the navigation fallback as the PWA plugin writes it into sw.js once
// patches/strudel/0002-pwa-navigation-denylist.patch is applied.
const SW = String.raw`e.registerRoute(new e.NavigationRoute(e.createHandlerBoundToURL("/"),{denylist:[/^\/(api|ws|mcp|widget)/]}))`;
const BUILD_INFO = '{"strudelCommit":"9f19e46","patches":[],"builtAt":"2026-11-01T00:00:00.000Z"}';

/** Makes `dir` hold `files`; a file whose content is null is left out. */
function writeFiles(dir: string, files: Record<string, string | null>): void {
  mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) {
    if (content !== null) writeFileSync(join(dir, name), content);
  }
}

/**
 * A scratch tree laid out as the repo is: static/ holds a build that passes, and client/ the files that static/ copies.
 * `changes` replaces a file of static/ with other content, or removes it when null; `client` does the same in client/.
 * Returns the root of the tree.
 */
function fixture(changes: Record<string, string | null> = {}, client: Record<string, string | null> = {}): string {
  const root = tempDir();
  writeFiles(join(root, 'static'), {
    'index.html': INDEX,
    'sw.js': SW,
    'strudel-ws-bridge.js': BRIDGE,
    _headers: HEADERS,
    'djopus-build.json': BUILD_INFO,
    ...changes,
  });
  writeFiles(join(root, 'client'), { 'strudel-ws-bridge.js': BRIDGE, _headers: HEADERS, ...client });
  return root;
}

function run(script: string, ...args: string[]) {
  return spawnSync(execPath, [script, ...args], { encoding: 'utf8' });
}

/** The script against the static/ and client/ of a scratch tree. */
function check(root: string) {
  return run(checkStatic, join(root, 'static'), join(root, 'client'));
}

/** The reasons a refusal gives: the lines of its report that start with "  - ". */
function reasons(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.startsWith('  - ')).map((line) => line.slice(4));
}

it('passes a directory that holds a Strudel build', () => {
  const result = check(fixture());
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
});

it('refuses a directory with the stub marker, even when everything else is in place', () => {
  const result = check(fixture({ '.djopus-stub': '' }));
  expect(result.status).toBe(1);
  expect(reasons(result.stderr)).toEqual([expect.stringContaining('.djopus-stub exists')]);
});

it('refuses a directory without index.html', () => {
  const result = check(fixture({ 'index.html': null }));
  expect(result.status).toBe(1);
  expect(reasons(result.stderr)).toEqual([expect.stringContaining('index.html is missing')]);
});

it('refuses an index.html that has no /_astro/ in it', () => {
  const result = check(fixture({ 'index.html': '<script src="/strudel-ws-bridge.js"></script>' }));
  expect(result.status).toBe(1);
  expect(reasons(result.stderr)).toEqual([expect.stringContaining('/_astro/')]);
});

it('refuses an index.html that does not load strudel-ws-bridge.js', () => {
  const result = check(fixture({ 'index.html': '<script src="/_astro/page.js"></script>' }));
  expect(result.status).toBe(1);
  expect(reasons(result.stderr)).toEqual([expect.stringContaining('strudel-ws-bridge.js')]);
});

it('refuses a directory without sw.js', () => {
  const result = check(fixture({ 'sw.js': null }));
  expect(result.status).toBe(1);
  expect(reasons(result.stderr)).toEqual([expect.stringContaining('sw.js is missing')]);
});

it('refuses an sw.js without the navigation denylist: it would answer /api, /ws, /mcp and /widget with the cached page', () => {
  const withoutDenylist = 'e.registerRoute(new e.NavigationRoute(e.createHandlerBoundToURL("/")))';
  const result = check(fixture({ 'sw.js': withoutDenylist }));
  expect(result.status).toBe(1);
  expect(reasons(result.stderr)).toEqual([expect.stringContaining('navigation denylist')]);
});

it('refuses an sw.js whose denylist leaves out one of the Worker paths, or holds something else', () => {
  const lists = [
    String.raw`{denylist:[/^\/(api|ws|mcp)/]}`,
    String.raw`{denylist:[/^\/(api|ws|widget)/]}`,
    String.raw`{denylist:[/^\/(api|mcp|widget)/]}`,
    String.raw`{denylist:[/^\/(ws|mcp|widget)/]}`,
    String.raw`{denylist:[/^\/other/]}`,
    // The rule is there, but not as the denylist: the allowlist only narrows the pages the fallback answers.
    String.raw`{allowlist:[/^\/(api|ws|mcp|widget)/],denylist:[]}`,
  ];
  for (const list of lists) {
    const result = check(fixture({ 'sw.js': `e.registerRoute(new e.NavigationRoute(e.createHandlerBoundToURL("/"),${list}))` }));
    expect(result.status, list).toBe(1);
    expect(reasons(result.stderr), list).toEqual([expect.stringContaining('navigation denylist')]);
  }
});

it('looks for the rule that patches/strudel/0002-pwa-navigation-denylist.patch adds to the build', () => {
  const patch = readFileSync(repoPath('patches/strudel/0002-pwa-navigation-denylist.patch'), 'utf8');
  const added = /^\+\s*navigateFallbackDenylist:\s*\[(.*)\],?\s*$/m.exec(patch);
  expect(added, 'the patch adds a navigateFallbackDenylist: [...] line').not.toBeNull();

  // The PWA plugin writes the regexes of the patch into sw.js as they are.
  const sw = `e.registerRoute(new e.NavigationRoute(e.createHandlerBoundToURL("/"),{denylist:[${added?.[1]}]}))`;
  const result = check(fixture({ 'sw.js': sw }));
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});

it('refuses a directory without strudel-ws-bridge.js, though index.html loads it', () => {
  const result = check(fixture({ 'strudel-ws-bridge.js': null }));
  expect(result.status).toBe(1);
  expect(reasons(result.stderr)).toEqual([expect.stringContaining('strudel-ws-bridge.js is missing')]);
});

it('refuses a strudel-ws-bridge.js that differs from client/strudel-ws-bridge.js by a single byte', () => {
  const result = check(fixture({ 'strudel-ws-bridge.js': BRIDGE.slice(0, -1) }));
  expect(result.status).toBe(1);
  expect(reasons(result.stderr)).toEqual([expect.stringContaining('strudel-ws-bridge.js differs from client/strudel-ws-bridge.js')]);
});

it('refuses a directory without _headers: nothing else gives the assets their Referrer-Policy', () => {
  const result = check(fixture({ _headers: null }));
  expect(result.status).toBe(1);
  expect(reasons(result.stderr)).toEqual([expect.stringContaining('_headers is missing')]);
});

it('refuses a _headers that differs from client/_headers', () => {
  const result = check(fixture({ _headers: `${HEADERS}  X-Content-Type-Options: nosniff\n` }));
  expect(result.status).toBe(1);
  expect(reasons(result.stderr)).toEqual([expect.stringContaining('_headers differs from client/_headers')]);
});

it('refuses a _headers without the rule "Referrer-Policy: strict-origin" for every path, even one that matches client/_headers', () => {
  const wrong: Record<string, string> = {
    'an empty file': '',
    'other headers only': '/*\n  X-Content-Type-Options: nosniff\n',
    'the rule in a comment': '# Referrer-Policy: strict-origin\n/*\n  X-Content-Type-Options: nosniff\n',
    'another policy': '/*\n  Referrer-Policy: no-referrer\n',
    'a policy that only starts like it': '/*\n  Referrer-Policy: strict-origin-when-cross-origin\n',
    'the rule for one path only': '/s/*\n  Referrer-Policy: strict-origin\n',
    'the rule under the next path': '/*\n  X-Content-Type-Options: nosniff\n/other\n  Referrer-Policy: strict-origin\n',
  };
  for (const [what, headers] of Object.entries(wrong)) {
    const result = check(fixture({ _headers: headers }, { _headers: headers }));
    expect(result.status, what).toBe(1);
    expect(reasons(result.stderr), what).toEqual([expect.stringContaining('Referrer-Policy: strict-origin')]);
  }
});

it('accepts a _headers that holds more than the rule: comments, other headers, other paths, CRLF line ends', () => {
  const more =
    '# the assets\n/*\n# every response\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin\n\n/other\n  Cache-Control: no-store\n';
  for (const headers of [more, more.replace(/\n/g, '\r\n')]) {
    const result = check(fixture({ _headers: headers }, { _headers: headers }));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  }
});

it('accepts the rule whatever the case of the header name, which HTTP does not tell apart', () => {
  for (const name of ['referrer-policy', 'REFERRER-POLICY', 'Referrer-policy']) {
    const headers = `/*\n  ${name}: strict-origin\n`;
    const result = check(fixture({ _headers: headers }, { _headers: headers }));
    expect(result.status, name).toBe(0);
    expect(result.stderr, name).toBe('');
  }
});

it("accepts the repo's own client/_headers as the source of _headers: it holds the rule", () => {
  const root = fixture();
  copyFileSync(repoPath('client/_headers'), join(root, 'client', '_headers'));
  copyFileSync(repoPath('client/_headers'), join(root, 'static', '_headers'));
  const result = check(root);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
});

it('refuses a directory without djopus-build.json: npm run build:strudel writes it as its last step', () => {
  const result = check(fixture({ 'djopus-build.json': null }));
  expect(result.status).toBe(1);
  expect(reasons(result.stderr)).toEqual([expect.stringContaining('djopus-build.json is missing')]);
});

it('refuses, and says so, when client/ lacks the file a copy is checked against', () => {
  for (const name of ['strudel-ws-bridge.js', '_headers']) {
    const result = check(fixture({}, { [name]: null }));
    expect(result.status, name).toBe(1);
    expect(reasons(result.stderr), name).toEqual([expect.stringContaining(`client/${name} cannot be read`)]);
  }
});

it('refuses a directory that does not exist, and says what is missing from it', () => {
  const root = fixture();
  const result = run(checkStatic, join(root, 'no-such-directory'), join(root, 'client'));
  expect(result.status).toBe(1);
  expect(reasons(result.stderr)).toEqual([
    expect.stringContaining('index.html is missing'),
    expect.stringContaining('sw.js is missing'),
    expect.stringContaining('strudel-ws-bridge.js is missing'),
    expect.stringContaining('_headers is missing'),
    expect.stringContaining('djopus-build.json is missing'),
  ]);
});

it('checks the static/ and client/ next to its own scripts/ when it is given no directory, as the predeploy hooks run it', () => {
  // The script finds both from its own location. A copy of it in a scratch tree lets it check that tree.
  const root = fixture();
  mkdirSync(join(root, 'scripts'));
  const script = join(root, 'scripts', 'check-static.mjs');
  copyFileSync(checkStatic, script);
  expect(run(script).status).toBe(0);

  // client/ moves on and static/ is not synced: the stale copy is refused.
  writeFileSync(join(root, 'client', 'strudel-ws-bridge.js'), `${BRIDGE}// a newer bridge\n`);
  const stale = run(script);
  expect(stale.status).toBe(1);
  expect(reasons(stale.stderr)).toEqual([expect.stringContaining('strudel-ws-bridge.js differs from client/strudel-ws-bridge.js')]);
});

it('refuses the stub that scripts/ensure-static.mjs writes on a checkout without a build, and gives every reason', () => {
  // ensure-static.mjs writes to ../static, next to its own scripts/ directory. A copy of it
  // in a scratch tree lets it write there, not into the real static/.
  const root = tempDir();
  mkdirSync(join(root, 'scripts'));
  copyFileSync(scriptPath('ensure-static.mjs'), join(root, 'scripts', 'ensure-static.mjs'));
  expect(run(join(root, 'scripts', 'ensure-static.mjs')).status).toBe(0);
  writeFiles(join(root, 'client'), { 'strudel-ws-bridge.js': BRIDGE, _headers: HEADERS });

  const result = check(root);
  expect(result.status).toBe(1);
  expect(reasons(result.stderr)).toEqual([
    expect.stringContaining('.djopus-stub exists'),
    expect.stringContaining('/_astro/'),
    expect.stringContaining('sw.js is missing'),
    expect.stringContaining('strudel-ws-bridge.js is missing'),
    expect.stringContaining('_headers is missing'),
    expect.stringContaining('djopus-build.json is missing'),
  ]);
});
