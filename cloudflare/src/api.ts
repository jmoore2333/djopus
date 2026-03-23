import type { Env } from './env';
import { PatternGenerator } from './services/PatternGenerator';
import { PatternValidator } from './services/PatternValidator';
import { MusicTheory } from './services/MusicTheory';

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

export async function handleApiRoutes(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }));
  }

  const path = url.pathname;
  const method = request.method;

  if (path === '/api/health') {
    return cors(Response.json({ ok: true, app: env.APP_NAME, timestamp: new Date().toISOString() }));
  }

  if (path === '/api/patterns' && method === 'GET') {
    return cors(await listPatterns(env, url));
  }
  if (path === '/api/patterns' && method === 'POST') {
    return cors(await savePattern(request, env));
  }
  if (path.startsWith('/api/patterns/') && method === 'GET') {
    const name = decodeURIComponent(path.slice('/api/patterns/'.length));
    return cors(await loadPattern(env, name));
  }
  if (path.startsWith('/api/patterns/') && method === 'DELETE') {
    const name = decodeURIComponent(path.slice('/api/patterns/'.length));
    return cors(await deletePattern(env, name));
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

async function listPatterns(env: Env, url: URL): Promise<Response> {
  const tag = url.searchParams.get('tag');
  let query = 'SELECT id, name, tags, created_at, updated_at FROM patterns ORDER BY updated_at DESC';
  const params: string[] = [];

  if (tag) {
    query = "SELECT id, name, tags, created_at, updated_at FROM patterns WHERE tags LIKE ? ORDER BY updated_at DESC";
    params.push(`%"${tag}"%`);
  }

  const result = await env.DB.prepare(query).bind(...params).all();
  const patterns = result.results.map((row: Record<string, unknown>) => ({
    ...row,
    tags: JSON.parse(row.tags as string || '[]'),
  }));

  return Response.json({ patterns });
}

async function savePattern(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { name?: string; content?: string; tags?: string[]; session_id?: string };
  if (!body.name || !body.content) {
    return Response.json({ error: 'name and content are required' }, { status: 400 });
  }

  const tags = JSON.stringify(body.tags || []);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO patterns (name, content, tags, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET content = ?, tags = ?, updated_at = ?`
  ).bind(body.name, body.content, tags, body.session_id || null, now, now, body.content, tags, now).run();

  return Response.json({ saved: body.name, timestamp: now });
}

async function loadPattern(env: Env, name: string): Promise<Response> {
  const result = await env.DB.prepare(
    'SELECT * FROM patterns WHERE name = ?'
  ).bind(name).first();

  if (!result) {
    return Response.json({ error: `Pattern "${name}" not found` }, { status: 404 });
  }

  return Response.json({
    ...result,
    tags: JSON.parse(result.tags as string || '[]'),
  });
}

async function deletePattern(env: Env, name: string): Promise<Response> {
  const result = await env.DB.prepare(
    'DELETE FROM patterns WHERE name = ?'
  ).bind(name).run();

  if (result.meta.changes === 0) {
    return Response.json({ error: `Pattern "${name}" not found` }, { status: 404 });
  }

  return Response.json({ deleted: name });
}

async function generatePattern(request: Request): Promise<Response> {
  const body = await request.json() as { style?: string; bpm?: number; key?: string };
  const style = body.style || 'techno';
  const bpm = body.bpm || 130;
  const key = body.key || 'C';

  const pattern = generator.generateCompletePattern(style, key, bpm);
  return Response.json({ pattern, style, bpm, key });
}

async function generateDrums(request: Request): Promise<Response> {
  const body = await request.json() as { style?: string; complexity?: number };
  const style = body.style || 'techno';
  const complexity = body.complexity ?? 0.7;

  const pattern = generator.generateDrumPattern(style, complexity);
  return Response.json({ pattern, style, complexity });
}

async function generateBassline(request: Request): Promise<Response> {
  const body = await request.json() as { key?: string; style?: string };
  const key = body.key || 'C';
  const style = body.style || 'techno';

  const pattern = generator.generateBassline(key, style);
  return Response.json({ pattern, key, style });
}

async function generateScale(request: Request): Promise<Response> {
  const body = await request.json() as { root?: string; scale?: string };
  const root = body.root || 'C';
  const scale = body.scale || 'minor';

  const notes = theory.generateScale(root, scale as any);
  return Response.json({ notes, root, scale });
}

async function generateChords(request: Request): Promise<Response> {
  const body = await request.json() as { key?: string; style?: string };
  const key = body.key || 'C';
  const style = body.style || 'pop';

  const progression = theory.generateChordProgression(key, style as any);
  return Response.json({ progression, key, style });
}

async function validatePattern(request: Request): Promise<Response> {
  const body = await request.json() as { pattern?: string };
  if (!body.pattern) {
    return Response.json({ error: 'pattern is required' }, { status: 400 });
  }

  const result = validator.validate(body.pattern);
  return Response.json(result);
}
