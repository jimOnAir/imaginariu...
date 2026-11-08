// vlmAsk's reasoning escape hatch (ticket 08 live finding): ollama 0.40 ignores think:false for
// qwen3-vl - the model fills message.thinking and leaves content empty. vlmAsk must then ask once
// with reasoning ON (bigger budget) and return the finished answer; two silences stay an honest error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vlmAsk } from '../server/vlm.mjs';

const scripted = (replies) => {
  const seen = [];
  const fetchFn = async (url, o) => {
    const body = JSON.parse(o.body);
    seen.push({ think: body.think, num_predict: body.options.num_predict, messages: body.messages.length });
    return { ok: true, status: 200, json: async () => replies.shift(), text: async () => '' };
  };
  return { fetchFn, seen };
};

test('vlmAsk: an empty content with a thinking field re-asks with reasoning on and a finished budget', async () => {
  const { fetchFn, seen } = scripted([
    { message: { role: 'assistant', content: '', thinking: 'let me analyze each axis, first the likeness...' } },
    { message: { role: 'assistant', content: '{"likeness":8,"silhouette":7,"seams":6,"face":null,"style":7,"note":"ok"}' } },
  ]);
  const text = await vlmAsk({ url: 'http://ollama.test', model: 'qwen3-vl:8b', prompt: 'score', images: ['aGk='], fetchFn });
  assert.match(text, /likeness/);
  assert.deepEqual(seen.map((s) => [s.think, s.num_predict]), [[false, 700], [true, 3000]]);
});

test('vlmAsk: a plain answer costs exactly one request; two silences are an honest error', async () => {
  const plain = scripted([{ message: { role: 'assistant', content: 'a fox toy' } }]);
  assert.equal(await vlmAsk({ url: 'http://ollama.test', model: 'm', prompt: 'p', images: [], fetchFn: plain.fetchFn }), 'a fox toy');
  assert.equal(plain.seen.length, 1);
  const silent = scripted([
    { message: { role: 'assistant', content: '', thinking: 'reasoning again' } },
    { message: { role: 'assistant', content: '   ' } },
  ]);
  await assert.rejects(vlmAsk({ url: 'http://ollama.test', model: 'm', prompt: 'p', images: ['x'], fetchFn: silent.fetchFn }), /empty text/);
  assert.equal(silent.seen.length, 2);
});
