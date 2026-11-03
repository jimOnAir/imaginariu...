// AstraForge MCP server tests: a fake studio on node:http + a real MCP client over stdio.
// Run: cd ai/mcp && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

// ------------------------------------------------------------------ fake studio

const seen = [];            // every request: {method, url, headers, body}
let fake, fakeUrl, jobPolls = 0;

const JOBS = [
  { id: UUID, status: 'completed', progress: 100, message: 'Готово', engine: 'pixal3d', quality: 'standard', seed: 42, prompt: 'гоблин', asset: { id: UUID2, url: '/api/assets/' + UUID2 }, createdAt: '2026-10-20T10:00:00Z' },
  { id: '33333333-3333-4333-8333-333333333333', status: 'failed', error: 'нет видеопамяти', createdAt: '2026-10-21T10:00:00Z' },
];
const STEPS = [{ step: 'render_sprites', title: 'Спрайты', kinds: ['humanoid'], gpu: true, timeoutSec: 3600, params: { profile: { type: 'enum' }, fps: { type: 'int' } } }, { step: 'cleanup', title: 'Ремонт', kinds: [], gpu: 'conditional', timeoutSec: 600, params: {} }];
const send = (res, status, body, headers = {}) => {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isJson ? 'application/json' : 'application/octet-stream', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
};

