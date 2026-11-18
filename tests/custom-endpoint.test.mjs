// ADR-0005: the custom endpoint's model list proxy (server/llm.mjs -> customModels), the one
// place the studio may fetch an arbitrary user-configured address. It never sends a key the
// user did not save, and every server failure comes back as an honest line, never a throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customModels } from '../server/llm.mjs';

const cfg = { provider: 'custom', customUrl: 'https://api.example.com/v1/' };
const jsonBody = (v) => ({ ok: true, status: 200, json: async () => v });

test('customModels joins /models once and returns sorted unique ids from the OpenAI shape', async (t) => {
  const spy = t.mock.method(globalThis, 'fetch', async () => jsonBody({ data: [{ id: 'z-model' }, { id: 'a-model' }, 'm-model'] }));
  const v = await customModels(cfg);
  assert.deepEqual(v.models, ['a-model', 'm-model', 'z-model']);
  assert.equal(v.error, undefined);
  assert.equal(spy.mock.calls[0].arguments[0], 'https://api.example.com/v1/models', 'the trailing slash is joined, not doubled');
});

test('customModels reads the models-array shape too and sends no Authorization without a saved key', async (t) => {
  const had = process.env.CUSTOM_LLM_API_KEY;
  delete process.env.CUSTOM_LLM_API_KEY;
  try {
    const spy = t.mock.method(globalThis, 'fetch', async () => jsonBody({ models: ['x'] }));
    assert.deepEqual((await customModels(cfg)).models, ['x']);
    assert.equal(spy.mock.calls[0].arguments[1].headers.Authorization, undefined, 'keyless endpoint, keyless request');
  } finally {
    if (had !== undefined) process.env.CUSTOM_LLM_API_KEY = had;
  }
});

test('customModels sends the saved key as a bearer token', async (t) => {
  const had = process.env.CUSTOM_LLM_API_KEY;
  process.env.CUSTOM_LLM_API_KEY = 'sk-test';
  try {
    const spy = t.mock.method(globalThis, 'fetch', async () => jsonBody({ data: [{ id: 'x' }] }));
    await customModels(cfg);
    assert.equal(spy.mock.calls[0].arguments[1].headers.Authorization, 'Bearer sk-test');
  } finally {
    if (had === undefined) delete process.env.CUSTOM_LLM_API_KEY;
    else process.env.CUSTOM_LLM_API_KEY = had;
  }
});

test('customModels answers every server failure with an error line instead of a throw', async (t) => {
  assert.deepEqual(await customModels({ provider: 'custom', customUrl: '' }), { models: [], error: 'Set the endpoint address in the connections.' });
  const refused = t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, json: async () => ({}) }));
  assert.match((await customModels(cfg)).error, /401/);
  refused.mock.restore();
  const down = t.mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
  assert.match((await customModels(cfg)).error, /ECONNREFUSED/);
  down.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => jsonBody({ data: [] }));
  assert.match((await customModels(cfg)).error, /empty model list/);
});
