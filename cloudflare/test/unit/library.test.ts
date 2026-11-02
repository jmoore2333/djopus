import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { buildLibrary, LIBRARY_LIMITS } from '../../scripts/build-library.mjs';
import { LIBRARY } from '../../src/core/library';
import { HttpError } from '../../src/http';
import committedJson from '../../src/library.generated.json';
import { checkTags, MAX_CODE_BYTES, MAX_NAME_CHARS, MAX_TAG_CHARS, MAX_TAGS } from '../../src/limits';

// The read-only library is generated from the curated patterns of the repository's patterns/ directory
// (scripts/build-library.mjs writes src/library.generated.json), so the Worker bundles the patterns as data and
// reads no file. These tests pin the generator, the committed file, and the limits the library has to meet to be
// loaded into a crate-sized editor.

const PATTERNS_DIR = fileURLToPath(new URL('../../../patterns', import.meta.url));
const GENERATED_FILE = fileURLToPath(new URL('../../src/library.generated.json', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/build-library.mjs', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'build-library-'));
  made.push(dir);
  return dir;
}

/** A patterns directory holding `files` (name -> content of the file; an object is written as JSON). */
function patternsDir(files: Record<string, unknown>): string {
  const dir = tempDir();
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

// --- the committed file ---

it('library.generated.json is up to date', () => {
  expect(buildLibrary(PATTERNS_DIR)).toEqual(committedJson);
});

it('is exactly what the script writes, so that a regenerated file leaves no diff', () => {
  const out = join(tempDir(), 'library.json');
  const run = spawnSync(execPath, [SCRIPT, PATTERNS_DIR, out], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  expect(readFileSync(out, 'utf8')).toBe(readFileSync(GENERATED_FILE, 'utf8'));
});

it('LIBRARY is the generated file: every curated pattern, sorted by name, with unique names', () => {
  expect(LIBRARY).toEqual(committedJson);
  expect(LIBRARY.length).toBeGreaterThan(0);
  const names = LIBRARY.map((entry) => entry.name);
  expect(names).toEqual([...names].sort());
  expect(new Set(names).size).toBe(names.length);
  for (const entry of LIBRARY) expect(Object.keys(entry), entry.name).toEqual(['name', 'content', 'tags']);
});

it('every library pattern fits the limits of a crate entry, so that loading one never needs more than saving one does', () => {
  for (const entry of LIBRARY) {
    expect(entry.name.length, entry.name).toBeGreaterThanOrEqual(1);
    expect(entry.name.length, entry.name).toBeLessThanOrEqual(MAX_NAME_CHARS);
    expect(bytes(entry.content), entry.name).toBeGreaterThan(0);
    expect(bytes(entry.content), entry.name).toBeLessThanOrEqual(MAX_CODE_BYTES);
    expect(entry.tags.length, entry.name).toBeLessThanOrEqual(MAX_TAGS);
    for (const tag of entry.tags) expect(tag.length, `${entry.name} / ${tag}`).toBeLessThanOrEqual(MAX_TAG_CHARS);
  }
});

// --- buildLibrary ---

it('checks patterns against the limits of src/limits.ts: a script that is plain Node cannot import them, so it keeps a copy', () => {
  expect(LIBRARY_LIMITS).toEqual({
    maxNameChars: MAX_NAME_CHARS,
    maxCodeBytes: MAX_CODE_BYTES,
    maxTags: MAX_TAGS,
    maxTagChars: MAX_TAG_CHARS,
  });
});

it('keeps name, content and tags of each .json file, drops every other field, and sorts by name', () => {
  const dir = patternsDir({
    // File names are not the order of the library, and neither is the order of the names' first letters.
    'a.json': { name: 'zebra', content: 's("z")', tags: ['b'], timestamp: '2026-03-24T00:00:00.000Z', extra: { a: 1 } },
    'b.json': { name: 'Apple', content: 's("A")', tags: [] },
    'c.json': { name: 'apple', content: 's("a")', tags: ['x', 'y'] },
    'd.json': { name: 'Mango pie', content: 's("m")', tags: ['trance'], timestamp: 'x' },
    'notes.txt': 'not a pattern',
    'README.md': '# patterns',
  });
  expect(buildLibrary(dir)).toEqual([
    // By UTF-16 code unit, which is the same on every machine: capitals come before lowercase letters.
    { name: 'Apple', content: 's("A")', tags: [] },
    { name: 'Mango pie', content: 's("m")', tags: ['trance'] },
    { name: 'apple', content: 's("a")', tags: ['x', 'y'] },
    { name: 'zebra', content: 's("z")', tags: ['b'] },
  ]);
});

it('gives a pattern with no tags none, and an empty directory an empty library', () => {
  expect(buildLibrary(patternsDir({ 'a.json': { name: 'a', content: 's("a")' }, 'b.json': { name: 'b', content: 's("b")', tags: null } }))).toEqual([
    { name: 'a', content: 's("a")', tags: [] },
    { name: 'b', content: 's("b")', tags: [] },
  ]);
  expect(buildLibrary(patternsDir({}))).toEqual([]);
});

it('takes the limits of the crate at their edges', () => {
  const tags = Array.from({ length: MAX_TAGS }, (_, i) => String(i).padEnd(MAX_TAG_CHARS, 't'));
  const dir = patternsDir({
    'edge.json': { name: 'n'.repeat(MAX_NAME_CHARS), content: 'c'.repeat(MAX_CODE_BYTES), tags },
    // The limit is in bytes: 21,845 euro signs are 65,535 of them.
    'euro.json': { name: 'euro', content: '€'.repeat(21_845), tags: [] },
  });
  expect(buildLibrary(dir)).toHaveLength(2);
});

it.each<[string, Record<string, unknown>, RegExp]>([
  ['a file that is not JSON', { 'bad.json': '{ nope' }, /bad\.json: .*not valid JSON/],
  ['a JSON value that is not an object', { 'bad.json': '[1, 2]' }, /bad\.json: .*JSON object/],
  ['a missing name', { 'bad.json': { content: 's("a")', tags: [] } }, /bad\.json: name must be/],
  ['an empty name', { 'bad.json': { name: '', content: 's("a")', tags: [] } }, /bad\.json: name must be/],
  ['a name that is not a string', { 'bad.json': { name: 7, content: 's("a")', tags: [] } }, /bad\.json: name must be/],
  ['a name over 128 characters', { 'bad.json': { name: 'n'.repeat(129), content: 's("a")', tags: [] } }, /bad\.json: name must be/],
  ['missing content', { 'bad.json': { name: 'a', tags: [] } }, /bad\.json: content must be/],
  ['empty content', { 'bad.json': { name: 'a', content: '', tags: [] } }, /bad\.json: content must be/],
  ['content that is not a string', { 'bad.json': { name: 'a', content: ['s("a")'], tags: [] } }, /bad\.json: content must be/],
  ['content over 65,536 bytes', { 'bad.json': { name: 'a', content: 'c'.repeat(65_537), tags: [] } }, /bad\.json: content must be/],
  ['content over 65,536 bytes that is under 65,536 characters', { 'bad.json': { name: 'a', content: '€'.repeat(21_846), tags: [] } }, /bad\.json: content must be/],
  // The D1 backup has one of these: tags that were saved as a string of JSON.
  ['tags saved as a string of JSON', { 'bad.json': { name: 'a', content: 's("a")', tags: '["trance"]' } }, /bad\.json: tags must be/],
  ['a tag that is not a string', { 'bad.json': { name: 'a', content: 's("a")', tags: ['ok', 7] } }, /bad\.json: tags must be/],
  ['more than 10 tags', { 'bad.json': { name: 'a', content: 's("a")', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) } }, /bad\.json: tags must be/],
  ['a tag over 32 characters', { 'bad.json': { name: 'a', content: 's("a")', tags: ['t'.repeat(33)] } }, /bad\.json: tags must be/],
])('refuses %s, and names the file', (_what, files, message) => {
  expect(() => buildLibrary(patternsDir({ 'good.json': { name: 'good', content: 's("g")', tags: [] }, ...files }))).toThrow(message);
});

// The tags of a pattern are judged by one rule on every surface: checkTags (src/limits.ts) for the REST route, and for
// the crate, which test/worker/crate.test.ts holds to it; and this script, which is plain Node and keeps its own copy
// of the rule. No tags, undefined or null, is none.
it.each<[string, unknown]>([
  ['omitted', undefined],
  ['null', null],
  ['an empty list', []],
  ['one tag', ['a']],
  ['an empty tag', ['']],
  ['a tag of 32 characters', ['t'.repeat(32)]],
  ['a tag of 33 characters', ['t'.repeat(33)]],
  ['10 tags', Array.from({ length: 10 }, (_, i) => `t${i}`)],
  ['11 tags', Array.from({ length: 11 }, (_, i) => `t${i}`)],
  ['a string', 'techno'],
  ['a string of JSON', '["techno"]'],
  ['a number', 7],
  ['true', true],
  ['an object', {}],
  ['a number among strings', ['ok', 7]],
  ['null among strings', ['ok', null]],
  ['a list in a list', [['nested']]],
])('takes tags that are %s as checkTags does', (_what, tags) => {
  let rule: string[] | 'refused';
  try {
    rule = checkTags(tags);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    rule = 'refused';
  }
  // JSON.stringify leaves out a property that is undefined: the file has no tags at all.
  const dir = patternsDir({ 'a.json': JSON.stringify({ name: 'a', content: 's("a")', tags }) });
  if (rule === 'refused') {
    expect(() => buildLibrary(dir)).toThrow(/a\.json: tags must be/);
  } else {
    expect(buildLibrary(dir)).toEqual([{ name: 'a', content: 's("a")', tags: rule }]);
  }
});

it('refuses two files with the same name, and says which', () => {
  const dir = patternsDir({
    'one.json': { name: 'same', content: 's("1")', tags: [] },
    'two.json': { name: 'same', content: 's("2")', tags: [] },
  });
  expect(() => buildLibrary(dir)).toThrow(/two\.json: .*"same".*one\.json/);
});

it('reports every problem in the directory at once', () => {
  const dir = patternsDir({
    'a.json': { name: '', content: 's("a")', tags: [] },
    'b.json': { name: 'b', content: '', tags: [] },
    'c.json': { name: 'c', content: 's("c")', tags: 'nope' },
  });
  expect(() => buildLibrary(dir)).toThrow(/a\.json[^]*b\.json[^]*c\.json/);
});

it('fails on a directory that is not there', () => {
  expect(() => buildLibrary(join(tempDir(), 'missing'))).toThrow(/ENOENT|no such file/i);
});

// --- run directly ---

it('writes the library as JSON when run directly, and says how many patterns went in', () => {
  const dir = patternsDir({
    'b.json': { name: 'b', content: 's("b")', tags: ['x'] },
    'a.json': { name: 'a', content: 's("a")', tags: [], timestamp: 'dropped' },
  });
  const out = join(tempDir(), 'library.json');
  const run = spawnSync(execPath, [SCRIPT, dir, out], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain('2 patterns');
  expect(readFileSync(out, 'utf8')).toBe(
    `${JSON.stringify([{ name: 'a', content: 's("a")', tags: [] }, { name: 'b', content: 's("b")', tags: ['x'] }], null, 2)}\n`,
  );
});

it('exits 1 with the reasons, and writes nothing, when a pattern is bad', () => {
  const dir = patternsDir({ 'broken.json': { name: 'broken', content: '', tags: [] } });
  const out = join(tempDir(), 'library.json');
  const run = spawnSync(execPath, [SCRIPT, dir, out], { encoding: 'utf8' });
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/broken\.json: content must be/);
  expect(existsSync(out)).toBe(false);
});

it('says so, and does not write, when the file is already up to date', () => {
  const dir = patternsDir({ 'a.json': { name: 'a', content: 's("a")', tags: [] } });
  const out = join(tempDir(), 'library.json');
  expect(spawnSync(execPath, [SCRIPT, dir, out], { encoding: 'utf8' }).stdout).toMatch(/wrote 1 pattern\b/);
  const again = spawnSync(execPath, [SCRIPT, dir, out], { encoding: 'utf8' });
  expect(again.status, again.stderr).toBe(0);
  expect(again.stdout).toMatch(/1 pattern\b.*up to date/);
});

// --- the wiring ---

it('runs the check before the tests, and the build before a dev server and a deploy', () => {
  const scripts = (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { scripts: Record<string, string> }).scripts;
  expect(scripts['build:library']).toBe('node scripts/build-library.mjs');
  expect(scripts['check:library']).toBe('node scripts/build-library.mjs --check');
  // Before the tests the file is only checked: a run that wrote it would make the file match patterns/ whatever it held,
  // and library.generated.json is up to date could not fail.
  expect(scripts.pretest).toContain('npm run check:library');
  expect(scripts.pretest).not.toContain('build:library');
  // Before what runs the Worker, the file is built, so that what runs is what patterns/ holds.
  expect(scripts.predev).toBe('npm run build:library');
  expect(scripts.predeploy).toContain('npm run build:library');
});

// --- --check ---
//
// `npm test` runs the script with --check first (pretest). The writing run would rewrite the committed file to match
// patterns/ and so could never find it stale: the check is what makes `library.generated.json is up to date` able to fail.

/** A patterns directory and the library file the script wrote for it. */
function builtLibrary(files: Record<string, unknown> = { 'a.json': { name: 'a', content: 's("a")', tags: ['x'] } }) {
  const dir = patternsDir(files);
  const out = join(tempDir(), 'library.json');
  const first = spawnSync(execPath, [SCRIPT, dir, out], { encoding: 'utf8' });
  expect(first.status, first.stderr).toBe(0);
  return { dir, out };
}

const check = (...args: string[]) => spawnSync(execPath, [SCRIPT, '--check', ...args], { encoding: 'utf8' });

it('--check passes on a file that is up to date, says so, and writes nothing', () => {
  const { dir, out } = builtLibrary();
  const before = readFileSync(out, 'utf8');
  const run = check(dir, out);
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toMatch(/1 pattern\b.*up to date/);
  expect(run.stderr).toBe('');
  expect(readFileSync(out, 'utf8')).toBe(before);
});

it('--check passes on the real tree: the committed file is what patterns/ builds', () => {
  const run = spawnSync(execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toMatch(/up to date/);
});

it.each<[string, (dir: string) => void, RegExp]>([
  ['a pattern whose content changed', (dir) => writeFileSync(join(dir, 'a.json'), JSON.stringify({ name: 'a', content: 's("changed")', tags: ['x'] })), /changed: a\b/],
  ['a pattern whose tags changed', (dir) => writeFileSync(join(dir, 'a.json'), JSON.stringify({ name: 'a', content: 's("a")', tags: ['y'] })), /changed: a\b/],
  ['a pattern that was added', (dir) => writeFileSync(join(dir, 'b.json'), JSON.stringify({ name: 'b', content: 's("b")', tags: [] })), /added: b\b/],
  ['a pattern that was removed', (dir) => rmSync(join(dir, 'a.json'), { recursive: false, force: false }), /removed: a\b/],
  ['a pattern that was renamed', (dir) => writeFileSync(join(dir, 'a.json'), JSON.stringify({ name: 'z', content: 's("a")', tags: ['x'] })), /added: z\b.*removed: a\b/],
])('--check exits 1 when %s, says what differs and how to fix it, and leaves the file as it was', (_what, change, difference) => {
  const { dir, out } = builtLibrary();
  const before = readFileSync(out, 'utf8');
  change(dir);
  const run = check(dir, out);
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/out of date/);
  expect(run.stderr).toMatch(difference);
  expect(run.stderr).toContain('npm run build:library');
  expect(run.stdout).toBe('');
  expect(readFileSync(out, 'utf8')).toBe(before); // a check writes nothing
});

it('--check exits 1 for a file that was edited by hand, though its patterns are the same', () => {
  const { dir, out } = builtLibrary();
  const entries = JSON.parse(readFileSync(out, 'utf8')) as Array<{ content: string }>;
  entries[0].content = 's("edited by hand")';
  writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
  const before = readFileSync(out, 'utf8');
  const run = check(dir, out);
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/changed: a\b/);
  expect(readFileSync(out, 'utf8')).toBe(before);
});

it('--check exits 1 for a file that holds the same patterns written another way, because the file is what is committed', () => {
  const { dir, out } = builtLibrary();
  const entries = JSON.parse(readFileSync(out, 'utf8')) as unknown;
  writeFileSync(out, JSON.stringify(entries)); // no indent, no final newline
  const run = check(dir, out);
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/out of date.*formatting/);
});

