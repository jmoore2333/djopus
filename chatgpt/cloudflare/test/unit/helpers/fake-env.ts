import { vi, type Mock } from 'vitest';

// What client/strudel-ws-bridge.js exports under CommonJS, and the dependencies it takes.
// The bridge is a plain JS file, so these types live here and nothing checks them against it.

export type BridgeStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

/** What the status pill shows: the connection's status, or 'waiting' for a connection no agent has used yet. */
export type PillState = BridgeStatus | 'waiting';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BridgeDeps {
  WebSocketImpl: new (url: string) => FakeWebSocket;
  getMirror(): FakeMirror | null;
  getConfig(): Record<string, unknown> | undefined;
  location: { protocol: string; host: string; search: string; origin: string; pathname: string };
  timers: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(id: unknown): void;
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(id: unknown): void;
  };
  random(): number;
  /** Fills the bytes with cryptographically strong random values: the source of a new session id. */
  getRandomValues(bytes: Uint8Array): Uint8Array;
  /** Puts the path in the address bar without loading it (history.replaceState). */
  replaceUrl(path: string): void;
  localStorage: StorageLike;
  sessionStorage: StorageLike;
  onStatus?(status: BridgeStatus): void;
  onPill?(state: PillState): void;
  showAudioUnlockPrompt?(message?: string): void;
  clearAudioUnlockPrompt?(): void;
}

export interface Bridge {
  sessionId: string;
  /** The link to the player of this session: what the status pill copies. */
  playerUrl(): string;
  status: string;
  /** What the status pill shows now. */
  pill: PillState;
  connect(): void;
  onVisible(): void;
  onOnline(): void;
  onOffline(): void;
  reportPendingEvalError(message: string): boolean;
  resumeAudio(): Promise<string | null>;
  unlockAudio(): void;
}

export interface BridgeModule {
  createBridge(deps: BridgeDeps): Bridge;
  nextReconnectDelay(attempt: number, random: () => number): number;
  resolveSessionId(
    location: { pathname: string },
    config: Record<string, unknown> | undefined,
    mint: () => string,
  ): { id: string; rewriteTo: string | null };
  mintSessionId(getRandomValues: (bytes: Uint8Array) => Uint8Array): string;
  SESSION_ID_PATTERN: RegExp;
  LOCAL_KEYS: { local: string[]; session: string[] };
  pillState(status: BridgeStatus, agentSeen: boolean): PillState;
  /** The links of the AGPL source offer, in the order the pill shows them. */
  SOURCE_LINKS: ReadonlyArray<{ label: string; href: string; title: string }>;
}

type Listener = (event: { data?: unknown; code?: number }) => void;

