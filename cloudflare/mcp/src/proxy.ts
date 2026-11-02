import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

const VERSION = '0.3.0';

// What a failure message keeps of what the remote answered: a challenge page is a few KB of HTML.
const MAX_REASON_LENGTH = 500;

export interface ProxyOptions {
  /** The DJ Opus host, such as https://play.djopus.party. Its MCP server is at /mcp. */
  remoteUrl: string;
  /** The transport to the agent: stdio, in the process. */
  local: Transport;
  /** How long a request to the remote may go without an answer. The SDK's default is 60 s. */
  requestTimeoutMs?: number;
}

export interface ProxyHandle {
  /** Lets go of the agent and of the remote. */
  close(): Promise<void>;
}

/** The MCP endpoint of a DJ Opus host, or the error to answer with when `remoteUrl` is not an address. */
function endpointOf(remoteUrl: string): URL | Error {
  try {
    return new URL('/mcp', remoteUrl);
  } catch {
    return new Error('not a valid URL (DJOPUS_URL must be an address such as https://play.djopus.party)');
  }
}

/** What went wrong, in a line: for the status of an HTTP answer and the cause behind fetch's "fetch failed". */
function describeError(error: unknown): string {
  const text = error instanceof StreamableHTTPError ? describeHttpError(error) : describeCauses(error);
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH)}...` : text;
}

// The SDK keeps the status of the answer in a field and only the body in the message.
function describeHttpError(error: StreamableHTTPError): string {
  const answer = error.message.replace(/^Streamable HTTP error: /, '');
  return error.code !== undefined && error.code > 0 ? `HTTP ${error.code}: ${answer}` : answer;
}

// fetch fails with "fetch failed", and the reason (ECONNREFUSED, ENOTFOUND, a certificate) is in the causes.
function describeCauses(error: unknown): string {
  const parts: string[] = [];
  for (let cause = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth++) {
    const nested = cause instanceof AggregateError ? cause.errors.map((inner) => (inner instanceof Error ? inner.message : String(inner))) : [];
    parts.push([cause.message, ...nested].filter(Boolean).join('; ') || cause.name);
  }
  return parts.length > 0 ? parts.join(': ') : String(error);
}

/** The remote answers 404 to a request that names an MCP session it does not know, as for one it ended after 30 idle days. */
function isSessionGone(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
}

/**
 * A JSON-RPC error that the remote itself answered a request with, ready to be thrown from a handler of the local server
 * so that it goes on to the agent as it came: same code, same message, same data. The SDK throws it as an McpError, which
 * puts "MCP error <code>: " in front of the message, and the message to pass on is the one without it. The two codes the
 * client makes up itself (a request that timed out, a connection that closed) are not answers of the remote.
 */
function remoteAnswer(error: unknown): (Error & { code: number; data: unknown }) | undefined {
  if (!(error instanceof McpError)) return undefined;
  if (error.code === ErrorCode.RequestTimeout || error.code === ErrorCode.ConnectionClosed) return undefined;
  const prefix = `MCP error ${error.code}: `;
  const message = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  return Object.assign(new Error(message), { code: error.code, data: error.data });
}

function closeQuietly(client: Client): Promise<void> {
  return client.close().catch(() => {});
}

/** One connection to the remote: one MCP session there. */
interface Connection {
  /** From the start of the attempt, so that closing the proxy also stops an attempt that is waiting for the remote. */
  client: Client;
  /** The connection itself, once the remote has answered initialize. */
  ready: Promise<Connection>;
  /** The requests that are on it and have no answer yet. */
  inFlight: number;
  /** Set when a new connection has taken its place: it takes no more requests, and closes when it has none in flight. */
  replaced: boolean;
}

/**
 * Serves the agent on `opts.local` with the tools of the DJ Opus MCP server at `<remoteUrl>/mcp`, which is where they
 * live: tools/list and tools/call go to it and its answer comes back as it is. The agent's handshake does not wait for
 * the remote. The connection to it is made by the first request, so a proxy starts whether or not the remote can be
 * reached, and when it cannot, every request says so: a call comes back as an isError result and a tool list as an
 * error, each with the address and what went wrong, and the next request tries again.
 */
export async function createProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const endpoint = endpointOf(opts.remoteUrl);
  const where = endpoint instanceof URL ? endpoint.href : opts.remoteUrl;
  const failure = (error: unknown): string => `Request to DJ Opus at ${where} failed: ${describeError(error)}`;

  let current: Connection | undefined;

  function connect(): Connection {
    const client = new Client({ name: 'djopus-mcp-proxy', version: VERSION }, { capabilities: {} });
    const started =
      endpoint instanceof URL
        ? client.connect(new StreamableHTTPClientTransport(endpoint), { timeout: opts.requestTimeoutMs })
        : Promise.reject(endpoint);
    const made: Connection = {
      client,
      inFlight: 0,
      replaced: false,
      ready: started.then(
        () => made,
        (error: unknown) => {
          // A connection that did not come up is not kept: the next request makes another attempt.
          if (current === made) current = undefined;
          throw error;
        },
      ),
    };
    return made;
  }

  /** The connection to the remote: the one there is, or a new one. Requests that arrive together share it. */
  function connected(): Promise<Connection> {
    current ??= connect();
    return current.ready;
  }

  /** The connection in place of `stale`, which is the one there already when another request has replaced it. */
  function replace(stale: Connection): Promise<Connection> {
    if (current === stale) current = undefined;
    stale.replaced = true;
    retire(stale);
    return connected();
  }

  // A replaced connection is closed once its requests have their answers: the other requests that were on it when one of
  // them was answered 404 are about to be answered the same, and closing it now would cut them off first.
  function retire(replaced: Connection): void {
    if (replaced.replaced && replaced.inFlight === 0) void closeQuietly(replaced.client);
  }

  async function sendOn<T>(on: Connection, send: (client: Client) => Promise<T>): Promise<T> {
    on.inFlight++;
    try {
      return await send(on.client);
    } finally {
      on.inFlight--;
      retire(on);
    }
  }

  /**
   * Sends a request on the connection to the remote. When the remote answers 404, it does not know the MCP session any
   * more (it ends them after 30 idle days), and it ran nothing for the request: so the request goes again on a new
   * session, once. Any other failure stays one: a request that may have run is not sent twice.
   */
  async function viaRemote<T>(send: (client: Client) => Promise<T>): Promise<T> {
    const first = await connected();
    try {
      return await sendOn(first, send);
    } catch (error) {
      if (!isSessionGone(error)) throw error;
    }
    return sendOn(await replace(first), send);
  }

  function release(): Promise<void> {
    const held = current;
    current = undefined;
    return held ? closeQuietly(held.client) : Promise.resolve();
  }

  const server = new Server({ name: 'djopus', version: VERSION }, { capabilities: { tools: {} } });
  server.onclose = () => {
    void release();
  };

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    try {
      return await viaRemote((client) =>
        client.request({ method: 'tools/list', params: request.params }, ListToolsResultSchema, { timeout: opts.requestTimeoutMs }),
      );
    } catch (error) {
      throw remoteAnswer(error) ?? new Error(failure(error));
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await viaRemote((client) =>
        client.request({ method: 'tools/call', params: request.params }, CallToolResultSchema, { timeout: opts.requestTimeoutMs }),
      );
    } catch (error) {
      const answer = remoteAnswer(error);
      if (answer) throw answer;
      return { content: [{ type: 'text' as const, text: failure(error) }], isError: true };
    }
  });

  await server.connect(opts.local);

  return {
    async close() {
      await Promise.all([release(), server.close()]);
    },
  };
}
