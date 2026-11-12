import { MAX_BODY_BYTES } from './limits';
import { logEvent } from './log';

// limits.ts imports HttpError from here, and this file reads MAX_BODY_BYTES from
// there. Each is used only when a function runs, never while a module loads, so
// the cycle is harmless as long as it stays that way.

type Handler<E> = (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;

// The most of an error's message that withErrorHandling logs. A message can quote
// what the client sent (a note name, a value the database refused), and a log line
// should not carry a megabyte of that.
const MAX_LOGGED_MESSAGE_CHARS = 200;

/** An error the client is told about, with the HTTP status to answer with. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Reads a request body as text. The stream is read chunk by chunk, so a body over
 * `maxBytes` (or one that never ends) is cut off at the limit with 413, not read in
 * full the way request.text() would. Reading a clone leaves the original body for
 * whoever reads it next.
 */
export async function readBoundedText(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, 'Request body too large');
      }
      chunks.push(value);
    }
  }

  // Decoding after joining the chunks keeps a character that spans two of them whole.
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Reads a request body that must be a JSON object, within `maxBytes` (see readBoundedText). */
export async function readJsonBody<T>(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<T> {
  const text = await readBoundedText(request, maxBytes);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as T;
}

/**
 * The path of a request, as it may be logged. The player URL is /s/<id>, so there the path is where a session ID
 * is: everything after /s/ goes, a mistyped ID included.
 */
function loggablePath(pathname: string): string {
  return pathname.startsWith('/s/') ? '/s/:id' : pathname;
}

/**
 * Answers an HttpError with its own status and message. Anything else thrown is
 * a bug: the client gets a bare 500, and the log gets the path (not the query
 * string, which is where a session ID would be, and not the ID of a player URL,
 * see loggablePath) and the start of the message.
 */
export function withErrorHandling<E>(handler: Handler<E>): Handler<E> {
  return async (request, env, ctx) => {
    try {
      return await handler(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) return jsonError(error.status, error.message);
      logEvent('unhandled', {
        path: loggablePath(new URL(request.url).pathname),
        message: (error instanceof Error ? error.message : String(error)).slice(0, MAX_LOGGED_MESSAGE_CHARS),
      });
      return jsonError(500, 'Internal error');
    }
  };
}
