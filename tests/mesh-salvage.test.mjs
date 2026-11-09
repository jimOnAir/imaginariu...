// Ticket 34 (0.6.18 wave): over-cap generations are simplified to the limit, never thrown away;
// ±1 surface level gets the "try 0" suggestion. The Blender path is exercised through a stubbed
// runStep — the unit lane needs no Blender, no GPU, no ComfyUI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateGeneratedMesh, maxMeshTriangles, maxMeshBytes } from '../server/mesh-validation.mjs';
import { acceptOrSimplify, surfaceLevelHint, makeBlenderSimplify } from '../server/mesh-salvage.mjs';

// index-count GLB builder (the validator reads the JSON chunk only): triangles = count/3
function glb(indexCount, padBytes = 0) {
  let json = Buffer.from(JSON.stringify({ meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], accessors: [{ count: 3 }, { count: indexCount }] }));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const len = 20 + json.length + padBytes;
  const header = Buffer.alloc(20);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(len, 8); header.writeUInt32LE(json.length, 12); header.write('JSON', 16);
  return Buffer.concat([header, json, Buffer.alloc(padBytes, 32)]);
}
function glbEmpty() {
  let json = Buffer.from(JSON.stringify({ meshes: [] }));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + json.length, 8); header.writeUInt32LE(json.length, 12); header.write('JSON', 16);
  return Buffer.concat([header, json]);
}
const OVER = glb((maxMeshTriangles + 1) * 3);      // 2 500 001 triangles
const SMALL = glb(300);
const FAT = () => glb((maxMeshTriangles + 1) * 3, maxMeshBytes); // also > 100 MB

test('the oversize failure is typed and carries the triangle count (ticket 34)', () => {
  try { validateGeneratedMesh(OVER); assert.fail('must throw'); }
  catch (e) { assert.equal(e.code, 'oversize'); assert.equal(e.triangles, maxMeshTriangles + 1); }
  assert.equal(validateGeneratedMesh(SMALL).triangles, 100);
});

test('the 100 MB byte gate is typed too, so salvage can reach it', () => {
  const fat = FAT();
  assert.ok(fat.length > maxMeshBytes);
  try { validateGeneratedMesh(fat); assert.fail('must throw'); }
  catch (e) { assert.equal(e.code, 'oversize-bytes'); }
});

test('surface-level hint only fires at the ±1 edge', () => {
  assert.match(surfaceLevelHint(1), /back to 0/);
  assert.match(surfaceLevelHint(-1), /back to 0/);
  assert.equal(surfaceLevelHint(0), '');
  assert.equal(surfaceLevelHint(undefined), '');
});

test('an over-cap mesh with a working simplify completes with simplifiedFrom', async () => {
  const { validation, simplifiedBuffer } = await acceptOrSimplify(OVER, { meshLevel: 0, simplify: async () => SMALL });
  assert.equal(validation.triangles, 100);
  assert.equal(validation.simplifiedFrom, maxMeshTriangles + 1);
  assert.ok(Buffer.isBuffer(simplifiedBuffer));
});

test('a >100 MB mesh is simplified to the byte limit as well (attribute-splitting case)', async () => {
  const { validation } = await acceptOrSimplify(FAT(), { meshLevel: 0, simplify: async () => SMALL });
  assert.equal(validation.triangles, 100);
  assert.equal(validation.simplifiedFrom, undefined); // byte-gated failure has no triangle count to name
});

test('simplify that cannot reach the cap returns the ORIGINAL honest error', async () => {
  await assert.rejects(
    acceptOrSimplify(OVER, { simplify: async () => OVER }),
    (e) => e.code === 'oversize' && /2\.5 million/.test(e.message));
  await assert.rejects(acceptOrSimplify(OVER, { simplify: async () => { throw new Error('blender died'); } }),
    (e) => e.code === 'oversize');
});

test('without a simplify hook (or oversize alone at the edge) the message suggests 0', async () => {
  await assert.rejects(acceptOrSimplify(OVER, { meshLevel: 1 }), (e) => /2\.5 million/.test(e.message) && /back to 0/.test(e.message));
  await assert.rejects(acceptOrSimplify(glbEmpty(), { meshLevel: -1 }), (e) => /empty mesh/.test(e.message) && /back to 0/.test(e.message));
  await assert.rejects(acceptOrSimplify(glbEmpty(), { meshLevel: 0 }), (e) => !/back to 0/.test(e.message));
});

test('non-oversize structural failures never route through salvage', async () => {
  await assert.rejects(acceptOrSimplify(Buffer.from('bad'), { simplify: async () => SMALL }), /GLB/);
});

test('makeBlenderSimplify calls the branch cleanup step with ONLY the decimate knob set', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'salvage-test-'));
  let seen = null;
  const stub = async (o) => {
    seen = o;
    assert.equal(await fs.readFile(o.request.inputs.mesh).then((b) => b.length), OVER.length); // input landed
    await fs.mkdir(o.request.out_dir, { recursive: true });
    await fs.writeFile(path.join(o.request.out_dir, 'clean.glb'), SMALL);
    return { result: {} };
  };
  const out = await makeBlenderSimplify({ runStep: stub, root })(OVER);
  assert.deepEqual(out, SMALL);
  assert.equal(seen.step, 'cleanup');
  const p = seen.request.params;
  assert.equal(p.target_tris, maxMeshTriangles);
  assert.equal(p.ground, false); assert.equal(p.center, false); assert.equal(p.preview, false);
  assert.equal(p.merge_distance, 0); assert.equal(p.recalc_normals, false); assert.equal(p.shade_auto_smooth_deg, null);
  assert.deepEqual(await fs.readdir(root), []); // every temp dir is cleaned up
  await fs.rm(root, { recursive: true, force: true });
});

test('makeBlenderSimplify halves the budget when pass 1 still misses a cap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'salvage-test-'));
  const targets = [];
  const stub = async (o) => {
    targets.push(o.request.params.target_tris);
    await fs.mkdir(o.request.out_dir, { recursive: true });
    await fs.writeFile(path.join(o.request.out_dir, 'clean.glb'), targets.length === 1 ? OVER : SMALL);
    return { result: {} };
  };
  const out = await makeBlenderSimplify({ runStep: stub, root })(OVER);
  assert.deepEqual(out, SMALL);
  assert.deepEqual(targets, [maxMeshTriangles, Math.floor(maxMeshTriangles / 2)]);
  assert.deepEqual(await fs.readdir(root), []);
  await fs.rm(root, { recursive: true, force: true });
});

test('makeBlenderSimplify reports failure without leaving the temp dir behind', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'salvage-test-'));
  await assert.rejects(makeBlenderSimplify({ runStep: async () => ({}), root })(OVER));
  assert.deepEqual(await fs.readdir(root), []);
  await fs.rm(root, { recursive: true, force: true });
});

// Source pins: every job completion that produces a .glb goes through the salvage-aware path.
test('jobs.mjs completion sites are salvage-aware', async () => {
  const src = await fs.readFile(new URL('../server/jobs.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/validateGlbAsset\(/g) || []).length, 5); // helper + pixal3d + triposg + hunyuan + validateJobMesh
  assert.ok(!/validateGeneratedMesh\(result\.buffer\)/.test(src));
  assert.ok(/if\(e\.code!=='oversize'\)throw e;/.test(src)); // downloadOutput keeps oversize on disk
  const pr = await fs.readFile(new URL('../server/pixal3d-run.mjs', import.meta.url), 'utf8');
  assert.equal((pr.match(/e\.code !== 'oversize'/g) || []).length, 2);
});