before(async () => {
  fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw.toString('utf8') });
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    // the same guards as the real studio
    if (req.method !== 'GET' && p.startsWith('/api') && req.headers['x-astra-client'] !== 'studio') return send(res, 403, { error: 'Запрос должен быть отправлен из студии.' });
    if (req.headers.origin) return send(res, 403, { error: 'Недопустимый источник запроса' });
    if (p === '/api/health') return send(res, 200, { app: 'AstraForge', version: '0.3.0' });
    if (p === '/api/status') return send(res, 200, { pixal3d: { installed: true, running: false, missing: [] }, ollama: { online: true, models: ['qwen3-vl'] }, comfy: { online: false, ready: false }, gpu: { name: 'RTX 4070', vram_total: 12e9 } });
    if (p === '/api/forge/status') return send(res, 200, { blender: { ok: true, version: '5.0.1' }, godot: { ok: true, version: '4.5.1' }, library: { clips: 3 }, queue: { running: 0, queued: 0 } });
    if (p === '/api/jobs' && req.method === 'GET') return send(res, 200, JOBS);
    if (p === '/api/jobs' && req.method === 'POST') {
      const body = JSON.parse(raw.toString());
      if (!body.imageId && !body.prompt) return send(res, 400, { error: 'Загрузите концепт или напишите описание.' });
      return send(res, 202, { id: UUID, status: 'queued', progress: 0, ...body });
    }
    if (p === `/api/jobs/${UUID}/cancel`) return send(res, 200, { ok: true });
    if (p === '/api/assets' && req.method === 'POST') return send(res, 200, { id: UUID2, extension: '.png', name: 'x.png', url: '/api/assets/' + UUID2 });
    if (p === `/api/assets/${UUID2}`) return send(res, 200, Buffer.from('PNGDATA'), { 'content-type': 'image/png', 'content-length': '7' });
    if (p.startsWith('/api/assets/')) return send(res, 404, { error: 'Файл не найден.' });
    if (p === `/api/exports/${UUID2}`) return send(res, 200, Buffer.from('ZIPDATA'), { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="pack.zip"' });
    if (p === '/api/forge/steps') return send(res, 200, STEPS);
    if (p === '/api/forge/presets') return send(res, 200, [{ id: 'humanoid_basic', kind: 'humanoid', title: 'Гуманоид', steps: [{ step: 'cleanup', params: {} }, { step: 'rig', params: { a: 1 } }] }]);
    if (p === '/api/forge/assets' && req.method === 'GET') return send(res, 200, [{ id: 'a1', name: 'Лучник', kind: 'humanoid', updated: '2026-10-20', lastStatus: 'completed' }, { id: 'a2', name: 'Дракон', kind: 'creature', updated: '2026-10-21', lastStatus: 'failed' }]);
    if (p === '/api/forge/assets' && req.method === 'POST') return send(res, 201, { id: 'a3', name: 'Новый', kind: 'humanoid', source: { type: 'upload' } });
    if (p === '/api/forge/assets/a3/run') return send(res, 202, { jobId: 'fj1', version: 'v001', warnings: [] });
    if (p === '/api/forge/jobs/fj1') {
      jobPolls++;
      return send(res, 200, { id: 'fj1', assetId: 'a3', version: 'v001', status: jobPolls >= 2 ? 'completed' : 'running', steps: [{ index: 1, step: 'cleanup', status: 'completed', result: { outputs: { glb: 'C:/x.glb' } } }] });
    }
    if (p === '/api/views' && req.method === 'POST') return send(res, 201, { id: UUID, frontAssetId: JSON.parse(raw.toString()).imageId, slots: {} });
    if (p === `/api/views/${UUID}/generate`) return send(res, 202, { id: UUID, task: { status: 'running', provider: JSON.parse(raw.toString()).provider } });
    if (p === `/api/views/${UUID}`) return send(res, 200, { id: UUID, canBuild: true, task: { status: 'completed' } });
    if (p === '/api/forge/assets/a3/export') return send(res, 202, { jobId: 'fj2', version: 'v002' });
    if (p === '/api/forge/jobs/fj2') return send(res, 200, { id: 'fj2', status: 'completed', steps: [] });
    if (p === '/api/forge/assets/a3') return send(res, 200, { id: 'a3', name: 'Новый', kind: 'humanoid', versions: [{ version: 'v002', status: 'completed', steps: ['godot_package'] }], exports: [{ profile: 'godot', version: 'v002', jobId: 'fj2', path: 'C:/lib/pack_godot.zip', url: '/api/forge/assets/a3/files/v002/x/pack_godot.zip', bytes: 7 }] });
    if (p === '/api/forge/assets/a3/files/v002/x/pack_godot.zip') return send(res, 200, Buffer.from('ZIPDATA'), { 'content-type': 'application/zip' });
    if (p === '/api/forge/clips' && req.method === 'GET') return send(res, 200, { clips: [{ id: 'idle_01', category: 'idle', frames: 30, name: 'Idle' }, { id: 'run_01', category: 'locomotion', frames: 20, name: 'Run' }] });
    if (p === '/api/forge/clips' && req.method === 'POST') return send(res, 202, { jobId: 'fj1', files: ['walk.fbx'], rejected: [] });
    if (p === '/api/forge/batch' && req.method === 'POST') return send(res, 202, { batchId: 'b1', items: [{ assetId: 'a3', jobId: 'fj1' }] });
    if (p === '/api/forge/batch/b1') return send(res, 200, { id: 'b1', status: 'completed', counts: { total: 1, completed: 1 }, items: [{ name: 'Новый', assetId: 'a3', status: 'completed' }] });
    if (p === '/api/vfx-tools') return send(res, 200, { root: 'C:/AstraForge/tools/vfx', rootExists: true, tools: [{ id: 'material-maker', name: 'Material Maker', kind: 'desktop', license: 'MIT', ru: 'Нодовый генератор' }, { id: 'tiny-noise', name: 'Tiny', kind: 'web-local' }] });
    if (p === '/api/vfx-tools/textures') return send(res, 200, [{ name: 'a.png', size: 10, mtime: '2026-10-20', url: '/api/vfx-tools/textures/a.png' }]);
    if (p === '/api/projects') return send(res, 200, [{ id: UUID, name: 'Риг для Godot', updatedAt: '2026-10-09', thumbnail: 'data:image/jpeg;base64,AAAA' }]);
    if (p === `/api/projects/${UUID}`) return send(res, 200, { id: UUID, name: 'Риг', scene: { object: { type: 'Group', name: 'AstraForge', children: [{ type: 'SkinnedMesh', name: 'Тело' }, { type: 'Bone', name: 'hips', children: [{ type: 'Bone', name: 'spine' }] }, { type: 'PointLight', name: 'L' }] }, geometries: [{}], materials: [{}, {}], textures: [] }, editor: { duration: 5, preset: 'walk', tracks: [1, 2], savedClips: [{ name: 'Idle' }] } });
    return send(res, 404, { error: 'Нет такого маршрута.' });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
});
after(() => new Promise((r) => fake.close(r)));

// ------------------------------------------------------------------ MCP client

