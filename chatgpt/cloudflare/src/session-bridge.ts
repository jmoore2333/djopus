import { DurableObject } from 'cloudflare:workers';
import { CRATE_MAX_ENTRIES, type CrateEntry, type CrateError, type CrateResult, type CrateSummary } from './core/crate-store';
import { HttpError } from './http';
import { isSessionId, newSessionId } from './core/session-id';
import { byteLength, checkCode, checkName, checkTags, MAX_CODE_BYTES, MAX_FRAME_BYTES } from './limits';
import { logEvent, sessionHash } from './log';
import type { AckMessage, ClientRole, IncomingMessage, SessionState, UndoResultMessage } from './protocol';

// The contract of the crate's RPC methods (below), for a caller that has this class in hand. The definitions are in
// src/core/crate-store.ts, which the store of the tools shares, and which imports this module for its type only.
export { CRATE_MAX_ENTRIES };
export type { CrateEntry, CrateError, CrateResult, CrateSummary };

// Stored on each socket with serializeAttachment(), so it survives hibernation.
// Sockets accepted by earlier code have no attachment, or one without sessionHash.
export interface SocketAttachment {
  role: ClientRole;
  connectedAt: string;
  sessionHash: string;
  // What is known of whether this browser is playing: its last status_report or code_update, or what the last
  // evaluate, undo, redo, stop or reset_session sent to it made it. Absent until there is one, and for a controller. A
  // socket accepted by earlier code has no attachment to keep it in, so it has no report.
  isPlaying?: boolean;
}

// The 'session' record. Records written before isPlaying, lastActivity and rev
// existed lack them.
interface StoredSession {
  currentPattern: string;
  patternHistory: string[];
  historyIndex: number;
  createdAt: string;
  isPlaying?: boolean;
  lastActivity?: string;
  rev?: number;
}

const MAX_HISTORY = 50;

// How many requests of one kind (edits, get_codes) can be waiting for their answer at once. When a controller sends more
// than that without an answer, the oldest are forgotten, so that the lists cannot grow without bound.
export const MAX_PENDING_REQUESTS = 100;

// A SQLite-backed Durable Object stores at most 2 MB for a key and its value, and the
// whole session, history included, is one value: 50 entries of 64 KB would be 3.2 MB,
// and every write after that would fail. So the oldest entries also go when the
// history passes this many bytes, which leaves room for the rest of the record.
// Every character counts as two bytes, because that is the most the storage needs
// for a string: it keeps one with a character above U+00FF at two bytes a character.
const MAX_HISTORY_BYTES = 1_048_576;

// lastActivity moves on every message but is written at most this often, unless
// something else is written anyway.
const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

// A session that has had no message for this long and has no socket open is deleted by
// its own alarm. A tab that is left open keeps its session, however quiet it is.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// The alarm is set for lastActivity + SESSION_TTL_MS, but is moved only when it is more
// than this far off that, so a busy session writes its alarm about once a day and not on
// every message.
const ALARM_SLACK_MS = 24 * 60 * 60 * 1000;

// The crate: a session's saved patterns, one storage key each, crate:<name>. Every other key of this object (session,
// sessionHash, aliasSessionId) is without that prefix, so no name can reach one of them.
const CRATE_PREFIX = 'crate:';

const NO_BROWSER_WARNING = 'No DJ Opus browser session is connected. Call openDJOpus first and wait for the REPL to load.';

// What a controller sends to drive the session. Each one is logged as a route, and only a
// controller's is obeyed: from a browser it is dropped (see webSocketMessage). What a browser sends
// (ack, error, code_response, status_report, code_update) is not in this list, and a controller's
// is not obeyed either.
const COMMAND_TYPES = new Set<IncomingMessage['type']>([
  'evaluate', 'stop', 'set_code', 'set_tempo', 'get_code', 'append_code', 'replace_code',
  'add_effect', 'recover_audio', 'reset_session', 'undo', 'redo', 'get_state',
]);

// Acks in which the browser reports the editor's text after changing it.
const EDIT_ACK_STATUSES = new Set(['appended', 'replaced', 'effect_added']);

// ws.close() throws for these. A peer never sends them: the runtime reports 1005
// for a close frame without a code and 1006 for a connection that dropped.
const UNSENDABLE_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

function isRole(value: unknown): value is ClientRole {
  return value === 'browser' || value === 'controller';
}

// A socket's role comes from its attachment first. Sockets accepted before
// attachments existed carry only a role tag, and anything else is a browser.
export function resolveRole(attachment: unknown, tags: string[]): ClientRole {
  const fromAttachment = (attachment as Partial<SocketAttachment> | null)?.role;
  if (isRole(fromAttachment)) return fromAttachment;
  return tags.find(isRole) ?? 'browser';
}

// The code to close with when answering a peer's close. A close that carried no
// code arrives as 1005, and that cannot be sent back, so 1000 stands in for it.
export function reciprocalCloseCode(code: number): number {
  return UNSENDABLE_CLOSE_CODES.has(code) ? 1000 : code;
}

