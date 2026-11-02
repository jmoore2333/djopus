// Builds src/library.generated.json, the read-only library the generic MCP's load and list tools offer next to a
// session's own crate, from the curated patterns of the repository's patterns/ directory. The Worker bundles the
// JSON, so it reads no file at run time and the library cannot differ from what was reviewed and committed.
//
//   node scripts/build-library.mjs [--check] [patternsDir] [outFile]
//
// Both paths default to the repository's own (../patterns and src/library.generated.json); the tests give throwaway
// ones. The file is committed: after a change to patterns/, `npm run build:library` writes it again, and the result is
// committed with the change. `npm run dev` and `npm run deploy` run that first, so what runs is built from patterns/.
//
// --check writes nothing. It exits 1, saying what differs, when the file is not exactly what the build would write:
// `npm test` runs it first (`npm run check:library`), so a library that has fallen behind patterns/ stops the tests
// instead of being quietly written over. (The writing run could never find the file stale.)
//
// Exit codes: 0 the file is up to date, or was written; 1 it is out of date (--check), or a pattern cannot be a
// library entry; 2 the command line is wrong.
//
// Each patterns/*.json file is { name, content, tags, timestamp }. The library keeps name, content and tags, sorted by
// name, so that the file is the same on every machine and does not change when a pattern is only touched.
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATTERNS_DIR = join(HERE, '..', '..', 'patterns');
const DEFAULT_OUT_FILE = join(HERE, '..', 'src', 'library.generated.json');

// What src/limits.ts allows a crate entry. A library pattern is loaded into the editor the same way, so it has to
// fit the same limits. This is plain Node and cannot import TypeScript, so it keeps a copy, and
// test/unit/library.test.ts checks the copy against the real ones.
export const LIBRARY_LIMITS = { maxNameChars: 128, maxCodeBytes: 65_536, maxTags: 10, maxTagChars: 32 };

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const byteLength = (text) => new TextEncoder().encode(text).length;

/** Why `pattern` (a parsed file) cannot be a library entry: one sentence for each thing that is wrong with it. */
function problemsOf(pattern) {
  const { maxNameChars, maxCodeBytes, maxTags, maxTagChars } = LIBRARY_LIMITS;
  const problems = [];
  if (typeof pattern.name !== 'string' || pattern.name.length < 1 || pattern.name.length > maxNameChars) {
    problems.push(`name must be a string of 1 to ${maxNameChars} characters`);
  }
  if (typeof pattern.content !== 'string' || pattern.content.length === 0 || byteLength(pattern.content) > maxCodeBytes) {
    problems.push(`content must be a non-empty string of at most ${maxCodeBytes} bytes`);
  }
  // No tags is no tags, as in checkTags. A string is a problem and not a tag list: the D1 backup has a pattern whose
  // tags were saved as a string of JSON.
  const { tags } = pattern;
  const noTags = tags === undefined || tags === null;
  if (
    !noTags &&
    (!Array.isArray(tags) ||
      tags.length > maxTags ||
      tags.some((tag) => typeof tag !== 'string' || tag.length > maxTagChars))
  ) {
    problems.push(`tags must be an array of at most ${maxTags} strings of at most ${maxTagChars} characters`);
  }
  return problems;
}

/**
 * The library of the *.json files in `patternsDir`, sorted by name. Throws, with a line for every problem found and
 * the file it was found in, when a file cannot be an entry or two files have the same name.
 *
 * @param {string} patternsDir
 * @returns {{ name: string, content: string, tags: string[] }[]}
 */
