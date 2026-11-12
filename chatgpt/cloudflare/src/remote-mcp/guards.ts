import { HttpError, readBoundedText } from '../http';
import { logEvent } from '../log';

/** The most messages one POST to /mcp may carry as a JSON-RPC batch, as on the ChatGPT Worker (src/chatgpt/handler.ts). */
const MAX_BATCH_MESSAGES = 16;

/** An Mcp-Session-Id as McpAgent makes one: namespace.newUniqueId().toString(), 64 lowercase hex digits. */
const MCP_SESSION_ID_RE = /^[0-9a-f]{64}$/;

/** Why /mcp turned a request away. This is the whole of what is logged about it. */
export type McpRejectReason = 'body_too_large' | 'batch_too_large' | 'invalid_session' | 'rate_limited';

/** Logs that /mcp refused a request: the reason, and not the session id or anything else the request carried. */
export function logMcpReject(reason: McpRejectReason): void {
  logEvent('mcp_reject', { reason });
}

/**
 * What /mcp refuses before McpAgent sees a request, none of which touches a Durable Object. McpAgent checks only that
 * Content-Length is at most 4 MiB before it reads a body in full, and takes a batch of any length, so the limits of the
 * ChatGPT Worker's /mcp stand in front of it. In this order:
 *
 * - a POST body over 128 KB: 413, by the bounded read of src/http.ts, which throws the HttpError that
 *   withErrorHandling answers with { error: 'Request body too large' }. The read is of a clone, so McpAgent reads
 *   the original. A body that is not JSON is McpAgent's to refuse.
 * - a JSON-RPC batch of more than 16 messages: 400.
 * - an mcp-session-id that is not one McpAgent could have made: 404, as for a session McpAgent does not know, so that
 *   a client starts a new one. McpAgent would start the Durable Object of whatever the header names to find out.
 *
 * Returns the answer to a request it refuses, and null for one that goes on (to the rate limit, then McpAgent).
 */
export async function refuseMcpRequest(request: Request): Promise<Response | null> {
  if (request.method === 'POST') {
    let text: string;
    try {
      text = await readBoundedText(request.clone());
    } catch (error) {
      if (error instanceof HttpError) logMcpReject('body_too_large');
      throw error;
    }
    if (messageCount(text) > MAX_BATCH_MESSAGES) {
      logMcpReject('batch_too_large');
      return Response.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Batch too large' }, id: null }, { status: 400 });
    }
  }

  const sessionId = request.headers.get('mcp-session-id');
  if (sessionId !== null && !MCP_SESSION_ID_RE.test(sessionId)) {
    logMcpReject('invalid_session');
    return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }, { status: 404 });
  }
  return null;
}

/** How many JSON-RPC messages a body holds: the length of a batch, 1 for anything else, 0 when it is not JSON. */
function messageCount(text: string): number {
  try {
    const body: unknown = JSON.parse(text);
    return Array.isArray(body) ? body.length : 1;
  } catch {
    return 0;
  }
}
