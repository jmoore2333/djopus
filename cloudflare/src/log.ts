// One JSON object per line, so Workers Logs indexes every field. Callers pass
// ids and counts, never a full session ID or any pattern code: a session shows
// up only as its sessionHash. A field called event cannot replace the event name.
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ...fields, event }));
}

// Used when no key is given. It is random and made once per isolate, so it never
// leaves memory and a restart changes it.
let isolateKey: CryptoKey | undefined;

function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function hmacKey(key: string | undefined): Promise<CryptoKey> {
  if (key) return importHmacKey(new TextEncoder().encode(key));
  if (!isolateKey) {
    const created = await importHmacKey(crypto.getRandomValues(new Uint8Array(32)));
    isolateKey ??= created; // a call that started at the same time may have stored one already
  }
  return isolateKey;
}

// The first 8 hex characters of HMAC-SHA256(key, sessionId): enough to tell
// sessions apart in logs without revealing the ID. The key is what keeps the
// short hash from being undone: legacy IDs have few possibilities (opus- plus 4
// characters, chatgpt- plus 8 hex), and without a secret anyone who can read the
// logs could try them all. An empty key counts as none. Without one the key is
// random per isolate, so a hash made with it is only stable if it is stored.
export async function sessionHash(sessionId: string, key?: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(key), new TextEncoder().encode(sessionId));
  return [...new Uint8Array(mac).subarray(0, 4)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
