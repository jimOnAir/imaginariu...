// Ticket 57 (0.7.4 fold wave): a Pixal3D job names what it lacks BEFORE any wait for a concept -
// the engine install state and the concept-prep python, both in the existing honest sentences
// (pixal3dInstallState's text and the venv-health text of ticket 25). Cancelled-vs-failed is
// covered in forge-ui-core.test.mjs (batchCounts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pixal3dPreflight } from '../server/jobs.mjs';
import { PIXAL3D_REQUIREMENTS } from '../server/pixal3d.mjs';

const tmp = mkdtempSync(path.join(tmpdir(), 'af-p3preflight-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const touch = (p) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, ''); };
const fullEngine = (dir) => { for (const [rel] of PIXAL3D_REQUIREMENTS) touch(path.join(dir, ...rel.split('/'))); };
const comfyWith = (dir, python) => { mkdirSync(path.join(dir, '.venv', 'bin'), { recursive: true }); if (python) touch(path.join(dir, '.venv', 'bin', 'python')); };

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('pixal3dPreflight: no engine folder - the job is refused with the install reason, not a wait', async () => {
  const comfy = path.join(tmp, 'comfy-ok'); comfyWith(comfy, true);
  await withEnv({ ASTRA_PIXAL3D_DIR: path.join(tmp, 'nowhere'), ASTRA_COMFY_DIR: comfy }, async () => {
    await assert.rejects(pixal3dPreflight(), /Pixal3D is not installed: folder not found/);
  });
});

test('pixal3dPreflight: engine installed, concept-prep python missing - refused up front with the ticket-25 fix command', async () => {
  const p3 = path.join(tmp, 'p3'); fullEngine(p3);
  const comfy = path.join(tmp, 'comfy-dead'); comfyWith(comfy, false);   // the venv folder exists, its python does not
  await withEnv({ ASTRA_PIXAL3D_DIR: p3, ASTRA_COMFY_DIR: comfy }, async () => {
    await assert.rejects(pixal3dPreflight(),
      /Background removal needs the studio's Python at .* and it does not start.*install\.sh -Yes -Only comfydeps/s,
      'the dead venv answers as the fixing sentence, not an errno and not after a concept wait');
  });
});

test('pixal3dPreflight: both present - the preflight passes', async () => {
  const p3 = path.join(tmp, 'p3-ok'); fullEngine(p3);
  const comfy = path.join(tmp, 'comfy-live'); comfyWith(comfy, true);
  await withEnv({ ASTRA_PIXAL3D_DIR: p3, ASTRA_COMFY_DIR: comfy }, async () => {
    const { cfg, state } = await pixal3dPreflight();
    assert.equal(cfg.dir, p3);
    assert.equal(state.installed, true);
  });
});

test('runPixal3d puts the capability row before the SDXL concept wait (fast-fail ordering)', () => {
  const src = readFileSync(new URL('../server/jobs.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function runPixal3d'));
  const pre = fn.indexOf('pixal3dPreflight()'), concept = fn.indexOf('conceptFromPrompt');
  assert.ok(pre >= 0 && concept >= 0 && pre < concept,
    'the up-front check must run before any concept generation inside runPixal3d');
});
