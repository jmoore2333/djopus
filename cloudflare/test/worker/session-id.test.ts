import { afterEach, expect, it, vi } from 'vitest';
import { encodeSessionId, isSessionId, newSessionId, SESSION_ID_RE } from '../../src/core/session-id';

afterEach(() => {
  vi.restoreAllMocks();
});

// A session id is 16 random bytes, 128 bits, written as 26 characters of Crockford's base32 in lowercase: the digits
// and the letters without i, l, o and u. It is the only thing that lets a client into a session, so it has to be
// unguessable, and everything that takes one checks it with the same pattern.

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** The id of 16 bytes, worked out from a BigInt instead of a bit buffer, so that the two ways to do it can disagree. */
function viaBigInt(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  n <<= 2n; // 128 bits become 130: 26 characters of 5 bits, the last one with two bits of padding
  let id = '';
  for (let i = 0; i < 26; i++) {
    id = ALPHABET[Number(n & 31n)] + id;
    n >>= 5n;
  }
  return id;
}

it('newSessionId is 26 base32 chars and unique', () => {
  const ids = Array.from({ length: 1000 }, newSessionId);
  expect(ids.every((id) => SESSION_ID_RE.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(1000);
});

it('legacy ids are not session ids', () => {
  expect(isSessionId('opus-ab12')).toBe(false);
  expect(isSessionId('chatgpt-conv-0123456789abcdef')).toBe(false);
  expect(isSessionId('default')).toBe(false);
});

it('SESSION_ID_RE is the 26 characters of lowercase Crockford base32', () => {
  expect(SESSION_ID_RE.source).toBe('^[0-9a-hjkmnp-tv-z]{26}$');
  expect(SESSION_ID_RE.flags).toBe('');
});

it('isSessionId takes 26 characters of the alphabet and nothing else', () => {
  const id = '0123456789abcdefghjkmnpqrs';
  expect(id).toHaveLength(26);
  expect(isSessionId(id)).toBe(true);
  expect(isSessionId(ALPHABET.slice(0, 26))).toBe(true);
  expect(isSessionId(ALPHABET.slice(6))).toBe(true); // the last 26

  const refused: Array<[label: string, value: string]> = [
    ['empty', ''],
    ['25 characters', id.slice(1)],
    ['27 characters', id + '0'],
    ['uppercase', id.toUpperCase()],
    ['trailing newline', id + '\n'],
    ['leading space', ' ' + id.slice(1)],
    ['a hyphen', id.slice(0, 25) + '-'],
    ['a look-alike beyond ASCII', id.slice(0, 25) + 'ǀ'],
    ['two ids', id + id],
  ];
  for (const letter of 'ilou') refused.push([`the letter ${letter}, which Crockford leaves out`, id.slice(0, 25) + letter]);
  for (const [label, value] of refused) expect(isSessionId(value), label).toBe(false);
});

it('isSessionId is false for something that is not a string, even when it prints as an id', () => {
  const lookalike = { toString: () => '0123456789abcdefghjkmnpqrs' };
  expect(isSessionId(lookalike as unknown as string)).toBe(false);
  expect(isSessionId(undefined as unknown as string)).toBe(false);
  expect(isSessionId(null as unknown as string)).toBe(false);
});

it('encodeSessionId writes the 16 bytes as 128 bits, most significant first, padded with two zero bits', () => {
  expect(encodeSessionId(new Uint8Array(16))).toBe('0'.repeat(26));
  expect(encodeSessionId(new Uint8Array(16).fill(0xff))).toBe('z'.repeat(25) + 'w'); // 11111 x 25, then 111 and 00
  expect(encodeSessionId(Uint8Array.from({ length: 16 }, (_, i) => i))).toBe('000g40r40m30e209185gr38e1w');

  const samples = [
    Uint8Array.from({ length: 16 }, (_, i) => i * 17 + 3),
    Uint8Array.from({ length: 16 }, (_, i) => 255 - i),
    Uint8Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 0x80 : 0x01)),
    ...Array.from({ length: 50 }, () => crypto.getRandomValues(new Uint8Array(16))),
  ];
  for (const bytes of samples) expect(encodeSessionId(bytes)).toBe(viaBigInt(bytes));
});

it('encodeSessionId refuses anything but 16 bytes', () => {
  for (const length of [0, 1, 15, 17, 32]) {
    expect(() => encodeSessionId(new Uint8Array(length)), String(length)).toThrow(RangeError);
  }
});

it('newSessionId takes its 16 bytes from crypto.getRandomValues and never from Math.random', () => {
  const random = vi.spyOn(Math, 'random');
  const secure = vi.spyOn(crypto, 'getRandomValues');
  const id = newSessionId();
  expect(random).not.toHaveBeenCalled();
  expect(secure).toHaveBeenCalledTimes(1);
  const filled = secure.mock.calls[0][0] as Uint8Array;
  expect(filled).toBeInstanceOf(Uint8Array);
  expect(filled).toHaveLength(16);
  expect(id).toBe(viaBigInt(filled));
});
