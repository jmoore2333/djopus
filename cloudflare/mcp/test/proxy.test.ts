import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createProxy } from '../src/proxy.js';
import { startRemote, unreachableUrl } from './helpers/remote-mcp.js';
import type { RemoteMcp } from './helpers/remote-mcp.js';
import { until } from './helpers/until.js';

// The proxy against a real MCP server in this process (test/helpers/remote-mcp.ts): the SDK's StreamableHTTPServerTransport
// with sessions, over HTTP on a local port. The agent's side is an SDK Client on an in-memory pair, which stands in for
// stdio; test/stdio.test.ts runs the same proxy as a process.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startedRemote(): Promise<RemoteMcp> {
  const remote = await startRemote();
  cleanups.push(() => remote.close());
  return remote;
}

/** A proxy to `remoteUrl`, and an agent connected to it. */
async function connectAgent(remoteUrl: string, options: { requestTimeoutMs?: number } = {}) {
  const [agentSide, proxySide] = InMemoryTransport.createLinkedPair();
  const proxy = await createProxy({ remoteUrl, local: proxySide, ...options });
  const agent = new Client({ name: 'test-agent', version: '0' });
  await agent.connect(agentSide);
  cleanups.push(async () => {
    await agent.close();
    await proxy.close();
  });
  return { agent, proxy };
}

/** A client that talks to the remote itself, with no proxy in between: what the proxy has to be the same as. */
async function connectDirect(remoteUrl: string): Promise<Client> {
  const client = new Client({ name: 'direct', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', remoteUrl)));
  cleanups.push(() => client.close());
  return client;
}

const echo = (text: string) => ({ name: 'echo', arguments: { text } });

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const { content = [] } = result as { content?: Array<{ text?: string }> };
  return content.map((part) => part.text ?? '').join('\n');
}

describe('forwarding', () => {
  it('lists the remote tools, with their schemas', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);

    const { tools } = await agent.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'fail', 'needs_login']);
    const echoTool = tools.find((tool) => tool.name === 'echo');
    expect(echoTool?.description).toBe('Echoes the text back');
    expect(echoTool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
    expect(tools).toEqual((await (await connectDirect(remote.url)).listTools()).tools); // all of it, as the remote lists it
  });

  it('passes on what the request carries: the cursor of a tool list', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);

    await agent.listTools({ cursor: 'page-2' });

    expect(remote.received('tools/list')).toEqual([{ cursor: 'page-2' }]);
  });

  it('forwards calls and isError results unchanged', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);

    // the arguments arrive, and the result is the remote's, field for field
    expect(await agent.callTool(echo('hello'))).toEqual({
      content: [{ type: 'text', text: 'echo: hello' }],
      structuredContent: { echoed: 'hello' },
    });
    // an isError result stays a result, and stays an error
    expect(await agent.callTool({ name: 'fail', arguments: {} })).toEqual({
      content: [{ type: 'text', text: 'it failed on purpose' }],
      isError: true,
      _meta: { reason: 'on purpose' },
    });
  });

  it('forwards a JSON-RPC error of the remote as it is: same code, message and data', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);
    const direct = await connectDirect(remote.url);

    const throughProxy = await agent.callTool({ name: 'needs_login', arguments: {} }).catch((error: unknown) => error);
    const withoutProxy = await direct.callTool({ name: 'needs_login', arguments: {} }).catch((error: unknown) => error);

    expect(throughProxy).toMatchObject({
      code: -32042,
      data: { elicitations: [{ elicitationId: 'login-1', url: 'https://example.com/login' }] },
    });
    const { code, message, data } = withoutProxy as { code: number; message: string; data: unknown };
    expect(throughProxy).toMatchObject({ code, message, data });
  });

  it('uses one MCP session on the remote for all its requests', async () => {
    // Each MCP session on the real remote is bound to its own DJ Opus session: a session for every request would send
    // each tool call to another player.
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);

    await agent.listTools();
    await agent.callTool(echo('a'));
    await agent.callTool(echo('b'));

    expect(remote.initializeCount()).toBe(1);
  });

  it('makes one MCP session for requests that arrive together before it exists', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);

    const [list, first, second] = await Promise.all([agent.listTools(), agent.callTool(echo('a')), agent.callTool(echo('b'))]);

    expect(list.tools).toHaveLength(3);
    expect(textOf(first)).toBe('echo: a');
    expect(textOf(second)).toBe('echo: b');
    expect(remote.initializeCount()).toBe(1);
  });
});

