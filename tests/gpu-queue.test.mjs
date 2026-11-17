// The 0.7.11 GPU queue rules (server/jobs.mjs decideDispatch): two generations at a time, only
// on different cards, with the pool's facts injected - no pump, no engines, no GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDispatch, MAX_GPU_JOBS } from '../server/jobs.mjs';

const A = { index: 0, uuid: 'GPU-A', name: 'RTX 5070', memoryTotalMiB: 12227, freeMiB: 9000 };
const B = { index: 1, uuid: 'GPU-B', name: 'RTX 5060 Ti', memoryTotalMiB: 16311, freeMiB: 15000 };
const cards = [A, B];
const claims = (m) => (e) => m[e] || null;

test('an empty queue dispatches anything, pool or no pool (the pre-pool behaviour)', () => {
  assert.deepEqual(decideDispatch('hunyuan', { running: [], cardFor: () => null }), { ok: true, card: null });
  assert.equal(decideDispatch('pixal3d', { running: [], cardFor: () => B }).card, B);
});

test('one card busy, the other free: the second generation on the free card runs beside it', () => {
  const r = decideDispatch('pixal3d', { running: [{ engine: 'hunyuan', card: A }], cardFor: claims({ hunyuan: A, pixal3d: B }), cards, freeRamMiB: 20000, ramNeedMib: 4096 });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.card, B);
});

test('both engines would land on ONE card: the second job waits', () => {
  const r = decideDispatch('pixal3d', { running: [{ engine: 'hunyuan', card: A }], cardFor: claims({ hunyuan: A, pixal3d: A }), cards, freeRamMiB: 20000, ramNeedMib: 4096 });
  assert.equal(r.ok, false);
  assert.match(r.why, /already generating/);
});

test('no pool (no nvidia-smi) or an engine on an unknown card: strictly one generation, as before', () => {
  const r1 = decideDispatch('pixal3d', { running: [{ engine: 'hunyuan', card: null }], cardFor: () => null, cards: null });
  assert.equal(r1.ok, false);
  assert.match(r1.why, /no GPU card pool/);
  const r2 = decideDispatch('pixal3d', { running: [{ engine: 'hunyuan', card: null }], cardFor: () => null, cards });
  assert.equal(r2.ok, false);
  assert.match(r2.why, /unknown card/);
});

test('never two jobs on one engine - the engine itself is the unit, whatever card it sits on', () => {
  const r = decideDispatch('hunyuan', { running: [{ engine: 'hunyuan', card: A }], cardFor: claims({ hunyuan: A }), cards });
  assert.equal(r.ok, false);
  assert.match(r.why, /studio 3D engine is busy/);
});

test('the cap is MAX_GPU_JOBS', () => {
  assert.equal(MAX_GPU_JOBS, 2);
  const r = decideDispatch('triposg', { running: [{ engine: 'hunyuan', card: A }, { engine: 'pixal3d', card: B }], cardFor: claims({}), cards });
  assert.equal(r.ok, false);
  assert.match(r.why, /2 generations already run/);
});

test('the RAM gate before a second concurrent engine (the machine died once on two engines)', () => {
  const ok = decideDispatch('pixal3d', { running: [{ engine: 'hunyuan', card: A }], cardFor: claims({ hunyuan: A, pixal3d: B }), cards, freeRamMiB: 20000, ramNeedMib: 4096 });
  assert.equal(ok.ok, true);
  const r = decideDispatch('pixal3d', { running: [{ engine: 'hunyuan', card: A }], cardFor: claims({ hunyuan: A, pixal3d: B }), cards, freeRamMiB: 1500, ramNeedMib: 4096 });
  assert.equal(r.ok, false);
  assert.match(r.why, /1500 MiB of free memory/);
});

test('TripoSG dispatches onto a card nobody holds and pins exactly it', () => {
  const picks = [];
  const triposgPick = (claimed) => { picks.push(claimed.map((c) => c.uuid)); return B; };
  const r = decideDispatch('triposg', { running: [{ engine: 'hunyuan', card: A }], cardFor: claims({ hunyuan: A }), cards, triposgPick });
  assert.equal(r.ok, true);
  assert.equal(r.card, B);
  assert.deepEqual(picks, [['GPU-A']], 'the card of the running generation is never offered');
  const r2 = decideDispatch('triposg', { running: [{ engine: 'hunyuan', card: A }], cardFor: claims({ hunyuan: A }), cards, triposgPick: () => null });
  assert.equal(r2.ok, false, 'no card the worker could take -> it waits, visibly');
});