async function connect(env = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, ASTRA_URL: fakeUrl, ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}
const text = (r) => r.content.map((c) => c.text).join('');
const json = (r) => JSON.parse(text(r));
async function withClient(fn, env) {
  const c = await connect(env);
  try { return await fn(c); } finally { await c.close(); }
}

test('tool and resource listing', () => withClient(async (c) => {
  const { tools } = await c.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['studio_status', 'studio_start', 'studio_open', 'asset_upload', 'asset_info', 'asset_download', 'generate_3d', 'jobs_list', 'job_get', 'job_cancel',
    'views_create', 'views_generate', 'views_get', 'views_cancel', 'forge_steps', 'forge_presets', 'forge_assets', 'forge_asset_show', 'forge_create', 'forge_run', 'forge_job',
    'forge_export', 'forge_batch', 'clips_list', 'clips_import', 'sprites_render', 'sculpt', 'sculpt_transfer', 'fx_presets', 'fx_texture_generate', 'projects_list', 'project_get', 'vfx_tools', 'vfx_textures', 'vfx_tool_launch']) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
  assert.ok(tools.every((t) => /^[a-z0-9_]+$/.test(t.name) && t.description.length > 20), 'snake_case names, filled descriptions');
  assert.ok(!names.includes('project_save'));
  const { resources } = await c.listResources();
  assert.deepEqual(resources.map((r) => r.uri).sort(), ['astraforge://skill', 'astraforge://status']);
}));

test('studio_status: health, engines, Blender; the x-astra-client header; no Origin', () => withClient(async (c) => {
  seen.length = 0;
  const r = json(await c.callTool({ name: 'studio_status', arguments: {} }));
  assert.equal(r.app, 'AstraForge');
  assert.equal(r.pixal3d.installed, true);
  assert.equal(r.gpu.name, 'RTX 4070');
  assert.equal(r.forge.blender.version, '5.0.1');
  assert.ok(seen.length >= 3);
  for (const s of seen) { assert.equal(s.headers['x-astra-client'], 'studio'); assert.equal(s.headers.origin, undefined); }
}));

test('studio_open and studio_start (already running)', () => withClient(async (c) => {
  const open = json(await c.callTool({ name: 'studio_open', arguments: {} }));
  assert.equal(open.url, fakeUrl); assert.equal(open.running, true);
  const start = json(await c.callTool({ name: 'studio_start', arguments: {} }));
  assert.equal(start.alreadyRunning, true); assert.equal(start.started, false);
}));

test('generate_3d, jobs_list, job_get, job_cancel', () => withClient(async (c) => {
  seen.length = 0;
  const g = json(await c.callTool({ name: 'generate_3d', arguments: { prompt: 'гоблин', engine: 'pixal3d', seed: 7 } }));
  assert.equal(g.status, 'queued');
  const posted = JSON.parse(seen.find((s) => s.method === 'POST' && s.url === '/api/jobs').body);
  assert.equal(posted.engine, 'pixal3d'); assert.equal(posted.seed, 7); assert.equal(posted.prompt, 'гоблин');
  const none = await c.callTool({ name: 'generate_3d', arguments: {} });
  assert.equal(none.isError, true); assert.match(text(none), /imageId|prompt/);
  const list = json(await c.callTool({ name: 'jobs_list', arguments: { limit: 1 } }));
  assert.equal(list.total, 2); assert.equal(list.items.length, 1); assert.equal(list.items[0].status, 'failed'); // newest on top
  const done = json(await c.callTool({ name: 'jobs_list', arguments: { status: 'completed' } }));
  assert.equal(done.total, 1);
  const job = json(await c.callTool({ name: 'job_get', arguments: { id: UUID, wait: true, timeoutSec: 5 } }));
  assert.equal(job.status, 'completed'); assert.equal(job.asset.id, UUID2);
  const missing = await c.callTool({ name: 'job_get', arguments: { id: '44444444-4444-4444-8444-444444444444' } });
  assert.equal(missing.isError, true); assert.match(text(missing), /не найдено/);
  assert.equal(json(await c.callTool({ name: 'job_cancel', arguments: { id: UUID } })).ok, true);
}));

