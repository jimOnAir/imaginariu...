// Ticket 54 (0.7.9 fold wave): the shape-model choice of the Hunyuan engine. 'auto' - the new
// default - picks Hunyuan3D-2mini (the 3.8 GB self-contained file, the 0.7.4 note's 8 GB-class
// shape model) when the card is under the branch's one low-VRAM seam AND the mini file is
// installed; everything else keeps the pre-0.7.9 behaviour byte-for-byte. Unknown VRAM is
// "not small" (ticket 33's honesty), so auto never picks on faith.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickShapeCheckpoint } from '../server/jobs.mjs';
import { generationSchema, hunyuanWorkflow } from '../server/schema.mjs';
import { LOW_VRAM_CEILING_MIB } from '../server/low-vram.mjs';

const MINI = 'hunyuan3d-dit-v2-mini.safetensors';
const HY2 = 'hunyuan3d-dit-v2.safetensors';

test('pickShapeCheckpoint: auto picks mini only for a small card that has mini installed', () => {
  const names = [HY2, MINI];
  assert.equal(pickShapeCheckpoint('auto', { names, fallback: HY2, vramMib: 8192 }), MINI);
  assert.equal(pickShapeCheckpoint('auto', { names, fallback: HY2, vramMib: 12227 }), HY2, 'a 12 GB card keeps the configured model');
  assert.equal(pickShapeCheckpoint('auto', { names: [HY2], fallback: HY2, vramMib: 8192 }), HY2, 'auto never invents a download: no mini file, no mini pick');
  assert.equal(pickShapeCheckpoint('auto', { names, fallback: HY2, vramMib: null }), HY2, 'unknown VRAM is not small');
  assert.equal(pickShapeCheckpoint('auto', { names, fallback: HY2, vramMib: LOW_VRAM_CEILING_MIB }), HY2, 'strictly-below, the same seam as ticket 37');
});

test('pickShapeCheckpoint: explicit choices pass through, default stays the configured checkpoint', () => {
  assert.equal(pickShapeCheckpoint('hunyuan21', { names: [], fallback: HY2 }), 'hunyuan_3d_v2.1.safetensors');
  assert.equal(pickShapeCheckpoint('hunyuan2mini', { names: [], fallback: HY2 }), MINI, 'explicit mini is passed to the engine, which reports a missing file (the 2.1 convention)');
  assert.equal(pickShapeCheckpoint('default', { names: [MINI], fallback: HY2, vramMib: 1024 }), HY2, "'default' is byte-for-byte the pre-0.7.9 path");
  assert.equal(pickShapeCheckpoint(undefined, { names: [MINI], fallback: HY2, vramMib: 1024 }), HY2, 'a job record without the field behaves as before');
});

test('generationSchema: auto is the default, the pre-0.7.9 values still parse', () => {
  assert.equal(generationSchema.parse({ prompt: 'bone staff' }).shapeModel, 'auto');
  assert.equal(generationSchema.parse({ prompt: 'x', shapeModel: 'default' }).shapeModel, 'default');
  assert.equal(generationSchema.parse({ prompt: 'x', shapeModel: 'hunyuan21' }).shapeModel, 'hunyuan21');
  assert.equal(generationSchema.parse({ prompt: 'x', shapeModel: 'hunyuan2mini' }).shapeModel, 'hunyuan2mini');
  assert.throws(() => generationSchema.parse({ prompt: 'x', shapeModel: 'hunyuan2maxi' }));
});

test('the mini workflow keeps the 2.0 latent (the 2.1 branch of resolution tests a version, not the word)', () => {
  const w = hunyuanWorkflow('x.png', MINI, 'standard', 42, 'test');
  assert.equal(w['1'].inputs.ckpt_name, MINI);
  assert.equal(w['5'].inputs.resolution, 3072);
  assert.equal(hunyuanWorkflow('x.png', 'hunyuan_3d_v2.1.safetensors', 'high', 42, 'test')['5'].inputs.resolution, 4096);
});
