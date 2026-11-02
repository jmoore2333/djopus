import { HttpError, jsonError, readJsonBody } from '../http';
import { checkCode, checkName, checkSessionId, checkTags } from '../limits';
import { PatternGenerator } from '../services/PatternGenerator';
import { PatternValidator } from '../services/PatternValidator';
import { MusicInputError, MusicTheory } from '../services/MusicTheory';

const generator = new PatternGenerator();
const validator = new PatternValidator();
const theory = new MusicTheory();

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The env of the API: the Worker's own, which both entries pass, plus the two bindings that only the ChatGPT Worker has
 * (wrangler.chatgpt.toml). The app has neither: its entry passes `patterns: 'none'`, so nothing there reads them.
 */
export type ApiEnv = Cloudflare.Env & { DB?: D1Database; PUBLIC_PATTERN_WRITES?: string };

/** The D1 database of the pattern routes. Only a Worker that passes `patterns: 'd1'` has one. */
function patternDb(env: ApiEnv): D1Database {
  if (!env.DB) throw new Error('This Worker has no D1 database for patterns: its entry has to pass patterns: none');
  return env.DB;
}

/**
 * Options of handleApiRoutes. A request from the network is never trusted: the entries (src/index.ts and
 * src/chatgpt/index.ts) pass no `trusted`, only `patterns`.
 */
export interface ApiOptions {
  /**
   * A tool of the Worker (the ChatGPT executor) is calling. It saves and deletes even
   * when PUBLIC_PATTERN_WRITES is not 'on', but only patterns that belong to `sessionId`.
   */
  trusted?: boolean;
  /** The session a trusted caller acts for. A trusted call without one is a bug in the caller, and throws. */
  sessionId?: string;
  /**
   * Where the pattern routes (/api/patterns and /api/patterns/<name>) keep their patterns. 'd1' (the default)
   * is the D1 table. 'none' is a host with no pattern store: those routes answer 404 like any other path
   * this API does not have, and nothing reads env.DB.
   */
  patterns?: 'd1' | 'none';
}

export async function handleApiRoutes(request: Request, env: ApiEnv, url: URL, opts?: ApiOptions): Promise<Response> {
  try {
    return await route(request, env, url, opts);
  } catch (error) {
    // A request the API turns away (bad JSON, too large, a bad field) is answered
    // here, so that the error carries the CORS headers like every other API answer.
    if (error instanceof HttpError) return cors(jsonError(error.status, error.message));
    throw error;
  }
}

// Decides whose patterns this write may touch, as the session_id they carry. A trusted
// caller writes for its own session, whatever the host's flag says. A public client writes
// for nobody (null) when this host has public writes on, so it reaches only the patterns
// no session owns. Otherwise it is refused with a 403, which goes out through
// handleApiRoutes, so with the CORS headers. Routes call this before they read the body or
// decode the name, so a host with writes off spends no work on a refused write.
function patternOwner(env: ApiEnv, opts?: ApiOptions): string | null {
  if (opts?.trusted === true) {
    if (!opts.sessionId) throw new Error('A trusted pattern write has to name the sessionId it acts for');
    return opts.sessionId;
  }
  if (env.PUBLIC_PATTERN_WRITES === 'on') return null;
  throw new HttpError(403, 'Pattern writes are disabled on this host');
}

async function route(request: Request, env: ApiEnv, url: URL, opts?: ApiOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }));
  }

  const path = url.pathname;
  const method = request.method;

  if (path === '/api/health') {
    return cors(Response.json({ ok: true, app: env.APP_NAME, timestamp: new Date().toISOString() }));
  }

  if ((opts?.patterns ?? 'd1') === 'd1') {
    if (path === '/api/patterns' && method === 'GET') {
      return cors(await listPatterns(env, url));
    }
    if (path === '/api/patterns' && method === 'POST') {
      const owner = patternOwner(env, opts);
      return cors(await savePattern(request, env, owner));
    }
    if (path.startsWith('/api/patterns/') && method === 'GET') {
      const name = decodeURIComponent(path.slice('/api/patterns/'.length));
      return cors(await loadPattern(env, name));
    }
    if (path.startsWith('/api/patterns/') && method === 'DELETE') {
      const owner = patternOwner(env, opts);
      const name = decodeURIComponent(path.slice('/api/patterns/'.length));
      return cors(await deletePattern(env, name, owner));
    }
  }

  if (path === '/api/generate/pattern' && method === 'POST') {
    return cors(await generatePattern(request));
  }
  if (path === '/api/generate/drums' && method === 'POST') {
    return cors(await generateDrums(request));
  }
  if (path === '/api/generate/bassline' && method === 'POST') {
    return cors(await generateBassline(request));
  }
  if (path === '/api/generate/scale' && method === 'POST') {
    return cors(await generateScale(request));
  }
  if (path === '/api/generate/chords' && method === 'POST') {
    return cors(await generateChords(request));
  }
  if (path === '/api/validate' && method === 'POST') {
    return cors(await validatePattern(request));
  }

  return cors(Response.json({ error: 'Not found' }, { status: 404 }));
}

