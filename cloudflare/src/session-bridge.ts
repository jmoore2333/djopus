import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { ClientRole, IncomingMessage, SessionState } from './protocol';

interface ClientMeta {
  role: ClientRole;
  connectedAt: string;
}

const MAX_HISTORY = 50;

export class SessionBridge extends DurableObject<Env> {
  private clients: Map<WebSocket, ClientMeta> = new Map();
  private currentPattern = '';
  private isPlaying = false;
  private createdAt: string;
  private lastActivity: string;
  private patternHistory: string[] = [''];
  private historyIndex = 0;
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.createdAt = new Date().toISOString();
    this.lastActivity = this.createdAt;
  }

  // Restore state from SQLite storage on first access
  private async ensureLoaded(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const stored = await this.ctx.storage.get<{
      currentPattern: string;
      patternHistory: string[];
      historyIndex: number;
      createdAt: string;
    }>('session');

    if (stored) {
      this.currentPattern = stored.currentPattern;
      this.patternHistory = stored.patternHistory;
      this.historyIndex = stored.historyIndex;
      this.createdAt = stored.createdAt;
    }
  }

  // Persist session state to SQLite storage
  private async persistState(): Promise<void> {
    await this.ctx.storage.put('session', {
      currentPattern: this.currentPattern,
      patternHistory: this.patternHistory,
      historyIndex: this.historyIndex,
      createdAt: this.createdAt,
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();

    const url = new URL(request.url);
    const role: ClientRole = url.searchParams.get('role') === 'controller' ? 'controller' : 'browser';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);

    this.clients.set(server, { role, connectedAt: new Date().toISOString() });

    server.send(JSON.stringify({
      type: 'session_state',
      payload: this.getSessionState(),
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    await this.ensureLoaded();

    let data: IncomingMessage;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const sender = this.clients.get(ws);
    if (!sender) return;

    this.lastActivity = new Date().toISOString();
    const rid = (data as { request_id?: string }).request_id;

    switch (data.type) {
      case 'evaluate': {
        this.currentPattern = data.payload.code;
        this.isPlaying = true;
        this.pushHistory(data.payload.code);
        await this.persistState();
        const browserCount = this.broadcastTo('browser', data);
        if (browserCount === 0) {
          this.ackTo('controller', rid, 'no_browser', { warning: 'No browser connected. Open djopus.moore.nyc first.' });
        } else {
          this.ackTo('controller', rid, 'playing', { browsers: browserCount });
        }
        break;
      }

      case 'stop':
        this.isPlaying = false;
        this.broadcastTo('browser', data);
        this.ackTo('controller', rid, 'stopped');
        break;

      case 'set_code':
        this.currentPattern = data.payload.code;
        this.pushHistory(data.payload.code);
        await this.persistState();
        this.broadcastTo('browser', data);
        this.ackTo('controller', rid, 'code_set');
        break;

      case 'set_tempo':
        this.broadcastTo('browser', data);
        this.ackTo('controller', rid, 'tempo_sent');
        break;

      case 'get_code':
        this.broadcastTo('browser', data);
        break;

      case 'append_code':
        this.broadcastTo('browser', data);
        this.ackTo('controller', rid, 'append_sent');
        break;

      case 'replace_code':
        this.broadcastTo('browser', data);
        this.ackTo('controller', rid, 'replace_sent');
        break;

      case 'add_effect':
        this.broadcastTo('browser', data);
        this.ackTo('controller', rid, 'effect_sent');
        break;

      case 'undo': {
        const code = this.undo();
        if (code !== null) {
          this.currentPattern = code;
          await this.persistState();
          this.broadcastTo('browser', { type: 'evaluate', payload: { code } });
          this.ackTo('controller', rid, 'undone', { code, historyIndex: this.historyIndex });
        } else {
          this.ackTo('controller', rid, 'nothing_to_undo');
        }
        break;
      }

      case 'redo': {
        const code = this.redo();
        if (code !== null) {
          this.currentPattern = code;
          await this.persistState();
          this.broadcastTo('browser', { type: 'evaluate', payload: { code } });
          this.ackTo('controller', rid, 'redone', { code, historyIndex: this.historyIndex });
        } else {
          this.ackTo('controller', rid, 'nothing_to_redo');
        }
        break;
      }

      case 'get_state':
        ws.send(JSON.stringify({
          type: 'session_state',
          request_id: rid,
          payload: this.getSessionState(),
        }));
        break;

      case 'status_report':
        if (sender.role === 'browser') {
          this.broadcastTo('controller', { type: 'client_status', payload: data.payload });
        }
        break;

      case 'error':
        if (sender.role === 'browser') {
          this.broadcastTo('controller', { type: 'pattern_error', request_id: rid, payload: data.payload });
        }
        break;

      case 'code_response':
        if (sender.role === 'browser') {
          this.currentPattern = data.payload.code;
          this.broadcastTo('controller', { type: 'code_response', request_id: rid, payload: data.payload });
        }
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.clients.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.clients.delete(ws);
  }

  // --- History ---

  private pushHistory(code: string): void {
    if (code === this.patternHistory[this.historyIndex]) return;
    this.patternHistory = this.patternHistory.slice(0, this.historyIndex + 1);
    this.patternHistory.push(code);
    if (this.patternHistory.length > MAX_HISTORY) {
      this.patternHistory.shift();
    }
    this.historyIndex = this.patternHistory.length - 1;
  }

  private undo(): string | null {
    if (this.historyIndex <= 0) return null;
    this.historyIndex--;
    return this.patternHistory[this.historyIndex];
  }

  private redo(): string | null {
    if (this.historyIndex >= this.patternHistory.length - 1) return null;
    this.historyIndex++;
    return this.patternHistory[this.historyIndex];
  }

  // --- Helpers ---

  private getSessionState(): SessionState {
    let browsers = 0;
    let controllers = 0;
    for (const meta of this.clients.values()) {
      if (meta.role === 'browser') browsers++;
      else controllers++;
    }
    return {
      currentPattern: this.currentPattern,
      isPlaying: this.isPlaying,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      connectedClients: browsers,
      connectedControllers: controllers,
      historySize: this.patternHistory.length,
      historyIndex: this.historyIndex,
    };
  }

  private broadcastTo(role: ClientRole, message: object): number {
    const json = JSON.stringify(message);
    let count = 0;
    for (const [ws, meta] of this.clients) {
      if (meta.role === role) {
        try { ws.send(json); count++; } catch { this.clients.delete(ws); }
      }
    }
    return count;
  }

  private ackTo(role: ClientRole, requestId: string | undefined, status: string, payload?: Record<string, unknown>): void {
    const msg: Record<string, unknown> = { type: 'ack', status };
    if (requestId) msg.request_id = requestId;
    if (payload) msg.payload = payload;
    this.broadcastTo(role, msg);
  }
}
