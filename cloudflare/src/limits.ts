// http.ts imports MAX_BODY_BYTES from this file, so the two import each other: see the note at the top of http.ts.
import { HttpError } from './http';

// Size limits shared by the Worker and the Durable Object. Code, frames and
// request bodies count UTF-8 bytes, because that is what the storage and the
// wire carry. Names and tags count characters, as String.length does.
export const MAX_CODE_BYTES = 65_536;
export const MAX_NAME_CHARS = 128;
export const MAX_TAGS = 10;
export const MAX_TAG_CHARS = 32;
export const MAX_FRAME_BYTES = 131_072;
export const MAX_BODY_BYTES = 131_072;

// The session of /ws and /widget (the `session` parameter) and of /mcp (the
// mcp-session-id header). Every session ID in use today fits, and nothing in it
// can break out of an HTML or JavaScript context.
export const SESSION_PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** The code, when it is a string within MAX_CODE_BYTES. `field` names it in the error. */
export function checkCode(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  const bytes = byteLength(value);
  if (bytes > MAX_CODE_BYTES) {
    throw new HttpError(413, `${field} is too large (${bytes} bytes, the limit is ${MAX_CODE_BYTES})`);
  }
  return value;
}

export function checkName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, 'name must be a non-empty string');
  if (value.length > MAX_NAME_CHARS) {
    throw new HttpError(400, `name is too long (the limit is ${MAX_NAME_CHARS} characters)`);
  }
  return value;
}

/** The tags, or none when there are none. */
export function checkTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((tag): tag is string => typeof tag === 'string')) {
    throw new HttpError(400, 'tags must be an array of strings');
  }
  if (value.length > MAX_TAGS) throw new HttpError(400, `too many tags (the limit is ${MAX_TAGS})`);
  if (value.some((tag) => tag.length > MAX_TAG_CHARS)) {
    throw new HttpError(400, `a tag is too long (the limit is ${MAX_TAG_CHARS} characters)`);
  }
  return value;
}

/** The session_id stored with a pattern: a plain session ID, or null when there is none. */
export function checkSessionId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SESSION_PARAM_RE.test(value)) {
    throw new HttpError(400, 'session_id must be a session id (1 to 64 letters, digits, _ or -)');
  }
  return value;
}
