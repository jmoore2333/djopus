import WebSocket from 'ws';
import { randomUUID } from 'crypto';

interface SessionState {
  currentPattern: string;
  isPlaying: boolean;
  connectedClients: number;
  connectedControllers: number;
  historySize: number;
  historyIndex: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT = 10000;

export class WorkerClient {
  private wsUrl: string;
  private apiUrl: string;
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private sessionState: SessionState | null = null;
  private _connected = false;
  private _connectResolved = false;

  constructor(baseUrl: string, sessionId: string = 'default') {
    const wsProtocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
    const wsHost = baseUrl.replace(/^https?:\/\//, '');
    this.wsUrl = `${wsProtocol}://${wsHost}/ws?session=${sessionId}&role=controller`;
    this.apiUrl = `${baseUrl}/api`;
  }

  isConnected(): boolean {
    return this._connected && this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    this._connectResolved = false;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
        this.ws?.close();
      }, 10000);

      this.ws.on('open', () => {
        this._connected = true;
        clearTimeout(timeout);
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);

        // Resolve connect promise on first session_state
        if (msg.type === 'session_state' && !this._connectResolved) {
          this.sessionState = msg.payload;
          this._connectResolved = true;
          resolve();
        }
      });

      this.ws.on('close', () => {
        this._connected = false;
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('WebSocket disconnected'));
          this.pendingRequests.delete(id);
        }
      });

      this.ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }

  // --- WebSocket Commands ---

  async evaluate(code: string): Promise<unknown> {
    return this.sendCommand({ type: 'evaluate', payload: { code } });
  }

  async stop(): Promise<unknown> {
    return this.sendCommand({ type: 'stop' });
  }

  async setCode(code: string): Promise<unknown> {
    return this.sendCommand({ type: 'set_code', payload: { code } });
  }

  async setTempo(bpm: number): Promise<unknown> {
    return this.sendCommand({ type: 'set_tempo', payload: { bpm } });
  }

  async getCode(): Promise<string> {
    const result = await this.sendCommand({ type: 'get_code' }, 'code_response');
    return (result as { payload: { code: string } }).payload.code;
  }

  async appendCode(code: string): Promise<unknown> {
    return this.sendCommand({ type: 'append_code', payload: { code } });
  }

  async replaceCode(search: string, replace: string): Promise<unknown> {
    return this.sendCommand({ type: 'replace_code', payload: { search, replace } });
  }

  async undo(): Promise<unknown> {
    return this.sendCommand({ type: 'undo' });
  }

  async redo(): Promise<unknown> {
    return this.sendCommand({ type: 'redo' });
  }

  async addEffect(effect: string, params?: Record<string, number>): Promise<unknown> {
    return this.sendCommand({ type: 'add_effect', payload: { effect, params } });
  }

  async getState(): Promise<SessionState> {
    if (!this.isConnected()) {
      await this.connect();
    }
    const result = await this.sendCommand({ type: 'get_state' }, 'session_state');
    return (result as { payload: SessionState }).payload;
  }

  // --- REST API ---

  async listPatterns(tag?: string): Promise<unknown> {
    const url = tag ? `${this.apiUrl}/patterns?tag=${encodeURIComponent(tag)}` : `${this.apiUrl}/patterns`;
    const res = await fetch(url);
    return res.json();
  }

  async savePattern(name: string, content: string, tags?: string[]): Promise<unknown> {
    const res = await fetch(`${this.apiUrl}/patterns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content, tags: tags || [] }),
    });
    return res.json();
  }

  async loadPattern(name: string): Promise<{ content: string; name: string; tags: string[] }> {
    const res = await fetch(`${this.apiUrl}/patterns/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Pattern "${name}" not found`);
    return res.json() as Promise<{ content: string; name: string; tags: string[] }>;
  }

  async deletePattern(name: string): Promise<unknown> {
    const res = await fetch(`${this.apiUrl}/patterns/${encodeURIComponent(name)}`, { method: 'DELETE' });
    return res.json();
  }

  async generatePattern(style: string, bpm?: number, key?: string): Promise<string> {
    const res = await fetch(`${this.apiUrl}/generate/pattern`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style, bpm, key }),
    });
    const data = await res.json() as { pattern: string };
    return data.pattern;
  }

  async generateDrums(style: string, complexity?: number): Promise<string> {
    const res = await fetch(`${this.apiUrl}/generate/drums`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style, complexity }),
    });
    const data = await res.json() as { pattern: string };
    return data.pattern;
  }

  async generateBassline(key: string, style: string): Promise<string> {
    const res = await fetch(`${this.apiUrl}/generate/bassline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, style }),
    });
    const data = await res.json() as { pattern: string };
    return data.pattern;
  }

  async validatePattern(pattern: string): Promise<unknown> {
    const res = await fetch(`${this.apiUrl}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern }),
    });
    return res.json();
  }

  // --- Internal ---

  private async sendCommand(msg: Record<string, unknown>, waitForType?: string): Promise<unknown> {
    // Auto-reconnect if disconnected
    if (!this.isConnected()) {
      this.sessionState = null;
      await this.connect();
    }

    const requestId = randomUUID();
    msg.request_id = requestId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timeout: ${msg.type}`));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        ...(waitForType ? { waitForType } : {}),
      } as PendingRequest & { waitForType?: string });

      this.ws!.send(JSON.stringify(msg));
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const requestId = msg.request_id as string | undefined;

    // Update local state mirror
    if (msg.type === 'session_state') {
      this.sessionState = msg.payload as SessionState;
    }
    if (msg.type === 'client_status') {
      // Update playing state from browser reports
      const status = msg.payload as { isPlaying: boolean };
      if (this.sessionState) {
        this.sessionState.isPlaying = status.isPlaying;
      }
    }

    // Resolve pending requests
    if (requestId && this.pendingRequests.has(requestId)) {
      const pending = this.pendingRequests.get(requestId)!;
      const waitForType = (pending as unknown as { waitForType?: string }).waitForType;

      // If waiting for a specific type (like code_response), only resolve on that type
      if (waitForType && msg.type !== waitForType) {
        return; // Keep waiting
      }

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(requestId);
      pending.resolve(msg);
      return;
    }

    // Handle broadcasts (no request_id match)
    if (msg.type === 'pattern_error') {
      console.error('[djopus-mcp] Pattern error:', (msg.payload as { message: string }).message);
    }
  }
}
