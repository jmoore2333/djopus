import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startRemote, unreachableUrl } from './helpers/remote-mcp.js';
import type { RemoteMcp } from './helpers/remote-mcp.js';
import { until } from './helpers/until.js';

// These tests run src/index.ts for real, the way the `djopus` registration does (tsx on the source, over stdio), against
// a remote MCP server in this process (test/helpers/remote-mcp.ts). They cover what proxy.test.ts cannot: the entry point,
// its default remote, and the process: what is on stdout, and when it exits.

const MCP_DIR = fileURLToPath(new URL('..', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
const RECORD_FETCH = pathToFileURL(fileURLToPath(new URL('./helpers/record-fetch.mjs', import.meta.url))).href;
const LINGER = pathToFileURL(fileURLToPath(new URL('./helpers/linger.mjs', import.meta.url))).href;
const SLOW = 90_000; // tsx has to start and compile the proxy first, which a loaded machine can stretch a lot

interface JsonRpcReply {
  id: number;
  result?: { isError?: boolean; content?: Array<{ type: string; text: string }>; tools?: Array<{ name: string }> };
  error?: { code: number; message: string };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startedRemote(): Promise<RemoteMcp> {
  const remote = await startRemote();
  cleanups.push(() => remote.close());
  return remote;
}

// Runs src/index.ts with `env` on top of this process's, the way the registration does, and does the MCP handshake.
// An undefined value takes the variable out of the environment, so that a DJOPUS_URL of the person running the tests
// cannot reach the proxy.
async function launch(env: Record<string, string | undefined>) {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  const child = spawn(TSX, ['src/index.ts'], { cwd: MCP_DIR, env: childEnv as NodeJS.ProcessEnv });
  cleanups.push(async () => {
    // A test may have ended the proxy already, by closing its stdin: there is no exit left to wait for then.
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(killer);
  });

  let stdout = '';
  let stderr = '';
  let nextId = 1;
  const waiting = new Map<number, (message: JsonRpcReply) => void>();
  const strayLines: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    for (let end = stdout.indexOf('\n'); end >= 0; end = stdout.indexOf('\n')) {
      const line = stdout.slice(0, end).trim();
      stdout = stdout.slice(end + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as JsonRpcReply;
        waiting.get(message.id)?.(message);
      } catch {
        strayLines.push(line); // not a JSON-RPC message: it would break the agent's side of the protocol
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  function request(method: string, params: object): Promise<JsonRpcReply> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer to ${method}. stderr so far: ${stderr}`)), 60_000);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(message);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stdio-test', version: '0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return {
    /** Everything the proxy has written to stderr so far. */
    stderr: () => stderr,
    /** The lines it has written to stdout that are not JSON. */
    strayStdout: () => strayLines,
    request,
    async listTools(): Promise<string[]> {
      const reply = await request('tools/list', {});
      if (reply.error) throw new Error(`tools/list failed at the protocol level: ${JSON.stringify(reply.error)}`);
      return reply.result!.tools!.map((tool) => tool.name);
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      const reply = await request('tools/call', { name, arguments: args });
      if (reply.error) throw new Error(`${name} failed at the protocol level: ${JSON.stringify(reply.error)}`);
      const result = reply.result!;
      return { isError: result.isError, content: result.content!, text: result.content![0].text };
    },
    /** Closes the proxy's stdin, as a client that is done does, and resolves with the exit code. */
    async endInput(timeoutMs = 10_000): Promise<number | null> {
      if (child.exitCode !== null || child.signalCode !== null) return child.exitCode; // gone already
      const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tooLate = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The proxy did not exit within ${timeoutMs} ms of its stdin closing. stderr: ${stderr}`)),
          timeoutMs,
        );
      });
      child.stdin.end();
      try {
        return await Promise.race([exited, tooLate]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

describe('src/index.ts over stdio', () => {
  it('lists the tools of the remote', async () => {
    const remote = await startedRemote();
    const proxy = await launch({ DJOPUS_URL: remote.url });

    expect(await proxy.listTools()).toEqual(['echo', 'fail', 'needs_login']);
  }, SLOW);

  it('forwards a call, and an isError result, with nothing else on stdout', async () => {
    const remote = await startedRemote();
    const proxy = await launch({ DJOPUS_URL: remote.url });

    const echoed = await proxy.call('echo', { text: 'hello' });
    expect(echoed.isError).toBeUndefined();
    expect(echoed.text).toBe('echo: hello');

    const failed = await proxy.call('fail');
    expect(failed.isError).toBe(true);
    expect(failed.text).toBe('it failed on purpose');

    expect(proxy.strayStdout()).toEqual([]);
  }, SLOW);

  it('answers with isError results and an error for the tool list while the remote is unreachable, and keeps running', async () => {
    // Never a success the remote did not give, and the process starts anyway: the agent's handshake has to succeed.
    const url = await unreachableUrl();
    const proxy = await launch({ DJOPUS_URL: url });

    for (const name of ['echo', 'fail']) {
      const result = await proxy.call(name, { text: 'hello' });
      expect(result.isError, name).toBe(true);
      expect(result.text, name).toContain(url);
      expect(result.text, name).toContain('ECONNREFUSED');
    }

    const listed = await proxy.request('tools/list', {});
    expect(listed.result).toBeUndefined();
    expect(listed.error?.message).toContain(url);
    expect(listed.error?.message).toContain('ECONNREFUSED');
  }, SLOW);

  it('exits 0 when its stdin closes, and the remote sees it let go', async () => {
    const remote = await startedRemote();
    const proxy = await launch({ DJOPUS_URL: remote.url });
    await proxy.call('echo', { text: 'hello' }); // connects to the remote, which keeps a stream open for as long as it is there
    await until(() => remote.openStreams() === 1);

    expect(await proxy.endInput()).toBe(0);

    await until(() => remote.openStreams() === 0);
  }, SLOW);

  it('exits 0 when its stdin closes, whatever else would keep the process running', async () => {
    const remote = await startedRemote();
    const proxy = await launch({ DJOPUS_URL: remote.url, NODE_OPTIONS: `--import ${LINGER}` });
    await proxy.call('echo', { text: 'hello' });

    expect(await proxy.endInput()).toBe(0);
  }, SLOW);

  it('exits 0 when its stdin closes before any request', async () => {
    const remote = await startedRemote();
    const proxy = await launch({ DJOPUS_URL: remote.url });

    expect(await proxy.endInput()).toBe(0);
  }, SLOW);

  it('exits 0 when its stdin closes while the remote is unreachable', async () => {
    const proxy = await launch({ DJOPUS_URL: await unreachableUrl() });
    await proxy.call('echo', { text: 'hello' });

    expect(await proxy.endInput()).toBe(0);
  }, SLOW);

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('goes to https://play.djopus.party/mcp when DJOPUS_URL is %s', async (_what, value) => {
    // fetch is stubbed in the process (test/helpers/record-fetch.mjs): the request is seen, and goes nowhere.
    const proxy = await launch({ DJOPUS_URL: value, NODE_OPTIONS: `--import ${RECORD_FETCH}` });

    const result = await proxy.call('echo', { text: 'hello' });

    expect(result.isError).toBe(true);
    expect(proxy.stderr()).toContain('[record-fetch] POST https://play.djopus.party/mcp');
  }, SLOW);
});
