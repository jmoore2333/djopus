import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { INSTRUCTIONS } from '../core/guide';
import { CHATGPT_INSTRUCTIONS } from './chatgpt-guide';
import { logEvent, sessionHash } from '../log';
import { SESSION_TTL_MS } from '../session-bridge';
import { SESSION_BINDING_KEY, storageBinding } from './binding';
import { registerGuide } from './guide';
import { registerGenericTools } from './tools';
import { registerWidgetResource } from '../widget/resource';

/** When the MCP session last ran a tool, in ms since the epoch. There is none until its first tool call. */
const LAST_ACTIVITY_KEY = 'lastActivity';

/** The delay of the expiry schedule, in seconds: an MCP session lasts as long as a DJ Opus session, 30 idle days. */
const EXPIRY_DELAY_S = SESSION_TTL_MS / 1000;

/**
 * One MCP session of the app's generic MCP (/mcp, src/index.ts). McpAgent gives each MCP session (each Mcp-Session-Id)
 * a Durable Object of this class, named streamable-http:<Mcp-Session-Id>, and replays its initialize request when the
 * object starts again after an eviction. Its storage holds the DJ Opus session it is bound to (src/remote-mcp/binding.ts)
 * and when it last ran a tool. The origin of the host comes in the props the Worker sets, which McpAgent keeps.
 *
 * Expiry. An MCP session is deleted once it has run no tool for 30 days and has no request in flight. Every start of the
 * object and every tool call schedules expireIfIdle 30 days out, idempotently: an idempotent schedule is the one row of
 * that callback and payload, whatever its time, so the first time stands. expireIfIdle therefore looks at the requests
 * in flight and at lastActivity when it runs, and either destroys the object or schedules itself again. Scheduling on
 * start is what expires an MCP session that never ran a tool (an agent launched without using DJ Opus), and the object
 * McpAgent starts for a forged but well-formed Mcp-Session-Id: it answers 404, but the object has started and stored
 * its props.
 */
export class DjOpusMcp extends McpAgent<Env, unknown, { origin: string }> {
  // The ChatGPT deployment needs inline-player guidance; generic clients keep their standalone-player guide.
  server = new McpServer({ name: 'djopus', version: '1.0.0' }, {
    instructions: this.env.CHATGPT_PRIVACY_MODE === '1' ? CHATGPT_INSTRUCTIONS : INSTRUCTIONS,
  });

  // The framework's telemetry events carry this object's name, streamable-http:<Mcp-Session-Id>, and the session id is
  // what lets a client into the MCP session. Nothing subscribes to them, but no raw id is to be logged anywhere, so this
  // object sends none. What it logs are logEvent lines with keyed session hashes.
  override observability = undefined;

  async init(): Promise<void> {
    await this.scheduleExpiry();
    registerGuide(this.server, this.env.CHATGPT_PRIVACY_MODE === '1');
    registerWidgetResource(this.server, this.props?.origin ?? '', this.env.CHATGPT_PRIVACY_MODE === '1');
    registerGenericTools(this.server, {
      binding: storageBinding(this.ctx.storage),
      origin: this.props?.origin ?? '',
      env: this.env,
      onToolCall: () => this.recordActivity(),
    });
  }

  /**
   * The expiry schedule's callback.
   *
   * - With a request in flight, the MCP session is kept for another 30 days: destroying the object would cut the
   *   request off. McpAgent bridges every request to this object over a connection of its own, which closes with its
   *   answer.
   * - The SSE stream a client keeps open for the server's messages does not count (ruling P2-R27). The Worker that holds
   *   it learns that the client has gone only when it writes to it, and nothing is written to an idle one, so a stream
   *   can outlive its client for good (under wrangler dev one did). Counting it would take away the 30-day bound. A
   *   client that is still there after 30 idle days finds its MCP session gone and starts a new one, and connect takes
   *   it back to the player it had.
   * - Otherwise it is destroyed once it has run no tool for 30 days (one that never ran any counts as idle), and
   *   scheduled again for 30 days after the last tool call when it has.
   *
   * The schedule is set again not idempotently: the row that is running is listed until this returns and is deleted
   * after, and an idempotent schedule would be that row.
   */
  async expireIfIdle(): Promise<void> {
    if (this.hasRequestInFlight()) {
      await this.schedule(EXPIRY_DELAY_S, 'expireIfIdle', undefined, { idempotent: false });
      return;
    }
    const now = Date.now();
    const lastActivity = await this.ctx.storage.get<unknown>(LAST_ACTIVITY_KEY);
    if (typeof lastActivity === 'number' && now - lastActivity < SESSION_TTL_MS) {
      await this.schedule(Math.ceil((lastActivity + SESSION_TTL_MS - now) / 1000), 'expireIfIdle', undefined, { idempotent: false });
      return;
    }
    const bound = await this.ctx.storage.get<unknown>(SESSION_BINDING_KEY);
    logEvent('mcp_session_expired', typeof bound === 'string' ? { sessionHash: await sessionHash(bound, this.env.LOG_HASH_KEY) } : {});
    // Drops everything the object holds, the agent's own keys and tables included, and aborts it.
    await this.destroy();
  }

  // getConnections() lists the open connections, the hibernated ones included: one for each request in flight, and the
  // standalone SSE stream, which McpAgent's transport marks with _standaloneSse in the connection's state (agents
  // 0.30.1, StreamableHTTPServerTransport.handleGetRequest). A GET that resumes a request's stream carries that
  // request's ids instead, and counts. So does a connection whose state is not set yet: a request that has just come in.
  private hasRequestInFlight(): boolean {
    for (const connection of this.getConnections()) {
      const state = connection.state as { _standaloneSse?: unknown } | null | undefined;
      if (state?._standaloneSse !== true) return true;
    }
    return false;
  }

  private async recordActivity(): Promise<void> {
    await this.ctx.storage.put(LAST_ACTIVITY_KEY, Date.now());
    await this.scheduleExpiry();
  }

  // The same form of `when` (a delay in seconds) and the same payload (none) everywhere, so that every call finds the
  // one row: the scheduler matches the kind of time too, and a Date would be another kind.
  private async scheduleExpiry(): Promise<void> {
    await this.schedule(EXPIRY_DELAY_S, 'expireIfIdle', undefined, { idempotent: true });
  }
}
