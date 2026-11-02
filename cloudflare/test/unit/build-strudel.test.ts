import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env as processEnv, version as nodeVersion } from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

// scripts/build-strudel.sh keeps a clone of Strudel in .strudel-build/ and runs `git checkout --force`, `git reset --hard` and
// `git clean -fdx` there. These tests run a copy of it in a scratch tree, offline, and check that those commands reach that
// clone and nothing else: not a repository that git is pointed at through the environment, not what a symbolic link points at,
// not the repository that .strudel-build/ happens to sit in. Each of those keeps its HEAD, its index and its work tree.
//
// The scratch tree holds the real script and the real patches, except for two lines of the copy. The commit it builds is a
// commit of the repository the test wants to see damaged, so that a git command that reaches that repository shows (the pin
// check passes there, and the checkout and the reset follow). And the upstream URL points nowhere, so a build that went wrong
// could not reach the network. A fake npx stands in for pnpm: it answers --version, records the spec it was called with, and
// emulates the install and the build (a minimal website/dist). Most tests end at a check, before the install, and get a fake
// rsync that fails if it is ever run; the tests that go through to the end use the real rsync.
const repoPath = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'build-strudel-'));
  made.push(dir);
  return dir;
}

// What git reads from its environment to find a repository. A git hook exports them, so a test run from a hook would inherit
// them: the setup here clears them, and the one test that wants them sets them for the script alone.
const GIT_REPOSITORY_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
];

/** This process's environment without those variables, and with git cut off from the user's own configuration. */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env = { ...processEnv };
  for (const name of GIT_REPOSITORY_VARIABLES) delete env[name];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    ...extra,
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout;
}