test('asset_upload (multipart), asset_info, asset_download', () => withClient(async (c) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'afmcp-'));
  try {
    const png = path.join(dir, 'concept.png');
    await fs.writeFile(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]));
    seen.length = 0;
    const up = json(await c.callTool({ name: 'asset_upload', arguments: { path: png } }));
    assert.equal(up.id, UUID2);
    const req = seen.find((s) => s.method === 'POST' && s.url === '/api/assets');
    assert.match(req.headers['content-type'], /^multipart\/form-data/);
    assert.match(req.body, /name="file"; filename="concept\.png"/);
    const bad = await c.callTool({ name: 'asset_upload', arguments: { path: path.join(dir, 'x.txt') } });
    assert.equal(bad.isError, true);
    await fs.writeFile(path.join(dir, 'x.txt'), 'hi');
    const badExt = await c.callTool({ name: 'asset_upload', arguments: { path: path.join(dir, 'x.txt') } });
    assert.match(text(badExt), /не поддерживается/);
    const info = json(await c.callTool({ name: 'asset_info', arguments: { id: UUID2 } }));
    assert.equal(info.kind, 'asset'); assert.equal(info.contentType, 'image/png'); assert.equal(info.bytes, 7);
    // auto: the asset is gone -> the export
    const exp = json(await c.callTool({ name: 'asset_info', arguments: { id: UUID2, kind: 'export' } }));
    assert.equal(exp.fileName, 'pack.zip');
    const out = path.join(dir, 'out');
    const dl = json(await c.callTool({ name: 'asset_download', arguments: { id: UUID2, dir: out } }));
    assert.equal(path.basename(dl.path), UUID2 + '.png');
    assert.equal(await fs.readFile(dl.path, 'utf8'), 'PNGDATA');
    const dl2 = json(await c.callTool({ name: 'asset_download', arguments: { id: UUID2, kind: 'export', dir: out } }));
    assert.equal(path.basename(dl2.path), 'pack.zip');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}));

test('the forge: steps, presets, assets, create + run, job wait', () => withClient(async (c) => {
  const steps = json(await c.callTool({ name: 'forge_steps', arguments: {} }));
  assert.equal(steps.total, 2); assert.deepEqual(steps.items[0].params, ['profile', 'fps']);
  const one = json(await c.callTool({ name: 'forge_steps', arguments: { step: 'render_sprites' } }));
  assert.equal(one.params.fps.type, 'int');
  assert.match(text(await c.callTool({ name: 'forge_steps', arguments: { step: 'nope' } })), /Нет шага/);
  const presets = json(await c.callTool({ name: 'forge_presets', arguments: {} }));
  assert.deepEqual(presets.items[0].steps, ['cleanup', 'rig']);
  const assets = json(await c.callTool({ name: 'forge_assets', arguments: { kind: 'creature' } }));
  assert.equal(assets.total, 1); assert.equal(assets.items[0].name, 'Дракон');
  seen.length = 0;
  const created = json(await c.callTool({ name: 'forge_create', arguments: { kind: 'humanoid', name: 'Новый', fromJob: UUID, preset: 'humanoid_basic' } }));
  assert.equal(created.asset.id, 'a3'); assert.equal(created.run.jobId, 'fj1');
  const body = JSON.parse(seen.find((s) => s.url === '/api/forge/assets' && s.method === 'POST').body);
  assert.deepEqual(body.source, { type: 'job', jobId: UUID });
  const runBody = JSON.parse(seen.find((s) => s.url === '/api/forge/assets/a3/run').body);
  assert.equal(runBody.preset, 'humanoid_basic'); assert.equal(runBody.from, 'source');
  const conflict = await c.callTool({ name: 'forge_create', arguments: { kind: 'item', fromJob: UUID, fromAsset: 'zz' } });
  assert.equal(conflict.isError, true);
  jobPolls = 0;
  const job = json(await c.callTool({ name: 'forge_job', arguments: { id: 'fj1', wait: true, timeoutSec: 20 } }));
  assert.equal(job.status, 'completed'); assert.equal(job.steps[0].outputs.glb, 'C:/x.glb');
}));

test('sprites_render assembles the render_sprites step and passes params through (incl. profile pixel)', () => withClient(async (c) => {
  seen.length = 0;
  const r = json(await c.callTool({ name: 'sprites_render', arguments: { assetId: 'a3', profile: 'pixel', directions: ['S', 'E'], clips: ['idle'], fps: 8, pixels_per_meter: 64, params: { palette: 'gb4', cell: [64, 64] } } }));
  assert.equal(r.jobId, 'fj1');
  const body = JSON.parse(seen.find((s) => s.url === '/api/forge/assets/a3/run').body);
  assert.deepEqual(body.steps, [{ step: 'render_sprites', params: { profile: 'pixel', directions: ['S', 'E'], clips: ['idle'], fps: 8, pixels_per_meter: 64, palette: 'gb4', cell: [64, 64] } }]);
  assert.equal(body.from, 'latest');
}));