it('--check exits 1 when there is no file to compare, and does not make one', () => {
  const dir = patternsDir({ 'a.json': { name: 'a', content: 's("a")', tags: [] } });
  const out = join(tempDir(), 'library.json');
  const run = check(dir, out);
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/does not exist|missing/);
  expect(run.stderr).toContain('npm run build:library');
  expect(existsSync(out)).toBe(false);
});

it('--check exits 1 for a file that is not JSON', () => {
  const { dir, out } = builtLibrary();
  writeFileSync(out, '<<<<<<< HEAD\n[]');
  const run = check(dir, out);
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/not valid JSON/);
  expect(readFileSync(out, 'utf8')).toBe('<<<<<<< HEAD\n[]');
});

it('--check exits 1 with the reasons, as the writing run does, when a pattern is bad', () => {
  const { dir, out } = builtLibrary();
  const before = readFileSync(out, 'utf8');
  writeFileSync(join(dir, 'broken.json'), JSON.stringify({ name: 'broken', content: '', tags: [] }));
  const run = check(dir, out);
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/broken\.json: content must be/);
  expect(readFileSync(out, 'utf8')).toBe(before);
});

it('takes --check before or after the paths', () => {
  const { dir, out } = builtLibrary();
  expect(spawnSync(execPath, [SCRIPT, dir, out, '--check'], { encoding: 'utf8' }).status).toBe(0);
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ name: 'b', content: 's("b")', tags: [] }));
  expect(spawnSync(execPath, [SCRIPT, dir, out, '--check'], { encoding: 'utf8' }).status).toBe(1);
  expect(spawnSync(execPath, [SCRIPT, '--check', dir, out], { encoding: 'utf8' }).status).toBe(1);
});

