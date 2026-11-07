// The style bible over HTTP (behavior per ADR-0004, ticket 06): /api/styles CRUD with real
// multipart uploads behind the studio error middleware, the picture rules (1..6, magic bytes,
// trash not delete), and `describe` driving the LOCAL vision model - think:false enforced, the
// Connections pick honored, and an uninstalled model answered with its reason, never a download.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerStyles } from '../server/styles.mjs';

const tmp = mkdtempSync(path.join(tmpdir(), 'af-styles-'));
const dataDir = path.join(tmp, 'data');
after(() => rmSync(tmp, { recursive: true, force: true }));

// minimal-valid pictures of three kinds + one liar with a PNG name
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 7), Buffer.from([0xff, 0xd9])]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(64)]);
const FAKE_PNG = Buffer.from('this is not a picture', 'utf8');

// fake Ollama: what is installed and what /api/chat answers are scripted per test
let ollama = { models: [], answer: null, lastBody: null };
const fetchFn = async (url, opts = {}) => {
  if (String(url).endsWith('/api/tags')) {
    if (!ollama.models) throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => ({ models: ollama.models.map((name) => ({ name, digest: 'sha256:' + name, size: 1e9, details: {} })) }) };
  }
  if (String(url).endsWith('/api/chat')) {
    ollama.lastBody = JSON.parse(opts.body);
    if (ollama.answer === null) return { ok: false, status: 500, text: async () => 'no such model' };
    return { ok: true, json: async () => ({ message: { content: ollama.answer } }) };
  }
  throw new Error('unexpected ' + url);
};

