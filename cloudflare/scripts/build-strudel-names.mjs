// Builds src/core/strudel-names.generated.json: every name a pattern can call in the Strudel REPL that DJ Opus serves.
// PatternValidator refuses a call to any other name before playback (see executor.ts validatePlayablePattern), because
// the REPL turns a call to an unknown name into an evaluation error that leaves the player silent while the tool
// reports success. The list comes from the pinned, patched Strudel clone that scripts/build-strudel.sh made, never
// from a hand-written list:
//
//   node scripts/build-strudel-names.mjs [--check] [buildDir] [outFile]
//
// buildDir defaults to .strudel-build, outFile to src/core/strudel-names.generated.json. `npm run build:strudel` runs
// this right after the build, so a clone at a new pin writes a new list; the file is committed with the pin. The
// clean-clone check of scripts/publish.sh runs build:strudel and refuses a release whose tracked files change, so a
// list that has fallen behind the pin stops a publish. --check writes nothing and exits 1 when the file differs.
//
// What is in the REPL's scope, in the order the REPL builds it:
//   1. The modules website/src/repl/util.mjs loadModules() hands to evalScope (every export of each one), and the
//      website's settingPatterns.
//   2. The names packages/core/repl.mjs adds with evalScope({...}) on every evaluation (setcps, setcpm, hush, all...).
//   3. Pattern methods: what the modules add to Pattern.prototype, by assignment, register('name') and
//      registerWidget('name') anywhere in the files they import.
// The modules are read with acorn (the clone's own copy), which finds 1 to 3 for every module, including the ones that
// only load in a browser. Names that are computed at run time (the controls of core/controls.mjs, register() over a
// list) are read by importing the modules that load in Node and listing their exports, Pattern.prototype and
// strudelScope. Both sources go into one sorted list, so the file is the same on every machine.
//
// Exit codes: 0 up to date or written; 1 out of date (--check), or the clone is missing or not at the pinned commit;
// 2 the command line is wrong.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUILD_DIR = join(HERE, '..', '.strudel-build');
const DEFAULT_OUT_FILE = join(HERE, '..', 'src', 'core', 'strudel-names.generated.json');
const BUILD_SCRIPT = join(HERE, 'build-strudel.sh');
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The commit scripts/build-strudel.sh pins. */
export function pinnedCommit() {
  const match = readFileSync(BUILD_SCRIPT, 'utf8').match(/^STRUDEL_COMMIT="([0-9a-f]{40})"$/m);
  if (!match) throw new Error('scripts/build-strudel.sh pins no STRUDEL_COMMIT');
  return match[1];
}

function checkedOutCommit(buildDir) {
  const head = join(buildDir, '.git', 'HEAD');
  if (!existsSync(head)) throw new Error(`${buildDir} is not a Strudel clone: run npm run build:strudel first`);
  return readFileSync(head, 'utf8').trim();
}

/** Calls fn on every node of an ESTree tree. */
function walk(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, fn));
    else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value, fn);
  }
}

function patternNames(pattern, out) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier': out.push(pattern.name); break;
    case 'ObjectPattern': pattern.properties.forEach((p) => patternNames(p.type === 'RestElement' ? p.argument : p.value, out)); break;
    case 'ArrayPattern': pattern.elements.forEach((e) => patternNames(e, out)); break;
    case 'RestElement': patternNames(pattern.argument, out); break;
    case 'AssignmentPattern': patternNames(pattern.left, out); break;
  }
}

const literalString = (node) => (node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined);
const literalStrings = (node) => {
  const one = literalString(node);
  if (one !== undefined) return [one];
  if (node?.type === 'ArrayExpression') return node.elements.map(literalString).filter((s) => s !== undefined);
  return [];
};
const isPatternPrototype = (node) =>
  node?.type === 'MemberExpression' && !node.computed && node.property.name === 'prototype' &&
  node.object.type === 'Identifier' && node.object.name === 'Pattern';

