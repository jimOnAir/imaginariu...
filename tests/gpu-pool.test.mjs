// The GPU card pool (0.7.11): enumeration parsing, fit-first choice, per-card lock naming and
// the card->CUDA_VISIBLE_DEVICES mapping. No nvidia-smi is ever run here: the probe comes through
// spawnFn, the whole card list through the IMAGINARIUM_GPU_CARDS seam.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateGpus, pickCard, vramNeedMiB, cardLockName, cardEnv, sharesCard, claimEngineCard, engineCardFor, resetGpuPool, ENGINE_VRAM_NEED_MIB, noCardText } from '../server/gpu-pool.mjs';

const CSV = [
  '0, GPU-d7cc0128-7dbd-c868-180e-4f88b1ae663a, NVIDIA GeForce RTX 5070, 12227, 2843, 570.172.08',
  '1, GPU-99dc7203-c09c-a3bb-7237-9d6f49bfac33, NVIDIA GeForce RTX 5060 Ti, 16311, 834, 570.172.08',
].join('\n');
const fakeSpawn = (out) => () => ({ stdout: out });

afterEach(() => resetGpuPool());

test('enumerateGpus parses one nvidia-smi line per card, free = total - used', () => {
  const cards = enumerateGpus({ env: {}, spawnFn: fakeSpawn(CSV) });
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => c.index), [0, 1]);
  assert.equal(cards[0].name, 'NVIDIA GeForce RTX 5070');
  assert.equal(cards[0].uuid, 'GPU-d7cc0128-7dbd-c868-180e-4f88b1ae663a');
  assert.equal(cards[0].freeMiB, 12227 - 2843);
  assert.equal(cards[1].memoryTotalMiB, 16311);
  assert.equal(cards[1].driverVersion, '570.172.08');
});

test('enumerateGpus: no nvidia-smi answer means NO pool (null), never a guessed card', () => {
  assert.equal(enumerateGpus({ env: {}, spawnFn: () => { throw new Error('nvidia-smi: command not found'); } }), null);
  assert.equal(enumerateGpus({ env: {}, spawnFn: () => ({ stdout: '' }) }), null);
  // a card name with a comma still parses: the anchors are first-two/last-three fields
  const one = enumerateGpus({ env: {}, spawnFn: fakeSpawn('0, GPU-x, Some Card, Series X, 8000, 100, 570.1') });
  assert.equal(one[0].name, 'Some Card, Series X');
  assert.equal(one[0].freeMiB, 7900);
});

test('IMAGINARIUM_GPU_CARDS fakes the whole pool (deterministic tests, rescue lever on odd machines)', () => {
  const cards = enumerateGpus({ env: { IMAGINARIUM_GPU_CARDS: JSON.stringify([{ index: 1, uuid: 'U1', name: 'Big', memoryTotalMiB: 16311, memoryUsedMiB: 0 }]) }, spawnFn: () => { throw new Error('must not probe'); } });
  assert.equal(cards[0].name, 'Big');
  assert.equal(enumerateGpus({ env: { IMAGINARIUM_GPU_CARDS: '{not json' }, spawnFn: fakeSpawn(CSV) }).length, 2, 'a broken seam falls through to the real probe');
});

test('pickCard is fit-first: the heavy engine gets the big card, a light job must not eat it', () => {
  const cards = enumerateGpus({ env: {}, spawnFn: fakeSpawn(CSV) });
  // pixal3d (10240 need): only the 5060 Ti has that much free now
  assert.equal(pickCard({ engine: 'pixal3d', cards })?.index, 1);
  // hunyuan (6144): both fit - the SMALLEST fitting card wins, the 16 GiB stays for Pixal3D
  assert.equal(pickCard({ engine: 'hunyuan', cards })?.index, 0);
  // tie on size -> the emptier card
  const two = pickCard({ engine: 'hunyuan', cards: [{ index: 5, memoryTotalMiB: 12000, freeMiB: 7000 }, { index: 6, memoryTotalMiB: 12000, freeMiB: 11000 }] });
  assert.equal(two.index, 6);
});