let config = { ollamaUrl: 'http://127.0.0.1:11434', reviewModel: '' };
let server, base;
before(async () => {
  const app = express();
  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  app.use(express.json());
  registerStyles(app, asyncRoute, { getLiveConfig: () => config, dataDir, fetchFn });
  app.use((err, _req, res, next) => { if (res.headersSent) return next(err); res.status(err.status || 400).json({ error: err.message || 'Application error' }); });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const call = async (method, url, body, raw) => {
  const res = await fetch(base + url, { method, body, ...(raw ? {} : { headers: { 'content-type': 'application/json' } }) });
  const v = res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, v };
};
const form = (files, fields = {}) => {
  const fd = new FormData();
  for (const [name, file] of Object.entries(fields)) fd.append(name, file);
  for (const [buf, filename] of files) fd.append('images', new Blob([buf]), filename);
  return fd;
};
async function createStyle(name, images = [[PNG, 'a.png'], [JPG, 'b.jpg']]) {
  const { status, v } = await call('POST', '/api/styles', form(images, { name }), true);
  assert.equal(status, 200, JSON.stringify(v));
  return v;
}

test('a style is pictures plus text: create, list, read back, serve the exact bytes', async () => {
  const rec = await createStyle('Painted dusk');
  assert.equal(rec.name, 'Painted dusk');
  assert.deepEqual([rec.description, rec.negative, rec.palette, rec.notes], ['', '', '', '']);
  assert.equal(rec.images.length, 2);
  assert.ok(rec.images.every((f) => /^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(f)), 'stored under generated names, not the user spelling');
  const listed = await call('GET', '/api/styles');
  assert.equal(listed.v.length, 1); assert.equal(listed.v[0].id, rec.id);
  const single = await call('GET', '/api/styles/' + rec.id);
  assert.deepEqual(single.v, rec);
  const bytes = await call('GET', `/api/styles/${rec.id}/images/${rec.images[0]}`, null, true);
  assert.equal(bytes.status, 200);
  assert.ok(Buffer.compare(Buffer.from(bytes.v), PNG) === 0, 'the file comes back untouched');
  // unknown id and smuggled names are dead ends
  assert.equal((await call('GET', '/api/styles/' + '0'.repeat(8) + '-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await call('GET', `/api/styles/${rec.id}/images/${encodeURIComponent('../../storage.mjs')}`)).status, 404);
});

test('create is picky: a name, real pictures only, one to six of them', async () => {
  assert.match((await call('POST', '/api/styles', form([], { name: 'air' }), true)).v.error, /at least one reference picture/);
  assert.match((await call('POST', '/api/styles', form([[PNG, 'ok.png'], [FAKE_PNG, 'liar.png']], { name: 'n' }), true)).v.error, /liar\.png/);
  assert.match((await call('POST', '/api/styles', form([[Buffer.alloc(20), 'x.gif']], { name: 'n' }), true)).v.error, /PNG, JPG or WEBP/);
  const seven = Array.from({ length: 7 }, (_, i) => [PNG, `p${i}.png`]);
  assert.ok((await call('POST', '/api/styles', form(seven), true)).status >= 400, 'seven pictures are refused, whatever layer notices first');
  assert.match((await call('POST', '/api/styles', form([[PNG, 'a.png']], { name: '' }), true)).v.error, /name/i);
});

test('text edits go through the strict schema; the pictures survive untouched', async () => {
  const rec = await createStyle('Turnaround set');
  const ok = await call('PUT', '/api/styles/' + rec.id, JSON.stringify({ description: 'soft gouache, warm rim light', palette: 'ochre and teal', lmstudioUrl: 1 }));
  assert.equal(ok.status, 400, 'PUT stays strict like /api/config');
  assert.match(ok.v.error, /lmstudioUrl/);
  const saved = await call('PUT', '/api/styles/' + rec.id, JSON.stringify({ description: 'soft gouache, warm rim light', palette: 'ochre and teal' }));
  assert.equal(saved.status, 200);
  assert.equal(saved.v.description, 'soft gouache, warm rim light');
  assert.deepEqual(saved.v.images, rec.images, 'a text edit cannot shuffle the pictures');
  assert.ok(saved.v.updatedAt >= saved.v.createdAt);
  assert.match((await call('PUT', '/api/styles/' + rec.id, JSON.stringify({ name: '   ' }))).v.error, /name/i);
});

test('pictures: add up to six, remove moves them to the trash, the last one stays', async () => {
  const rec = await createStyle('Six at most', [[WEBP, 'w.webp']]);
  const more = await call('POST', `/api/styles/${rec.id}/images`, form([[PNG, '1.png'], [PNG, '2.png']]), true);
  assert.equal(more.v.images.length, 3);
  assert.ok(existsSync(path.join(dataDir, 'styles', rec.id, more.v.images[2])));
  const over = await call('POST', `/api/styles/${rec.id}/images`, form(Array.from({ length: 4 }, (_, i) => [PNG, `x${i}.png`])), true);
  assert.match(over.v.error, /at most 6/);
  const gone = more.v.images[1];
  const dropped = await call('DELETE', `/api/styles/${rec.id}/images/${gone}`);
  assert.deepEqual(dropped.v.images, more.v.images.filter((f) => f !== gone));
  assert.ok(!existsSync(path.join(dataDir, 'styles', rec.id, gone)), 'the style folder no longer holds it');
  assert.ok(existsSync(path.join(dataDir, 'styles', 'trash', gone)), 'the trash does');
  const one = await call('POST', `/api/styles/${rec.id}/images`, form([[JPG, 'last.jpg']]), true);
  for (const f of one.v.images) await call('DELETE', `/api/styles/${rec.id}/images/${f}`);
  const lastStanding = await call('GET', '/api/styles/' + rec.id);
  assert.equal(lastStanding.v.images.length, 1, 'the last reference picture cannot be pruned away');
  assert.match((await call('DELETE', `/api/styles/${rec.id}/images/${lastStanding.v.images[0]}`)).v.error, /at least one/);
});

test('describe: the installed vision model, think:false, the pictures in hand', async () => {
  const rec = await createStyle('Look for the demo');
  ollama = { models: ['qwen3:8b', 'qwen3-vl:8b'], answer: 'Gouache concept art: painterly edges, warm dusk palette, soft rim light. Avoid: photorealism.', lastBody: null };
  const vram = process.env.ASTRA_VRAM_MIB; process.env.ASTRA_VRAM_MIB = '4096';
  try {
    const out = await call('POST', `/api/styles/${rec.id}/describe`);
    assert.equal(out.status, 200);
    assert.equal(out.v.model, 'qwen3-vl:8b', 'the text model is not asked to see - the pick lands on the vision one');
    assert.match(out.v.reason, /is not installed - taking qwen3-vl:8b/, 'and the reason says the tier wanted something else');
    assert.match(out.v.style.description, /Gouache concept art/);
    assert.ok(ollama.lastBody.think === false, 'thinking is forced off');
    assert.equal(ollama.lastBody.model, 'qwen3-vl:8b');
    assert.equal(ollama.lastBody.messages[0].images.length, 2, 'both references travel as base64');
    assert.match(ollama.lastBody.messages[0].content, /art-style sheet/);
    // the draft is on disk: a later read finds it, and the chosen model from Connections wins
    assert.match((await call('GET', '/api/styles/' + rec.id)).v.description, /Gouache/);
    config = { ...config, reviewModel: 'qwen3-vl:8b' };
    await call('POST', `/api/styles/${rec.id}/describe`);
    assert.equal(ollama.lastBody.model, 'qwen3-vl:8b');
  } finally {
    if (vram === undefined) delete process.env.ASTRA_VRAM_MIB; else process.env.ASTRA_VRAM_MIB = vram;
    config = { ...config, reviewModel: '' };
  }
});

test('describe without a vision model is a sentence, not a download and not a crash', async () => {
  const rec = await createStyle('Blind draft', [[PNG, 'a.png']]);
  ollama = { models: ['qwen3:8b'], answer: 'should not be asked' };
  const none = await call('POST', `/api/styles/${rec.id}/describe`);
  assert.equal(none.status, 503);
  assert.match(none.v.error, /No local vision model/);
  assert.match(none.v.error, /-Only vlm|installed/, 'the reason names the way out');
  ollama = { models: null };
  const offline = await call('POST', `/api/styles/${rec.id}/describe`);
  assert.equal(offline.status, 503, 'an Ollama that does not answer is the same honest absence');
  assert.equal((await call('GET', '/api/styles/' + rec.id)).v.description, '', 'nothing was written to the style on the way out');
  ollama = { models: ['qwen3-vl:8b'], answer: '   ' };
  assert.match((await call('POST', `/api/styles/${rec.id}/describe`)).v.error, /empty text/);
});

test('deleting a style moves the whole folder - style.json and pictures - to the trash', async () => {
  const rec = await createStyle('Retired look');
  const before = (await call('GET', '/api/styles')).v.length;
  const del = await call('DELETE', '/api/styles/' + rec.id);
  assert.equal(del.v.trashed, rec.id);
  assert.equal((await call('GET', '/api/styles')).v.length, before - 1, 'one line off the list, no other style touched');
  assert.ok(existsSync(path.join(dataDir, 'styles', 'trash', rec.id, 'style.json')));
  assert.ok(readdirSync(path.join(dataDir, 'styles', 'trash', rec.id)).length >= 3, 'record + both pictures moved together');
  assert.match((await call('GET', '/api/styles/' + rec.id)).v.error, /No such style/);
});