function ackMessage(requestId: string | undefined, status: string, payload?: Record<string, unknown>): Record<string, unknown> {
  const msg: Record<string, unknown> = { type: 'ack', status };
  if (requestId) msg.request_id = requestId;
  if (payload) msg.payload = payload;
  return msg;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Why the code in a payload off the wire cannot be used, or null when it can: it is
// not a string, or it is a string over the limit.
function codeProblem(payload: unknown): 'invalid_payload' | 'code_too_large' | null {
  const code = isObject(payload) ? payload.code : undefined;
  if (typeof code !== 'string') return 'invalid_payload';
  return byteLength(code) > MAX_CODE_BYTES ? 'code_too_large' : null;
}

// null for anything that is not a JSON object.
function parseFrame(text: string): IncomingMessage | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as IncomingMessage) : null;
  } catch {
    return null;
  }
}

// For sort: negative, zero or positive, by UTF-16 code unit. Times in ISO 8601 order by it, as they do in time.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// A UTF-16 code unit of a surrogate pair with no partner: text that is not well-formed, such as an emoji cut in half.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// What one of the Phase 1 checks of src/limits.ts (checkName, checkCode, checkTags) answers, or undefined when it
// refuses. They throw an HttpError for that, which is the only thing caught here.
function accepted<T>(check: () => T): T | undefined {
  try {
    return check();
  } catch (error) {
    if (error instanceof HttpError) return undefined;
    throw error;
  }
}

// A crate name is what checkName takes, a string of 1 to MAX_NAME_CHARS characters, and well-formed text besides.
// Storage keeps two names that differ only in a lone surrogate apart, but a listing returns its keys decoded, where
// they are one: several would fold into a single entry in crateList and in the count of the crate, which could then
// hold more than CRATE_MAX_ENTRIES.
function crateName(value: unknown): string | undefined {
  const name = accepted(() => checkName(value));
  return name !== undefined && !LONE_SURROGATE.test(name) ? name : undefined;
}

// A save as the crate keeps it, or why it cannot be kept. The verdict is that of the Phase 1 checks the REST route
// used, in its order (name, content, tags), so that a pattern is acceptable on every surface or on none. That is more
// than limits on size: content has to be a string before it has a size (TextEncoder reads any object as the text
// "[object Object]", 15 bytes), and no tags, undefined or null, is none, as checkTags says. 'too_large' is the code
// for both ways content can fail, because the crate has no other for it, and the store tells the agent which it was.
// What reaches this is not trusted to be what its type says.
function checkCrateSave(input: { name: unknown; content: unknown; tags: unknown }):
  | { error: Exclude<CrateError, 'crate_full'> }
  | { error?: undefined; name: string; content: string; tags: string[] } {
  const name = crateName(input.name);
  if (name === undefined) return { error: 'invalid_name' };
  const content = accepted(() => checkCode(input.content, 'content'));
  if (content === undefined) return { error: 'too_large' };
  const tags = accepted(() => checkTags(input.tags));
  if (tags === undefined) return { error: 'invalid_tags' };
  return { name, content, tags };
}

// When a stored session was last active: its lastActivity, or the time it was created for a
// record from before lastActivity was kept. 0 when there is no record at all, which is a
// session that was only ever connected to. A time that cannot be read counts as now: the
// alarm deletes everything the session holds, and a record that cannot be understood is no
// reason to do that.
function lastActivityOf(stored: StoredSession | undefined, now: number): number {
  if (!stored) return 0;
  const at = Date.parse(stored.lastActivity ?? stored.createdAt);
  return Number.isNaN(at) ? now : at;
}

