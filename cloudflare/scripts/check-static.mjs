// A deploy uploads ./static as the Worker's assets (the [assets] table in both wrangler
// configs), and that directory is gitignored: it holds the built Strudel REPL. This refuses
// a directory that would put a broken site online. `npm run deploy` and `npm run deploy:chatgpt`
// run it first, after `npm run sync:static` (the predeploy hooks in package.json).
//
// It exits 1, and says why, when:
//   - .djopus-stub exists. scripts/ensure-static.mjs writes that marker along with a stub page
//     on a checkout without a build, so that the tests can run.
//   - index.html is missing, has no /_astro/ (the bundles of the Strudel site build), or does
//     not load strudel-ws-bridge.js (the REPL would never connect to the Worker).
//   - sw.js is missing, or lacks the navigation denylist that patches/strudel/0002-pwa-navigation-denylist.patch
//     adds: without it the service worker answers a navigation to /api, /ws, /mcp or /widget with the cached
//     REPL page, not with what the Worker says.
//   - strudel-ws-bridge.js or _headers is missing, or differs from its source in client/ (npm run sync:static
//     and npm run build:strudel both copy the two), or _headers lacks the rule that gives every asset its
//     Referrer-Policy. The app serves assets without running its Worker, so that file is all that sets it.
//   - djopus-build.json is missing. npm run build:strudel writes it as its last step, so a static/ without it was
//     not made by that script, or the script stopped before its end.
//
//   node scripts/check-static.mjs [dir [clientDir]]
//     dir defaults to ../static and clientDir to ../client; the tests point both at fixtures
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ? resolve(process.argv[2]) : join(here, '..', 'static');
const clientDir = process.argv[3] ? resolve(process.argv[3]) : join(here, '..', 'client');
const shown = relative(process.cwd(), dir) || '.';

/** The rule of patches/strudel/0002-pwa-navigation-denylist.patch, as it appears in the denylist of sw.js. */
const DENYLIST_RULE = String.raw`/^\/(api|ws|mcp|widget)/`;

/** The text of a file, or null when it cannot be read. */
function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The bytes of a file, or null when it cannot be read. */
function readBytes(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether the PWA plugin wrote a navigation denylist into the service worker that holds DENYLIST_RULE. */
function hasNavigationDenylist(sw) {
  return [...sw.matchAll(/denylist\s*:\s*\[([^\]]*)\]/g)].some((list) => list[1].includes(DENYLIST_RULE));
}

/** Whether a _headers file sets `Referrer-Policy: strict-origin` in the block of its /* rule, the one for every path. */
function setsReferrerPolicy(headers) {
  let path = null;
  for (const line of headers.split('\n')) {
    if (line.startsWith('#')) continue;
    // A path starts in the first column and its headers are indented under it. \s* also takes the CR of a CRLF line end.
    // Header names are case-insensitive (and so is the policy token), so the flag.
    if (/^\S/.test(line)) path = line.trim();
    else if (path === '/*' && /^\s+Referrer-Policy\s*:\s*strict-origin\s*$/i.test(line)) return true;
  }
  return false;
}

const problems = [];

/** A file that npm run sync:static copies from client/ into static/: it has to be there, and equal its source byte for byte. */
function checkCopy(name, purpose) {
  const source = readBytes(join(clientDir, name));
  const copy = readBytes(join(dir, name));
  if (source === null) {
    problems.push(`client/${name} cannot be read, so ${name} cannot be checked against it`);
  } else if (copy === null) {
    problems.push(`${name} is missing (${purpose}; npm run sync:static copies it from client/)`);
  } else if (!copy.equals(source)) {
    problems.push(`${name} differs from client/${name} (npm run sync:static copies it again)`);
  }
}

if (existsSync(join(dir, '.djopus-stub'))) {
  problems.push(
    '.djopus-stub exists: this is the test stub that scripts/ensure-static.mjs writes on a checkout without a build, ' +
      'not a Strudel build (delete the file once a real build is in place)',
  );
}

const index = readText(join(dir, 'index.html'));
if (index === null) {
  problems.push('index.html is missing or cannot be read');
} else {
  if (!index.includes('/_astro/')) {
    problems.push('index.html has no /_astro/ in it, so it is not the page of a Strudel site build');
  }
  if (!index.includes('strudel-ws-bridge.js')) {
    problems.push('index.html does not load strudel-ws-bridge.js, so the REPL would never connect to the Worker');
  }
}

const sw = readText(join(dir, 'sw.js'));
if (sw === null) {
  problems.push('sw.js is missing (the page registers it as its service worker)');
} else if (!hasNavigationDenylist(sw)) {
  problems.push(
    `sw.js lacks the navigation denylist ${DENYLIST_RULE} (patches/strudel/0002-pwa-navigation-denylist.patch adds it): ` +
      'the service worker would answer a navigation to /api, /ws, /mcp or /widget with the cached page',
  );
}

checkCopy('strudel-ws-bridge.js', 'the REPL page loads it');
checkCopy('_headers', 'it gives every asset its Referrer-Policy');
const headers = readText(join(dir, '_headers'));
if (headers !== null && !setsReferrerPolicy(headers)) {
  problems.push(
    '_headers has no "Referrer-Policy: strict-origin" rule for /*, so the assets would go out without that policy',
  );
}

if (!isFile(join(dir, 'djopus-build.json'))) {
  problems.push('djopus-build.json is missing (npm run build:strudel writes it as its last step)');
}

if (problems.length > 0) {
  console.error(`check-static: refusing to deploy, ${shown} is not a complete Strudel build:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    `Run npm run build:strudel to build ${shown} from the pinned Strudel commit and the patches ` +
      '(npm run sync:static alone refreshes the two files copied from client/), then deploy again.',
  );
  process.exitCode = 1;
} else {
  console.log(`check-static: ok, ${shown} holds a Strudel build`);
}
