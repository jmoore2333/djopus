// A session id is 16 random bytes, 128 bits, from crypto.getRandomValues, written as 26 characters of Crockford's
// base32 in lowercase: the digits and the letters without i, l, o and u, so that nothing in it is mistaken for
// something else when it is read out or typed. It is the only thing that lets a client into a session, so it has to
// be unguessable. The player URL is https://<host>/s/<id>.
//
// client/strudel-ws-bridge.js mints ids of the same shape in the page and has its own copy of the alphabet and of
// the pattern: that file is a classic script and cannot import this one. test/unit/bridge-session.test.ts holds the
// two together.

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** The bytes of a session id. */
const SESSION_ID_BYTES = 16;

/** What every place that takes a session id checks it against. */
export const SESSION_ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;

/**
 * The 16 bytes as 26 characters: the 128 bits in order, most significant first, five to a character. The last
 * character holds the 3 bits left over, followed by two bits of zero.
 */
export function encodeSessionId(bytes: Uint8Array): string {
  if (bytes.length !== SESSION_ID_BYTES) {
    throw new RangeError(`A session id is made of ${SESSION_ID_BYTES} bytes, not ${bytes.length}`);
  }
  let id = '';
  let buffer = 0; // the bits not written out yet, at most 4 of them between two bytes
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) id += ALPHABET[(buffer << (5 - bits)) & 31];
  return id;
}

/** A new session id. */
export function newSessionId(): string {
  return encodeSessionId(crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES)));
}

/** Whether `s` is a session id. A string only: something that merely prints as one is not. */
export function isSessionId(s: string): boolean {
  return typeof s === 'string' && SESSION_ID_RE.test(s);
}
