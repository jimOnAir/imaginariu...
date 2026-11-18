// The generator routes behind the MCP family (behavior per ADR-0004, ticket 06):
// GET /api/runtime/graphs is the studio's own graphs derived from the builders (the catalog
// cannot drift), GET /api/runtime/nodes reports the connected ComfyUI's node classes without
// ever raising, and POST /api/runtime/restart either restarts the owned service or answers with
// an actionable statement - never a crash, never a detached ComfyUI. The launched server gets an
// IMAGINARIUM_COMFY_DIR that cannot exist: even a wrong expectation cannot boot a real GPU engine here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 39876;
const base = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: new URL('../', import.meta.url).pathname, stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), IMAGINARIUM_ENGINE_AUTOSTART: '0', IMAGINARIUM_COMFY_DIR: '/nonexistent-imaginarium-comfy-dir' },
});
after(() => child.kill());
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await delay(250); }

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, json: await r.json().catch(() => null) }; };
const post = async (p) => { const r = await fetch(base + p, { method: 'POST', headers: { 'x-imaginarium-client': 'studio' } }); return { status: r.status, json: await r.json().catch(() => null) }; };

test('GET /api/runtime/graphs: every studio graph with its node classes, derived from the builders', async () => {
  const { status, json } = await get('/api/runtime/graphs');
  assert.equal(status, 200);
  assert.deepEqual(json.graphs.map((g) => g.id),
    ['sdxl-concept', 'hunyuan-single-view', 'hunyuan-2.1', 'hunyuan-2mini', 'hunyuan-multiview', 'pixal3d-single-view', 'pixal3d-multiview']);
  for (const g of json.graphs) {
    assert.ok(g.title && g.usedWhen && g.checkpointSetting, `${g.id}: catalog rows explain themselves`);
    assert.ok(Array.isArray(g.classTypes) && g.classTypes.length > 0, `${g.id}: class types`);
    assert.deepEqual(g.classTypes, [...g.classTypes].sort(), `${g.id}: classes sorted for stable digests`);
  }
  const byId = Object.fromEntries(json.graphs.map((g) => [g.id, g.classTypes]));
  assert.ok(byId['sdxl-concept'].includes('KSampler') && byId['sdxl-concept'].includes('SaveImage'));
  assert.ok(byId['hunyuan-single-view'].includes('ImageOnlyCheckpointLoader') && byId['hunyuan-single-view'].includes('ImagiMarchingCubes') && byId['hunyuan-single-view'].includes('SaveGLB'));
  assert.ok(byId['hunyuan-multiview'].includes('Hunyuan3Dv2ConditioningMultiView'));
  assert.ok(byId['pixal3d-single-view'].includes('Trellis2ExportMesh'));
  // the Pixal3D shape-only rule (tests/pixal3d.test.mjs) holds in the catalog too: no texturing nodes
  assert.doesNotMatch(JSON.stringify(json).toLowerCase(), /nvdiffrast|trellis2.*texture/, 'shape-only graphs stay shape-only');
});

test('GET /api/runtime/nodes: answers with the ComfyUI reality, never raises', async () => {
  const { status, json } = await get('/api/runtime/nodes');
  assert.equal(status, 200);
  assert.equal(typeof json.online, 'boolean');
  assert.ok(Array.isArray(json.classes));
  assert.equal(json.count, json.classes.length);
  assert.deepEqual(json.classes, [...json.classes].sort());
  const filtered = await get('/api/runtime/nodes?contains=hunyuan');
  assert.equal(filtered.status, 200);
  assert.ok(filtered.json.classes.every((c) => c.toLowerCase().includes('hunyuan')));
  assert.ok(filtered.json.classes.length <= json.classes.length);
});

test('POST /api/runtime/restart: owned child restarts, anything else answers actionably - no crash, no stray engine', async () => {
  const comfyUp = await fetch('http://127.0.0.1:8190/system_stats', { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
  const { status, json } = await post('/api/runtime/restart');
  if (comfyUp) {
    // an instance answers on 8190: either declared external (untouched) or refused with guidance
    assert.ok(status === 200 || status === 400, `status ${status}`);
    if (status === 200) assert.equal(json.external, true);
    else assert.match(json.error, /another ComfyUI|ComfyUI not found/);
  } else {
    // nothing on the port and the configured ComfyUI folder cannot exist: a plain, useful error
    assert.equal(status, 400);
    assert.match(json.error, /ComfyUI not found/);
    assert.match(json.error, /IMAGINARIUM_COMFY_DIR/);
  }
  // and the studio itself is still alive after the restart attempt
  assert.ok((await fetch(`${base}/api/health`)).ok);
});