/** A repository at `dir` with one commit per entry of `commits` (a map of file name to content). Returns the commit ids, oldest first. */
function makeRepo(dir: string, commits: Array<Record<string, string>>): string[] {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  return commits.map((files) => {
    for (const [name, content] of Object.entries(files)) {
      const slash = name.lastIndexOf('/');
      if (slash > 0) mkdirSync(join(dir, name.slice(0, slash)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'commit');
    return git(dir, 'rev-parse', 'HEAD').trim();
  });
}

/** A repository with two commits, and work on top of the second that a reset --hard or a clean -fdx would lose. Returns the first. */
function dirtyRepo(dir: string): string {
  const [first] = makeRepo(dir, [{ 'important.txt': 'one\n' }, { 'important.txt': 'two\n' }]);
  writeFileSync(join(dir, 'staged.txt'), 'staged work\n');
  git(dir, 'add', 'staged.txt');
  writeFileSync(join(dir, 'important.txt'), 'unstaged edit\n');
  writeFileSync(join(dir, 'notes.txt'), 'untracked notes\n');
  return first;
}

/** Everything a checkout, a reset and a clean would change in a repository: where HEAD is, the index, the work tree. */
function fingerprint(dir: string): string {
  const files = ['important.txt', 'staged.txt', 'notes.txt'].map((name) =>
    existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : `(no ${name})\n`,
  );
  return [
    git(dir, 'rev-parse', 'HEAD'),
    git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git(dir, 'ls-files', '-s'),
    git(dir, 'status', '--porcelain=v1', '--untracked-files=all'),
    git(dir, 'diff'),
    git(dir, 'diff', '--cached'),
    ...files,
  ].join('\n--\n');
}

/** What `rsync --version` does here: the tests that go through to the end need the real one, and are skipped without it. */
const HAS_RSYNC = spawnSync('rsync', ['--version'], { encoding: 'utf8' }).status === 0;

/**
 * A tool directory for the front of PATH: an npx that stands in for pnpm, and (unless `realRsync`) an rsync that must not run.
 * The fake pnpm writes the spec it was called with to $FAKE_NPX_LOG, answers --version, makes a node_modules for `install`, and
 * for `run build` writes a small website/dist, with a _headers and a bridge of its own that the build must not let through.
 */
function fakeBin(root: string, realRsync: boolean): string {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const tools: Record<string, string[]> = {
    npx: [
      '[ "$1" = "--yes" ] && shift',
      'case "$1" in pnpm@*) [ -z "${FAKE_NPX_LOG:-}" ] || echo "$1" >> "$FAKE_NPX_LOG"; shift ;;',
      '  *) echo "fake npx: unexpected $*" >&2; exit 2 ;; esac',
      'case "$1" in',
      '  --version) [ -z "${FAKE_PNPM_FAILS:-}" ] || { echo "fake pnpm: cannot run" >&2; exit 1; }; echo 10.0.0-fake ;;',
      '  install) mkdir -p node_modules ;;',
      '  run) [ "$2" = build ] || exit 2',
      '    mkdir -p website/dist/_astro website/dist/sub',
      '    echo js > website/dist/_astro/page.js',
      '    echo nested > website/dist/sub/page.html',
      '    echo sw > website/dist/sw.js',
      '    printf \'<!doctype html><script src="/_astro/page.js"></script>\\n\' > website/dist/index.html',
      '    printf \'/*\\n  X-From-Upstream: yes\\n\' > website/dist/_headers',
      '    echo upstream-bridge > website/dist/strudel-ws-bridge.js ;;',
      '  *) echo "fake pnpm: unexpected $*" >&2; exit 2 ;;',
      'esac',
    ],
  };
  if (!realRsync) tools.rsync = ['echo "fake rsync: the build went on past its checks" >&2', 'exit 2'];
  for (const [name, lines] of Object.entries(tools)) {
    writeFileSync(join(bin, name), ['#!/bin/sh', ...lines, ''].join('\n'));
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

interface Tree {
  root: string;
  cloudflare: string;
  /** Where the script keeps its clone. Nothing is there until a test puts something there. */
  build: string;
  bin: string;
}

/**
 * The scratch tree: cloudflare/ with the script (told to build `pin`, from `options.upstream` if there is one), the real patches,
 * a client/, and a static/ with an earlier build, tracked-looking _headers and bridge included.
 */
function install(root: string, pin: string, options: { upstream?: string; realRsync?: boolean } = {}): Tree {
  const cloudflare = join(root, 'cloudflare');
  for (const dir of ['scripts', 'patches/strudel', 'client', 'static']) mkdirSync(join(cloudflare, dir), { recursive: true });

  const real = readFileSync(repoPath('scripts/build-strudel.sh'), 'utf8');
  const url = `file://${options.upstream ?? `${root}/no-such-upstream.git`}`;
  const script = real
    .replace(/^STRUDEL_COMMIT=".*"$/m, `STRUDEL_COMMIT="${pin}"`)
    .replace(/^STRUDEL_URL=".*"$/m, `STRUDEL_URL="${url}"`);
  // If the script changes in a way these patterns miss, a test must not go on to build the real commit from the real URL.
  expect(script).toContain(`STRUDEL_COMMIT="${pin}"`);
  expect(script).toContain(`STRUDEL_URL="${url}"`);
  writeFileSync(join(cloudflare, 'scripts', 'build-strudel.sh'), script);

  for (const name of readdirSync(repoPath('patches/strudel'))) {
    copyFileSync(repoPath(`patches/strudel/${name}`), join(cloudflare, 'patches', 'strudel', name));
  }
  writeFileSync(join(cloudflare, 'client', 'strudel-ws-bridge.js'), '// the bridge\n');
  writeFileSync(join(cloudflare, 'client', '_headers'), '/*\n  Referrer-Policy: strict-origin\n');
  writeFileSync(join(cloudflare, 'static', 'index.html'), 'the earlier build\n');
  writeFileSync(join(cloudflare, 'static', 'old-page.html'), 'a page the new build would not have\n');
  writeFileSync(join(cloudflare, 'static', '_headers'), 'the tracked _headers\n');
  writeFileSync(join(cloudflare, 'static', 'strudel-ws-bridge.js'), '// the tracked bridge\n');

  return { root, cloudflare, build: join(cloudflare, '.strudel-build'), bin: fakeBin(root, options.realRsync ?? false) };
}

/** Puts a clone of a small repository, which has no commit the script wants, where the script keeps its clone. */
function cloneOfAnotherRepo(tree: Tree): void {
  makeRepo(join(tree.root, 'upstream'), [{ 'README.md': 'another repository\n' }]);
  git(tree.root, 'clone', '-q', join(tree.root, 'upstream'), tree.build);
}

/** Runs the copy of the script the way `npm run build:strudel` does (a relative path, from cloudflare/). */
function build(tree: Tree, env: Record<string, string> = {}, script = 'scripts/build-strudel.sh') {
  return spawnSync('bash', [script], {
    cwd: tree.cloudflare,
    encoding: 'utf8',
    env: cleanEnv({ PATH: `${tree.bin}:${processEnv.PATH ?? ''}`, ...env }),
  });
}

function expectEarlierBuildKept(tree: Tree): void {
  expect(readFileSync(join(tree.cloudflare, 'static', 'old-page.html'), 'utf8')).toBe('a page the new build would not have\n');
}

it('runs its git commands in .strudel-build when the environment points git at another repository, as a git hook does', () => {
  const root = tempDir();
  const canary = join(root, 'canary');
  const pin = dirtyRepo(canary);
  const tree = install(root, pin);
  cloneOfAnotherRepo(tree);
  const before = fingerprint(canary);

  // GIT_DIR and GIT_INDEX_FILE are what git exports to the hooks of a linked worktree. If they reached the script's git commands, the
  // pin check would pass in the canary, which has the commit, and the checkout and reset would follow there.
  const result = build(tree, { GIT_DIR: join(canary, '.git'), GIT_INDEX_FILE: join(canary, '.git', 'index') });

  // The pin is not in .strudel-build, whose upstream lacks it, so the build stops at the pin check.
  expect(result.stderr).toContain('is not in');
  expect(result.status).toBe(1);
  expect(fingerprint(canary)).toBe(before);
  expectEarlierBuildKept(tree);
});

it('refuses a .strudel-build that is a symbolic link, and leaves what it points to alone', () => {
  const root = tempDir();
  const target = join(root, 'elsewhere');
  const pin = dirtyRepo(target);
  const tree = install(root, pin);
  symlinkSync(target, tree.build);
  const before = fingerprint(target);

  const result = build(tree);

  expect(result.stderr).toContain('is a symbolic link');
  expect(result.status).toBe(1);
  expect(fingerprint(target)).toBe(before);
  expectEarlierBuildKept(tree);
});

it('refuses a .strudel-build that is a file', () => {
  const tree = install(tempDir(), 'a'.repeat(40));
  writeFileSync(tree.build, 'not a directory\n');

  const result = build(tree);

  expect(result.stderr).toContain('is not a git clone');
  expect(result.status).toBe(1);
  expect(readFileSync(tree.build, 'utf8')).toBe('not a directory\n');
  expectEarlierBuildKept(tree);
});

it('refuses a .strudel-build that has no repository of its own, and leaves the repository around it alone', () => {
  // The scratch tree sits in a repository, as the real one does: git run in an empty .strudel-build would land there.
  const root = tempDir();
  const pin = dirtyRepo(root);
  const tree = install(root, pin);
  mkdirSync(tree.build);
  const before = fingerprint(root);

  const result = build(tree);

  expect(result.stderr).toContain('is not a git clone');
  expect(result.status).toBe(1);
  expect(fingerprint(root)).toBe(before);
  expectEarlierBuildKept(tree);
});

it('finds its own directory when CDPATH is set, though cd then prints the directory it goes to', () => {
  const tree = install(tempDir(), 'a'.repeat(40));
  cloneOfAnotherRepo(tree);
  // `cd scripts/..` searches CDPATH for scripts/ before it looks in the current directory, and prints where it ended up.
  mkdirSync(join(tree.root, 'cdpath', 'scripts'), { recursive: true });

  const result = build(tree, { CDPATH: join(tree.root, 'cdpath') });

  // It found the patches and the clone of the scratch tree and stopped at the pin check, as it does without CDPATH.
  expect(result.stderr).toContain('is not in');
  expect(result.status).toBe(1);
});

it('stops before it clones anything when pnpm cannot run', () => {
  const tree = install(tempDir(), 'a'.repeat(40));

  const result = build(tree, { FAKE_PNPM_FAILS: '1' });

  expect(result.stderr).toContain('could not run');
  expect(result.status).toBe(1);
  expect(existsSync(tree.build)).toBe(false);
  expectEarlierBuildKept(tree);
});

it('runs its git commands on .strudel-build own index when only GIT_INDEX_FILE is exported, as a pre-commit hook does', () => {
  // A pre-commit hook in an ordinary checkout gets GIT_INDEX_FILE and no GIT_DIR. The clone has the pinned commit, so a
  // checkout that used the canary's index would go ahead and rewrite it.
  const root = tempDir();
  const canary = join(root, 'canary');
  dirtyRepo(canary);
  const [pin] = makeRepo(join(root, 'upstream'), [{ 'README.md': 'a small repository\n' }]);
  const tree = install(root, pin);
  git(root, 'clone', '-q', join(root, 'upstream'), tree.build);
  const before = fingerprint(canary);

  const result = build(tree, { GIT_INDEX_FILE: join(canary, '.git', 'index') });

  // It went on to the patches, which do not apply to the small repository.
  expect(result.stderr).toContain('does not apply');
  expect(result.status).toBe(1);
  expect(fingerprint(canary)).toBe(before);
});

/**
 * The files the real patches change, as they were before: filler lines up to the hunk, then the lines the hunk expects. A small
 * stand-in for Strudel at the pin, which the patches apply to.
 */
function patchTargets(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(repoPath('patches/strudel'))) {
    const patch = readFileSync(repoPath(`patches/strudel/${name}`), 'utf8');
    const path = /^--- a\/(.+)$/m.exec(patch)?.[1];
    const start = /^@@ -(\d+)[ ,]/m.exec(patch)?.[1];
    if (path === undefined || start === undefined) throw new Error(`${name} is not a one-file patch`);
    const lines = patch.split('\n');
    const before: string[] = [];
    for (const line of lines.slice(lines.findIndex((l) => l.startsWith('@@')) + 1)) {
      if (line.startsWith(' ') || line.startsWith('-')) before.push(line.slice(1));
      else if (!line.startsWith('+')) break;
    }
    files[path] = [...Array.from({ length: Number(start) - 1 }, () => '// filler'), ...before, ''].join('\n');
  }
  return files;
}

/** A scratch tree that can go through to the end: it clones a stand-in upstream that holds the pin, and uses the real rsync. */
function wholeBuild(): { tree: Tree; pin: string } {
  const root = tempDir();
  const upstream = join(root, 'upstream');
  const [pin] = makeRepo(upstream, [patchTargets()]);
  return { tree: install(root, pin, { upstream, realRsync: true }), pin };
}

it.skipIf(!HAS_RSYNC)('builds with the pinned pnpm, replaces static/ and records what it built', () => {
  const { tree, pin } = wholeBuild();
  const log = join(tree.root, 'npx.log');

  const result = build(tree, { FAKE_NPX_LOG: log });

  expect(result.status, result.stderr).toBe(0);
  // Every call of npx names the same pnpm, exactly: --version, install, run build.
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['pnpm@10.34.9', 'pnpm@10.34.9', 'pnpm@10.34.9']);
  // The patches were applied to the clone the build ran in.
  expect(readFileSync(join(tree.build, 'website/src/pages/index.astro'), 'utf8')).toContain('/strudel-ws-bridge.js');
  expect(readFileSync(join(tree.build, 'website/astro.config.mjs'), 'utf8')).toContain('navigateFallbackDenylist');

  // static/ is the new site: the stale page is gone, the nested page is there, and _headers and the bridge are the ones of client/,
  // not the upstream's and not the earlier build's.
  const staticDir = join(tree.cloudflare, 'static');
  expect(readFileSync(join(staticDir, 'index.html'), 'utf8')).toContain('/_astro/');
  expect(readFileSync(join(staticDir, 'sub', 'page.html'), 'utf8')).toBe('nested\n');
  expect(existsSync(join(staticDir, 'old-page.html'))).toBe(false);
  for (const name of ['_headers', 'strudel-ws-bridge.js']) {
    expect(readFileSync(join(staticDir, name), 'utf8'), name).toBe(readFileSync(join(tree.cloudflare, 'client', name), 'utf8'));
  }

  // The manifest names the commit, each patch with its hash, and the tools that ran.
  const patchDir = join(tree.cloudflare, 'patches', 'strudel');
  expect(JSON.parse(readFileSync(join(staticDir, 'djopus-build.json'), 'utf8'))).toEqual({
    strudelCommit: pin,
    patches: readdirSync(patchDir)
      .sort()
      .map((file) => ({ file, sha256: createHash('sha256').update(readFileSync(join(patchDir, file), 'utf8')).digest('hex') })),
    pnpm: '10.0.0-fake',
    node: nodeVersion,
    builtAt: expect.any(String),
  });
});

it.skipIf(!HAS_RSYNC)('leaves the tracked _headers and bridge of static/ in place when the build fails after the rsync', () => {
  // The upstream build has a _headers and a bridge of its own. The rsync --delete must not delete the tracked ones, and must not
  // let the upstream's in; here the copy from client/ that follows fails, so only the exclusions stand between them and static/.
  const { tree } = wholeBuild();
  const staticDir = join(tree.cloudflare, 'static');
  for (const name of ['_headers', 'strudel-ws-bridge.js']) chmodSync(join(tree.cloudflare, 'client', name), 0o000);
  try {
    readFileSync(join(tree.cloudflare, 'client', '_headers'), 'utf8');
    return; // a user who reads files without permission (root) cannot make the copy fail
  } catch {
    // unreadable, as meant
  }

  const result = build(tree);

  expect(result.status).toBe(1);
  expect(existsSync(join(staticDir, 'old-page.html'))).toBe(false); // the rsync ran, and deleted what the new site lacks
  expect(readFileSync(join(staticDir, '_headers'), 'utf8')).toBe('the tracked _headers\n');
  expect(readFileSync(join(staticDir, 'strudel-ws-bridge.js'), 'utf8')).toBe('// the tracked bridge\n');
  expect(existsSync(join(staticDir, 'djopus-build.json'))).toBe(false); // so check-static refuses what is left
});

it.skipIf(!HAS_RSYNC)('refuses a static/ that is a symbolic link before it does anything, and leaves what it points to alone', () => {
  // rsync --delete follows the link, so with static -> another checkout the build would replace that checkout.
  const { tree } = wholeBuild();
  const target = join(tree.root, 'elsewhere');
  mkdirSync(target);
  writeFileSync(join(target, 'precious.txt'), 'not a build\n');
  rmSync(join(tree.cloudflare, 'static'), { recursive: true, force: true });
  symlinkSync(target, join(tree.cloudflare, 'static'));

  const result = build(tree);

  expect(result.stderr).toContain('is a symbolic link');
  expect(result.status).toBe(1);
  expect(readFileSync(join(target, 'precious.txt'), 'utf8')).toBe('not a build\n');
  expect(readdirSync(target)).toEqual(['precious.txt']);
  expect(existsSync(tree.build)).toBe(false);
});

it('refuses a .strudel-build whose .git is a symbolic link or a gitfile, and leaves the repository it leads to alone', () => {
  // The work tree of such a directory is .strudel-build, so a check of the top level passes, and the git directory is somewhere else.
  for (const kind of ['symbolic link', 'gitfile']) {
    const root = tempDir();
    const target = join(root, 'elsewhere');
    const pin = dirtyRepo(target);
    const tree = install(root, pin);
    mkdirSync(tree.build);
    if (kind === 'gitfile') writeFileSync(join(tree.build, '.git'), `gitdir: ${join(target, '.git')}\n`);
    else symlinkSync(join(target, '.git'), join(tree.build, '.git'));
    const before = fingerprint(target);

    const result = build(tree);

    expect(result.stderr, kind).toContain('is not a git clone');
    expect(result.status, kind).toBe(1);
    expect(fingerprint(target), kind).toBe(before);
  }
});

// On a case-insensitive volume (APFS by default) a path can be typed in another case than the one stored. bash's pwd -P keeps the
// typed case where git reports the stored one, so a good clone was refused.
it.skipIf(!existsSync(tmpdir().toUpperCase()))('finds its directory under a path typed in another case', () => {
  const tree = install(tempDir(), 'a'.repeat(40));
  cloneOfAnotherRepo(tree);

  const result = build(tree, {}, join(tree.cloudflare, 'scripts', 'build-strudel.sh').toUpperCase());

  expect(result.stderr).toContain('is not in');
  expect(result.status).toBe(1);
});
