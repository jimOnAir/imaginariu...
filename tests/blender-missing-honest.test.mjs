// Ticket 42 (0.7.1 wave, degraded-start honesty): when Blender is not installed, a Forge step
// must answer with the remedy the branch actually ships (the installer row / ASTRA_BLENDER),
// never with the raw `spawn blender ENOENT`. Windows 0.7 shipped exactly this "clear message
// when Blender is missing" fact; the probe of the three degraded-start shapes found the step
// spawn the only bricked one, and these two tests pin its honesty both directions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBlenderStep, blenderSpawnFailText, BlenderStepError } from '../server/blender.mjs';

test('a Forge step with no Blender names the remedy, not the errno', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'af-blender-missing-'));
  const missing = path.join(tmp, 'nope', 'blender');
  await assert.rejects(
    runBlenderStep({ step: 'cleanup', request: { inputs: {}, params: {}, out_dir: tmp }, blender: missing, logDir: tmp }),
    (err) => {
      assert.ok(err instanceof BlenderStepError);
      assert.equal(err.code, 'spawn_failed');
      assert.match(err.message, /Blender was not found/);
      assert.match(err.message, /installer\/install\.sh -Yes -Only blender/);   // the branch's real remedy
      assert.match(err.message, /ASTRA_BLENDER/);
      assert.doesNotMatch(err.message, /ENOENT/);                                // the raw errno stays in the log
      return true;
    });
});

test('a spawn failure that is not "missing" keeps its own message', () => {
  const t = blenderSpawnFailText('/opt/blender/blender', Object.assign(new Error('permission denied'), { code: 'EACCES' }));
  assert.match(t, /Failed to start Blender \(\/opt\/blender\/blender\): permission denied/);
  assert.doesNotMatch(t, /-Only blender/);   // no false remedy for a different disease
});