export class SessionBridge extends DurableObject<Cloudflare.Env> {
  private currentPattern = '';
  // Whether the session is playing: any open browser's last report says it is, or when no open browser has one, what
  // the last command made it (see refreshPlaying). This is what is stored and reported.
  private isPlaying = false;
  // Counts changes to the code, so a client can tell a newer session_state from an older one.
  private rev = 0;
  private createdAt: string;
  private lastActivity: string;
  // When the lastActivity in storage was set, in ms since the epoch. 0 if nothing is stored.
  private persistedActivityAt = 0;
  // When the alarm is set for, in ms since the epoch, or null if there is none. Read from storage
  // once when the object starts, and kept right by the setAlarm calls of this object, so that
  // a message does not have to ask.
  private alarmAt: number | null = null;
  private patternHistory: string[] = [''];
  private historyIndex = 0;
  // For sockets whose attachment has no sessionHash. Written when a socket connects.
  private storedSessionHash: string | undefined;
  // The request_ids of the edits (append_code, replace_code, add_effect) that were sent to a browser and are still
  // waiting for its ack, and of the get_codes still waiting for their code_response. The ack of an edit and the answer
  // to a get_code carry the editor's whole text and the session takes that for its code, so it takes it only from an
  // answer it is waiting for: one that nobody asked for, or that comes after a newer evaluate, set_code, undo, redo or
  // reset_session, holds text that is stale or unasked, and adopting it would put it over the session's code. Each kind
  // is bounded by itself. In memory only. After an eviction the requests in flight are not waited for, which costs
  // nothing: an answer comes within a second, and the next get_code sets the session right. So does the next play by
  // hand: once the page has sent an answer or an ack it does not know what the session holds, so it reports the next
  // play, whatever the text.
  private pendingEdits = new Set<string>();
  private pendingGets = new Set<string>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.createdAt = new Date().toISOString();
    this.lastActivity = this.createdAt;
    // The runtime answers this itself, without waking an evicted object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // Nothing is delivered until the stored state is back, so no handler sees the defaults.
    void ctx.blockConcurrencyWhile(() => this.load());
  }

  private async load(): Promise<void> {
    const stored = await this.ctx.storage.get<StoredSession>('session');
    if (stored) {
      this.currentPattern = stored.currentPattern;
      this.patternHistory = stored.patternHistory;
      this.historyIndex = stored.historyIndex;
      this.createdAt = stored.createdAt;
      this.isPlaying = stored.isPlaying ?? false;
      this.lastActivity = stored.lastActivity ?? stored.createdAt;
      this.rev = stored.rev ?? 0;
      this.persistedActivityAt = Date.parse(this.lastActivity);
    }
    this.storedSessionHash = await this.ctx.storage.get<string>('sessionHash');
    this.alarmAt = await this.ctx.storage.getAlarm();
  }

  // Persist session state to SQLite storage
  private async persistState(): Promise<void> {
    const record: StoredSession = {
      currentPattern: this.currentPattern,
      patternHistory: this.patternHistory,
      historyIndex: this.historyIndex,
      createdAt: this.createdAt,
      isPlaying: this.isPlaying,
      lastActivity: this.lastActivity,
      rev: this.rev,
    };
    await this.ctx.storage.put('session', record);
    this.persistedActivityAt = Date.parse(this.lastActivity);
  }

  /** Resolve one ChatGPT conversation to a random player capability, atomically.
   * This object is named by a hash of the conversation metadata, never the raw id.
   * Supplying a capability rebinds the conversation after an explicit connect.
   */
  async conversationSession(rebind?: string): Promise<string> {
    if (rebind !== undefined && !isSessionId(rebind)) throw new Error('Invalid session id');
    const id = await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<string>('conversationSessionId');
      if (rebind !== undefined) {
        await txn.put('conversationSessionId', rebind);
        return rebind;
      }
      if (existing) return existing;
      const created = newSessionId();
      await txn.put('conversationSessionId', created);
      return created;
    });
    // The mapping is idle-expiring, just like the session it points at.
    this.lastActivity = new Date().toISOString();
    await this.persistState();
    await this.scheduleExpiry();
    return id;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      if (url.pathname === '/alias') {
        if (request.method === 'GET') {
          const sessionId = await this.ctx.storage.get<string>('aliasSessionId');
          return Response.json({ sessionId: sessionId ?? null });
        }

        if (request.method === 'POST') {
          const body = (await request.json()) as { sessionId?: string };
          if (!body.sessionId) {
            return Response.json({ error: 'sessionId is required' }, { status: 400 });
          }
          await this.ctx.storage.put('aliasSessionId', body.sessionId);
          return Response.json({ ok: true });
        }
      }

      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const role: ClientRole = url.searchParams.get('role') === 'controller' ? 'controller' : 'browser';
    if (this.storedSessionHash === undefined) {
      // Made once and kept. Without a LOG_HASH_KEY the key is random per isolate,
      // so hashing again after a restart would tag the same session differently.
      // The object's own name is the session id the Worker addressed it by (an agent's internal request carries no
      // ?session=, and a browser's carries the same id). A request without one went to the session named 'default'.
      const created = await sessionHash(this.ctx.id.name ?? (url.searchParams.get('session') || 'default'), this.env.LOG_HASH_KEY);
      await this.ctx.storage.put('sessionHash', created);
      this.storedSessionHash = created;
    }
    const hash = this.storedSessionHash;
    // A session that is only ever connected to, and never written to, has to expire as well, so a connect sets the
    // alarm when there is none: SESSION_TTL_MS from now, since a socket is open now. It is not lastActivity +
    // SESSION_TTL_MS, which is long past for a session that was quiet before sessions had alarms, and an alarm in the
    // past runs at once. A connect leaves an alarm that is there alone: it is not a message.
    if (this.alarmAt === null) await this.scheduleExpiry(Date.now());

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    const attachment: SocketAttachment = { role, connectedAt: new Date().toISOString(), sessionHash: hash };
    server.serializeAttachment(attachment);

    server.send(JSON.stringify({
      type: 'session_state',
      payload: this.getSessionState(),
    }));
    logEvent('ws_connect', { sessionHash: hash, role });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const { role: senderRole, sessionHash: hash } = this.identify(ws);
    await this.recordActivity();

    if (typeof message !== 'string') {
      logEvent('drop', { sessionHash: hash, reason: 'binary_frame' });
      return;
    }
    if (byteLength(message) > MAX_FRAME_BYTES) {
      logEvent('drop', { sessionHash: hash, reason: 'frame_too_large' });
      this.replyTo(ws, { type: 'error', payload: { message: 'Message too large' } });
      return;
    }
    const data = parseFrame(message);
    if (!data) {
      logEvent('drop', { sessionHash: hash, reason: 'invalid_json' });
      return;
    }

    const rid = (data as { request_id?: string }).request_id;
    if (COMMAND_TYPES.has(data.type)) {
      // Only a controller commands the session. A browser is sent commands and reports back (ack, error,
      // code_response, status_report, code_update); if it could send one, the page of anybody who holds the session id would
      // drive it, run code in the other tabs included, and the ban on role=controller at the app's /ws would mean
      // little. The sender is not answered, and nothing is forwarded, routed or changed. The role is the socket's
      // own (its attachment, or its tag for a socket the previous code accepted); a socket with neither is a browser.
      if (senderRole !== 'controller') {
        logEvent('drop', { sessionHash: hash, reason: 'browser_sent_command' });
        return;
      }
      logEvent('route', { sessionHash: hash, type: data.type, browsers: this.openSockets('browser').length });
    }

    // evaluate and set_code replace the session's code, so the code has to be a string
    // within the limit. If it is not, it never reaches the session, its history or
    // the browsers, and the sender is told why.
    if (data.type === 'evaluate' || data.type === 'set_code') {
      const problem = codeProblem(data.payload);
      if (problem) {
        logEvent('drop', { sessionHash: hash, reason: problem });
        this.replyTo(ws, ackMessage(rid, 'rejected', { reason: problem }));
        return;
      }
    }

    switch (data.type) {
      case 'evaluate':
        this.currentPattern = data.payload.code;
        this.setPlayingByCommand(true);
        this.forgetPending();
        this.rev++;
        this.pushHistory(data.payload.code);
        await this.persistState();
        this.forwardToBrowsers(data, rid);
        break;

      // The session is stopped as the command goes out, but the controller is not told it stopped: the browser's own ack
      // (status 'stopped', with the request_id) is relayed, as for any command a browser carries out. With no browser,
      // forwardToBrowsers answers no_browser. An ack from the session itself would report a success that no page confirmed.
      case 'stop':
        if (this.setPlayingByCommand(false)) await this.persistState();
        this.forwardToBrowsers(data, rid);
        break;

      case 'set_code':
        this.currentPattern = data.payload.code;
        this.forgetPending();
        this.rev++;
        this.pushHistory(data.payload.code);
        await this.persistState();
        this.forwardToBrowsers(data, rid);
        break;

      case 'set_tempo':
      case 'recover_audio':
        this.forwardToBrowsers(data, rid);
        break;

      // The browser answers a get_code with a code_response that holds the editor's text, and an edit with an ack that
      // does, and the session waits for those answers: see pendingGets and pendingEdits. With no browser to receive the
      // request there is no answer to wait for.
      case 'get_code':
        if (this.forwardToBrowsers(data, rid)) this.expectAnswer(this.pendingGets, rid);
        break;

      case 'append_code':
      case 'replace_code':
      case 'add_effect':
        if (this.forwardToBrowsers(data, rid)) this.expectAnswer(this.pendingEdits, rid);
        break;

      case 'reset_session':
        this.resetState();
        await this.persistState();
        this.broadcastTo('browser', { type: 'reset_session', payload: { code: '' } });
        this.ackTo('controller', rid, 'session_reset', {
          currentPattern: this.currentPattern,
          historySize: this.patternHistory.length,
        });
        break;

      case 'undo':
      case 'redo':
        this.forgetPending();
        await this.moveHistory(ws, data.type, rid);
        break;

      case 'get_state':
        this.replyTo(ws, { type: 'session_state', request_id: rid, payload: this.getSessionState() });
        break;

      // What a browser reports reaches the controllers, which read these payloads without
      // checking them, so a payload that is not what its type needs stops here.
      case 'status_report':
        if (senderRole === 'browser') {
          if (!isObject(data.payload)) {
            logEvent('drop', { sessionHash: hash, reason: 'invalid_payload' });
            return;
          }
          const reported: unknown = data.payload.isPlaying; // off the wire, so check the type
          if (typeof reported === 'boolean') {
            this.rememberPlaying(ws, reported);
            if (this.refreshPlaying()) await this.persistState();
          }
          this.broadcastTo('controller', { type: 'client_status', payload: data.payload });
        }
        break;

      case 'error':
        if (senderRole === 'browser') {
          if (!isObject(data.payload)) {
            logEvent('drop', { sessionHash: hash, reason: 'invalid_payload' });
            return;
          }
          if (rid !== undefined) { // a request that failed has no answer to wait for
            this.pendingEdits.delete(rid);
            this.pendingGets.delete(rid);
          }
          this.broadcastTo('controller', { type: 'pattern_error', request_id: rid, payload: data.payload });
        }
        break;

      case 'code_response':
        if (senderRole === 'browser') {
          // The get_code is answered, whatever the answer holds. Only the answer to one the session is waiting for is
          // the editor's text as of now: one that nobody asked for, or that a newer command has passed, is passed on to
          // the controllers (the one that asked is waiting for it) and is not adopted.
          const asked = this.takeAnswer(this.pendingGets, rid);
          const problem = codeProblem(data.payload);
          if (problem) {
            // Whoever asked for this code is waiting for the answer, so they are told it was refused.
            logEvent('drop', { sessionHash: hash, reason: 'invalid_payload' });
            this.ackTo('controller', rid, 'rejected', { reason: problem });
            return;
          }
          // What the editor shows is what the session holds, as for the code in an ack.
          if (asked && this.adoptEditorCode(data.payload.code)) await this.persistState();
          this.broadcastTo('controller', { type: 'code_response', request_id: rid, payload: data.payload });
        }
        break;

      // The user played the editor's text by hand. A controller has no editor, and a code_update from one would put code in
      // the session that no page has played, so it is dropped, as a browser's command is. From a browser it is the editor's
      // text like the one in an ack or a get_code answer, and is taken the same way: only when it differs from the
      // session's code, and a page that plays it is playing.
      case 'code_update':
        if (senderRole !== 'browser') {
          logEvent('drop', { sessionHash: hash, reason: 'controller_code_update' });
          return;
        }
        if (codeProblem(data.payload)) {
          logEvent('drop', { sessionHash: hash, reason: 'invalid_payload' });
          return;
        }
        if (this.adoptEditorCode(data.payload.code)) {
          this.rememberPlaying(ws, true);
          this.isPlaying = true;
          await this.persistState();
        }
        break;

      case 'ack':
        if (senderRole === 'browser') {
          if (this.adoptAckCode(data)) await this.persistState();
          this.broadcastTo('controller', {
            type: 'ack',
            request_id: rid,
            status: data.status,
            payload: data.payload,
          });
        }
        break;

      default:
        logEvent('drop', { sessionHash: hash, reason: 'unknown_type' });
        return;
    }

    await this.persistActivity();
  }

  // Answer the peer's close with one of our own. Without it the browser never
  // sees the handshake finish and reports 1006.
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const { role, sessionHash: hash } = this.identify(ws);
    try {
      ws.close(reciprocalCloseCode(code), reason);
    } catch {
      // the peer is already gone
    }
    logEvent('ws_close', { sessionHash: hash, role, code });
    await this.browserGone(role);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const { role } = this.identify(ws);
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      // already closed
    }
    await this.browserGone(role);
  }

  // A tab that closes, or errors out and is closed, no longer counts, and the ones that are left may all report that
  // they are idle.
  private async browserGone(role: ClientRole): Promise<void> {
    if (role === 'browser' && this.refreshPlaying()) await this.persistState();
  }

  // --- Crate (RPC) ---
  //
  // The saves of this session, called by the Worker's tools through the session's stub (src/core/crate-store.ts is the
  // caller). Private to the session by being in its object, and gone with the rest of it when the alarm deletes the
  // session. Each entry is one key, crate:<name>, so that one write is one entry and each value stays far below the
  // 2 MB a key and its value can take. A save that is turned away comes back as a CrateResult and is not thrown, so
  // that the reason crosses the RPC boundary as it is.
  //
  // Every call here is a call on the session, so it counts as activity (see recordUse). The reads and the writes
  // below await nothing but storage, so no other call to this object runs between a check and the write that
  // depends on it: two saves that arrive together cannot both take the last place.

  async crateSave(input: { name: string; content: string; tags: string[] }): Promise<CrateResult<{ saved: string; overwritten: boolean }>> {
    await this.recordUse();
    const checked = checkCrateSave(input);
    if (checked.error) return this.refuseCrateSave(checked.error);
    const { name, content, tags } = checked;

    const key = CRATE_PREFIX + name;
    const overwritten = (await this.ctx.storage.get(key)) !== undefined;
    // A name that is in the crate takes no new place. The limit on the listing stops it reading more than the
    // crate can hold, whatever else might have got into storage.
    if (!overwritten && (await this.ctx.storage.list({ prefix: CRATE_PREFIX, limit: CRATE_MAX_ENTRIES })).size >= CRATE_MAX_ENTRIES) {
      return this.refuseCrateSave('crate_full');
    }

    const entry: CrateEntry = { content, tags, savedAt: new Date().toISOString() };
    await this.ctx.storage.put(key, entry);
    // The name and the content are the user's, and stay out of the log.
    logEvent('crate_save', { sessionHash: this.storedSessionHash, overwritten });
    return { ok: true, value: { saved: name, overwritten } };
  }

  async crateGet(name: string): Promise<CrateEntry | null> {
    await this.recordUse();
    const known = crateName(name);
    if (known === undefined) return null;
    return (await this.ctx.storage.get<CrateEntry>(CRATE_PREFIX + known)) ?? null;
  }

  // Name, tags and time of each entry, the newest save first. The listing comes in the order of the keys and the sort
  // is stable, so saves of the same millisecond stay in the order of their names.
  async crateList(): Promise<CrateSummary[]> {
    await this.recordUse();
    const entries = await this.ctx.storage.list<CrateEntry>({ prefix: CRATE_PREFIX });
    return [...entries]
      .map(([key, { tags, savedAt }]) => ({ name: key.slice(CRATE_PREFIX.length), tags, savedAt }))
      .sort((a, b) => compareText(b.savedAt, a.savedAt));
  }

  // Whether there was an entry to delete.
  async crateDelete(name: string): Promise<boolean> {
    await this.recordUse();
    const known = crateName(name);
    if (known === undefined) return false;
    const deleted = await this.ctx.storage.delete(CRATE_PREFIX + known);
    if (deleted) logEvent('crate_delete', { sessionHash: this.storedSessionHash });
    return deleted;
  }

  // A call on the crate is activity, as a message from a socket is: lastActivity moves, the alarm follows, and the
  // session record is written (at most once a minute) because the alarm reads lastActivity from the record and counts a
  // session with none as idle. Without the write, a crate that was used yesterday on a session that never had a
  // message would be deleted by its first alarm. Reads count too: somebody who lists their crate is there.
  private async recordUse(): Promise<void> {
    await this.recordActivity();
    await this.persistActivity();
    await this.learnSessionHash();
  }

  // The hash the crate's log lines carry. A socket's connect is where this object learns it (see fetch), but the
  // generic MCP can use a session's crate before any player has opened the session. The object's own name is the
  // session id the Worker addresses it by, so the hash is made from that, and kept, as fetch keeps it. An object
  // that was not addressed by a name has none, and its lines go without a hash, as before.
  private async learnSessionHash(): Promise<void> {
    const name = this.ctx.id.name;
    if (this.storedSessionHash !== undefined || name === undefined) return;
    const created = await sessionHash(name, this.env.LOG_HASH_KEY);
    await this.ctx.storage.put('sessionHash', created);
    this.storedSessionHash = created;
  }

  private refuseCrateSave(error: CrateError): { ok: false; error: CrateError } {
    logEvent('crate_refused', { sessionHash: this.storedSessionHash, reason: error });
    return { ok: false, error };
  }

  // --- Expiry ---

  // The alarm that expires an idle session. A session with a socket open keeps everything for
  // another SESSION_TTL_MS: the tab is there, so somebody may be too. Any socket counts, and the
  // runtime finds the ones that hibernated while this object was gone. One with no socket is
  // deleted if it has had no message for SESSION_TTL_MS, and otherwise gets its alarm moved to the
  // day it will have.
  //
  // The decision is made from storage and not from the memory of this object. lastActivity is
  // written at most once a minute, which is nothing against 30 days, but an object that was just
  // woken by this alarm holds the time it started at, not the time of the session's last message.
  async alarm(): Promise<void> {
    const now = Date.now();
    this.alarmAt = null; // the alarm that fired is spent
    // Everything the decision needs is read first, and nothing is awaited between the decision and deleteAll().
    const stored = await this.ctx.storage.get<StoredSession>('session');

    if (this.hasOpenSocket()) {
      await this.armAlarm(now + SESSION_TTL_MS);
      return;
    }
    const lastActivityMs = lastActivityOf(stored, now);
    if (now - lastActivityMs < SESSION_TTL_MS) {
      await this.armAlarm(lastActivityMs + SESSION_TTL_MS);
      return;
    }

    const hash = this.storedSessionHash;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    this.forgetSession();
    logEvent('session_expired', { sessionHash: hash });
  }

  // A message from a socket is activity: lastActivity moves at once, and the alarm follows when it has to.
  // (The session record, which holds lastActivity for the alarm to read, is written at most once a minute: see
  // persistActivity.)
  private async recordActivity(): Promise<void> {
    this.lastActivity = new Date().toISOString();
    await this.scheduleExpiry();
  }

  // Writes the session record unless it was written within ACTIVITY_WRITE_INTERVAL_MS. It is also written whenever
  // something in it changes, so this is only for activity that changes nothing else. A session with no record has
  // persistedActivityAt 0, so the first activity writes one.
  private async persistActivity(): Promise<void> {
    if (Date.now() - this.persistedActivityAt >= ACTIVITY_WRITE_INTERVAL_MS) await this.persistState();
  }

  // Sets the alarm for SESSION_TTL_MS after `from` (by default lastActivity) if there is none, or if the alarm is more
  // than ALARM_SLACK_MS off that. lastActivity only moves forward, so the alarm falls behind it by the
  // time since it was set, and this moves it about once a day. Best effort: the next message tries
  // again, and a command is not worth failing for a missing alarm.
  private async scheduleExpiry(from: number = Date.parse(this.lastActivity)): Promise<void> {
    const due = from + SESSION_TTL_MS;
    if (!Number.isFinite(due)) return;
    if (this.alarmAt !== null && Math.abs(this.alarmAt - due) <= ALARM_SLACK_MS) return;
    try {
      await this.armAlarm(due);
    } catch (error) {
      logEvent('alarm_error', {
        sessionHash: this.storedSessionHash,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      });
    }
  }

  private async armAlarm(at: number): Promise<void> {
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }

  // Whether a socket of either role is open.
  private hasOpenSocket(): boolean {
    return this.ctx.getWebSockets().some((ws) => ws.readyState === WebSocket.OPEN);
  }

  // After deleteAll() this object is the one thing that still remembers the session, and it can stay
  // in memory after the alarm. The next visitor has to find a new session, and the first write after
  // it must not bring the old one back. These are the values of an object that was just made.
  private forgetSession(): void {
    this.currentPattern = '';
    this.isPlaying = false;
    this.rev = 0;
    this.createdAt = new Date().toISOString();
    this.lastActivity = this.createdAt;
    this.persistedActivityAt = 0;
    this.alarmAt = null;
    this.patternHistory = [''];
    this.historyIndex = 0;
    this.storedSessionHash = undefined;
    this.forgetPending();
  }

  // --- History ---

  private pushHistory(code: string): void {
    if (code === this.patternHistory[this.historyIndex]) return;
    this.patternHistory = this.patternHistory.slice(0, this.historyIndex + 1);
    this.patternHistory.push(code);
    if (this.patternHistory.length > MAX_HISTORY) {
      this.patternHistory.shift();
    }
    // Then the oldest entries go until the rest fits the budget. The newest stays.
    const sizes = this.patternHistory.map((entry) => 2 * entry.length);
    let total = sizes.reduce((sum, size) => sum + size, 0);
    let dropped = 0;
    while (total > MAX_HISTORY_BYTES && dropped < this.patternHistory.length - 1) total -= sizes[dropped++];
    if (dropped > 0) this.patternHistory = this.patternHistory.slice(dropped);
    this.historyIndex = this.patternHistory.length - 1;
  }

  // An undo or a redo moves the history, and the code it lands on has to be played, which only a browser can
  // confirm. So the evaluate the browsers are sent carries the command's request_id, and the browser's ack (or its
  // error) is what settles the command. That evaluate plays the code, so the session is playing and every browser
  // is told to play, as by an evaluate command. The controller that asked is told where the history went in an
  // undo_result, which is not an ack and settles nothing. With no browser to play the code the history stays where
  // it is, and the controllers hear no_browser as for any other command. Nothing to undo or redo is answered at
  // once, browser or not.
  private async moveHistory(ws: WebSocket, direction: 'undo' | 'redo', requestId: string | undefined): Promise<void> {
    const target = direction === 'undo' ? this.historyIndex - 1 : this.historyIndex + 1;
    if (target < 0 || target >= this.patternHistory.length) {
      this.ackTo('controller', requestId, direction === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo');
      return;
    }
    if (this.openSockets('browser').length === 0) {
      this.ackTo('controller', requestId, 'no_browser', { warning: NO_BROWSER_WARNING });
      return;
    }

    this.historyIndex = target;
    const code = this.patternHistory[target];
    this.showHistoryEntry(code);
    this.setPlayingByCommand(true); // the browsers play the code they are sent, as for an evaluate
    await this.persistState();
    const result: UndoResultMessage = { type: 'undo_result', request_id: requestId, payload: { code, historyIndex: target, direction } };
    this.replyTo(ws, result);
    this.forwardToBrowsers({ type: 'evaluate', request_id: requestId, payload: { code } }, requestId);
  }

  private resetState(): void {
    this.currentPattern = '';
    this.setPlayingByCommand(false);
    this.forgetPending();
    this.rev++;
    this.patternHistory = [''];
    this.historyIndex = 0;
  }

  // The code undo or redo moved to counts toward rev only if it differs from what the session holds.
  private showHistoryEntry(code: string): void {
    if (code !== this.currentPattern) this.rev++;
    this.currentPattern = code;
  }

  // Only the browser knows what the editor holds. After an append, a replace or an effect a controller knows
  // only the fragment it sent, and after an edit by hand it knows nothing. Taking the browser's text keeps
  // currentPattern and the undo history right. The session takes it from the answers it is waiting for (the ack of
  // an edit, the code_response to a get_code: see pendingEdits and pendingGets) and from a code_update, and not from
  // an answer that nobody asked for or that a newer command has passed. Like every other change of the pattern it
  // moves rev and is written out, so that after an eviction the session comes back with the pattern it last
  // reported, at the rev it reported it at. The same text from a second tab, or text the session already holds,
  // changes nothing. The caller has checked that the code is a string within the limit. Returns true when the
  // session changed, which is when it has to be written out.
  private adoptEditorCode(code: string): boolean {
    if (code === this.currentPattern) return false;
    this.currentPattern = code;
    this.pushHistory(code);
    this.rev++;
    return true;
  }

  // The ack of an edit holds the editor's text after it, and is taken for the session's code only if the session is
  // waiting for that edit (see pendingEdits). Whatever the ack holds, it answers the edit, so its request_id is spent
  // and a second ack for it, from another tab, is not taken.
  private adoptAckCode(ack: AckMessage): boolean {
    if (!EDIT_ACK_STATUSES.has(ack.status) || !this.takeAnswer(this.pendingEdits, ack.request_id)) return false;
    const code: unknown = ack.payload?.code; // off the wire, so check the type
    if (typeof code !== 'string' || byteLength(code) > MAX_CODE_BYTES) return false;
    return this.adoptEditorCode(code);
  }

  // The session now waits for the answer to this request. With no request_id an answer cannot be told from a stray one.
  private expectAnswer(pending: Set<string>, requestId: unknown): void {
    if (typeof requestId !== 'string' || requestId === '') return;
    pending.add(requestId);
    if (pending.size > MAX_PENDING_REQUESTS) {
      const oldest = pending.values().next().value as string;
      pending.delete(oldest);
    }
  }

  // Whether the session was waiting for the answer to this request. It no longer is.
  private takeAnswer(pending: Set<string>, requestId: unknown): boolean {
    return typeof requestId === 'string' && pending.delete(requestId);
  }

  // The code the session holds has been replaced, so the answers still on their way hold older text.
  private forgetPending(): void {
    this.pendingEdits.clear();
    this.pendingGets.clear();
  }

  // --- Playing ---
  //
  // The session is playing when any open browser's last report says it is. A browser's report is kept in its socket's
  // attachment, so that it outlives the object: its last status_report, a code_update of its own, or what the last
  // evaluate, undo, redo, stop or reset_session made it, because those commands went to every browser and each of
  // them plays or stops for them (an undo or a redo sends an evaluate). Without the commands, a report from before one
  // (an idle tab's, say) would count against it until the tab reported again. And if the last report of any tab were
  // the answer, a tab that opens later and is idle would stop the session while another still plays. When no open
  // browser has a report, the stored value stands, which is what the last command made it. A socket accepted before
  // attachments existed has nowhere to keep a report, so it has none.

  private rememberPlaying(ws: WebSocket, isPlaying: boolean): void {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment) ws.serializeAttachment({ ...attachment, isPlaying });
  }

  // A command that tells every browser to play or to stop. Returns true when the session's answer changed, which is when
  // it has to be written out.
  private setPlayingByCommand(isPlaying: boolean): boolean {
    for (const ws of this.openSockets('browser')) this.rememberPlaying(ws, isPlaying);
    const changed = this.isPlaying !== isPlaying;
    this.isPlaying = isPlaying;
    return changed;
  }

  // Works out the session's answer from the reports of the open browsers. Returns true when it changed, which is when it
  // has to be written out.
  private refreshPlaying(): boolean {
    let anyReport = false;
    let playing = false;
    for (const ws of this.openSockets('browser')) {
      const reported = (ws.deserializeAttachment() as Partial<SocketAttachment> | null)?.isPlaying;
      if (typeof reported !== 'boolean') continue;
      anyReport = true;
      if (reported) {
        playing = true;
        break;
      }
    }
    const next = anyReport ? playing : this.isPlaying;
    const changed = next !== this.isPlaying;
    this.isPlaying = next;
    return changed;
  }

  // --- Helpers ---

  private getSessionState(): SessionState {
    return {
      currentPattern: this.currentPattern,
      isPlaying: this.isPlaying,
      rev: this.rev,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      connectedClients: this.openSockets('browser').length,
      connectedControllers: this.openSockets('controller').length,
      historySize: this.patternHistory.length,
      historyIndex: this.historyIndex,
    };
  }

  // The role and session of a socket. Both come from its attachment, and from the
  // role tag and storage for a socket accepted before the attachment held them.
  private identify(ws: WebSocket): { role: ClientRole; sessionHash: string | undefined } {
    const attachment = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
    return {
      role: resolveRole(attachment, this.ctx.getTags(ws)),
      sessionHash: attachment?.sessionHash ?? this.storedSessionHash,
    };
  }

  // Sockets belong to the runtime, not to this object, so they are still found
  // after the object has been evicted and rebuilt.
  private openSockets(role: ClientRole): WebSocket[] {
    return this.ctx.getWebSockets(role).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private broadcastTo(role: ClientRole, message: object): number {
    const json = JSON.stringify(message);
    let count = 0;
    for (const ws of this.openSockets(role)) {
      try {
        ws.send(json);
        count++;
      } catch {
        // closed between the readyState check and the send
      }
    }
    return count;
  }

  // Sends a command on to every browser. With none connected, the controllers hear no_browser. Returns whether a
  // browser got it.
  private forwardToBrowsers(message: object, requestId: string | undefined): boolean {
    if (this.broadcastTo('browser', message) > 0) return true;
    this.ackTo('controller', requestId, 'no_browser', { warning: NO_BROWSER_WARNING });
    return false;
  }

  private ackTo(role: ClientRole, requestId: string | undefined, status: string, payload?: Record<string, unknown>): void {
    this.broadcastTo(role, ackMessage(requestId, status, payload));
  }

  // Answers the socket that sent a message, and no other.
  private replyTo(ws: WebSocket, message: object): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // closed since the message arrived
    }
  }
}
