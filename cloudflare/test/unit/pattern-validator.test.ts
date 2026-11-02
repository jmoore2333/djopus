import { existsSync, readFileSync } from 'node:fs';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildStrudelNames, pinnedCommit, serialize } from '../../scripts/build-strudel-names.mjs';
import committed from '../../src/core/strudel-names.generated.json';
import library from '../../src/library.generated.json';
import { PatternGenerator } from '../../src/services/PatternGenerator';
import { PatternValidator } from '../../src/services/PatternValidator';

// The validator refuses a call to a name the Strudel REPL does not have (the executor makes that fatal before playback),
// and takes the names from the pinned Strudel build (scripts/build-strudel-names.mjs), not from a hand-written list.

const validator = new PatternValidator();
const unknownOf = (pattern: string) =>
  validator.validate(pattern).warnings.filter((w) => w.startsWith('Unknown function:'));

const CHEATSHEET = fileURLToPath(new URL('../../../skills/dj-opus/references/strudel-cheatsheet.md', import.meta.url));
const GENERATED_FILE = fileURLToPath(new URL('../../src/core/strudel-names.generated.json', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));
const BUILD_DIR = env.STRUDEL_BUILD_DIR ?? fileURLToPath(new URL('../../.strudel-build', import.meta.url));

describe('known names', () => {
  it('accepts the dream-trance pattern the hosted app refused (lpq, size, delaytime, delayfeedback, pianoroll)', () => {
    const pattern = [
      'setcps(138/60/4)',
      'stack(',
      '  note("<a3 f3 c4 g3>").s("supersaw").lpf(1800).lpq(8).room(0.7).size(0.9),',
      '  note("a4 c5 e5 a5").s("triangle").delay(0.5).delaytime(3/8).delayfeedback(0.45),',
      ').pianoroll({ cycles: 4 })',
    ].join('\n');
    expect(validator.validate(pattern)).toMatchObject({ valid: true, warnings: [] });
  });

  it('compares names as written, so camelCase Strudel names are known', () => {
    for (const name of ['degradeBy', 'echoWith', 'chooseWith', 'loopAt', 'juxBy', 'compressorRatio']) {
      expect(unknownOf(`s("bd*4").${name}(0.5)`), name).toEqual([]);
    }
    // Strudel names are case-sensitive: the lowercase spelling is not one of them.
    expect(unknownOf('s("bd*4").degradeby(0.5)')).toEqual(['Unknown function: degradeby']);
  });

  it('knows names the REPL adds itself, widgets, signals and sample loading', () => {
    const pattern = 'samples("github:tidalcycles/dirt-samples")\nsetcpm(120)\nall(x => x.gain(0.8))\n'
      + 's("bd").scope()._pianoroll().punchcard().spiral().pitchwheel().color("red")\n'
      + 'note(irand(8)).cutoff(slider(0.5, 0, 1))\nhush()';
    expect(unknownOf(pattern)).toEqual([]);
  });

  it('still refuses a name Strudel does not have, as a method and as a call', () => {
    expect(unknownOf('s("bd").nosuchfn()')).toEqual(['Unknown function: nosuchfn']);
    expect(unknownOf('lpfq(800)')).toEqual(['Unknown function: lpfq']);
    // Not Strudel, though the old hand-written list had them.
    expect(unknownOf('s("bd").reverb(0.5).euclidLegacy(3, 8)')).toEqual([
      'Unknown function: reverb', 'Unknown function: euclidLegacy',
    ]);
  });

  it('allows standard JavaScript and what the pattern declares', () => {
    const pattern = [
      'const wobble = (pat, amt) => pat.lpf(sine.range(200, 200 + Math.floor(amt * 1000)))',
      'function swell(p) { return p.gain(0.8) }',
      'let notes = ["c3", "e3"].map((n) => n.toUpperCase()).join(" ")',
      'wobble(swell(note(notes).s("sawtooth")), parseFloat("0.5"))',
    ].join('\n');
    expect(unknownOf(pattern)).toEqual([]);
  });
});

