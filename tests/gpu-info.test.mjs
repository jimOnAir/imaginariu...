// gpu-info + the Pixal3D driver-570 gate (0.6.10 wave ticket 20). The floor (570) and the
// nvidia-smi query are the 0.6.8 interface facts; the refusal before spawning anything is the
// behavior; the wording is this branch's. No real nvidia-smi here - every read is a scripted
// spawnFn or an env seam (ASTRA_DRIVER_VERSION / ASTRA_VRAM_MIB), the same style as ticket 02.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driverMajor, gpuInfo, oldDriverText, resetGpuInfo, MIN_NVIDIA_DRIVER } from '../server/gpu-info.mjs';
import { generatePixal3d } from '../server/pixal3d-run.mjs';

const spawn = (line) => () => ({ stdout: line });
const boom = () => { throw new Error('nvidia-smi: command not found'); };

test('driverMajor: real version shapes, junk stays null', () => {
  assert.equal(driverMajor('615.71.09'), 615);
  assert.equal(driverMajor('570.86.16'), 570);
  assert.equal(driverMajor(' 570 '), 570);
  assert.equal(driverMajor(''), null);
  assert.equal(driverMajor(undefined), null);
  assert.equal(driverMajor('[N/A]'), null, 'old nvidia-smi placeholders are unknown, not ancient');
});

test('gpuInfo: one read answers name, size and driver; failures answer null, never a guess', () => {
  resetGpuInfo();
  const info = gpuInfo({ env: {}, spawnFn: spawn('NVIDIA GeForce RTX 5070, 12227, 615.71.09') });
  assert.deepEqual(info, { name: 'NVIDIA GeForce RTX 5070', vramMiB: 12227, driverVersion: '615.71.09', driverMajor: 615 });
  assert.equal(gpuInfo({ env: {}, spawnFn: boom }), null);
  assert.equal(gpuInfo({ env: {}, spawnFn: () => ({ stdout: '' }) }), null);
  const partial = gpuInfo({ env: {}, spawnFn: spawn('RTX A2000, 8192, [N/A]') });
  assert.equal(partial.driverVersion, '[N/A]', 'the string rides as reported; major stays null');
  assert.equal(partial.driverMajor, null);
});

test('the seams pin driver and size for tests and odd setups', () => {
  resetGpuInfo();
  const info = gpuInfo({ env: { ASTRA_DRIVER_VERSION: '560.35.03', ASTRA_VRAM_MIB: '8192' }, spawnFn: spawn('GeForce RTX 4000 SFF, 5734, 535.10') });
  assert.equal(info.driverVersion, '560.35.03');
  assert.equal(info.vramMiB, 8192);
  assert.equal(oldDriverText(info, 'Pixal3D').includes('560.35.03'), true, 'the sentence names what was detected');
});

test('oldDriverText: the boundary is exactly 570, unknown drivers are never refused', () => {
  const mk = (v) => ({ driverVersion: v, driverMajor: driverMajor(v) });
  assert.match(oldDriverText(mk('569.99.01'), 'Pixal3D'), /Pixal3D needs NVIDIA driver 570 or newer - this machine reports 569\.99\.01/);
  assert.equal(oldDriverText(mk('570.0')), null);
  assert.equal(oldDriverText(mk('615.71.09')), null);
  assert.equal(oldDriverText(null), null);
  assert.equal(oldDriverText({ driverVersion: '[N/A]' }), null, 'unknown is not old - the run answers for itself');
  assert.match(oldDriverText(mk('470.0')), /nothing was downloaded or run/, 'the refusal promises the un-spawned');
  assert.equal(MIN_NVIDIA_DRIVER, 570);
});

test('the cache answers repeated status calls without a second probe; refresh and reset re-read', () => {
  resetGpuInfo();
  let reads = 0;
  const counting = () => ({ stdout: `RTX 4070, 12288, 57${reads++}.0` });
  const first = gpuInfo({ spawnFn: counting });
  const again = gpuInfo({ spawnFn: counting });
  assert.equal(reads, 1, 'the second call is served from the cache');
  assert.equal(first.driverVersion, '570.0');
  const forced = gpuInfo({ spawnFn: counting, refresh: true });
  assert.equal(forced.driverVersion, '571.0', 'refresh re-probes');
  resetGpuInfo();
  gpuInfo({ spawnFn: counting });
  assert.equal(reads, 3, 'reset drops the cache');
});

test('a driver below the floor is refused BEFORE anything is started (the mid-run crash class)', async () => {
  resetGpuInfo();
  let started = 0;
  await assert.rejects(generatePixal3d({
    images: { front: 'f.png' }, tag: 't20',
    deps: {
      start: async () => { started++; },
      ensureRam: async () => ({ refuse: null }),
      gpuInfo: () => ({ name: 'RTX 4060', vramMiB: 8192, driverVersion: '565.11', driverMajor: 565 }),
    },
  }), /Pixal3D needs NVIDIA driver 570 or newer - this machine reports 565\.11/);
  assert.equal(started, 0, 'the engine never spawns behind the gate - that is the whole fix');
});

test('a current driver passes the gate through to the start call', async () => {
  resetGpuInfo();
  let started = 0;
  await assert.rejects(generatePixal3d({
    images: { front: 'f.png' }, tag: 't20ok',
    deps: {
      start: async () => { started++; throw new Error('stub stop - the gate already passed'); },
      ensureRam: async () => ({ refuse: null }),
      gpuInfo: () => ({ name: 'RTX 5070', vramMiB: 12227, driverVersion: '615.71.09', driverMajor: 615 }),
    },
  }), /stub stop/);
  assert.equal(started, 1);
});
