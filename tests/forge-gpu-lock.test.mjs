// Real cross-process GPU lock: Windows named mutex via a PowerShell holder, Linux flock(1) via an sh holder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { GPU_MUTEX_NAME, acquireGpuLock, gpuLockName, gpuLockState } from '../server/gpu-lock.mjs';

const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';
const bothImpls = (!isWin && !isLinux) ? 'Windows and Linux only' : false;
const testName = () => `Local\\Imaginarium_TEST_${randomUUID()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('GPU mutex name: default Global\\IMA_GPU_RENDER, IMAGINARIUM_GPU_LOCK_NAME overrides', () => {
  assert.equal(GPU_MUTEX_NAME, 'Global\\IMA_GPU_RENDER');
  assert.equal(gpuLockState().name, process.env.IMAGINARIUM_GPU_LOCK_NAME || process.env.IMAGINARIUM_GPU_MUTEX || 'Global\\IMA_GPU_RENDER');
  assert.equal(gpuLockName({}), 'Global\\IMA_GPU_RENDER');
  assert.equal(gpuLockName({ IMAGINARIUM_GPU_LOCK_NAME: 'Local\\MyLock' }), 'Local\\MyLock');
  assert.equal(gpuLockName({ IMAGINARIUM_GPU_MUTEX: 'Local\\Old', IMAGINARIUM_GPU_LOCK_NAME: 'Local\\New' }), 'Local\\New');
});

test('two acquirers of the real mutex are serialised', { skip: bothImpls }, async () => {
  const name = testName();
  const a = await acquireGpuLock({ name, timeoutMs: 20000 });
  let b = null;
  let bPromise = null;
  try {
    assert.equal(a.noop, false);
    assert.equal(gpuLockState().held, true);
    let bAt = 0;
    let waited = false;
    bPromise = acquireGpuLock({ name, timeoutMs: 20000, onWait: () => { waited = true; } }).then((lock) => { bAt = Date.now(); b = lock; return lock; });
    await sleep(900);
    assert.equal(bAt, 0, 'second acquirer must wait while the first holds the mutex');
    assert.equal(waited, true, 'second acquirer reports that it is waiting');
    const releasedAt = Date.now();
    await a.release();
    await bPromise;
    assert.ok(bAt >= releasedAt, 'second acquirer gets the mutex only after release');
    await b.release();
    await b.release(); // idempotent
    assert.equal(gpuLockState().held, false);
  } finally {
    await a.release();
    if (bPromise) await bPromise.catch(() => {});
    await b?.release();
  }
});

test('an abandoned mutex (holder killed) is acquirable', { skip: bothImpls }, async () => {
  const name = testName();
  const a = await acquireGpuLock({ name, timeoutMs: 20000 });
  let b = null;
  try {
    let markWaiting;
    const waiting = new Promise((r) => { markWaiting = r; });
    const pending = acquireGpuLock({ name, timeoutMs: 20000, onWait: () => markWaiting() });
    await waiting;
    process.kill(a.pid, 'SIGKILL'); // Windows: TerminateProcess marks the mutex abandoned; Linux: the kernel drops the flock
    b = await pending;
    assert.equal(b.abandoned, isWin, isWin ? 'the abandoned mutex is reported' : 'flock releases silently when the holder dies');
  } finally {
    await b?.release();
    await a.release(); // releasing a dead holder is a no-op
  }
  // With no other handle open the mutex object disappears entirely; a fresh acquire still works.
  const c = await acquireGpuLock({ name, timeoutMs: 20000 });
  if (isWin) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true });
  else process.kill(c.pid, 'SIGKILL');
  const d = await acquireGpuLock({ name, timeoutMs: 20000 });
  await d.release();
  await c.release();
});

test('waiting for the mutex honours timeout and abort', { skip: bothImpls }, async () => {
  const name = testName();
  const a = await acquireGpuLock({ name, timeoutMs: 20000 });
  try {
    await assert.rejects(acquireGpuLock({ name, timeoutMs: 400 }), (err) => err.code === 'gpu_timeout' && /The GPU has been busy/.test(err.message));
    const controller = new AbortController();
    const pending = acquireGpuLock({ name, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    await assert.rejects(pending, (err) => err.name === 'AbortError');
  } finally {
    await a.release();
  }
  const c = await acquireGpuLock({ name, timeoutMs: 5000 });
  await c.release();
});