it('refuses an option it does not know, so that a typo cannot turn a check into a write', () => {
  const { dir, out } = builtLibrary();
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ name: 'b', content: 's("b")', tags: [] }));
  const before = readFileSync(out, 'utf8');
  for (const option of ['--chek', '--Check', '--check=true', '-c', '--write']) {
    const run = spawnSync(execPath, [SCRIPT, option, dir, out], { encoding: 'utf8' });
    expect(run.status, option).toBe(2);
    expect(run.stderr, option).toMatch(/unknown option/);
    expect(readFileSync(out, 'utf8'), option).toBe(before);
  }
});

it('refuses more than the two paths', () => {
  const { dir, out } = builtLibrary();
  const run = spawnSync(execPath, [SCRIPT, '--check', dir, out, join(dir, 'a.json')], { encoding: 'utf8' });
  expect(run.status).toBe(2);
  expect(run.stderr).toMatch(/at most two paths/);
});

it('the writing run still brings a stale file up to date, which is what build:library is for', () => {
  const { dir, out } = builtLibrary();
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ name: 'b', content: 's("b")', tags: [] }));
  expect(check(dir, out).status).toBe(1);
  const write = spawnSync(execPath, [SCRIPT, dir, out], { encoding: 'utf8' });
  expect(write.status, write.stderr).toBe(0);
  expect(write.stdout).toMatch(/wrote 2 patterns/);
  expect(check(dir, out).status).toBe(0);
});
