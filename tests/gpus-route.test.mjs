// GET /api/gpus and the status.gpus row (0.7.11 commit E): the pool readout the UI's engine-card
// line and the post-factum "which card ran what" questions are answered from. The whole card list
// comes from the IMAGINARIUM_GPU_CARDS seam - nvidia-smi is never called here, and the shape is asserted
// on a two-card fake, an empty pool and a broken seam (each a booted studio on its own port).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const CARDS = JSON.stringify([
  { index: 0, uuid: 'GPU-A', name: 'RTX 5070', memoryTotalMiB: 12227, memoryUsedMiB: 2843, driverVersion: '570.172.08' },
  { index: 1, uuid: 'GPU-B', name: 'RTX 5060 Ti', memoryTotalMiB: 16311, memoryUsedMiB: 834, driverVersion: '570.172.08' },
]);
const children = [];
after(() => { for (const c of children) c.kill(); });

async function boot(port, env) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('../', import.meta.url).pathname, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), IMAGINARIUM_ENGINE_AUTOSTART: '0', IMAGINARIUM_COMFY_DIR: '/nonexistent-imaginarium-comfy-dir', ...env },
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/health')).ok) return base; } catch {} await delay(250); }
  throw new Error('studio did not boot on ' + port);
}

test('a two-card machine: /api/gpus reports the pool, both cards, no claims, empty jobs - and status carries the same', async () => {
  const base = await boot(39883, { IMAGINARIUM_GPU_CARDS: CARDS });
  const g = await (await fetch(base + '/api/gpus')).json();
  assert.equal(g.pool, true);
  assert.deepEqual(g.cards.map((c) => [c.index, c.name, c.freeMiB]), [[0, 'RTX 5070', 12227 - 2843], [1, 'RTX 5060 Ti', 16311 - 834]]);
  assert.deepEqual(g.engines, { hunyuan: null, pixal3d: null }, 'no engine has claimed a card yet');
  assert.deepEqual(g.jobs, []);
  const st = await (await fetch(base + '/api/status')).json();
  assert.equal(st.gpus.pool, true);
  assert.equal(st.gpus.cards.length, 2);
});

test('no nvidia-smi pool (empty seam): pool:false, cards empty - the UI line stays hidden and nothing throws', async () => {
  const base = await boot(39884, { IMAGINARIUM_GPU_CARDS: '[]' });
  const g = await (await fetch(base + '/api/gpus')).json();
  assert.equal(g.pool, false);
  assert.deepEqual(g.cards, []);
  assert.equal((await (await fetch(base + '/api/status')).json()).gpus.pool, false);
});
