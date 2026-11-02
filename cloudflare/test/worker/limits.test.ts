import { expect, it } from 'vitest';
import { HttpError } from '../../src/http';
import {
  byteLength,
  checkCode,
  checkName,
  checkSessionId,
  checkTags,
  MAX_BODY_BYTES,
  MAX_CODE_BYTES,
  MAX_FRAME_BYTES,
  MAX_NAME_CHARS,
  MAX_TAG_CHARS,
  MAX_TAGS,
  SESSION_PARAM_RE,
} from '../../src/limits';

/** The HttpError that `run` throws. Fails the test when it throws anything else, or nothing. */
function httpErrorOf(run: () => unknown): HttpError {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected an HttpError, but nothing was thrown');
}

it('has the limits the plan sets', () => {
  expect([MAX_CODE_BYTES, MAX_NAME_CHARS, MAX_TAGS, MAX_TAG_CHARS, MAX_FRAME_BYTES, MAX_BODY_BYTES])
    .toEqual([65_536, 128, 10, 32, 131_072, 131_072]);
});

it('byteLength counts UTF-8 bytes', () => {
  expect([byteLength(''), byteLength('abc'), byteLength('€'), byteLength('😀')]).toEqual([0, 3, 3, 4]);
});

// --- checkCode ---

it('limits count bytes, not characters', () => {
  expect(() => checkCode('a'.repeat(65_536), 'pattern')).not.toThrow();
  expect(() => checkCode('€'.repeat(21_846), 'pattern')).toThrow(/too large/); // 21,846 chars = 65,538 bytes
  expect(() => checkCode('€'.repeat(21_845) + 'a', 'pattern')).not.toThrow(); // exactly 65,536 bytes
});

it('checkCode returns the code it was given', () => {
  expect(checkCode('s("bd*4")', 'pattern')).toBe('s("bd*4")');
  expect(checkCode('', 'pattern')).toBe('');
});

it('checkCode answers 413 for code over the limit, naming the field', () => {
  const error = httpErrorOf(() => checkCode('a'.repeat(65_537), 'content'));
  expect(error.status).toBe(413);
  expect(error.message).toMatch(/^content is too large/);
});

it('checkCode answers 400 for a value that is not a string', () => {
  for (const value of [undefined, null, 42, true, {}, ['s("bd")']]) {
    const error = httpErrorOf(() => checkCode(value, 'pattern'));
    expect(error.status).toBe(400);
    expect(error.message).toBe('pattern must be a string');
  }
});

// --- checkName ---

it('checkName accepts a name up to 128 characters', () => {
  expect(checkName('x'.repeat(128))).toBe('x'.repeat(128));
  expect(checkName('my pattern')).toBe('my pattern');
});

it('checkName answers 400 for a name that is too long, empty or not a string', () => {
  expect(httpErrorOf(() => checkName('x'.repeat(129)))).toMatchObject({ status: 400, message: expect.stringContaining('128') });
  for (const value of ['', undefined, null, 42, ['a'], {}]) {
    expect(httpErrorOf(() => checkName(value)).status).toBe(400);
  }
});

// --- checkTags ---

it('checkTags treats missing tags as none and returns the tags it was given', () => {
  expect(checkTags(undefined)).toEqual([]);
  expect(checkTags(null)).toEqual([]);
  expect(checkTags([])).toEqual([]);
  expect(checkTags(['techno', 'acid'])).toEqual(['techno', 'acid']);
});

it('checkTags accepts 10 tags of 32 characters', () => {
  const tags = Array.from({ length: 10 }, (_, i) => String(i).padEnd(32, 'x'));
  expect(checkTags(tags)).toEqual(tags);
});

it('checkTags answers 400 for too many tags, a tag that is too long, or anything that is not a list of strings', () => {
  expect(httpErrorOf(() => checkTags(Array.from({ length: 11 }, (_, i) => `t${i}`)))).toMatchObject({
    status: 400, message: expect.stringContaining('10'),
  });
  expect(httpErrorOf(() => checkTags(['x'.repeat(33)]))).toMatchObject({
    status: 400, message: expect.stringContaining('32'),
  });
  for (const value of ['techno', 42, {}, [1], ['a', null], [['a']]]) {
    expect(httpErrorOf(() => checkTags(value)).status).toBe(400);
  }
});

// --- checkSessionId ---

it('checkSessionId treats a missing session as none and returns a plain one', () => {
  expect(checkSessionId(undefined)).toBeNull();
  expect(checkSessionId(null)).toBeNull();
  expect(checkSessionId('chatgpt-conv-0123456789abcdef')).toBe('chatgpt-conv-0123456789abcdef');
  expect(checkSessionId('x'.repeat(64))).toBe('x'.repeat(64));
});

it('checkSessionId answers 400 for anything else', () => {
  for (const value of ['', 'bad id', "a'b", 'x'.repeat(65), 42, true, {}, ['opus-ab12']]) {
    const error = httpErrorOf(() => checkSessionId(value));
    expect(error.status, JSON.stringify(value)).toBe(400);
    expect(error.message).toMatch(/^session_id must be a session id/);
  }
});

// --- SESSION_PARAM_RE ---

it('SESSION_PARAM_RE accepts every session format in use today', () => {
  for (const id of ['default', 'opus-ab12', 'chatgpt-conv-0123456789abcdef', 'chatgpt-3f9a1c2b', 'My_Session-9', 'x'.repeat(64)]) {
    expect(SESSION_PARAM_RE.test(id), id).toBe(true);
  }
});

it('SESSION_PARAM_RE rejects anything that is not 1 to 64 of letters, digits, _ and -', () => {
  const rejected = ['', 'x'.repeat(65), 'bad id', "a'b", 'a<b', 'a/b', 'a.b', 'a?b', 'a%20b', 'é', 'a\nb', 'opus-ab12\n'];
  for (const id of rejected) expect(SESSION_PARAM_RE.test(id), JSON.stringify(id)).toBe(false);
});