/**
 * A WebSocket that records every instance and every frame it was asked to send. The test plays the
 * network: open(), receive() and drop() raise the events a real socket would.
 */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  /** When true, close() never raises a close event, like a connection whose peer is gone. */
  static silentClose = false;
  /** When true, every `ping` sent is answered with `pong` 50 ms later, like the server does. */
  static autoPong = false;

  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.silentClose = false;
    FakeWebSocket.autoPong = false;
  }

  static last(): FakeWebSocket {
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!socket) throw new Error('no socket has been constructed');
    return socket;
  }

  readonly url: string;
  readyState = 0; // CONNECTING
  readonly sent: string[] = [];
  closeCalls = 0;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError: the socket is not open');
    this.sent.push(data);
    if (data === 'ping' && FakeWebSocket.autoPong) {
      setTimeout(() => {
        if (this.readyState === 1) this.receive('pong');
      }, 50);
    }
  }

  close(): void {
    this.closeCalls++;
    if (this.readyState === 3) return;
    if (FakeWebSocket.silentClose) {
      this.readyState = 2; // CLOSING, and it stays there
      return;
    }
    this.readyState = 3;
    this.emit('close', { code: 1000 });
  }

  // --- the network's side ---

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  receive(frame: string | object): void {
    this.emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  /** The connection went away: the peer closed it or the network dropped. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.emit('close', { code });
  }

  /** Every frame that was sent as JSON, in order. The text frame `ping` is left out. */
  json(): Array<Record<string, any>> {
    return this.sent.filter((text) => text !== 'ping').map((text) => JSON.parse(text));
  }

  jsonOfType(type: string): Array<Record<string, any>> {
    return this.json().filter((frame) => frame.type === type);
  }

  private emit(type: string, event: { data?: unknown; code?: number }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export class MemoryStorage implements StorageLike {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

export interface FakeMirror {
  code: string;
  /**
   * Called by the editor's own setCode, so it records every write that reached the editor. The bridge
   * wraps setCode for a while (the restore guard), so tests assert on this and not on setCode itself.
   */
  writes: Mock<(code: string) => void>;
  setCode(code: string): void;
  stop: Mock<() => void>;
  /**
   * Called by the editor's own evaluate, so it records every evaluation that reached the editor, and a test makes it
   * fail or take a while. The bridge wraps evaluate (to see the evaluations the user starts), so tests assert on this
   * and not on evaluate itself, as they do on `writes` for setCode.
   */
  evaluations: Mock<(autostart?: boolean) => Promise<void>>;
  /** What Ctrl+Enter and the play button call. */
  evaluate(autostart?: boolean): Promise<void>;
  repl: {
    scheduler: { started: boolean; cps: number };
    audioContext: { state: string; resume: Mock<() => Promise<void>> };
    evaluate: Mock<(code: string, autostart?: boolean) => void>;
    /** Strudel's evaluate does not reject when the code is wrong: it sets evalError and resolves. */
    state: { evalError: unknown };
  };
}

/**
 * The part of window.strudelMirror that the bridge reads and calls. setCode updates code at once, like
 * CodeMirror does, and uses `this`, like StrudelMirror's method does.
 */
export function makeMirror(initialCode = ''): FakeMirror {
  return {
    code: initialCode,
    writes: vi.fn(),
    setCode(this: FakeMirror, code: string) {
      this.writes(code);
      this.code = code;
    },
    stop: vi.fn(),
    evaluations: vi.fn(() => Promise.resolve()),
    evaluate(this: FakeMirror, autostart?: boolean) {
      return this.evaluations(autostart);
    },
    repl: {
      scheduler: { started: false, cps: 0.5 },
      audioContext: { state: 'running', resume: vi.fn(() => Promise.resolve()) },
      evaluate: vi.fn(),
      state: { evalError: undefined },
    },
  };
}

/** The same, with setCode and evaluate on the prototype, as they are on StrudelMirror. */
export function makeProtoMirror(initialCode = ''): FakeMirror {
  const { setCode, evaluate, ...own } = makeMirror(initialCode);
  return Object.assign(Object.create({ setCode, evaluate }), own) as FakeMirror;
}

export interface EnvOptions {
  config?: Record<string, unknown>;
  protocol?: string;
  host?: string;
  search?: string;
  pathname?: string;
  /** The editor the page has. A fresh one when omitted. */
  mirror?: FakeMirror;
  /** The page's editor has not started: getMirror() answers null. */
  noMirror?: boolean;
  random?: () => number;
  /** Fills the bytes of a new session id. The platform's crypto.getRandomValues when omitted. */
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
  /** What the address bar cannot be rewritten with: replaceUrl throws it. */
  replaceUrlError?: Error;
}

/**
 * The bridge's dependencies, all fake. random() answers 1 unless a test says otherwise, so the
 * reconnect delays are the plain doubling 1 s, 2 s, 4 s, ... capped at 30 s. The paths the bridge
 * puts in the address bar are collected in `replaced`, and what the status pill is told in `pills`.
 * Call after vi.useFakeTimers(): the timers read the globals each time they are used.
 */
export function makeEnv(options: EnvOptions = {}) {
  FakeWebSocket.reset();
  const mirror = options.mirror ?? makeMirror();
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const statuses: BridgeStatus[] = [];
  const pills: PillState[] = [];
  const prompts: Array<string | null> = [];
  const replaced: string[] = [];

  const deps: BridgeDeps = {
    WebSocketImpl: FakeWebSocket,
    getMirror: () => (options.noMirror ? null : mirror),
    getConfig: () => options.config,
    location: {
      protocol: options.protocol ?? 'https:',
      host: options.host ?? 'djopus.test',
      search: options.search ?? '',
      origin: `${options.protocol ?? 'https:'}//${options.host ?? 'djopus.test'}`,
      pathname: options.pathname ?? '/',
    },
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    },
    random: options.random ?? (() => 1),
    getRandomValues: options.getRandomValues ?? ((bytes) => crypto.getRandomValues(bytes)),
    replaceUrl: (path) => {
      if (options.replaceUrlError) throw options.replaceUrlError;
      replaced.push(path);
    },
    localStorage,
    sessionStorage,
    onStatus: (status) => statuses.push(status),
    onPill: (state) => pills.push(state),
    showAudioUnlockPrompt: (message) => prompts.push(message ?? 'default'),
    clearAudioUnlockPrompt: () => prompts.push(null),
  };
  return { deps, mirror, localStorage, sessionStorage, statuses, pills, prompts, replaced };
}