test('pickCard: claimed cards are never offered, free:false answers the most suitable busy one', () => {
  const cards = enumerateGpus({ env: {}, spawnFn: fakeSpawn(CSV) });
  assert.equal(pickCard({ engine: 'hunyuan', cards, claimed: [cards[0]] })?.index, 1);
  // every card too full for the engine: null while waiting, and with free:false the smallest card
  // big ENOUGH to host it (the spawn-anyway answer; the lock and hand-over serialize there)
  assert.equal(pickCard({ engine: 'pixal3d', cards: [{ index: 0, memoryTotalMiB: 12227, freeMiB: 100 }] }), null);
  assert.equal(pickCard({ engine: 'pixal3d', cards: [{ index: 0, memoryTotalMiB: 12227, freeMiB: 100 }], free: false })?.index, 0);
  assert.equal(pickCard({ engine: 'pixal3d', cards: null }), null);
});

test('vramNeedMiB: branch profiles with an env override', () => {
  assert.equal(vramNeedMiB('pixal3d', {}), ENGINE_VRAM_NEED_MIB.pixal3d);
  assert.equal(vramNeedMiB('pixal3d', { IMAGINARIUM_GPU_NEED_MIB_PIXAL3D: '0' }), 0, '0 disables the preference');
  assert.equal(vramNeedMiB('unknown-engine', {}), 0);
});

test('cardLockName: one lock per physical card (UUID), legacy global name without a card', () => {
  const cards = enumerateGpus({ env: {}, spawnFn: fakeSpawn(CSV) });
  const a = cardLockName(cards[0]), b = cardLockName(cards[1]);
  assert.match(a, /^Global\\IMA_GPU_RENDER_GPU-d7cc0128-7dbd-c868-180e-4f88b1ae663a$/);
  assert.notEqual(a, b, 'two cards never share a lock');
  assert.equal(cardLockName(null), null, 'no pool -> the caller keeps the legacy default name');
  assert.match(cardLockName({ index: 3 }), /IMA_GPU_RENDER_3$/, 'a card without UUID still gets its own name');
});

test('cardEnv pins CUDA_VISIBLE_DEVICES only when a card was chosen', () => {
  const base = { PATH: '/usr/bin' };
  assert.equal(cardEnv({ index: 1 }, base).CUDA_VISIBLE_DEVICES, '1');
  assert.deepEqual(cardEnv(null, base), base);
  assert.notEqual(cardEnv({ index: 2 }, base), base, 'the caller env is never mutated');
});

test('engineCardFor tracks long-lived engines; sharesCard keeps the safe default', () => {
  const cards = enumerateGpus({ env: {}, spawnFn: fakeSpawn(CSV) });
  assert.equal(engineCardFor('hunyuan'), null, 'unknown until an engine spawn claims a card');
  claimEngineCard('hunyuan', cards[0]);
  claimEngineCard('pixal3d', cards[1]);
  assert.equal(engineCardFor('hunyuan').index, 0);
  assert.equal(sharesCard(cards[0], cards[1]), false, 'two cards - the hand-over is not needed');
  assert.equal(sharesCard(cards[0], cards[0]), true);
  assert.equal(sharesCard(cards[0], null), true, 'an unknown card still serializes (the old behaviour)');
  claimEngineCard('hunyuan', null);
  assert.equal(engineCardFor('hunyuan'), null, 'a reused external engine claims nothing');
});

test('noCardText names the need and what every card is doing', () => {
  const cards = enumerateGpus({ env: {}, spawnFn: fakeSpawn(CSV) });
  const text = noCardText('pixal3d', cards);
  assert.match(text, /Pixal3D waits for a GPU with at least 10240 MiB/);
  assert.match(text, /RTX 5060 Ti: 15477 MiB free/);
  assert.match(noCardText('pixal3d', null), /no card was detected/);
});
