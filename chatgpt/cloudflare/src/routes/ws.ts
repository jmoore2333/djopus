import { isSessionId } from '../core/session-id';
import { jsonError } from '../http';
import { SESSION_PARAM_RE } from '../limits';
import { logEvent } from '../log';

/** What an entry's /ws accepts. */
export interface WsRules {
  /** Whether `id`, the ?session= of the request, names a session this host serves. */
  isValidSession(id: string): boolean;
  /** Whether a client may join as role=controller. When it may not, it is refused with 403. */
  allowController: boolean;
  /** Whether the Origin header has to be the origin of the request itself. A missing one is refused with 403. */
  requireSameOrigin: boolean;
}

/**
 * The rules of the first hosts: any plain session id (the default, opus-ab12, chatgpt-conv-0123456789abcdef),
 * agents and browsers alike, from any origin.
 */
export const LEGACY_WS_RULES: WsRules = {
  isValidSession: (s) => SESSION_PARAM_RE.test(s),
  allowController: true,
  requireSameOrigin: false,
};

/**
 * The rules of the app: only a 128-bit session id (/s/<id>), only a browser, and only one on the page this host
 * serves. An agent reaches a session through /mcp. The Origin check keeps another site's page from opening a socket
 * on a visitor's behalf; it is not what keeps a session private, the id is. Browser only means more than the 403
 * for role=controller: the SessionBridge obeys commands from controller sockets alone, and a socket opened here is
 * never one, so a page cannot drive the session however it talks.
 */
export const APP_WS_RULES: WsRules = {
  isValidSession: isSessionId,
  allowController: false,
  requireSameOrigin: true,
};

/** Why a /ws request was turned away. This is the whole of what is logged about it. */
export type WsRejectReason = 'invalid_session' | 'controller_role' | 'bad_origin' | 'rate_limited';

/**
 * Logs that a /ws request was refused: the reason and nothing else. Not the session id (a request that fails
 * `invalid_session` may hold a real id with a typo), and not the Origin, which says where a visitor came from.
 */
export function logWsReject(reason: WsRejectReason): void {
  logEvent('ws_reject', { reason });
}

function reject(reason: WsRejectReason, status: number, message: string): Response {
  logWsReject(reason);
  return jsonError(status, message);
}

/** The session a request names with ?session=: 'default' when it names none, or an empty one. */
export function requestedSession(url: URL): string {
  return url.searchParams.get('session') || 'default';
}

/**
 * WebSocket upgrade: /ws?session=<id>[&role=controller]. A request that passes `rules` goes on to the SessionBridge
 * of its session, which takes the role from the query: anything but controller is a browser, so a browser asks for
 * no role. The first rule a request breaks is the one it is refused for and the one that is logged.
 */
export async function handleWsUpgrade(request: Request, env: Cloudflare.Env, rules: WsRules, expectedOrigin?: string): Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const url = new URL(request.url);
  const sessionId = requestedSession(url);
  if (!rules.isValidSession(sessionId)) return reject('invalid_session', 400, 'Invalid session id');
  if (!rules.allowController && url.searchParams.get('role') === 'controller') {
    return reject('controller_role', 403, 'Agents connect through /mcp');
  }
  if (rules.requireSameOrigin && request.headers.get('Origin') !== (expectedOrigin ?? url.origin)) {
    return reject('bad_origin', 403, 'Origin not allowed');
  }

  const stub = env.SESSION_BRIDGE.get(env.SESSION_BRIDGE.idFromName(sessionId));
  return stub.fetch(request);
}