// --- the pattern table ---
//
// The SQL of the pattern routes, exported for the D1 PatternStore of the tools (src/core/d1-store.ts), so that a
// tool and a REST call save, read and delete by the same statements. `owner` is the session_id a write acts for:
// a session, or null for the patterns no session owns.

/** A stored pattern as it may be handed out: every column but session_id. */
export interface PatternRow {
  id: number;
  name: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

/** The fields of a pattern to save, checked against the limits as POST /api/patterns checks them. */
export function checkPatternInput(input: { name?: unknown; content?: unknown; tags?: unknown }): {
  name: string;
  content: string;
  tags: string[];
} {
  if (!input.name || !input.content) throw new HttpError(400, 'name and content are required');
  return { name: checkName(input.name), content: checkCode(input.content, 'content'), tags: checkTags(input.tags) };
}

/** Every pattern, newest first, or those tagged `tag`. Without content. */
export async function listPatternRows(db: D1Database, tag?: string | null): Promise<Array<Omit<PatternRow, 'content'>>> {
  let query = 'SELECT id, name, tags, created_at, updated_at FROM patterns ORDER BY updated_at DESC';
  const params: string[] = [];

  if (tag) {
    query = "SELECT id, name, tags, created_at, updated_at FROM patterns WHERE tags LIKE ? ORDER BY updated_at DESC";
    params.push(`%"${tag}"%`);
  }

  const result = await db.prepare(query).bind(...params).all();
  return result.results.map((row: Record<string, unknown>) => ({
    ...row,
    tags: JSON.parse(row.tags as string || '[]'),
  })) as Array<Omit<PatternRow, 'content'>>;
}

/**
 * Saves a checked pattern (checkPatternInput) for `owner`: a new name is created, a taken one is updated only when
 * `owner` owns it. Anything else is a 409.
 */
export async function savePatternRow(
  db: D1Database,
  pattern: { name: string; content: string; tags: string[] },
  owner: string | null,
): Promise<{ saved: string; timestamp: string }> {
  const now = new Date().toISOString();

  // The owner check and the write are one statement, so no other write can come between
  // them. A new name is inserted with this owner. A taken name is updated only when its
  // session_id IS the owner: unlike =, IS also matches NULL to NULL, which is how a public
  // client reaches the patterns no session owns, and why a session cannot. Any other row
  // is left as it is and nothing changes.
  const result = await db.prepare(
    `INSERT INTO patterns (name, content, tags, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET content = excluded.content, tags = excluded.tags, updated_at = excluded.updated_at
     WHERE patterns.session_id IS excluded.session_id`
  ).bind(pattern.name, pattern.content, JSON.stringify(pattern.tags), owner, now, now).run();
  if (result.meta.changes === 0) throw new HttpError(409, `Pattern "${pattern.name}" belongs to another session`);

  return { saved: pattern.name, timestamp: now };
}

/** The pattern called `name`, or null when there is none. */
export async function loadPatternRow(db: D1Database, name: string): Promise<PatternRow | null> {
  // The columns are named, and session_id is not one of them: it is what a trusted write is
  // checked against and the key to /ws?session=, so reading a pattern must not hand it out.
  const result = await db.prepare(
    'SELECT id, name, content, tags, created_at, updated_at FROM patterns WHERE name = ?'
  ).bind(name).first();
  if (!result) return null;

  return {
    ...result,
    tags: JSON.parse(result.tags as string || '[]'),
  } as PatternRow;
}

/** Deletes the pattern called `name` if `owner` owns it: 403 when another owner does, 404 when there is none. */
export async function deletePatternRow(db: D1Database, name: string, owner: string | null): Promise<{ deleted: string }> {
  // Only a pattern of the owner is deleted: the statement that deletes also checks the owner
  // (IS, as in savePatternRow, so that no owner means the patterns no session owns).
  const result = await db.prepare(
    'DELETE FROM patterns WHERE name = ? AND session_id IS ?'
  ).bind(name, owner).run();

  if (result.meta.changes === 0) {
    // Either there is no such pattern (404) or it has another owner and is still there (403).
    // This look at the table only picks the answer: nothing was deleted.
    const taken = await db.prepare('SELECT 1 FROM patterns WHERE name = ?').bind(name).first();
    if (taken) throw new HttpError(403, `Pattern "${name}" belongs to another session`);
    throw new HttpError(404, `Pattern "${name}" not found`);
  }

  return { deleted: name };
}

// --- the pattern routes ---

async function listPatterns(env: ApiEnv, url: URL): Promise<Response> {
  return Response.json({ patterns: await listPatternRows(patternDb(env), url.searchParams.get('tag')) });
}

async function savePattern(request: Request, env: ApiEnv, owner: string | null): Promise<Response> {
  const body = await readJsonBody<{ name?: unknown; content?: unknown; tags?: unknown; session_id?: unknown }>(request);
  const pattern = checkPatternInput(body);
  // Checked as before, so a bad value is still a 400, but never stored: the owner of a
  // pattern is the session of the trusted caller that saved it, and no client can name one.
  checkSessionId(body.session_id);
  return Response.json(await savePatternRow(patternDb(env), pattern, owner));
}

async function loadPattern(env: ApiEnv, name: string): Promise<Response> {
  const pattern = await loadPatternRow(patternDb(env), name);
  if (!pattern) {
    return Response.json({ error: `Pattern "${name}" not found` }, { status: 404 });
  }
  return Response.json(pattern);
}

async function deletePattern(env: ApiEnv, name: string, owner: string | null): Promise<Response> {
  return Response.json(await deletePatternRow(patternDb(env), name, owner));
}

// --- generation ---
//
// What a client sends is the input of the generators, so input they cannot use is a 400 with the reason: a text
// field that is not a string, or a root, scale or progression style MusicTheory does not know (MusicInputError).

/** A text field of a generate request: its default when it is left out or empty, as before. */
function textField(value: unknown, field: string, fallback: string): string {
  if (!value) return fallback;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  return value;
}

function generated<T>(generate: () => T): T {
  try {
    return generate();
  } catch (error) {
    if (error instanceof MusicInputError) throw new HttpError(400, error.message);
    throw error;
  }
}

async function generatePattern(request: Request): Promise<Response> {
  const body = await readJsonBody<{ style?: unknown; bpm?: number; key?: unknown }>(request);
  const style = textField(body.style, 'style', 'techno');
  const bpm = body.bpm || 130;
  const key = textField(body.key, 'key', 'C');

  const pattern = generated(() => generator.generateCompletePattern(style, key, bpm));
  return Response.json({ pattern, style, bpm, key });
}

async function generateDrums(request: Request): Promise<Response> {
  const body = await readJsonBody<{ style?: unknown; complexity?: number }>(request);
  const style = textField(body.style, 'style', 'techno');
  const complexity = body.complexity ?? 0.7;

  const pattern = generated(() => generator.generateDrumPattern(style, complexity));
  return Response.json({ pattern, style, complexity });
}

async function generateBassline(request: Request): Promise<Response> {
  const body = await readJsonBody<{ key?: unknown; style?: unknown }>(request);
  const key = textField(body.key, 'key', 'C');
  const style = textField(body.style, 'style', 'techno');

  const pattern = generated(() => generator.generateBassline(key, style));
  return Response.json({ pattern, key, style });
}

async function generateScale(request: Request): Promise<Response> {
  const body = await readJsonBody<{ root?: unknown; scale?: unknown }>(request);
  const root = textField(body.root, 'root', 'C');
  const scale = textField(body.scale, 'scale', 'minor');

  const notes = generated(() => theory.generateScale(root, scale as any));
  return Response.json({ notes, root, scale });
}

async function generateChords(request: Request): Promise<Response> {
  const body = await readJsonBody<{ key?: unknown; style?: unknown }>(request);
  const key = textField(body.key, 'key', 'C');
  const style = textField(body.style, 'style', 'pop');

  const progression = generated(() => theory.generateChordProgression(key, style as any));
  return Response.json({ progression, key, style });
}

async function validatePattern(request: Request): Promise<Response> {
  const body = await readJsonBody<{ pattern?: unknown }>(request);
  if (!body.pattern) {
    return Response.json({ error: 'pattern is required' }, { status: 400 });
  }

  const result = validator.validate(checkCode(body.pattern, 'pattern'));
  return Response.json(result);
}
