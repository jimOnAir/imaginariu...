// 0.7.11: the gpuIndex setting is dead - the GPU card pool (server/gpu-pool.mjs) CHOOSES the
// card at engine spawn, so the config has no card field any more. What stays contractually
// tested here is the retirement: a config.json written by 0.7.10 boots clean, the dead key is
// dropped with one honest sentence (not a generic "unknown"), and nothing else is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, defaults, bootConfig } from '../server/schema.mjs';

test('config has no gpuIndex any more - the card is chosen, not set', () => {
  assert.equal('gpuIndex' in defaults, false);
  assert.equal(configSchema.safeParse(defaults).success, true);
  assert.equal(configSchema.safeParse({ ...defaults, gpuIndex: 1 }).success, false, 'strict schema rejects the retired key');
});

test('boot retires gpuIndex with its own sentence and keeps every other setting', () => {
  const warnings = [];
  const stored = { ...defaults, gpuIndex: 1, ollamaModel: 'qwen3:8b' };
  const booted = bootConfig(stored, (m) => warnings.push(m));
  assert.equal('gpuIndex' in booted, false);
  assert.equal(booted.ollamaModel, 'qwen3:8b');
  assert.equal(warnings.filter((w) => w.includes('gpuIndex')).length, 1);
  assert.match(warnings.find((w) => w.includes('gpuIndex')), /retired - the generation card is picked from the card pool/);
  assert.equal(warnings.some((w) => w.includes('not a setting of this studio')), false, 'the retired key is not reported as unknown');
});
