// The gpuIndex setting: which nvidia-smi card the GPU engines (ComfyUI 8190 and Pixal3D 8191)
// see as their cuda:0. The pinning itself happens through CUDA_VISIBLE_DEVICES at spawn time
// (server/schema.mjs gpuEnv/engineEnv, used by server/runtime.mjs and server/pixal3d.mjs) -
// inside the child the numbering restarts at 0, so the engines take "cuda:0" unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, defaults, bootConfig, gpuEnv } from '../server/schema.mjs';

test('config gpuIndex: -1 (Auto - leave the environment untouched) is the default', () => {
  assert.equal(defaults.gpuIndex, -1);
  assert.equal(configSchema.safeParse(defaults).data.gpuIndex, -1);
  // a config written before the setting existed keeps booting, field for field
  const beforeGpuIndex = { ...defaults };
  delete beforeGpuIndex.gpuIndex;
  assert.equal(bootConfig(beforeGpuIndex).gpuIndex, -1);
});

test('config gpuIndex: an nvidia-smi index or -1, nothing else', () => {
  for (const n of [0, 1, 63]) assert.equal(configSchema.safeParse({ ...defaults, gpuIndex: n }).success, true, `accepts ${n}`);
  for (const bad of [-2, 64, 1.5, '1', null, true]) assert.equal(configSchema.safeParse({ ...defaults, gpuIndex: bad }).success, false, `rejects ${String(bad)}`);
  // boot is tolerant per field: a broken gpuIndex falls back to -1, the rest survives
  const booted = bootConfig({ ...defaults, gpuIndex: 1.5, ollamaModel: 'keepme' });
  assert.equal(booted.gpuIndex, -1);
  assert.equal(booted.ollamaModel, 'keepme');
  assert.equal(bootConfig({ ...defaults, gpuIndex: 1 }).gpuIndex, 1);
});

test('gpuEnv: a set index pins CUDA_VISIBLE_DEVICES over the inherited one, -1 changes nothing', () => {
  const base = { CUDA_VISIBLE_DEVICES: '0', PATH: '/usr/bin', HF_HUB_OFFLINE: '1' };
  assert.equal(gpuEnv(1, base).CUDA_VISIBLE_DEVICES, '1');
  assert.equal(gpuEnv(0, base).CUDA_VISIBLE_DEVICES, '0', 'pinning cuda:0 must still be explicit');
  assert.deepEqual(gpuEnv(-1, base), base, 'Auto never rewrites the environment');
  assert.equal(gpuEnv(undefined, base).CUDA_VISIBLE_DEVICES, '0', 'a missing setting behaves as Auto');
  assert.notEqual(gpuEnv(2, base), base, 'the caller env object is never mutated');
});