describe('comments and strings', () => {
  it('reads no comment: an apostrophe or a "word (" in one is neither a quote nor a call', () => {
    const pattern = [
      "// the lead's gaps leave room for chaos (on purpose)",
      '/* a block comment: wobble (later) and it\'s fine */',
      's("bd*4").gain(0.8) // more chaos (soon)',
    ].join('\n');
    expect(validator.validate(pattern)).toMatchObject({ valid: true, errors: [], warnings: [] });
  });

  it('reads no call inside a string: mini-notation euclid is not a function', () => {
    expect(unknownOf('s("bd(3,8) hh(5,8,2)")')).toEqual([]);
    expect(unknownOf("note('c3 e3').s(`sawtooth`)")).toEqual([]);
  });

  it('still finds unclosed quotes and unbalanced brackets in code', () => {
    expect(validator.validate('s("bd)').errors).toContain('Unbalanced quotes: Unclosed double quote');
    expect(validator.validate("s('bd").errors).toContain('Unbalanced quotes: Unclosed single quote');
    expect(validator.validate('s("bd"').errors.some((e) => e.startsWith('Unbalanced parentheses'))).toBe(true);
    // A comment's bracket does not unbalance the code, and a gain in a comment is not a gain.
    expect(validator.validate('s("bd") // ) ] .gain(9)')).toMatchObject({ valid: true });
    expect(validator.validate('s("bd").gain(9)').valid).toBe(false);
  });
});

describe('the skill cheatsheet', () => {
  it('validates every function its code examples call', () => {
    const text = readFileSync(CHEATSHEET, 'utf8');
    const blocks = [...text.matchAll(/```javascript\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(20);
    const unknown = blocks.flatMap((block) => unknownOf(block));
    expect(unknown).toEqual([]);
    // Each `.name(` of the cheatsheet, one at a time, for a message that names it.
    const names = new Set(blocks.flatMap((block) => [...block.matchAll(/\.([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1])));
    expect(names.size).toBeGreaterThan(100);
    for (const name of names) expect(unknownOf(`s("bd").${name}(1)`), name).toEqual([]);
  });
});

describe('the pattern generator', () => {
  it('generates only names Strudel has', () => {
    const generator = new PatternGenerator();
    for (const style of ['techno', 'house', 'trance', 'dnb', 'ambient', 'jazz', 'intelligent_dnb', 'trip_hop', 'boom_bap', 'dubstep']) {
      expect(unknownOf(generator.generateCompletePattern(style, 'A', 128)), style).toEqual([]);
    }
  });
});

describe('the read-only library', () => {
  it('calls only names Strudel has', () => {
    for (const entry of library) expect(unknownOf(entry.content), entry.name).toEqual([]);
  });
});

describe('the generated name list', () => {
  it('is sorted, without duplicates, and from the pinned Strudel commit', () => {
    expect(committed.strudelCommit).toBe(pinnedCommit());
    const sorted = [...new Set(committed.names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(committed.names).toEqual(sorted);
    expect(committed.names.length).toBeGreaterThan(1000);
  });

  it('is generated by build:strudel', () => {
    const scripts = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).scripts as Record<string, string>;
    expect(scripts['build:strudel']).toMatch(/&& npm run build:names$/);
    expect(scripts['build:names']).toBe('node scripts/build-strudel-names.mjs');
  });

  // Needs the clone that `npm run build:strudel` makes (or STRUDEL_BUILD_DIR): a clean checkout has none.
  it.skipIf(!existsSync(`${BUILD_DIR}/.git/HEAD`))('equals what the Strudel clone gives', { timeout: 60_000 }, async () => {
    expect(serialize(await buildStrudelNames(BUILD_DIR))).toBe(readFileSync(GENERATED_FILE, 'utf8'));
  });
});
