/**
 * PatternValidator - Validates Strudel patterns before execution
 * Provides syntax checking and error recovery for generated patterns
 */
import strudelNames from '../core/strudel-names.generated.json';

/**
 * Every name a pattern can call in the Strudel REPL that DJ Opus serves: the exports of the modules the REPL loads, the
 * names it adds itself (setcps, hush, all...) and every Pattern method, controls included. Generated from the pinned
 * Strudel build by scripts/build-strudel-names.mjs (`npm run build:strudel` runs it), never written by hand.
 */
const STRUDEL_NAMES: ReadonlySet<string> = new Set(strudelNames.names);

// Words that stand before "(" without being a call.
const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await', 'yield', 'with', 'do',
  'else', 'case', 'delete', 'void', 'in', 'of', 'instanceof', 'super', 'import', 'async', 'throw', 'class',
]);

/** Own property names of `objects`, the standard JavaScript a pattern can call as methods (Math.floor, list.map...). */
function ownNames(...objects: object[]): Set<string> {
  const names = new Set<string>();
  for (const object of objects) for (const name of Object.getOwnPropertyNames(object)) names.add(name);
  return names;
}

const JS_METHODS = ownNames(
  Math, JSON, Object, Array, Number, String, Promise, Reflect, console,
  Object.prototype, Array.prototype, String.prototype, Number.prototype, Function.prototype, Promise.prototype,
  Map.prototype, Set.prototype, Date.prototype, RegExp.prototype,
);

/**
 * `code` with every comment blanked out, and every string's content too when `blankStrings` is set (the quotes stay).
 * Blanking keeps each character's position and every line break, so positions in messages still match the input.
 * Also says which string, if any, the code leaves open.
 */
export function maskCode(code: string, blankStrings: boolean): { code: string; unclosed: "'" | '"' | '`' | null } {
  let out = '';
  let i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  while (i < code.length) {
    const char = code[i];
    const next = code[i + 1];
    if (char === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      out += blank(code.slice(i, stop));
      i = stop;
    } else if (char === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      out += blank(code.slice(i, stop));
      i = stop;
    } else if (char === "'" || char === '"' || char === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== char) {
        if (code[j] === '\\') j++;
        else if (char !== '`' && code[j] === '\n') break; // a quote never spans lines
        j++;
      }
      if (j >= code.length || code[j] !== char) {
        out += code.slice(i);
        return { code: out, unclosed: char };
      }
      const inner = code.slice(i + 1, j);
      out += char + (blankStrings ? blank(inner) : inner) + char;
      i = j + 1;
    } else {
      out += char;
      i++;
    }
  }
  return { code: out, unclosed: null };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
}

export class PatternValidator {
  /**
   * Validates a Strudel pattern for syntax errors
   * @param pattern - The pattern code to validate
   * @returns ValidationResult with errors and suggestions
   */
  validate(pattern: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    // Check for empty pattern
    if (!pattern || pattern.trim().length === 0) {
      errors.push('Pattern is empty');
      suggestions.push('Add a simple pattern like: s("bd*4")');
      return { valid: false, errors, warnings, suggestions };
    }

    // Comments say anything (an apostrophe, a "word (" ...): no check reads them. The checks below read `code`, the
    // pattern without its comments, and the call check reads it without its strings' content as well.
    const code = maskCode(pattern, false).code;

    // Check for balanced parentheses
    const parenCheck = this.checkBalancedParentheses(code);
    if (!parenCheck.valid) {
      errors.push(`Unbalanced parentheses: ${parenCheck.message}`);
      suggestions.push('Check that all ( ) [ ] { } are properly matched');
    }

    // Check for balanced quotes
    const quoteCheck = this.checkBalancedQuotes(pattern);
    if (!quoteCheck.valid) {
      errors.push(`Unbalanced quotes: ${quoteCheck.message}`);
      suggestions.push('Ensure all strings are properly quoted');
    }

    // Check for common Strudel syntax patterns
    const syntaxCheck = this.checkStrudelSyntax(code);
    errors.push(...syntaxCheck.errors);
    warnings.push(...syntaxCheck.warnings);
    suggestions.push(...syntaxCheck.suggestions);

    // Check for dangerous operations
    const safetyCheck = this.checkSafety(code);
    if (!safetyCheck.safe) {
      errors.push(...safetyCheck.errors);
    }
    warnings.push(...safetyCheck.warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      suggestions
    };
  }

  /**
   * Checks if parentheses, brackets, and braces are balanced
   */
  private checkBalancedParentheses(pattern: string): { valid: boolean; message: string } {
    const stack: string[] = [];
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const opening = Object.keys(pairs);
    const closing = Object.values(pairs);

    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i];

