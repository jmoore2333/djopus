import { SessionBridge } from './session-bridge';
import { handleApiRoutes } from './api';
import type { Env } from './env';

export { SessionBridge };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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

    // REST API routes
    if (url.pathname.startsWith('/api/')) {
      return handleApiRoutes(request, env, url);
    }

    // Static assets (Strudel REPL)
    // Bridge script is injected directly into static/index.html at build time
    return env.ASSETS.fetch(request);
  },
};