test('sculpt: the sculpt step with ops, symmetry, keep_uv; waits for the result and summarizes checks; an unknown operation errors in Russian', () => withClient(async (c) => {
  seen.length = 0; jobPolls = 0;
  const ops = [{ op: 'inflate', amount: 0.01, region: { type: 'sphere', center: [0, -0.1, 1.6], radius: 0.15 } }, { op: 'relax', iterations: 3 }];
  const r = json(await c.callTool({ name: 'sculpt', arguments: { assetId: 'a3', ops, symmetry: 'x', keep_uv: false, timeoutSec: 20, params: { preview: false } } }));
  const body = JSON.parse(seen.find((q) => q.url === '/api/forge/assets/a3/run').body);
  assert.deepEqual(body.steps, [{ step: 'sculpt', params: { ops, symmetry: 'x', keep_uv: false, preview: false } }]);
  assert.equal(body.from, 'latest');
  assert.equal(r.status, 'completed'); assert.equal(r.jobId, 'fj1'); assert.equal(r.version, 'v001');
  assert.ok(Array.isArray(r.checks));
  jobPolls = 0;
  const quick = json(await c.callTool({ name: 'sculpt', arguments: { assetId: 'a3', ops: [{ op: 'smooth' }], wait: false, from: 'v002' } }));
  assert.equal(quick.jobId, 'fj1'); assert.equal(quick.status, undefined); assert.match(quick.note, /forge_job/);
  assert.equal(JSON.parse(seen.filter((q) => q.url === '/api/forge/assets/a3/run').at(-1).body).from, 'v002');
  const bad = await c.callTool({ name: 'sculpt', arguments: { assetId: 'a3', ops: [{ op: 'smooth' }, { op: 'melt' }] } });
  assert.equal(bad.isError, true); assert.match(text(bad), /Неизвестные операции №2: «melt»/);
  assert.equal((await c.callTool({ name: 'sculpt', arguments: { assetId: 'a3', ops: [] } })).isError, true);
}));

test('sculpt_transfer uploads an OBJ source (multipart) and runs transfer with source_asset; exactly one source is required', () => withClient(async (c) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'afmcp-sculpt-'));
  try {
    const obj = path.join(dir, 'head.obj');
    await fs.writeFile(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    seen.length = 0; jobPolls = 0;
    const region = { type: 'sphere', center: [0, 0, 1.6], radius: 0.2 };
    const r = json(await c.callTool({ name: 'sculpt_transfer', arguments: { assetId: 'a3', source: obj, region, method: 'nearest', align: 'bbox', timeoutSec: 20 } }));
    const up = seen.find((q) => q.url === '/api/forge/assets' && q.method === 'POST');
    assert.match(up.headers['content-type'], /multipart\/form-data/);
    assert.match(up.body, /name="kind"\r\n\r\nprop/); assert.match(up.body, /filename="head.obj"/);
    const run = JSON.parse(seen.find((q) => q.url === '/api/forge/assets/a3/run').body);
    assert.deepEqual(run.steps, [{ step: 'sculpt', params: { ops: [{ op: 'transfer', source_asset: 'a3', region, method: 'nearest', align: 'bbox' }] } }]);
    assert.equal(r.sourceAsset, 'a3'); assert.equal(r.status, 'completed');
    // a ready asset instead of a file: nothing is uploaded
    seen.length = 0; jobPolls = 0;
    json(await c.callTool({ name: 'sculpt_transfer', arguments: { assetId: 'a3', sourceAsset: UUID2, strength: 0.5, wait: false } }));
    assert.equal(seen.some((q) => q.url === '/api/forge/assets' && q.method === 'POST'), false);
    assert.deepEqual(JSON.parse(seen.find((q) => q.url === '/api/forge/assets/a3/run').body).steps[0].params.ops, [{ op: 'transfer', source_asset: UUID2, strength: 0.5 }]);
    for (const args of [{ assetId: 'a3' }, { assetId: 'a3', source: obj, sourceAsset: UUID2 }, { assetId: 'a3', source: path.join(dir, 'nope.obj') }, { assetId: 'a3', source: path.join(dir, 'x.png') }]) {
      assert.equal((await c.callTool({ name: 'sculpt_transfer', arguments: args })).isError, true);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}));

