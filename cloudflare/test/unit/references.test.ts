import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execPath } from 'node:process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReferences, MAX_REFERENCE_BYTES, REFERENCE_FILES } from '../../scripts/build-references.mjs';
import { REFERENCES } from '../../src/core/references';
import committedJson from '../../src/references.generated.json';

// The reference resources are generated from the DJ skill's references (skills/dj-opus/references/) by
// scripts/build-references.mjs into src/references.generated.json, so the Worker bundles them as data. These tests
// pin the generator and the committed file against the skill, so the two cannot drift.

const REFERENCES_DIR = fileURLToPath(new URL('../../../skills/dj-opus/references/', import.meta.url));
const GENERATED_FILE = fileURLToPath(new URL('../../src/references.generated.json', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/build-references.mjs', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'build-references-'));
  tempDirs.push(dir);
  return dir;
}

it('references.generated.json is up to date', () => {
  expect(readFileSync(GENERATED_FILE, 'utf8')).toBe(`${JSON.stringify(buildReferences(REFERENCES_DIR), null, 2)}\n`);
  expect(REFERENCES).toEqual(committedJson);
});

it('is checked before the tests and built before a deploy', () => {
  const scripts = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).scripts as Record<string, string>;
  expect(scripts['pretest']).toContain('npm run check:references');
  expect(scripts['predeploy']).toContain('npm run build:references');
  expect(scripts['check:references']).toBe('node scripts/build-references.mjs --check');
});

describe('the references', () => {
  it('are the four files of the skill, each with its text', () => {
    expect(REFERENCES.map((r) => r.name)).toEqual(REFERENCE_FILES.map((f) => f.name));
    for (const [reference, file] of REFERENCES.map((r, i) => [r, REFERENCE_FILES[i]!] as const)) {
      expect(reference.text).toBe(readFileSync(join(REFERENCES_DIR, file.file), 'utf8'));
      expect(reference.mimeType).toBe(file.mimeType);
      expect(new TextEncoder().encode(reference.text).length).toBeLessThanOrEqual(MAX_REFERENCE_BYTES);
    }
  });

  // The references are published verbatim and served to every client; the denylist of the publish script is the
  // rule, and a hit in a reference is a hit here first. The denylist itself is private (a release has none), so the
  // test runs only where it is.
  const DENYLIST = fileURLToPath(new URL('../../../scripts/publish-denylist.txt', import.meta.url));
  it.skipIf(!existsSync(DENYLIST))('say nothing a public reader should not see', () => {
    const denylist = readFileSync(DENYLIST, 'utf8')
      .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    for (const reference of REFERENCES) {
      for (const pattern of denylist) expect(reference.text, `${reference.name} matches ${pattern}`).not.toMatch(new RegExp(pattern));
    }
  });
});

describe('the script', () => {
  it('refuses a missing or empty file', () => {
    const dir = tempDir();
    expect(() => buildReferences(dir)).toThrow(/cannot be read/);
    for (const { file } of REFERENCE_FILES) writeFileSync(join(dir, file), '');
    expect(() => buildReferences(dir)).toThrow(/is empty/);
  });

  it('--check exits 1 and writes nothing when the file is stale, 0 when it is current', () => {
    const dir = tempDir();
    const out = join(dir, 'out.json');
    const run = (...args: string[]) => spawnSync(execPath, [SCRIPT, ...args, REFERENCES_DIR, out], { encoding: 'utf8' });
    expect(run('--check').status).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(run().status).toBe(0);
    expect(run('--check').status).toBe(0);
    writeFileSync(out, '[]\n');
    const stale = run('--check');
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/out of date: added/);
  });
});