      if (opening.includes(char)) {
        stack.push(char);
      } else if (closing.includes(char)) {
        if (stack.length === 0) {
          return { valid: false, message: `Unexpected closing '${char}' at position ${i}` };
        }
        const last = stack.pop()!;
        if (pairs[last] !== char) {
          return { valid: false, message: `Mismatched '${last}' and '${char}' at position ${i}` };
        }
      }
    }

    if (stack.length > 0) {
      return { valid: false, message: `Unclosed '${stack[stack.length - 1]}'` };
    }

    return { valid: true, message: '' };
  }

  /**
   * Checks if quotes are balanced
   */
  private checkBalancedQuotes(pattern: string): { valid: boolean; message: string } {
    // maskCode skips comments, so an apostrophe in one is not a quote.
    const { unclosed } = maskCode(pattern, true);
    if (unclosed === "'") return { valid: false, message: 'Unclosed single quote' };
    if (unclosed === '"') return { valid: false, message: 'Unclosed double quote' };
    if (unclosed === '`') return { valid: false, message: 'Unclosed backtick' };
    return { valid: true, message: '' };
  }

  /**
   * Checks for common Strudel syntax patterns and potential issues
   */
  private checkStrudelSyntax(pattern: string): { errors: string[]; warnings: string[]; suggestions: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    // Check for common Strudel functions
    const hasSound = /s\(/.test(pattern);
    const hasNote = /note\(/.test(pattern);
    const hasStack = /stack\(/.test(pattern);

    if (!hasSound && !hasNote && !hasStack) {
      warnings.push('Pattern may not produce sound - no s(), note(), or stack() found');
      suggestions.push('Try adding s("bd*4") for a basic kick drum pattern');
    }

    // Check for common mistakes
    // s( alone: setcps(140/60/4) and .size(0.9) end in "s(" too.
    if (/(?<![\w$])s\(\s*[^"'`\s]/.test(pattern)) {
      warnings.push('Sound patterns should be in quotes: s("bd") not s(bd)');
    }

    // Check for calls to names the REPL does not have. Strudel turns one into an evaluation error that leaves the
    // player silent, so the executor refuses these before playback (see validatePlayablePattern).
    for (const name of this.unknownCalls(pattern)) {
      warnings.push(`Unknown function: ${name}`);
    }

    // Check for tempo setting
    if (!pattern.includes('setcps') && !pattern.includes('setcpm')) {
      suggestions.push('Consider adding setcps(120/60/4) to set tempo');
    }

    const sliderIssues = this.checkSliderUsage(pattern);
    errors.push(...sliderIssues.errors);
    warnings.push(...sliderIssues.warnings);
    suggestions.push(...sliderIssues.suggestions);

    const rangeIssues = this.checkRangeUsage(pattern);
    errors.push(...rangeIssues.errors);
    warnings.push(...rangeIssues.warnings);
    suggestions.push(...rangeIssues.suggestions);

    return { errors, warnings, suggestions };
  }

  /**
   * The names `code` (a pattern without comments) calls that are neither Strudel's, nor standard JavaScript, nor
   * declared by the pattern itself. Names compare as written: Strudel's are case-sensitive (degradeBy, not degradeby).
   */
  unknownCalls(code: string): string[] {
    const masked = maskCode(code, true).code;
    const declared = this.declaredNames(masked);
    const unknown = new Set<string>();
    for (const match of masked.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[1];
      let before = match.index - 1;
      while (before >= 0 && /\s/.test(masked[before])) before--;
      const isMember = masked[before] === '.'; // x.name( and x?.name(
      if (STRUDEL_NAMES.has(name) || declared.has(name)) continue;
      if (isMember ? JS_METHODS.has(name) : JS_KEYWORDS.has(name) || name in globalThis) continue;
      unknown.add(name);
    }
    return [...unknown];
  }

  /** Names the pattern declares: variables, functions, classes and parameters. */
  private declaredNames(masked: string): Set<string> {
    const names = new Set<string>();
    const add = (list: string) => {
      for (const part of list.split(',')) {
        const id = part.replace(/[{}[\].]/g, ' ').trim().split(/[\s=:]+/)[0];
        if (id && /^[A-Za-z_$][\w$]*$/.test(id)) names.add(id);
      }
    };
    for (const m of masked.matchAll(/\b(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of masked.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) add(m[1]);
    for (const m of masked.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
    for (const m of masked.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1]);
    for (const m of masked.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g)) add(m[1]);
    return names;
  }

  /**
   * Checks for slider() usage that this Strudel build cannot handle safely.
   */
  private checkSliderUsage(pattern: string): { errors: string[]; warnings: string[]; suggestions: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    const sliderCalls = pattern.match(/slider\(([^)]*)\)/g);
    if (!sliderCalls) {
      return { errors, warnings, suggestions };
    }

    sliderCalls.forEach((call) => {
      const argsText = call.slice('slider('.length, -1);
      const args = argsText.split(',').map((arg) => arg.trim());
      if (args.length === 0) return;

      const firstArg = args[0];
      if (/^["'].*["']$/.test(firstArg)) {
        errors.push(`Named slider syntax is not supported here: ${call}`);
        suggestions.push('Use slider(initialValue, min, max, step) with only numeric arguments, for example slider(0.6, 0.0, 1.0, 0.01).');
        return;
      }

      if (args.length >= 3) {
        const min = Number(args[1]);
        const max = Number(args[2]);
        if (!Number.isNaN(min) && !Number.isNaN(max) && min > max) {
          warnings.push(`Slider min is greater than max: ${call}`);
          suggestions.push('Swap the slider min and max values so the range can move normally.');
        }
      }
    });

    return { errors, warnings, suggestions };
  }

  /**
   * Checks for bare range(...) calls. In this Strudel build, range is a Pattern method,
   * so bare calls like range(0, 1).slow(8) produce confusing runtime failures.
   */
  private checkRangeUsage(pattern: string): { errors: string[]; warnings: string[]; suggestions: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    const bareRangeCalls = Array.from(pattern.matchAll(/(^|[^.\w])(range\s*\([^)]*\))/g));
    if (bareRangeCalls.length === 0) {
      return { errors, warnings, suggestions };
    }

    bareRangeCalls.forEach((match) => {
      const call = match[2];
      errors.push(`Bare range() is not supported in this Strudel build: ${call}`);
    });

    suggestions.push('Use a continuous pattern method such as sine.slow(8).range(0, 1) instead of range(0, 1).slow(8).');
    suggestions.push('For filter sweeps, try a pattern like sine.slow(8).range(200, 8000).');

    return { errors, warnings, suggestions };
  }

  /**
   * Checks for potentially dangerous operations
   */
  private checkSafety(pattern: string): { safe: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for excessive gain that could damage speakers
    // The number is the capture: matching [0-9.]+ in the whole ".gain(9)" found its leading dot, NaN, and never warned.
    for (const [, value] of pattern.matchAll(/\.gain\(\s*([0-9]*\.?[0-9]+)\s*\)/g)) {
      const gainValue = parseFloat(value);
      if (gainValue > 2) {
        warnings.push(`High gain value detected: ${gainValue} - may be too loud`);
      }
      if (gainValue > 5) {
        errors.push(`Dangerous gain value: ${gainValue} - reduced to 2.0 for safety`);
      }
    }

    // Check for potentially infinite loops
    if (/while\s*\(true\)/.test(pattern) || /for\s*\(.*;;.*\)/.test(pattern)) {
      errors.push('Potential infinite loop detected');
    }

    // Check for eval or similar dangerous functions
    if (/\beval\(/.test(pattern) || /Function\(/.test(pattern)) {
      errors.push('Use of eval() or Function() is not allowed');
    }

    return {
      safe: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Attempts to auto-fix common pattern errors
   * @param pattern - The pattern to fix
   * @returns Fixed pattern with applied corrections
   */
  autoFix(pattern: string): { pattern: string; fixes: string[] } {
    const fixes: string[] = [];
    let fixed = pattern;

    // Fix excessive gain values
    fixed = fixed.replace(/\.gain\(([0-9.]+)\)/g, (match, value) => {
      const gainValue = parseFloat(value);
      if (gainValue > 2) {
        fixes.push(`Reduced gain from ${gainValue} to 2.0`);
        return '.gain(2.0)';
      }
      return match;
    });

    // Add missing quotes around sound patterns
    fixed = fixed.replace(/s\(([a-z0-9*]+)\)/gi, (match, sound) => {
      if (!sound.includes('"') && !sound.includes("'")) {
        fixes.push(`Added quotes around sound: ${sound}`);
        return `s("${sound}")`;
      }
      return match;
    });

    return { pattern: fixed, fixes };
  }

  /**
   * Provides helpful suggestions based on pattern analysis
   * @param pattern - The pattern to analyze
   * @returns Array of suggestions for improvement
   */
  suggest(pattern: string): string[] {
    const suggestions: string[] = [];

    // Suggest adding effects if pattern is plain
    if (!pattern.includes('room') && !pattern.includes('delay') && !pattern.includes('reverb')) {
      suggestions.push('Consider adding spatial effects: .room(0.5) or .delay(0.25)');
    }

    // Suggest adding variation
    if (!pattern.includes('sometimes') && !pattern.includes('every')) {
      suggestions.push('Add variation with .sometimes() or .every()');
    }

    // Suggest structure if pattern is very simple
    if (pattern.length < 30 && pattern.includes('s(')) {
      suggestions.push('Try stacking multiple patterns with stack()');
    }

    // Suggest tempo control
    if (!pattern.includes('setcps') && !pattern.includes('setcpm')) {
      suggestions.push('Set tempo with setcps(120/60/4) at the beginning');
    }

    return suggestions;
  }
}