test('views, export with downloading, clips, batch', () => withClient(async (c) => {
  const v = json(await c.callTool({ name: 'views_create', arguments: { imageId: UUID2 } }));
  assert.equal(v.frontAssetId, UUID2);
  const g = json(await c.callTool({ name: 'views_generate', arguments: { id: UUID, provider: 'codex', slots: ['left', 'back'] } }));
  assert.equal(g.task.provider, 'codex');
  assert.equal(json(await c.callTool({ name: 'views_get', arguments: { id: UUID, wait: true, timeoutSec: 5 } })).canBuild, true);
  const bad = await c.callTool({ name: 'views_generate', arguments: { id: UUID, provider: 'dalle' } });
  assert.equal(bad.isError, true);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'afmcp-exp-'));
  try {
    const ex = json(await c.callTool({ name: 'forge_export', arguments: { assetId: 'a3', profile: 'godot', out: dir, unzip: false } }));
    assert.equal(ex.jobId, 'fj2'); assert.equal(ex.exported.length, 1);
    assert.equal(await fs.readFile(ex.exported[0].zip, 'utf8'), 'ZIPDATA');
    const noOut = json(await c.callTool({ name: 'forge_export', arguments: { assetId: 'a3', profile: 'iso8' } }));
    assert.equal(noOut.jobId, 'fj2'); assert.match(noOut.note, /forge_export_fetch/);
    const show = json(await c.callTool({ name: 'forge_asset_show', arguments: { assetId: 'a3' } }));
    assert.equal(show.exports[0].url, '/api/forge/assets/a3/files/v002/x/pack_godot.zip');
    const clips = json(await c.callTool({ name: 'clips_list', arguments: { category: 'idle' } }));
    assert.equal(clips.total, 1);
    const fbx = path.join(dir, 'fbx'); await fs.mkdir(fbx);
    await fs.writeFile(path.join(fbx, 'walk.fbx'), 'Kaydara FBX Binary  ' + String.fromCharCode(0));
    seen.length = 0;
    const imp = json(await c.callTool({ name: 'clips_import', arguments: { folder: fbx } }));
    assert.equal(imp.jobId, 'fj1');
    assert.match(seen.find((s) => s.url === '/api/forge/clips' && s.method === 'POST').body, /name="files\[\]"; filename="walk\.fbx"/);
    assert.equal((await c.callTool({ name: 'clips_import', arguments: { folder: dir + '-none' } })).isError, true);
    await fs.writeFile(path.join(dir, 'items.json'), JSON.stringify({ items: [{ name: 'Новый', kind: 'humanoid', source: { type: 'upload', path: 'fbx/walk.fbx' }, preset: 'humanoid_basic' }] }));
    seen.length = 0;
    const b = json(await c.callTool({ name: 'forge_batch', arguments: { file: path.join(dir, 'items.json'), wait: true, timeoutSec: 10 } }));
    assert.equal(b.status, 'completed');
    const sent = seen.find((s) => s.url === '/api/forge/batch' && s.method === 'POST');
    assert.match(sent.headers['content-type'], /multipart/); assert.match(sent.body, /"fileIndex":0/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}));

test('projects and VFX', () => withClient(async (c) => {
  const pl = json(await c.callTool({ name: 'projects_list', arguments: {} }));
  assert.equal(pl.items[0].thumbnail, undefined); assert.equal(pl.items[0].name, 'Риг для Godot');
  const p = json(await c.callTool({ name: 'project_get', arguments: { id: UUID } }));
  assert.equal(p.counts.skinnedMeshes, 1); assert.equal(p.counts.bones, 2); assert.equal(p.counts.lights, 1);
  assert.equal(p.materials, 2); assert.deepEqual(p.editor.savedClips, ['Idle']); assert.equal(p.editor.tracks, 2);
  const v = json(await c.callTool({ name: 'vfx_tools', arguments: { kind: 'desktop' } }));
  assert.equal(v.total, 1); assert.equal(v.items[0].id, 'material-maker'); assert.equal(v.rootExists, true);
  const t = json(await c.callTool({ name: 'vfx_textures', arguments: {} }));
  assert.equal(t.items[0].name, 'a.png');
}));

