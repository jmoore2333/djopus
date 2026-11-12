// Builds src/references.generated.json, the reference files the generic MCP serves as resources (src/remote-mcp/guide.ts),
// from the DJ skill's references in the repository's skills/dj-opus/references/ directory. The Worker bundles the JSON,
// so it reads no file at run time and the resources cannot differ from what was reviewed and committed.
//
//   node scripts/build-references.mjs [--check] [referencesDir] [outFile]
//
// Both paths default to the repository's own (../../skills/dj-opus/references and src/references.generated.json). The
// file is committed: after a change to the references, `npm run build:references` writes it again, and the result is
// committed with the change. `npm run deploy` runs that first, so what runs is built from the skill.
//
// --check writes nothing. It exits 1, saying what differs, when the file is not exactly what the build would write:
// `npm test` runs it first (`npm run check:references`), so a file that has fallen behind the skill stops the tests.
//
// Exit codes: 0 the file is up to date, or was written; 1 it is out of date (--check) or a file is missing or too
// large; 2 the command line is wrong.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REFERENCES_DIR = join(HERE, '..', '..', 'skills', 'dj-opus', 'references');
const DEFAULT_OUT_FILE = join(HERE, '..', 'src', 'references.generated.json');

/**
 * The reference files, in the order the resource list shows them. The name is the resource's name and the last part
 * of its URI (djopus://reference/<name>); the description is what a client shows next to it.
 */
export const REFERENCE_FILES = [
  { name: 'strudel-cheatsheet', file: 'strudel-cheatsheet.md', mimeType: 'text/markdown', description: 'Strudel syntax, effects and the DJ Opus pitfalls, with examples' },
  { name: 'genres', file: 'genres.json', mimeType: 'application/json', description: 'Genres: BPM ranges, keys, characteristic elements and how to build them in Strudel' },
  { name: 'classic-tracks', file: 'classic-tracks.json', mimeType: 'application/json', description: 'Classic electronic tracks: BPM, key, signature elements and a Strudel approach for each' },
  { name: 'sample-banks', file: 'sample-banks.md', mimeType: 'text/markdown', description: 'The sound sources: drum machine banks, built-in samples, noise, wavetables, FM' },
];

/** The largest reference file, in bytes: a resource read answers with the whole file, in one message. */
export const MAX_REFERENCE_BYTES = 128 * 1024;

/**
 * The references of `referencesDir`, in REFERENCE_FILES order. Throws, with a line for every problem found, when a
 * file is missing, empty or too large.
 *
 * @param {string} referencesDir
 * @returns {{ name: string, mimeType: string, description: string, text: string }[]}
 */
export function buildReferences(referencesDir) {
  const problems = [];
  const entries = [];
  for (const { name, file, mimeType, description } of REFERENCE_FILES) {
    let text;
    try {
      text = readFileSync(join(referencesDir, file), 'utf8');
    } catch (error) {
      problems.push(`${file}: cannot be read (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const bytes = new TextEncoder().encode(text).length;
    if (bytes === 0) problems.push(`${file}: is empty`);
    else if (bytes > MAX_REFERENCE_BYTES) problems.push(`${file}: is ${bytes} bytes, more than the ${MAX_REFERENCE_BYTES} a resource may be`);
    else entries.push({ name, mimeType, description, text });
  }
  if (problems.length > 0) {
    throw new Error(`${problems.length} reference${problems.length === 1 ? '' : 's'} cannot be served (${referencesDir}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return entries;
}

function readIfThere(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The file as it is committed: what `JSON.stringify` writes with two spaces, and a final newline. */
const serialize = (references) => `${JSON.stringify(references, null, 2)}\n`;

/** What is wrong with the committed file `current` against `references`, in a clause. */
function describeDifference(current, references) {
  if (current === null) return 'the file does not exist';
  let committed;
  try {
    committed = JSON.parse(current);
  } catch {
    return 'the file is not valid JSON';
  }
  if (!Array.isArray(committed)) return 'the file is not a list of references';
  const byName = (list) => new Map(list.filter((e) => e && typeof e === 'object').map((e) => [e.name, JSON.stringify(e)]));
  const had = byName(committed);
  const now = byName(references);
  const differences = [
    ['changed', [...now.keys()].filter((name) => had.has(name) && had.get(name) !== now.get(name))],
    ['added', [...now.keys()].filter((name) => !had.has(name))],
    ['removed', [...had.keys()].filter((name) => !now.has(name))],
  ]
    .filter(([, list]) => list.length > 0)
    .map(([what, list]) => `${what}: ${list.join(', ')}`);
  return differences.length > 0 ? differences.join('; ') : 'it holds the same references, written differently (formatting)';
}

function parseArguments(argv) {
  const paths = [];
  let check = false;
  for (const arg of argv) {
    if (arg === '--check') check = true;
    else if (arg.startsWith('-')) return { error: `unknown option ${arg} (the only option is --check)` };
    else paths.push(arg);
  }
  if (paths.length > 2) return { error: 'at most two paths: the references directory, then the file to write' };
  return {
    check,
    referencesDir: paths[0] ? resolve(paths[0]) : DEFAULT_REFERENCES_DIR,
    outFile: paths[1] ? resolve(paths[1]) : DEFAULT_OUT_FILE,
  };
}

function runDirectly() {
  const args = parseArguments(process.argv.slice(2));
  if (args.error) {
    console.error(`build-references: ${args.error}`);
    process.exitCode = 2;
    return;
  }
  const { check, referencesDir, outFile } = args;
  const shown = relative(process.cwd(), outFile) || outFile;
  try {
    const references = buildReferences(referencesDir);
    const json = serialize(references);
    const count = `${references.length} reference${references.length === 1 ? '' : 's'}`;
    const current = readIfThere(outFile);
    if (current === json) {
      console.log(`build-references: ${count}, ${shown} is up to date`);
      return;
    }
    if (check) {
      console.error(`build-references: ${shown} is out of date: ${describeDifference(current, references)}. Run \`npm run build:references\` and commit the result.`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(outFile, json);
    console.log(`build-references: wrote ${count} to ${shown}`);
  } catch (error) {
    console.error(`build-references: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function isMainModule() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) runDirectly();
