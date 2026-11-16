// Ticket 60 item 6 (0.7.9 fold wave): "text → 3D" without an assistant installed must not stop
// with an assistant error - the concept is drawn from the text as written and the job carries an
// honest accuracy note. server/concept-llm.mjs is the extracted step, `llm` is the test seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conceptEnglishText } from '../server/concept-llm.mjs';

test('ascii description: the assistant is never asked', async () => {
  let calls = 0;
  const r = await conceptEnglishText('a knight with a cape', { llm: async () => { calls++; return { actions: [] }; } });
  assert.deepEqual(r, { english: 'a knight with a cape' });
  assert.equal(calls, 0);
});

test('no assistant: the text is drawn as written and the note carries the reason and the hint', async () => {
  const notes = [];
  const boom = async () => { throw new Error('Ollama is running but has no text model here'); };
  const r = await conceptEnglishText('рыцарь с плащом', { llm: boom, note: (m) => notes.push(m) });
  assert.equal(r.english, 'рыцарь с плащом');
  assert.equal(r.untranslated, true);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /No assistant to translate/);
  assert.match(notes[0], /Ollama is running but has no text model/);
  assert.match(notes[0], /more accurate/);
});

test('an assistant that answers without a concept action is still the old honest error', async () => {
  await assert.rejects(conceptEnglishText('рыцарь', { llm: async () => ({ actions: [{ type: 'other' }] }) }),
    /did not return an English concept/);
});

test('cancel is not a fallback: an aborted request re-throws instead of falling back', async () => {
  const ac = new AbortController();
  ac.abort(new Error('cancelled by user'));
  await assert.rejects(conceptEnglishText('рыцарь', {
    llm: async () => { throw new Error('The operation was aborted'); }, signal: ac.signal,
  }), /cancelled by user/);
});

test('a good answer translates, provider pinned to ollama, the original text in the request', async () => {
  let seen;
  const r = await conceptEnglishText('рыцарь', {
    llm: async (cfg, inp) => { seen = { cfg, inp }; return { actions: [{ type: 'concept', prompt: 'a knight' }] }; },
  });
  assert.equal(r.english, 'a knight');
  assert.equal(r.untranslated, undefined);
  assert.equal(seen.cfg.provider, 'ollama');
  assert.match(seen.inp.message, /рыцарь/);
});
