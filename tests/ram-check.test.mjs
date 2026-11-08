// RAM room before Pixal3D (0.6.10 wave ticket 21). Everything outside is faked: /proc/meminfo,
// the engines' queue and /free endpoints, the settle sleep. The rules pinned here: never refuse
// what was not read; never interrupt a busy engine; refuse with the numbers in the sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RAM_THRESHOLDS, ramFloor, freeRamMiB, ramRoomText, ensureRamFor } from '../server/ram-check.mjs';

const meminfo = (availMiB) => async () => `MemTotal:       32688612 kB\nMemFree:         2000000 kB\nMemAvailable:   ${availMiB * 1024} kB\nBuffers: 1 kB\n`;
const noMeminfo = async () => { throw new Error('no such file'); };

test('the floor is our own tuning, env-tunable and clamped', () => {
  assert.equal(RAM_THRESHOLDS.pixal3dMinFreeMiB, 4096);
  assert.equal(ramFloor('pixal3d', {}), 4096);
  assert.equal(ramFloor('pixal3d', { ASTRA_RAM_FLOOR_MIB: '2048' }), 2048);
  assert.equal(ramFloor('pixal3d', { ASTRA_RAM_FLOOR_MIB: '0' }), 0, '0 disables');
  assert.equal(ramFloor('pixal3d', { ASTRA_RAM_FLOOR_MIB: '-7' }), 0, 'clamped');
  assert.equal(ramFloor('pixal3d', { ASTRA_RAM_FLOOR_MIB: '99999999999' }), 1024 * 1024, 'a typo cannot be a floor');
  assert.equal(ramFloor('pixal3d', { ASTRA_RAM_FLOOR_MIB: 'nonsense' }), 4096, 'garbage keeps the table');
});

test('freeRamMiB: MemAvailable in MiB, honest null when the system does not answer; seam wins', async () => {
  assert.equal(await freeRamMiB({ env: {}, readFile: meminfo(9123) }), 9123);
  assert.equal(await freeRamMiB({ env: {}, readFile: async () => 'MemTotal: 1 kB' }), null);
  assert.equal(await freeRamMiB({ env: {}, readFile: noMeminfo }), null);
  assert.equal(await freeRamMiB({ env: { ASTRA_FREE_RAM_MIB: '123' }, readFile: noMeminfo }), 123);
});

test('ramRoomText: only a known shortfall speaks, with both numbers in it', () => {
  assert.equal(ramRoomText(null, 4096, 'Pixal3D'), null, 'not read -> not refused');
  assert.equal(ramRoomText(4096, 4096, 'Pixal3D'), null, 'exactly at the floor is room');
  assert.equal(ramRoomText(99999, 0, 'Pixal3D'), null, 'disabled check never talks');
  assert.match(ramRoomText(2048, 4096, 'Pixal3D'), /Pixal3D wants at least 4096 MiB .*2048 MiB free.*the engine was not started/);
});

test('enough memory up front: no engine is touched at all', async () => {
  let fetched = 0;
  const r = await ensureRamFor({
    engine: 'pixal3d', env: { ASTRA_FREE_RAM_MIB: '16384' },
    urls: { hunyuan: 'http://8190.test' },
    fetchFn: async () => { fetched++; throw new Error('must not be called'); },
    readFile: meminfo(16384),
  });
  assert.equal(fetched, 0);
  assert.equal(r.refuse, null);
  assert.equal(r.freeMiB, 16384);
});

test('short on RAM: the idle other engine is asked to unload, and the re-read decides the answer', async () => {
  const seen = [];
  let reads = 0;
  const r = await ensureRamFor({
    engine: 'pixal3d', env: {}, urls: { hunyuan: 'http://8190.test', pixal3d: 'http://8191.test' },
    readFile: async () => (++reads === 1 ? await meminfo(1500)() : await meminfo(5200)()),   // 1.5 GiB -> 5 GiB after unload
    fetchFn: async (url, o) => {
      seen.push((o?.method || 'GET') + ' ' + url);
      if (url.endsWith('/queue')) return { ok: true, status: 200, json: async () => ({ queue_running: [], queue_pending: [] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
    sleepFn: async () => {},
  });
  assert.deepEqual(seen, ['GET http://8190.test/queue', 'POST http://8190.test/free'], 'checked idle first, then unloaded; pixal3d itself untouched');
  assert.deepEqual(r.unloaded, ['hunyuan']);
  assert.equal(r.refuse, null, 'after unloading there is room - the job runs');
  assert.equal(r.freeMiB, 5200);
});

test('a busy engine is never interrupted - the wait belongs to the GPU hand-over', async () => {
  const seen = [];
  const r = await ensureRamFor({
    engine: 'pixal3d', env: { ASTRA_FREE_RAM_MIB: '1500' }, urls: { hunyuan: 'http://8190.test' },
    readFile: meminfo(1500),
    fetchFn: async (url, o) => {
      seen.push((o?.method || 'GET') + ' ' + url);
      if (url.endsWith('/queue')) return { ok: true, status: 200, json: async () => ({ queue_running: [{}], queue_pending: [] }) };
      throw new Error('/free must not be called on a busy engine');
    },
    sleepFn: async () => {},
  });
  assert.deepEqual(r.busy, ['hunyuan']);
  assert.equal(r.unloaded.length, 0);
  assert.deepEqual(seen, ['GET http://8190.test/queue']);
  assert.match(r.refuse, /wants at least 4096 MiB .*1500 MiB free/, 'still short, still refuses - with the numbers');
});

test('an engine that does not answer is not resident memory: skipped silently', async () => {
  const r = await ensureRamFor({
    engine: 'pixal3d', env: { ASTRA_FREE_RAM_MIB: '1500' }, urls: { hunyuan: 'http://down.test' },
    readFile: meminfo(1500),
    fetchFn: async () => { throw new Error('ECONNREFUSED'); },
    sleepFn: async () => {},
  });
  assert.deepEqual(r.unloaded, []); assert.deepEqual(r.busy, []);
  assert.match(r.refuse, /1500 MiB free/);
});

test('memory the system cannot report is never refused: the run answers for itself', async () => {
  const r = await ensureRamFor({ engine: 'pixal3d', env: {}, urls: {}, readFile: noMeminfo });
  assert.equal(r.freeMiB, null);
  assert.equal(r.refuse, null);
});