test('effects: fx_presets and fx_texture_generate write a real PNG', () => withClient(async (c) => {
  const list = json(await c.callTool({ name: 'fx_presets', arguments: {} }));
  assert.ok(list.presets.some((p) => p.id === 'fire'));
  const fire = json(await c.callTool({ name: 'fx_presets', arguments: { name: 'fire' } }));
  assert.ok(fire.description);
  assert.match(text(await c.callTool({ name: 'fx_presets', arguments: { name: 'nope' } })), /Нет пресета/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'afmcp-fx-'));
  try {
    const r = json(await c.callTool({ name: 'fx_texture_generate', arguments: { preset: 'spark', params: { size: 64 }, out: dir } }));
    assert.equal(r.width, 64);
    const png = await fs.readFile(r.path);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 64);                // the width in IHDR
    const again = json(await c.callTool({ name: 'fx_texture_generate', arguments: { preset: 'spark', params: { size: 64 }, out: dir } }));
    assert.deepEqual(await fs.readFile(again.path), png);  // determinism
    assert.equal((await c.callTool({ name: 'fx_texture_generate', arguments: { type: 'nope' } })).isError, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}));

test('resources: astraforge://skill and astraforge://status', () => withClient(async (c) => {
  const skill = await c.readResource({ uri: 'astraforge://skill' });
  assert.match(skill.contents[0].text, /AstraForge/);
  const st = JSON.parse((await c.readResource({ uri: 'astraforge://status' })).contents[0].text);
  assert.equal(st.running, true); assert.equal(st.health.app, 'AstraForge');
}));

test('a studio error (HTTP 4xx) arrives as Russian text with the code', () => withClient(async (c) => {
  const r = await c.callTool({ name: 'forge_asset_show', arguments: { assetId: 'missing' } });
  assert.equal(r.isError, true);
  assert.match(text(r), /Нет такого маршрута/);
}));

// ------------------------------------------------------------------ studio down

async function closedPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

test('without the studio: a clear Russian error with the Start.cmd / studio_start hint', async () => {
  const url = `http://127.0.0.1:${await closedPort()}`;
  await withClient(async (c) => {
    for (const [name, args] of [['studio_status', {}], ['jobs_list', {}], ['forge_steps', {}], ['vfx_tools', {}]]) {
      const r = await c.callTool({ name, arguments: args });
      assert.equal(r.isError, true, name);
      assert.match(text(r), /Студия AstraForge не отвечает/, name);
      assert.match(text(r), /Start\.cmd/, name);
      assert.match(text(r), /studio_start/, name);
    }
    // studio_open does not fail, it reports the studio as off
    const open = json(await c.callTool({ name: 'studio_open', arguments: {} }));
    assert.equal(open.running, false);
    // the status resource does not fail either
    const st = JSON.parse((await c.readResource({ uri: 'astraforge://status' })).contents[0].text);
    assert.equal(st.running, false);
  }, { ASTRA_URL: url });
});

test('studio_start: when the studio does not come up - a timeout error (a fake Start script)', { skip: process.platform !== 'win32' }, async () => {
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'afmcp-app-'));
  try {
    await fs.mkdir(path.join(app, 'scripts'));
    await fs.writeFile(path.join(app, 'scripts', 'Start.ps1'), 'param([switch]$NoBrowser)\nWrite-Host "fake start"\nexit 0\n');
    const url = `http://127.0.0.1:${await closedPort()}`;
    await withClient(async (c) => {
      const r = await c.callTool({ name: 'studio_start', arguments: { timeoutSec: 5 } });
      assert.equal(r.isError, true);
      assert.match(text(r), /не ответила на \/api\/health за 5 с/);
    }, { ASTRA_URL: url, ASTRA_APP: app });
  } finally { await fs.rm(app, { recursive: true, force: true }); }
});

test('studio_start refuses to start a non-local studio', async () => {
  await withClient(async (c) => {
    const r = await c.callTool({ name: 'studio_start', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(text(r), /не отвечает|только локальную/);
  }, { ASTRA_URL: 'http://192.0.2.1:3210' });
});
