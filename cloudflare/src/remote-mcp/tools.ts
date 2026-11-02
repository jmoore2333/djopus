import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createCrateLibraryStore } from '../core/crate-store';
import { createDoCommandSender } from '../core/do-command';
import { createExecutor } from '../core/executor';
import { LIBRARY } from '../core/library';
import { isSessionId, newSessionId } from '../core/session-id';
import { TOOL_DEFS } from '../core/tools';
import { logEvent, sessionHash } from '../log';
import type { SessionBinding } from './binding';

// How long a playback tool waits for a player to connect before it answers with the player URL. Less than ChatGPT's
// 5 s, which waits for a widget that is loading: here the player is a tab the user has yet to open, and a longer wait
// only puts off the answer that tells them to.
const BROWSER_WAIT_MS = 3_000;

export interface GenericToolsContext {
  /** The DJ Opus session the MCP session drives. */
  binding: SessionBinding;
  /** The origin of the host, such as https://play.djopus.party: the player is at <origin>/s/<id>. */
  origin: string;
  env: Env;
  /** Runs before each tool call. The agent records its activity with it (src/remote-mcp/agent.ts). */
  onToolCall?(): Promise<void>;
}

/** Where the player of a session is. */
function playerUrlOf(origin: string, sessionId: string): string {
  return `${origin}/s/${sessionId}`;
}

/** What a playback tool fails with while no player is open: where it is, and what the user has to do. */
function noBrowserMessage(playerUrl: string, action: string): string {
  return `No player is open for this session yet. Open ${playerUrl} in your browser, click once to enable audio, then run ${action} again.`;
}

/**
 * Registers the 23 tools of the registry (src/core/tools.ts) on `server`, as the registry defines them. connect binds
 * the MCP session to a session that is already open. Every other tool runs in the executor core on the bound session,
 * and the first one binds a new session when there is none, so an agent can start playing without knowing about
 * sessions: the tool that needs a player names its URL. The saves are the session's crate plus the library.
 *
 * What is logged is the keyed hash of a session (src/log.ts), never its id, its player URL or its code.
 */
export function registerGenericTools(server: McpServer, ctx: GenericToolsContext): void {
  const { binding, origin, env } = ctx;
  const hashOf = (sessionId: string) => sessionHash(sessionId, env.LOG_HASH_KEY);

  async function boundSession(): Promise<string> {
    const bound = await binding.get();
    if (bound) return bound;
    const created = newSessionId();
    await binding.set(created);
    logEvent('mcp_session_new', { sessionHash: await hashOf(created) });
    return created;
  }

  function executorFor(sessionId: string) {
    const playerUrl = playerUrlOf(origin, sessionId);
    return createExecutor({
      sessionId,
      sendCommand: createDoCommandSender(env.SESSION_BRIDGE, sessionId),
      store: createCrateLibraryStore(env.SESSION_BRIDGE.get(env.SESSION_BRIDGE.idFromName(sessionId)), LIBRARY),
      browserWaitMs: BROWSER_WAIT_MS,
      noBrowserMessage: (action) => noBrowserMessage(playerUrl, action),
      describeSession: () => ({ sessionId, playerUrl }),
    });
  }

  // Only a session id of this host's kind can be bound: what the player URL holds after /s/. The binding moves once the
  // session has answered, so a connect that fails leaves the MCP session where it was.
  async function connect(session: unknown): Promise<{ session: string; playerUrl: string; browserConnected: boolean }> {
    if (typeof session !== 'string' || !isSessionId(session)) {
      throw new Error(`That is not a DJ Opus session id. Use the 26 characters after /s/ in the player URL (${origin}/s/<id>).`);
    }
    const state = (await executorFor(session).executeTool('get_state', {})) as { connectedClients: number };
    await binding.set(session);
    const browserConnected = state.connectedClients > 0;
    logEvent('mcp_connect', { sessionHash: await hashOf(session), browserConnected });
    return { session, playerUrl: playerUrlOf(origin, session), browserConnected };
  }

  for (const def of TOOL_DEFS) {
    const name = def.name;
    server.registerTool(name, {
      description: def.description,
      inputSchema: def.input,
      annotations: def.annotations,
    }, async (args: Record<string, unknown>) => {
      await ctx.onToolCall?.();
      const result = name === 'connect'
        ? await connect(args.session)
        : await executorFor(await boundSession()).executeTool(name, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    });
  }
}
