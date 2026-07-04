import { SessionBridge } from './session-bridge';
import { handleApiRoutes } from './api';
import type { Env } from './env';

export { SessionBridge };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // MCP endpoint for ChatGPT Apps SDK
    // Dynamic import: agents SDK requires nodejs_compat flag (present in wrangler.chatgpt.toml
    // but not in the main wrangler.toml). Lazy import ensures the main deployment doesn't
    // fail to bundle when this route is never hit.
    if (url.pathname.startsWith('/mcp')) {
      const { handleMcp } = await import('./mcp/handler');
      return handleMcp(request, env, ctx);
    }

    // WebSocket upgrade: /ws?session=<id>&role=<browser|controller>
    if (url.pathname === '/ws') {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const sessionId = url.searchParams.get('session') || 'default';
      const durableId = env.SESSION_BRIDGE.idFromName(sessionId);
      const stub = env.SESSION_BRIDGE.get(durableId);

      return stub.fetch(request);
    }

    // Widget route: serves the REPL with injected config/CSS for ChatGPT iframe
    if (url.pathname === '/widget') {
      const { getWidgetHtml } = await import('./mcp/widget-html');
      const sessionId = url.searchParams.get('session') || 'default';
      const origin = url.origin;
      const html = await getWidgetHtml(env.ASSETS, sessionId, origin);
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // REST API routes
    if (url.pathname.startsWith('/api/')) {
      return handleApiRoutes(request, env, url);
    }

    // Static assets (Strudel REPL)
    // Add CORS headers so assets load from ChatGPT's srcdoc widget iframe (origin: null)
    const assetResp = await env.ASSETS.fetch(request);
    const resp = new Response(assetResp.body, assetResp);
    resp.headers.set('Access-Control-Allow-Origin', '*');
    resp.headers.set('Access-Control-Allow-Methods', 'GET');
    return resp;
  },
};
