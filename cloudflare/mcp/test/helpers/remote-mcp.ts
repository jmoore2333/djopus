import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, UrlElicitationRequiredError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// What DJ Opus's /mcp answers a request that names an MCP session it does not know (agents' McpAgent, and the guard in
// front of it): a 404 with this JSON-RPC error.
const SESSION_NOT_FOUND = JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
const SESSION_ID_REQUIRED = JSON.stringify({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
  id: null,
});

/** What the remote can be told to answer with, in place of what it would have answered. */
export interface RawAnswer {
  status: number;
  contentType: string;
  body: string;
}

/** Or to not answer at all: the request is held open until the remote closes. */
export type Answer = RawAnswer | 'silence';

export interface RemoteMcp {
  /** http://127.0.0.1:<port>, which is what DJOPUS_URL holds. */
  url: string;
  /** How many initialize requests the remote has received, whatever it answered. */
  initializeCount(): number;
  /** How many tools/call requests it has received, whatever it answered. */
  toolCallCount(): number;
  /** The params of every request of this JSON-RPC method that it has received, in order, whatever it answered. */
  received(method: string): unknown[];
  /** How many GET streams it holds open: the channel an MCP client keeps for the server's own messages. */
  openStreams(): number;
  /** How many GET streams it has been asked for, closed ones included. */
  streamsOpened(): number;
  /**
   * Forgets every MCP session, as the real remote does after 30 idle days: a request that names one gets the 404. Streams
   * that are open stay open, because a stream can outlive the session it was opened for.
   */
  expireSessions(): void;
  /** While set, every request that names an MCP session gets the 404, whether the remote knows the session or not. */
  refuseSessions(refuse: boolean): void;
  /** While set, a tools/call request gets the 404, whether the remote knows its session or not. The rest goes on as usual. */
  refuseToolCalls(refuse: boolean): void;
  /**
   * While set, a request of this JSON-RPC method gets this answer instead of the usual one: an initialize request, which has
   * no session yet, and any other request on a session the remote knows. Null goes back to the usual answer.
   */
  answerWith(method: string, answer: Answer | null): void;
  close(): Promise<void>;
}

// The tools of the remote: two that behave, and one that answers with a protocol error instead of a result.
function buildServer(): McpServer {
  const server = new McpServer({ name: 'test-remote', version: '1.0.0' });
  server.registerTool(
    'echo',
    { description: 'Echoes the text back', inputSchema: { text: z.string() } },
    async ({ text }) => ({
      content: [{ type: 'text' as const, text: `echo: ${text}` }],
      structuredContent: { echoed: text },
    }),
  );
  server.registerTool('fail', { description: 'Always fails, as a result' }, async () => ({
    content: [{ type: 'text' as const, text: 'it failed on purpose' }],
    isError: true,
    _meta: { reason: 'on purpose' },
  }));
  server.registerTool('needs_login', { description: 'Always answers with a JSON-RPC error' }, async () => {
    throw new UrlElicitationRequiredError([
      { mode: 'url', elicitationId: 'login-1', url: 'https://example.com/login', message: 'Sign in to continue' },
    ]);
  });
  return server;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function methodOf(body: unknown): string | undefined {
  const method = (body as { method?: unknown } | undefined)?.method;
  return typeof method === 'string' ? method : undefined;
}

function reply(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { 'content-type': contentType }).end(body);
}

function answer(response: ServerResponse, given: Answer): void {
  if (given !== 'silence') reply(response, given.status, given.contentType, given.body);
}

/**
 * A remote MCP server in this process, the way DJ Opus's /mcp behaves for a client: the SDK's StreamableHTTPServerTransport
 * with sessions, one McpServer for each MCP session, and the 404 for a session it does not know. It listens on a random
 * local port, and counts what a test has to check.
 */
export async function startRemote(): Promise<RemoteMcp> {
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();
  const everStarted: McpServer[] = [];
  const log: Array<{ method: string; params: unknown }> = [];
  let streams = 0;
  let streamsEver = 0;
  let refusingSessions = false;
  let refusingToolCalls = false;
  const answers = new Map<string, Answer>();

  async function startSession(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
    const server = buildServer();
    everStarted.push(server);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/mcp') {
      reply(response, 404, 'text/plain', 'Not found');
      return;
    }
    const body = request.method === 'POST' ? await readJson(request) : undefined;
    const method = methodOf(body);
    if (method) log.push({ method, params: (body as { params?: unknown }).params });

    const sessionId = request.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const session = refusingSessions || (refusingToolCalls && method === 'tools/call') ? undefined : sessions.get(sessionId);
      if (!session) {
        reply(response, 404, 'application/json', SESSION_NOT_FOUND);
        return;
      }
      const given = method ? answers.get(method) : undefined;
      if (given) {
        answer(response, given);
        return;
      }
      if (request.method === 'GET') {
        streams++;
        streamsEver++;
        response.on('close', () => {
          streams--;
        });
      }
      await session.transport.handleRequest(request, response, body);
      return;
    }

    if (request.method === 'POST' && isInitializeRequest(body)) {
      const given = answers.get('initialize');
      if (given) {
        answer(response, given);
        return;
      }
      await startSession(request, response, body);
      return;
    }
    reply(response, 400, 'application/json', SESSION_ID_REQUIRED);
  }

  const http = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) reply(response, 500, 'text/plain', `test remote failed: ${String(error)}`);
      else response.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    initializeCount: () => log.filter((entry) => entry.method === 'initialize').length,
    toolCallCount: () => log.filter((entry) => entry.method === 'tools/call').length,
    received: (method) => log.filter((entry) => entry.method === method).map((entry) => entry.params),
    openStreams: () => streams,
    streamsOpened: () => streamsEver,
    expireSessions: () => sessions.clear(),
    refuseSessions: (refuse) => {
      refusingSessions = refuse;
    },
    refuseToolCalls: (refuse) => {
      refusingToolCalls = refuse;
    },
    answerWith: (method, given) => {
      if (given) answers.set(method, given);
      else answers.delete(method);
    },
    async close() {
      for (const server of everStarted) void server.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** The URL of a port nothing listens on, so that connecting to it is refused. */
export async function unreachableUrl(): Promise<string> {
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  await new Promise<void>((resolve) => http.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
