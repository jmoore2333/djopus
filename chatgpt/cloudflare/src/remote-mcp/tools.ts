import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createCrateLibraryStore } from '../core/crate-store';
import { createDoCommandSender } from '../core/do-command';
import { createExecutor } from '../core/executor';
import { LIBRARY } from '../core/library';
import { isSessionId, newSessionId } from '../core/session-id';
import { TOOL_DEFS } from '../core/tools';
import { logEvent, sessionHash } from '../log';
import { widgetResourceUri } from '../widget/constants';
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
function noBrowserMessage(playerUrl: string, action: string, chatgptPrivacy: boolean): string {
  if (chatgptPrivacy) {
    return `No player is open for this session yet. Open DJ Opus in the conversation, then run ${action} again.`;
  }
  return `No player is open for this session yet. Open ${playerUrl} in your browser, click once to enable audio, then run ${action} again.`;
}

/** Avoid sending the bearer capability to the model in routine ChatGPT status results.
 * `connect` deliberately accepts an existing user-supplied session and remains usable. */
function resultForChatGPT(name: string, result: unknown): unknown {
  if ((name !== 'get_state' && name !== 'reset_session') || !result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const { sessionId: _sessionId, playerUrl: _playerUrl, ...visible } = result as Record<string, unknown>;
  return visible;
}

/**
 * Registers the inline launcher and 23 tools of the registry (src/core/tools.ts) on `server`, as the registry defines them. connect binds
 * the MCP session to a session that is already open. Every other tool runs in the executor core on the bound session,
 * and the first one binds a new session when there is none, so an agent can start playing without knowing about
 * sessions: the tool that needs a player names its URL. The saves are the session's crate plus the library.
 *
 * What is logged is the keyed hash of a session (src/log.ts), never its id, its player URL or its code.
 */
export function registerGenericTools(server: McpServer, ctx: GenericToolsContext): void {
  const { binding, origin, env } = ctx;
  const hashOf = (sessionId: string) => sessionHash(sessionId, env.LOG_HASH_KEY);
  const chatgptPrivacy = env.CHATGPT_PRIVACY_MODE === '1';
  const widgetUri = widgetResourceUri(chatgptPrivacy);

  // Development diagnostics: correlate launcher/playback routing without logging
  // conversation IDs, session capabilities, URLs, or pattern contents.
  async function traceChatGptRoute(tool: string, meta: Record<string, unknown> | undefined, sessionId: string): Promise<void> {
    if (!chatgptPrivacy || (tool !== 'openDJOpus' && tool !== 'compose')) return;
    const conversation = meta?.['openai/session'];
    logEvent('chatgpt_tool_route', {
      tool,
      hasConversationId: typeof conversation === 'string' && conversation.length > 0 && conversation.length <= 512,
      sessionHash: await hashOf(sessionId),
    });
  }

  // ChatGPT may make a new MCP transport session for each tool call. Its
  // conversation metadata links those calls; the mapping object stores a random
  // capability, not a value derived from the metadata. Metadata is untrusted:
  // without client authentication, knowing a conversation id allows spoofing it.
  async function conversationBinding(meta: Record<string, unknown> | undefined) {
    const conversation = meta?.['openai/session'];
    if (typeof conversation !== 'string' || conversation.length === 0 || conversation.length > 512) return null;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(conversation));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return env.SESSION_BRIDGE.get(env.SESSION_BRIDGE.idFromName(`chat-conversation:${hash}`));
  }

  async function boundSession(meta?: Record<string, unknown>): Promise<string> {
    const conversation = await conversationBinding(meta);
    if (conversation) return conversation.conversationSession();
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
      noBrowserMessage: (action) => noBrowserMessage(playerUrl, action, chatgptPrivacy),
      describeSession: () => chatgptPrivacy ? {} : { sessionId, playerUrl },
    });
  }

  // Only a session id of this host's kind can be bound: what the player URL holds after /s/. The binding moves once the
  // session has answered, so a connect that fails leaves the MCP session where it was.
  async function connect(session: unknown, meta?: Record<string, unknown>): Promise<{ session: string; playerUrl: string; browserConnected: boolean }> {
    if (typeof session !== 'string' || !isSessionId(session)) {
      throw new Error(`That is not a DJ Opus session id. Use the 26 characters after /s/ in the player URL (${origin}/s/<id>).`);
    }
    const state = (await executorFor(session).executeTool('get_state', {})) as { connectedClients: number };
    const conversation = await conversationBinding(meta);
    if (conversation) await conversation.conversationSession(session);
    else await binding.set(session);
    const browserConnected = state.connectedClients > 0;
    logEvent('mcp_connect', { sessionHash: await hashOf(session), browserConnected });
    return { session, playerUrl: playerUrlOf(origin, session), browserConnected };
  }

  // The launcher renders the same player bound to every other MCP tool. No
  // session capability is placed in model-visible content or server logs.
  server.registerTool('openDJOpus', {
    title: 'Open DJ Opus',
    outputSchema: { ok: z.boolean(), message: z.string() },
    description: 'Use this when the user wants the DJ Opus player visible inline. Creates a session if needed. After it opens, call compose, write, or load when the user also asked to start or change music.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: { resourceUri: widgetUri, visibility: ['model', 'app'] },
      'openai/outputTemplate': widgetUri,
      'openai/toolInvocation/invoking': 'Opening DJ Opus',
      'openai/toolInvocation/invoked': chatgptPrivacy ? 'DJ Opus player requested' : 'DJ Opus is ready',
    },
  }, async (extra) => {
    await ctx.onToolCall?.();
    const sessionId = await boundSession(extra._meta);
    await traceChatGptRoute('openDJOpus', extra._meta, sessionId);
    return {
      structuredContent: {
        ok: true,
        message: chatgptPrivacy ? 'DJ Opus player launch requested' : 'DJ Opus player is ready',
      },
      content: [{ type: 'text' as const, text: chatgptPrivacy
        ? 'DJ Opus player launch requested. The player must open and connect before it can receive music. If music was requested, use compose, write, or load next and report any connection or audio error.'
        : 'DJ Opus is ready. If music was requested, use compose, write, or load next.' }],
      _meta: { sessionId },
    };
  });

  for (const def of TOOL_DEFS) {
    const name = def.name;
    server.registerTool(name, {
      description: chatgptPrivacy && name === 'delete'
        ? 'Delete one named pattern from this session’s crate. Only call when the user explicitly identifies the exact pattern as the deletion target in their request or specifically confirms that exact deletion. If no target is identified, ask which one and do not guess from the saved list, recent activity, earlier tool results, or names mentioned for other purposes. Library patterns are read-only.'
        : chatgptPrivacy && name === 'set_tempo'
          ? 'Change the live BPM without editing code. The change is temporary: saved code retains its original tempo and editing the pattern or opening a new player can restore it. For a durable change, inspect and intentionally edit the pattern code.'
          : def.description,
      inputSchema: def.input,
      annotations: def.annotations,
    }, async (args: Record<string, unknown>, extra) => {
      await ctx.onToolCall?.();
      if (name === 'connect') {
        const result = await connect(args.session, extra._meta);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      }

      const sessionId = await boundSession(extra._meta);
      await traceChatGptRoute(name, extra._meta, sessionId);
      const executor = executorFor(sessionId);
      let result = await executor.executeTool(name, args);

      if (chatgptPrivacy && name === 'set_tempo' && result && typeof result === 'object') {
        result = { ...result, message: 'The live tempo changed without editing the pattern. Replaying unchanged code in this player keeps the requested tempo, but a code change or a new player can restore the tempo in the code. Saved patterns still contain the original code; explicitly edit its tempo for a lasting change.' };
      }

      // Writing editor code without autoplay does not stop code that was
      // already running. Tell ChatGPT what the session reports so it doesn't
      // incorrectly tell the user that all music stopped (or that the newly
      // loaded code has started). A failed status check must not turn an
      // otherwise successful write into an error or an invented status.
      if (chatgptPrivacy && (name === 'write' || name === 'load') && args.auto_play !== true && result && typeof result === 'object') {
        let isPlaying: boolean | null = null;
        try {
          const state = await executor.executeTool('get_state', {}) as { isPlaying?: unknown };
          if (typeof state?.isPlaying === 'boolean') isPlaying = state.isPlaying;
        } catch {
          // The write succeeded, but current playback could not be verified.
        }
        const message = isPlaying === true
          ? 'The new editor code was not started by this action. The session reports that playback remains active.'
          : isPlaying === false
            ? 'The new editor code was not started by this action. The session reports that playback is stopped.'
            : 'The new editor code was not started by this action. Current playback could not be verified.';
        result = { ...result, playback: { isPlaying, message } };
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(chatgptPrivacy ? resultForChatGPT(name, result) : result) }] };
    });
  }
}