describe('when the MCP session on the remote has expired', () => {
  it('re-initializes once when the remote session expires, and sends the call again', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);
    expect(textOf(await agent.callTool(echo('before')))).toBe('echo: before');
    expect(remote.initializeCount()).toBe(1);

    remote.expireSessions(); // what the real remote does to a session idle for 30 days: its next request gets a 404
    const after = await agent.callTool(echo('after'));

    expect(after.isError).toBeUndefined();
    expect(textOf(after)).toBe('echo: after');
    expect(remote.initializeCount()).toBe(2);
  });

  it('closes the connection it leaves, and keeps one stream on the new one', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);
    await agent.callTool(echo('before'));
    await until(() => remote.streamsOpened() === 1);

    remote.expireSessions(); // the stream of the old session is still open: only closing the old connection ends it
    await agent.callTool(echo('after'));

    await until(() => remote.streamsOpened() === 2); // the new connection has opened its own
    await until(() => remote.openStreams() === 1); // and the old one is gone
  });

  it('does the same for the tool list', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);
    await agent.listTools();

    remote.expireSessions();
    const { tools } = await agent.listTools();

    expect(tools).toHaveLength(3);
    expect(remote.initializeCount()).toBe(2);
  });

  it('makes one new MCP session for calls that all meet the expiry', async () => {
    // Calls on different sessions would drive different players.
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);
    await agent.callTool(echo('before'));

    remote.expireSessions();
    const results = await Promise.all(['a', 'b', 'c'].map((text) => agent.callTool(echo(text))));

    expect(results.map(textOf)).toEqual(['echo: a', 'echo: b', 'echo: c']);
    expect(remote.initializeCount()).toBe(2);
  });

  it('gives up after one retry: a second 404 is an isError result, and the proxy keeps serving', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);
    await agent.callTool(echo('first'));

    remote.refuseToolCalls(true); // the new session gets the 404 for the call as well
    const result = await agent.callTool(echo('second'));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(remote.url);
    expect(textOf(result)).toContain('Session not found');
    expect(remote.initializeCount()).toBe(2); // the first, and the one new session
    expect(remote.toolCallCount()).toBe(3); // the first call, the second, and its one retry

    remote.refuseToolCalls(false);
    expect(textOf(await agent.callTool(echo('third')))).toBe('echo: third');
    expect(remote.initializeCount()).toBe(2); // on the session made for the retry
  });

  it('reports it when the new session cannot be started either, and starts again for the next call', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);
    await agent.callTool(echo('first'));

    remote.refuseSessions(true); // the new session is refused from its first request on
    const result = await agent.callTool(echo('second'));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Session not found');
    expect(remote.initializeCount()).toBe(2);
    expect(remote.toolCallCount()).toBe(2); // the retry was never sent: there was no session to send it on

    remote.refuseSessions(false);
    expect(textOf(await agent.callTool(echo('third')))).toBe('echo: third');
    expect(remote.initializeCount()).toBe(3);
  });

  it('does not send a call again after any other error: it may have run', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);
    await agent.callTool(echo('first'));

    remote.answerWith('tools/call', { status: 500, contentType: 'text/plain', body: 'internal error' });
    const result = await agent.callTool(echo('second'));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('HTTP 500');
    expect(remote.toolCallCount()).toBe(2);
    expect(remote.initializeCount()).toBe(1);
  });
});

