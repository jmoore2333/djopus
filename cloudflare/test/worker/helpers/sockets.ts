import { env, exports } from 'cloudflare:workers';

type Json = Record<string, unknown>;
type Match = string | ((message: Json) => boolean);

export interface TestSocket {
  /** The first unconsumed JSON frame that matches: a string matches `type`, a predicate sees the parsed frame. */
  next(match: Match, timeoutMs?: number): Promise<Json>;
  /** The first unconsumed frame whose text is exactly `text` (for non-JSON frames such as `pong`). */
  nextRaw(text: string, timeoutMs?: number): Promise<string>;
  send(msg: object | string): void;
  /** Closes the socket and resolves with the code of the close event. */
  close(code?: number, reason?: string): Promise<number>;
}

const DEFAULT_TIMEOUT_MS = 2000;

interface Frame {
  text: string;
  json: Json | null;
  taken: boolean;
}

interface Waiter {
  accepts(frame: Frame): boolean;
  resolve(frame: Frame): void;
}

export function bridgeStub(session: string): DurableObjectStub {
  return env.SESSION_BRIDGE.get(env.SESSION_BRIDGE.idFromName(session));
}

/**
 * Upgrades directly on the Durable Object stub, the internal path the executor
 * uses, so tests of the DO do not depend on the Worker's public /ws rules. The URL
 * carries no session id, as the executor's does: the object knows its own name.
 */
export async function openSession(session: string, role: 'browser' | 'controller'): Promise<TestSocket> {
  const res = await bridgeStub(session).fetch(
    `https://internal/ws?role=${role}`,
    { headers: { Upgrade: 'websocket' } },
  );
  return adopt(res);
}

/** Upgrades through the Worker. Rejects with an error carrying `status` when the answer is not 101. */
export async function openWorkerSocket(
  pathAndQuery: string,
  init?: { headers?: Record<string, string> },
): Promise<TestSocket> {
  const res = await exports.default.fetch('https://djopus.test' + pathAndQuery, {
    headers: { Upgrade: 'websocket', ...init?.headers },
  });
  return adopt(res);
}

async function adopt(res: Response): Promise<TestSocket> {
  const ws = res.webSocket;
  if (res.status !== 101 || !ws) {
    const detail = (await res.text()).slice(0, 200);
    throw Object.assign(new Error(`WebSocket upgrade answered HTTP ${res.status}: ${detail}`), { status: res.status });
  }
  return wrap(ws);
}

function wrap(ws: WebSocket): TestSocket {
  const frames: Frame[] = [];
  const waiters = new Set<Waiter>();
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener('close', (event) => resolve(event.code));
  });

  ws.addEventListener('message', (event) => {
    const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
    const frame: Frame = { text, json: parseObject(text), taken: false };
    frames.push(frame);
    for (const waiter of waiters) {
      if (waiter.accepts(frame)) {
        frame.taken = true;
        waiters.delete(waiter);
        waiter.resolve(frame);
        return;
      }
    }
  });
  ws.accept();

  function take(accepts: (frame: Frame) => boolean, label: string, timeoutMs: number): Promise<Frame> {
    const ready = frames.find((frame) => !frame.taken && accepts(frame));
    if (ready) {
      ready.taken = true;
      return Promise.resolve(ready);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs);
      const waiter: Waiter = {
        accepts,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      waiters.add(waiter);
    });
  }

  return {
    async next(match, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const frame = await take((f) => f.json !== null && matches(match, f.json), String(match), timeoutMs);
      return frame.json as Json;
    },
    async nextRaw(text, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return (await take((f) => f.text === text, text, timeoutMs)).text;
    },
    send(msg) {
      ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    },
    close(code, reason) {
      ws.close(code, reason);
      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for the close event')), DEFAULT_TIMEOUT_MS);
        void closed.then((closeCode) => {
          clearTimeout(timer);
          resolve(closeCode);
        });
      });
    },
  };
}

function parseObject(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

// A predicate that throws on a frame it was not written for (a missing payload,
// say) simply does not match that frame.
function matches(match: Match, message: Json): boolean {
  if (typeof match === 'string') return message.type === match;
  try {
    return match(message);
  } catch {
    return false;
  }
}