export function buildLibrary(patternsDir) {
  const problems = [];
  const entries = [];
  const fileOfName = new Map();

  for (const file of readdirSync(patternsDir).filter((f) => f.endsWith('.json')).sort()) {
    let pattern;
    try {
      pattern = JSON.parse(readFileSync(join(patternsDir, file), 'utf8'));
    } catch (error) {
      problems.push(`${file}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (!isObject(pattern)) {
      problems.push(`${file}: expected a JSON object with name, content and tags`);
      continue;
    }
    const found = problemsOf(pattern);
    problems.push(...found.map((problem) => `${file}: ${problem}`));
    if (found.length > 0) continue;

    if (fileOfName.has(pattern.name)) {
      problems.push(`${file}: the name ${JSON.stringify(pattern.name)} is also the name in ${fileOfName.get(pattern.name)}`);
      continue;
    }
    fileOfName.set(pattern.name, file);
    entries.push({ name: pattern.name, content: pattern.content, tags: pattern.tags ?? [] });
  }

  if (problems.length > 0) {
    const count = problems.length === 1 ? '1 pattern cannot' : `${problems.length} patterns cannot`;
    throw new Error(`${count} be in the library (${patternsDir}):\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }
  // By UTF-16 code unit and not by locale, so that the order is the same on every machine.
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function readIfThere(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The file as it is committed: what `JSON.stringify` writes with two spaces, and a final newline. */
const serialize = (library) => `${JSON.stringify(library, null, 2)}\n`;

/** Up to five names, then how many more. */
const nameList = (names) => (names.length > 5 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', '));

/** What is wrong with the committed file `current` (its text, or null when there is none) against `library`, in a clause. */
function describeDifference(current, library) {
  if (current === null) return 'the file does not exist';
  let committed;
  try {
    committed = JSON.parse(current);
  } catch {
    return 'the file is not valid JSON';
  }
  if (!Array.isArray(committed)) return 'the file is not a list of patterns';

  const byName = (list) => new Map(list.filter(isObject).map((entry) => [entry.name, JSON.stringify(entry)]));
  const had = byName(committed);
  const now = byName(library);
  const differences = [
    ['changed', [...now.keys()].filter((name) => had.has(name) && had.get(name) !== now.get(name))],
    ['added', [...now.keys()].filter((name) => !had.has(name))],
    ['removed', [...had.keys()].filter((name) => !now.has(name))],
  ]
    .filter(([, list]) => list.length > 0)
    .map(([what, list]) => `${what}: ${nameList(list)}`);
  return differences.length > 0 ? differences.join('; ') : 'it holds the same patterns, written differently (formatting)';
}

/** The command line: --check, then at most two paths (the patterns, the file). An error is the message to print. */
function parseArguments(argv) {
  const paths = [];
  let check = false;
  for (const arg of argv) {
    if (arg === '--check') check = true;
    // An option it does not know is an error, never a path: a typo must not turn a check into a write.
    else if (arg.startsWith('-')) return { error: `unknown option ${arg} (the only option is --check)` };
    else paths.push(arg);
  }
  if (paths.length > 2) return { error: 'at most two paths: the patterns directory, then the file to write' };
  return {
    check,
    patternsDir: paths[0] ? resolve(paths[0]) : DEFAULT_PATTERNS_DIR,
    outFile: paths[1] ? resolve(paths[1]) : DEFAULT_OUT_FILE,
  };
}

function runDirectly() {
  const args = parseArguments(process.argv.slice(2));
  if (args.error) {
    console.error(`build-library: ${args.error}`);
    process.exitCode = 2;
    return;
  }
  const { check, patternsDir, outFile } = args;
  const shown = relative(process.cwd(), outFile) || outFile;
  try {
    const library = buildLibrary(patternsDir);
    const json = serialize(library);
    const count = `${library.length} pattern${library.length === 1 ? '' : 's'}`;
    const current = readIfThere(outFile);
    if (current === json) {
      console.log(`build-library: ${count}, ${shown} is up to date`);
      return;
    }
    if (check) {
      console.error(`build-library: ${shown} is out of date: ${describeDifference(current, library)}. Run \`npm run build:library\` and commit the result.`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(outFile, json);
    console.log(`build-library: wrote ${count} to ${shown}`);
  } catch (error) {
    console.error(`build-library: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

// Only when this file is the one node was started with, not when a test imports buildLibrary.
function isMainModule() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) runDirectly();
