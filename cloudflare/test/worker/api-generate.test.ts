import { exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

// /api/generate/*: what the client sends is the input to PatternGenerator and MusicTheory. Input they cannot use is
// the client's mistake, so it is a 400 with the reason, never a 500 (P2-R6b).

function post(path: string, body: object): Promise<Response> {
  return exports.default.fetch(`https://djopus.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function expectBadRequest(path: string, body: object, message: RegExp): Promise<void> {
  const label = `${path} ${JSON.stringify(body)}`;
  const res = await post(path, body);
  expect(res.status, label).toBe(400);
  expect(res.headers.get('Access-Control-Allow-Origin'), label).toBe('*'); // like every other API answer
  expect(((await res.json()) as { error: string }).error, label).toMatch(message);
}

it('answers a root, scale or progression style MusicTheory does not know with 400 and the reason', async () => {
  await expectBadRequest('/api/generate/scale', { root: 'H' }, /^Invalid root note: H\b/);
  await expectBadRequest('/api/generate/scale', { root: 'C', scale: 'bebop' }, /^Invalid scale: bebop\b/);
  await expectBadRequest('/api/generate/chords', { key: 'C', style: 'polka' }, /^Invalid progression style: polka\b/);
  await expectBadRequest('/api/generate/pattern', { style: 'techno', key: 'H' }, /^Invalid root note: H\b/);
});

it('does not take a name Object.prototype has for a scale or a progression style', async () => {
  await expectBadRequest('/api/generate/scale', { scale: 'constructor' }, /^Invalid scale: constructor\b/);
  await expectBadRequest('/api/generate/scale', { scale: '__proto__' }, /^Invalid scale: __proto__\b/);
  await expectBadRequest('/api/generate/chords', { style: 'toString' }, /^Invalid progression style: toString\b/);
});

it('answers a text field that is not a string with 400', async () => {
  await expectBadRequest('/api/generate/pattern', { style: 5 }, /^style must be a string$/);
  await expectBadRequest('/api/generate/pattern', { style: 'techno', key: ['C'] }, /^key must be a string$/);
  await expectBadRequest('/api/generate/drums', { style: { name: 'house' } }, /^style must be a string$/);
  await expectBadRequest('/api/generate/bassline', { key: 7 }, /^key must be a string$/);
  await expectBadRequest('/api/generate/scale', { root: 5 }, /^root must be a string$/);
  await expectBadRequest('/api/generate/chords', { key: true }, /^key must be a string$/);
});

it('still fills in its defaults for fields that are left out or empty', async () => {
  const scale = await post('/api/generate/scale', {});
  expect(scale.status).toBe(200);
  expect(await scale.json()).toEqual({ notes: ['C', 'D', 'D#', 'F', 'G', 'G#', 'A#'], root: 'C', scale: 'minor' });

  const chords = await post('/api/generate/chords', { key: '', style: null });
  expect(chords.status).toBe(200);
  expect(await chords.json()).toEqual({ progression: 'C G Am F', key: 'C', style: 'pop' });

  const pattern = await post('/api/generate/pattern', {});
  expect(pattern.status).toBe(200);
  expect(await pattern.json()).toMatchObject({ style: 'techno', bpm: 130, key: 'C', pattern: expect.stringMatching(/^\/\/ techno pattern in C at 130 BPM/) });
});