describe('when the remote cannot be used', () => {
  const cases: Array<{ what: string; expected: string[]; absent?: string[]; url: () => Promise<string> }> = [
    {
      what: 'refuses the connection',
      expected: ['ECONNREFUSED'],
      url: unreachableUrl,
    },
    {
      what: 'refuses the connection on localhost, over both of its addresses',
      expected: ['ECONNREFUSED'],
      url: async () => (await unreachableUrl()).replace('127.0.0.1', 'localhost'),
    },
    {
      what: 'answers initialize with a challenge page (403)',
      expected: ['HTTP 403', 'Just a moment'],
      url: async () => {
        const remote = await startedRemote();
        remote.answerWith('initialize', { status: 403, contentType: 'text/html', body: '<html><title>Just a moment...</title></html>' });
        return remote.url;
      },
    },
    {
      what: 'answers initialize with something that is not MCP (200, text/plain)',
      expected: ['Unexpected content type: text/plain'],
      absent: ['HTTP -1', 'HTTP 200'], // the SDK has no status for this one, and the answer was not an HTTP error
      url: async () => {
        const remote = await startedRemote();
        remote.answerWith('initialize', { status: 200, contentType: 'text/plain', body: 'hello' });
        return remote.url;
      },
    },
    {
      what: 'answers initialize with an error (500)',
      expected: ['HTTP 500', 'boom'],
      url: async () => {
        const remote = await startedRemote();
        remote.answerWith('initialize', { status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
        return remote.url;
      },
    },
  ];

  it.each(cases)('$what: the proxy still starts, a call is an isError result, and listing is an error', async ({ expected, absent = [], url }) => {
    const remoteUrl = await url();

    const { agent } = await connectAgent(remoteUrl); // the handshake with the agent succeeds: it does not wait for the remote
    const call = await agent.callTool(echo('hello'));

    expect(call.isError).toBe(true);
    expect(textOf(call)).toContain(remoteUrl);
    for (const part of expected) expect(textOf(call)).toContain(part);
    for (const part of absent) expect(textOf(call)).not.toContain(part);

    const listed = agent.listTools();
    await expect(listed).rejects.toThrow(remoteUrl);
    for (const part of expected) await expect(listed).rejects.toThrow(part);
  });

  it('keeps what the remote answered short: a challenge page is a few KB of HTML', async () => {
    const remote = await startedRemote();
    const page = `<html><title>Just a moment...</title>${'<p>padding</p>'.repeat(2000)}</html>`;
    remote.answerWith('initialize', { status: 403, contentType: 'text/html', body: page });
    const { agent } = await connectAgent(remote.url);

    const call = await agent.callTool(echo('hello'));

    expect(textOf(call)).toContain('Just a moment'); // the start of the answer is there
    expect(textOf(call).length).toBeLessThan(1000);
  });

  it('does not take a 404 on initialize for an expired session: one attempt, then the error', async () => {
    // A host with no MCP server at /mcp. There is no session to start again, so a new initialize would only repeat it.
    const remote = await startedRemote();
    remote.answerWith('initialize', { status: 404, contentType: 'text/plain', body: 'Not found' });
    const { agent } = await connectAgent(remote.url);

    const call = await agent.callTool(echo('hello'));

    expect(call.isError).toBe(true);
    expect(textOf(call)).toContain('HTTP 404');
    expect(remote.initializeCount()).toBe(1);
  });

  it('gives up on a remote that does not answer initialize, with an isError result that names it', async () => {
    const remote = await startedRemote();
    remote.answerWith('initialize', 'silence');
    const { agent } = await connectAgent(remote.url, { requestTimeoutMs: 300 });

    const call = await agent.callTool(echo('hello'));

    expect(call.isError).toBe(true);
    expect(textOf(call)).toContain(remote.url);
    expect(textOf(call)).toContain('timed out');
    await expect(agent.listTools()).rejects.toThrow(remote.url);
  });

  it('gives up on a tool list the remote does not answer, with an error that names it', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url, { requestTimeoutMs: 1000 }); // long enough for the requests that are answered
    await agent.listTools();

    remote.answerWith('tools/list', 'silence');
    const listed = agent.listTools();

    await expect(listed).rejects.toThrow(remote.url);
    await expect(listed).rejects.toThrow('timed out');
  });

  it('gives up on a call the remote does not answer, and does not send it again: it may be running', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url, { requestTimeoutMs: 1000 }); // long enough for the requests that are answered
    await agent.callTool(echo('first'));

    remote.answerWith('tools/call', 'silence');
    const call = await agent.callTool(echo('second'));

    expect(call.isError).toBe(true);
    expect(textOf(call)).toContain(remote.url);
    expect(textOf(call)).toContain('timed out');
    expect(remote.toolCallCount()).toBe(2);
  });

  it('tries again on the next request, and works once the remote is back', async () => {
    const remote = await startedRemote();
    remote.answerWith('initialize', { status: 503, contentType: 'text/plain', body: 'down for maintenance' });
    const { agent } = await connectAgent(remote.url);
    expect((await agent.callTool(echo('early'))).isError).toBe(true);

    remote.answerWith('initialize', null);

    expect(textOf(await agent.callTool(echo('later')))).toBe('echo: later');
    expect((await agent.listTools()).tools).toHaveLength(3);
  });

  it('starts when DJOPUS_URL is not a URL, and says so in every answer', async () => {
    const { agent } = await connectAgent('play.djopus.party'); // no scheme

    const call = await agent.callTool(echo('hello'));

    expect(call.isError).toBe(true);
    expect(textOf(call)).toContain('play.djopus.party');
    expect(textOf(call)).toContain('DJOPUS_URL');
    await expect(agent.listTools()).rejects.toThrow('DJOPUS_URL');
  });
});

describe('closing', () => {
  it('lets go of the remote when the agent goes away', async () => {
    const remote = await startedRemote();
    const { agent } = await connectAgent(remote.url);
    await agent.callTool(echo('hello'));
    await until(() => remote.openStreams() === 1); // the stream the MCP client keeps for the server's own messages

    await agent.close();

    await until(() => remote.openStreams() === 0);
  });

  it('lets go of the remote when it is closed', async () => {
    const remote = await startedRemote();
    const { agent, proxy } = await connectAgent(remote.url);
    await agent.callTool(echo('hello'));
    await until(() => remote.openStreams() === 1);

    await proxy.close();

    await until(() => remote.openStreams() === 0);
  });
});