/** Reads the workspace packages of the clone: package name -> { dir, entry }. */
function workspacePackages(buildDir) {
  const packages = new Map();
  const root = join(buildDir, 'packages');
  for (const dir of readdirSync(root).sort()) {
    const file = join(root, dir, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    packages.set(pkg.name, { dir: join(root, dir), entry: join(root, dir, pkg.module || pkg.main || 'index.mjs') });
  }
  return packages;
}

function createReader(buildDir) {
  const require = createRequire(join(buildDir, 'packages', 'transpiler', 'package.json'));
  const acorn = require('acorn');
  const packages = workspacePackages(buildDir);
  const parsed = new Map();

  /** The file an import specifier names, or undefined for one outside the workspace or not a module of the scope. */
  function resolveSpecifier(specifier, fromFile) {
    if (specifier.includes('?') || specifier.endsWith('.json') || specifier.endsWith('.css')) return undefined;
    let file;
    if (specifier.startsWith('.')) {
      file = resolve(dirname(fromFile), specifier);
    } else {
      const parts = specifier.split('/');
      const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      const pkg = packages.get(name);
      if (!pkg) return undefined; // a dependency from npm: its names are only in scope if a module re-exports them
      const sub = parts.slice(specifier.startsWith('@') ? 2 : 1).join('/');
      file = sub ? join(pkg.dir, sub) : pkg.entry;
    }
    for (const candidate of [file, `${file}.mjs`, `${file}.js`, join(file, 'index.mjs')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    throw new Error(`cannot find ${specifier}, imported by ${relative(buildDir, fromFile)}`);
  }

  /** The exports, imports and Pattern methods of one file. */
  function read(file) {
    if (parsed.has(file)) return parsed.get(file);
    const ast = acorn.parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    const info = { exports: [], exportAll: [], imports: [], methods: [], scopeKeys: [] };
    for (const node of ast.body) {
      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration?.id) info.exports.push(node.declaration.id.name);
        for (const d of node.declaration?.declarations ?? []) patternNames(d.id, info.exports);
        for (const s of node.specifiers) info.exports.push(s.exported.name ?? s.exported.value);
      } else if (node.type === 'ExportAllDeclaration') {
        if (node.exported) info.exports.push(node.exported.name ?? node.exported.value);
        else info.exportAll.push(node.source.value);
      }
    }
    walk(ast, (node) => {
      if ((node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') && node.source) {
        info.imports.push(node.source.value);
      } else if (node.type === 'ImportExpression' && literalString(node.source)) {
        info.imports.push(node.source.value);
      } else if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && isPatternPrototype(node.left.object)) {
        const name = node.left.computed ? literalString(node.left.property) : node.left.property.name;
        if (name) info.methods.push(name);
      } else if (node.type === 'CallExpression') {
        const callee = node.callee.type === 'Identifier' ? node.callee.name : undefined;
        if (callee === 'register' || callee === 'registerWidget') info.methods.push(...literalStrings(node.arguments[0]));
        if (callee === 'evalScope') {
          for (const arg of node.arguments) {
            if (arg.type === 'ObjectExpression') {
              for (const p of arg.properties) if (p.type === 'Property') info.scopeKeys.push(p.key.name ?? p.key.value);
            }
          }
        }
        // Object.defineProperty(Pattern.prototype, 'name', ...)
        if (node.callee.type === 'MemberExpression' && node.callee.property.name === 'defineProperty' && isPatternPrototype(node.arguments[0])) {
          info.methods.push(...literalStrings(node.arguments[1]));
        }
      }
    });
    parsed.set(file, info);
    return info;
  }

  /** Every name `file` exports, following export * from. */
  function exportsOf(file, seen = new Set()) {
    if (seen.has(file)) return [];
    seen.add(file);
    const info = read(file);
    const names = [...info.exports];
    for (const specifier of info.exportAll) {
      const target = resolveSpecifier(specifier, file);
      if (target) names.push(...exportsOf(target, seen));
    }
    return names;
  }

  /** Every Pattern method and evalScope key of `file` and the files it imports, transitively. */
  function sideEffectsOf(file, seen) {
    if (seen.has(file)) return [];
    seen.add(file);
    const info = read(file);
    const names = [...info.methods, ...info.scopeKeys];
    for (const specifier of info.imports) {
      const target = resolveSpecifier(specifier, file);
      if (target) names.push(...sideEffectsOf(target, seen));
    }
    return names;
  }

  return { packages, read, exportsOf, sideEffectsOf, resolveSpecifier };
}

/** The module specifiers the website REPL loads into its scope (the browser branch of loadModules). */
function replModules(buildDir) {
  const util = readFileSync(join(buildDir, 'website', 'src', 'repl', 'util.mjs'), 'utf8');
  const body = util.slice(util.indexOf('export function loadModules'));
  const specifiers = [...body.slice(0, body.indexOf('return evalScope')).matchAll(/import\('([^']+)'\)/g)].map((m) => m[1]);
  // The desktop app (Tauri) swaps midi and osc for these; the web REPL that DJ Opus serves never loads them.
  const modules = specifiers.filter((s) => !s.startsWith('@strudel/desktopbridge'));
  if (modules.length < 10 || !modules.includes('@strudel/core')) {
    throw new Error('website/src/repl/util.mjs loadModules() no longer looks as this script expects');
  }
  return modules;
}

/** Names found by importing the modules that load in Node (the ones with names computed at run time). */
async function runtimeNames(entries) {
  const names = [];
  let Pattern;
  let strudelScope;
  const log = console.log;
  console.log = () => {}; // @strudel/core announces itself
  try {
    for (const entry of entries) {
      try {
        const module = await import(pathToFileURL(entry).href);
        names.push(...Object.keys(module));
        Pattern ??= module.Pattern;
        strudelScope ??= module.strudelScope;
      } catch {
        // A module that needs a browser: acorn has read what it declares.
      }
    }
  } finally {
    console.log = log;
  }
  if (!Pattern) throw new Error('@strudel/core did not load in Node, and its controls are computed at run time');
  for (let proto = Pattern.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    names.push(...Object.getOwnPropertyNames(proto));
  }
  names.push(...Object.keys(strudelScope ?? {}));
  return names;
}

/** The generated file's content for the clone at `buildDir`. */
export async function buildStrudelNames(buildDir) {
  const commit = pinnedCommit();
  const head = checkedOutCommit(buildDir);
  if (head !== commit) {
    throw new Error(`${buildDir} has ${head} checked out, not the pinned ${commit}: run npm run build:strudel`);
  }
  const reader = createReader(buildDir);
  const names = [];
  const entries = [];
  const fakeImporter = join(buildDir, 'website', 'src', 'repl', 'util.mjs');
  const seen = new Set();
  for (const specifier of replModules(buildDir)) {
    const entry = reader.resolveSpecifier(specifier, fakeImporter);
    if (!entry) throw new Error(`loadModules() loads ${specifier}, which is not a package of the clone`);
    entries.push(entry);
    names.push(...reader.exportsOf(entry), ...reader.sideEffectsOf(entry, seen));
  }
  // The website's own evalScope(settingPatterns, ...): theme, fontFamily, fontSize.
  names.push(...settingKeys(buildDir));
  names.push(...(await runtimeNames(entries)));

  const unique = [...new Set(names.filter((n) => typeof n === 'string' && IDENTIFIER.test(n) && n !== 'constructor'))];
  unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { strudelCommit: commit, generatedBy: 'scripts/build-strudel-names.mjs', names: unique };
}

function settingKeys(buildDir) {
  const source = readFileSync(join(buildDir, 'website', 'src', 'settings.mjs'), 'utf8');
  const match = source.match(/export const settingPatterns = \{([^}]*)\}/);
  if (!match) throw new Error('website/src/settings.mjs has no settingPatterns');
  return match[1].split(',').map((s) => s.split(':')[0].trim()).filter(Boolean);
}

export const serialize = (content) => `${JSON.stringify(content, null, 2)}\n`;

async function main(argv) {
  const check = argv[0] === '--check';
  const args = check ? argv.slice(1) : argv;
  if (args.length > 2 || args.some((a) => a.startsWith('--'))) {
    console.error('usage: node scripts/build-strudel-names.mjs [--check] [buildDir] [outFile]');
    return 2;
  }
  const [buildDir = DEFAULT_BUILD_DIR, outFile = DEFAULT_OUT_FILE] = args;
  let text;
  try {
    text = serialize(await buildStrudelNames(resolve(buildDir)));
  } catch (err) {
    console.error(`build-strudel-names: ${err.message}`);
    return 1;
  }
  const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : undefined;
  if (check) {
    if (current === text) return 0;
    console.error(`build-strudel-names: ${outFile} is not what the Strudel clone gives: run npm run build:names`);
    return 1;
  }
  if (current !== text) writeFileSync(outFile, text);
  console.log(`build-strudel-names: ${JSON.parse(text).names.length} names from Strudel ${JSON.parse(text).strudelCommit}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
