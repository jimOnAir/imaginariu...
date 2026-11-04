// View modes of the Hybrid UI (ticket 04): Simple is the default; Detailed additionally reveals
// exactly the surfaces pinned in REVEALED_IN_DETAILED. The visibility rule is a pure predicate so
// the contract "what Simple hides" is a test, not a vibe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, MODE_KEY, readMode, saveMode, isRevealed, REVEALED_IN_DETAILED } from '../src/shell/mode.js';

const memStorage = (init = {}) => ({ data: { ...init }, getItem(k) { return k in this.data ? this.data[k] : null; }, setItem(k, v) { this.data[k] = String(v); } });

test('Simple is the default; only known stored modes are honored', () => {
  assert.deepEqual(MODES, ['simple', 'detailed']);
  assert.equal(readMode(memStorage()), 'simple');
  assert.equal(readMode(memStorage({ [MODE_KEY]: 'detailed' })), 'detailed');
  assert.equal(readMode(memStorage({ [MODE_KEY]: 'expert' })), 'simple');
  assert.equal(readMode(undefined), 'simple');
});

test('the mode persists under astra.mode', () => {
  const s = memStorage();
  saveMode('detailed', s);
  assert.equal(s.data[MODE_KEY], 'detailed');
  assert.equal(readMode(s), 'detailed');
});

test('Detailed reveals, Simple hides - exactly the pinned surface list', () => {
  assert.deepEqual(REVEALED_IN_DETAILED, ['advanced-generation', 'game-export-profiles', 'keyboard-shortcuts']);
  for (const surface of REVEALED_IN_DETAILED) {
    assert.equal(isRevealed('detailed', surface), true, surface + ' visible in Detailed');
    assert.equal(isRevealed('simple', surface), false, surface + ' hidden in Simple');
  }
  // everything else is always there - and an unknown mode is Simple, never a surprise reveal
  assert.equal(isRevealed('simple', 'concept-dropzone'), true);
  assert.equal(isRevealed('detailed', 'concept-dropzone'), true);
  assert.equal(isRevealed('whatever', 'game-export-profiles'), false);
});
