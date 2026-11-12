import { SessionBridge } from './session-bridge';
import { jsonError, withErrorHandling } from './http';
import { DjOpusMcp } from './remote-mcp/agent';
import { logMcpReject, refuseMcpRequest } from './remote-mcp/guards';
import { handleApiRoutes } from './routes/api';
import { REFERRER_POLICY, serveAsset } from './routes/assets';
import { isSessionId } from './core/session-id';
import { publicOrigin } from './widget/public-origin';
import { checkRateLimit } from './routes/rate-limit';
import { APP_WS_RULES, handleWsUpgrade, logWsReject } from './routes/ws';

export { DjOpusMcp, SessionBridge };

// McpAgent's handler for /mcp, which gives every MCP session a DjOpusMcp object. serve() makes it once, here.
const mcp = DjOpusMcp.serve('/mcp', { binding: 'DJOPUS_MCP' });

/**
 * /mcp: the generic remote MCP. A request passes the guards (src/remote-mcp/guards.ts), then the per-IP limit, and then
 * goes to McpAgent with the origin of the host in its props: that is where the agent finds the host of the player URL.
 */
async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const refused = await refuseMcpRequest(request);
  if (refused) return refused;
  const limited = await checkRateLimit(env.MCP_RATE_LIMITER, request);
  if (limited) {
    logMcpReject('rate_limited');
    return limited;
  }
  (ctx as { props: unknown }).props = { origin: publicOrigin(request, env) };
  return mcp.fetch(request, env, ctx);
}

// The entry of the app Worker (wrangler.toml). The ChatGPT Worker has its own, src/chatgpt/index.ts, and the
// ChatGPT code (its /mcp and /widget) is reachable only from there: nothing here imports it, so a tree without
// src/chatgpt/ still builds.
export default {
  fetch: withErrorHandling(async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);

    // The inline widget is served here; nothing under /mcp/ (/mcp itself is the MCP) or under
    // /.well-known/ (no OAuth: an MCP client that probes the metadata paths up front has to get a 404, not a 200 page).
    // Without these answers the assets would treat such paths as pages of the single-page app and send index.html with
    // 200. They are the paths wrangler.toml sends this Worker (run_worker_first): /mcpx or /mcp.json is not one of them,
    // the assets answer it without this Worker, and so it is left to the assets here too.
    if (url.pathname === '/widget') {
      const sessionId = url.searchParams.get('session') ?? '';
      if (!isSessionId(sessionId)) return jsonError(400, 'Invalid session id');
      const { getWidgetHtml } = await import('./widget/widget-html');
      const html = await getWidgetHtml(env.ASSETS, sessionId, publicOrigin(request, env));
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': REFERRER_POLICY } });
    }
    // OpenAI supplies this public proof when an app draft is connected. It is
    // configured separately for the relevant Worker; no proof is served until set.
    if (url.pathname === '/.well-known/openai-apps-challenge' && request.method === 'GET' && env.OPENAI_APP_VERIFICATION_TOKEN) {
      return new Response(env.OPENAI_APP_VERIFICATION_TOKEN, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (url.pathname.startsWith('/.well-known/')) return jsonError(404, 'Not found');
    if (url.pathname === '/mcp') return handleMcp(request, env, ctx);
    if (url.pathname.startsWith('/mcp/')) return jsonError(404, 'Not found');

    // WebSocket upgrade: /ws?session=<id>, from a browser on this host's own page, with a 128-bit session id (the
    // player is /s/<id>). The id stays in the query, where logs and traces redact it. No agent connects here. Each
    // upgrade counts against the per-IP limit first, whatever the rules then say about it.
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') === 'websocket') {
        const limited = await checkRateLimit(env.WS_RATE_LIMITER, request);
        if (limited) {
          logWsReject('rate_limited');
          return limited;
        }
      }
      return handleWsUpgrade(request, env, APP_WS_RULES, publicOrigin(request, env));
    }

    // REST API routes. The app keeps no patterns here: a session's saves are its crate (src/core/crate-store.ts), which
    // the tools of /mcp reach through the session's Durable Object, so /api/patterns is a path like any other that the
    // API does not have. Only the ChatGPT Worker still has the D1 table.
    if (url.pathname.startsWith('/api/')) return handleApiRoutes(request, env, url, { patterns: 'none' });

    // Static assets (Strudel REPL). Only a path of run_worker_first that nothing above answers gets here (/ws/<anything>):
    // the pages and files come from the assets alone, and static/_headers sends their Referrer-Policy. No CORS headers:
    // only the ChatGPT widget loads them from another origin.
    return serveAsset(request, env, { cors: false });
  }),
};
