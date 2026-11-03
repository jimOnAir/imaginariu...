// The Sculpt tab: vertex welding, the OBJ for SculptGL, the shape back onto the source mesh
// (src/sculpt-core.js) and StudioScene.sculptExport/sculptApply (src/sculpt-tools.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import { weldMesh, objFromParts, parseObj, applyWelded, changedPoints, dirtyVertices, creaseNormals, maxDisplacement } from '../src/sculpt-core.js';
import { installSculptTools } from '../src/sculpt-tools.js';

const boxGeo = () => new T.BoxGeometry(2, 2, 2);   // 24 vertices (4 per face), 8 unique positions
const arr = (geo) => Float32Array.from(geo.attributes.position.array);
// an OBJ with vertices only (as after a sculpt: faces are not needed to return the shape)
const vertsObj = (parts) => parts.map((p) => 'o ' + p.name + '\n' + Array.from({ length: p.positions.length / 3 }, (_, i) => 'v ' + [...p.positions.slice(i * 3, i * 3 + 3)].join(' ')).join('\n')).join('\n') + '\n';

test('weldMesh welds the split vertices of a cube: 24 -> 8, 12 triangles, map points at the shared points', () => {
  const geo = boxGeo(), w = weldMesh(arr(geo), geo.index.array);
  assert.equal(w.count, 8);
  assert.equal(w.faces.length / 3, 12);
  assert.equal(w.dropped, 0);
  const pos = arr(geo);
  for (let i = 0; i < 24; i++) {
    assert.ok(w.map[i] >= 0);
    assert.deepEqual([...w.welded.slice(w.map[i] * 3, w.map[i] * 3 + 3)], [...pos.slice(i * 3, i * 3 + 3)]);
  }
});

test('weldMesh: sphere poles (16 copies of one vertex) weld into a single point', () => {
  const geo = new T.SphereGeometry(1, 16, 8), w = weldMesh(arr(geo), geo.index.array);
  assert.equal(w.dropped, 0);
  assert.equal(w.count, 16 * (8 - 1) + 2, 'a 16x8 grid: seam-free rings and two poles');
  assert.equal(w.map.filter((x) => x < 0).length, 0);
});

test('weldMesh: a degenerate triangle is dropped, a vertex without faces stays out of the mesh (map -1)', () => {
  const pos = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5]);
  const w = weldMesh(pos, Uint32Array.from([0, 1, 2, 0, 0, 1]));
  assert.equal(w.count, 3);
  assert.equal(w.dropped, 1);
  assert.equal(w.map[3], -1);
});

test('OBJ round trip: objFromParts -> parseObj keeps groups, vertex counts and positions', () => {
  const a = boxGeo(), b = new T.SphereGeometry(1, 8, 6);
  const wa = weldMesh(arr(a), a.index.array), wb = weldMesh(arr(b), b.index.array);
  const text = objFromParts([{ name: 'Hull left', welded: wa.welded, faces: wa.faces }, { name: 'Ball', welded: wb.welded, faces: wb.faces }]);
  const parsed = parseObj(text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, 'Hull_left');
  assert.equal(parsed[0].positions.length / 3, wa.count);
  assert.equal(parsed[1].positions.length / 3, wb.count);
  assert.equal(parsed[0].faces, 12);
  for (let i = 0; i < wa.welded.length; i++) assert.ok(Math.abs(parsed[0].positions[i] - wa.welded[i]) < 1e-6);
  // faces of the second part are numbered globally, as in a normal OBJ
  assert.match(text, new RegExp('\\nf ' + (wa.count + 1) + ' '));
});

test('applyWelded: moving a welded point moves all its copies, untouched vertices stay bit-for-bit identical', () => {
  const geo = boxGeo(), pos = arr(geo), w = weldMesh(pos, geo.index.array);
  const moved = Float32Array.from(w.welded);
  moved[0] += 0.5;   // one welded point
  const out = applyWelded(pos, w.map, moved, w.welded, 1e-6);
  let changed = 0;
  for (let i = 0; i < 24; i++) {
    const same = out[i * 3] === pos[i * 3] && out[i * 3 + 1] === pos[i * 3 + 1] && out[i * 3 + 2] === pos[i * 3 + 2];
    if (w.map[i] === 0) { assert.ok(!same); assert.equal(out[i * 3], pos[i * 3] + 0.5); changed++; } else assert.ok(same);
  }
  assert.equal(changed, 3, 'a cube corner consists of three vertices');
  assert.equal(maxDisplacement(pos, out), 0.5);
  // OBJ/float rounding noise smaller than eps: nothing moves
  const noisy = Float32Array.from(w.welded, (v) => v + 1e-7);
  assert.equal(maxDisplacement(pos, applyWelded(pos, w.map, noisy, w.welded, 1e-5)), 0);
});

test('creaseNormals: hard cube edges stay hard, the seam of a smooth sphere stays smooth', () => {
  const box = boxGeo(), bp = arr(box), bw = weldMesh(bp, box.index.array), bn = creaseNormals(bp, box.index.array, bw.map);
  for (let i = 0; i < 24; i++) assert.ok(Math.abs(bn[i * 3] * box.attributes.normal.array[i * 3] + bn[i * 3 + 1] * box.attributes.normal.array[i * 3 + 1] + bn[i * 3 + 2] * box.attributes.normal.array[i * 3 + 2] - 1) < 1e-5, 'the face normal of the cube is not blurred');
  const sphere = new T.SphereGeometry(1, 24, 16), sp = arr(sphere), sw = weldMesh(sp, sphere.index.array), sn = creaseNormals(sp, sphere.index.array, sw.map);
  // the u=0/u=1 seam: two copies of one point get one outward normal
  const seam = [];
  for (let i = 0; i < sw.map.length; i++) if (Math.abs(sp[i * 3 + 2]) < 1e-6 && sp[i * 3] > 0.5 && Math.abs(sp[i * 3 + 1]) > 0.3 && sw.map[i] >= 0) seam.push(i);
  assert.ok(seam.length >= 2);
  for (const i of seam) {
    const len = Math.hypot(sp[i * 3], sp[i * 3 + 1], sp[i * 3 + 2]);
    assert.ok((sn[i * 3] * sp[i * 3] + sn[i * 3 + 1] * sp[i * 3 + 1] + sn[i * 3 + 2] * sp[i * 3 + 2]) / len > 0.97, 'the normal on the seam points outward');
  }
});

test('changedPoints and dirtyVertices: normals are recomputed only around the edit', () => {
  const geo = new T.SphereGeometry(1, 16, 12), pos = arr(geo), w = weldMesh(pos, geo.index.array);
  const moved = Float32Array.from(w.welded);
  moved[3 * 20] += 0.3;
  const mp = changedPoints(moved, w.welded, 1e-5), dirty = dirtyVertices(w.map, geo.index.array, mp);
  assert.equal(mp.reduce((n, x) => n + x, 0), 1);
  const n = dirty.reduce((a, x) => a + x, 0);
  assert.ok(n > 0 && n < pos.length / 3 / 4, 'a small neighborhood is touched, not the whole mesh: ' + n);
});

// ---- StudioScene.sculptExport / sculptApply on a stub scene ----
class FakeStudio {
  constructor() { this.content = new T.Group(); this.selected = null; this.editor = { tracks: {}, bases: {} }; this.mixers = []; this.box = { setFromObject() {} }; this.checkpoints = 0; }
  checkpoint() { this.checkpoints++; }
  emit() {}
  select(id) { this.selected = this.content.getObjectByProperty('uuid', id) || null; }
}
installSculptTools(FakeStudio);
const material = () => new T.MeshStandardMaterial({ color: '#99aabb', map: new T.Texture() });
function scene() {
  const s = new FakeStudio(), g = new T.Group();
  g.name = 'Ship'; g.position.set(1, 2, 3); g.rotation.y = 0.7; g.scale.setScalar(2);
  const hull = new T.Mesh(new T.SphereGeometry(1, 24, 16), material()); hull.name = 'Hull'; hull.position.set(0, 0.5, 0); hull.scale.set(0.6, 0.4, 1.4);
  const wing = new T.Mesh(boxGeo(), material()); wing.name = 'Wing'; wing.position.set(1.5, 0, 0);
  g.add(hull, wing); s.content.add(g); g.updateMatrixWorld(true); s.select(g.uuid);
  return { s, g, hull, wing };
}
const dump = (geo) => Float32Array.from(geo.attributes.position.array);

test('sculptExport: a welded mesh in the object coordinate system, the session is remembered', () => {
  const { s, g } = scene(), out = s.sculptExport();
  assert.equal(out.name, 'Ship');
  assert.equal(out.parts, 2);
  assert.equal(out.rigged, false);
  const parsed = parseObj(out.text);
  assert.equal(parsed.length, 2);
  // positions are in the root system: the wing sits at (1.5, 0, 0) without the ship position and rotation
  const wing = parsed[1].positions, xs = [...wing].filter((_, i) => i % 3 === 0);
  assert.ok(Math.min(...xs) > 0.4 && Math.max(...xs) < 2.6, 'wing x in the root system: ' + Math.min(...xs) + '..' + Math.max(...xs));
  assert.equal(s.sculptSession.rootId, g.uuid);
});

test('sculptApply: with no edits the geometry does not change by a single bit', () => {
  const { s, hull, wing } = scene(), before = [dump(hull.geometry), dump(wing.geometry)], nBefore = Float32Array.from(hull.geometry.attributes.normal.array);
  const res = s.sculptApply(s.sculptExport().text);
  assert.equal(res.mode, 'in-place');
  assert.equal(res.moved, 0);
  assert.deepEqual(dump(hull.geometry), before[0]);
  assert.deepEqual(dump(wing.geometry), before[1]);
  assert.deepEqual(Float32Array.from(hull.geometry.attributes.normal.array), nBefore);
});

test('sculptApply: editing a welded point moves both copies on the seam, UV and material stay, normals change locally', () => {
  const { s, hull } = scene(), out = s.sculptExport(), parsed = parseObj(out.text);
  const uvBefore = Float32Array.from(hull.geometry.attributes.uv.array), material0 = hull.material, nBefore = Float32Array.from(hull.geometry.attributes.normal.array);
  // pull outward the welded point on the sphere seam (x minimal, z near 0: u=0 and u=1 are two copies of one vertex)
  const pts = parsed[0].positions;
  let pick = -1;
  for (let i = 0; i < pts.length / 3; i++) if (Math.abs(pts[i * 3 + 2]) < 1e-3 && (pick < 0 || pts[i * 3] < pts[pick * 3])) pick = i;
  pts[pick * 3] -= 0.2;
  const edited = vertsObj(parsed);
  const res = s.sculptApply(edited);
  assert.equal(res.mode, 'in-place');
  assert.ok(res.moved > 0);
  assert.equal(res.points, 1);
  assert.equal(hull.material, material0, 'the same material');
  assert.deepEqual(Float32Array.from(hull.geometry.attributes.uv.array), uvBefore, 'UV untouched');
  const after = dump(hull.geometry), before = dump(scene().hull.geometry);
  let dup = 0;
  for (let i = 0; i < after.length / 3; i++) if (after[i * 3] !== before[i * 3] || after[i * 3 + 1] !== before[i * 3 + 1] || after[i * 3 + 2] !== before[i * 3 + 2]) dup++;
  assert.equal(dup, 2, 'both copies of the seam vertex moved, and only they');
  const nAfter = Float32Array.from(hull.geometry.attributes.normal.array);
  let nChanged = 0;
  for (let i = 0; i < nAfter.length; i++) if (nAfter[i] !== nBefore[i]) nChanged++;
  assert.ok(nChanged > 0 && nChanged < nAfter.length / 4, 'normals changed locally: ' + nChanged + ' of ' + nAfter.length);
  assert.equal(s.sculptSession.parts[0].base[pick * 3], pts[pick * 3], 'after returning, the next comparison runs against the new sculpt state');
});

test('sculptApply: the vertex count changed -> the object is replaced with a new one, same name and transform', () => {
  const { s, g } = scene(), out = s.sculptExport(), parsed = parseObj(out.text);
  const wide = objFromParts([{ name: 'a', welded: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), faces: Uint32Array.from([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]) }]);
  assert.equal(parsed.length, 2);
  const res = s.sculptApply(wide);
  assert.equal(res.mode, 'replace');
  assert.equal(res.name, 'Ship');
  assert.equal(res.uvLost, true, 'the new mesh has no UV, the material maps were dropped');
  assert.equal(s.content.children.length, 1);
  const made = s.content.children[0];
  assert.notEqual(made.uuid, g.uuid);
  assert.deepEqual(made.position.toArray(), g.position.toArray());
  assert.equal(made.scale.x, 2);
  assert.equal(s.selected, made);
  assert.equal(s.sculptSession, null);
});

test('sculptApply: a rigged object survives a topology change, the sculpt is added next to it without the rig', () => {
  const { s, g, hull } = scene();
  const bone = new T.Bone(); g.add(bone);
  const skinned = new T.SkinnedMesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial());
  skinned.name = 'Body'; skinned.geometry.setAttribute('skinIndex', new T.Uint16BufferAttribute(new Array(24 * 4).fill(0), 4)); skinned.geometry.setAttribute('skinWeight', new T.Float32BufferAttribute(new Array(24 * 4).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  g.add(skinned); skinned.bind(new T.Skeleton([bone])); g.updateMatrixWorld(true);
  const out = s.sculptExport();
  assert.equal(out.rigged, true);
  const res = s.sculptApply(objFromParts([{ name: 'x', welded: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), faces: Uint32Array.from([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]) }]));
  assert.equal(res.mode, 'new');
  assert.equal(res.rigged, true);
  assert.equal(s.content.children.length, 2);
  assert.ok(s.content.children.includes(g), 'the original stayed');
  assert.equal(s.content.children[1].name, 'Ship sculpt');
  assert.ok(hull.parent === g);
});

test('a rigged model on the same mesh: bone weights stay, the shape changes', () => {
  const s = new FakeStudio(), g = new T.Group(), bone = new T.Bone(), geo = new T.SphereGeometry(1, 12, 8);
  geo.setAttribute('skinIndex', new T.Uint16BufferAttribute(new Array(geo.attributes.position.count * 4).fill(0), 4));
  geo.setAttribute('skinWeight', new T.Float32BufferAttribute(new Array(geo.attributes.position.count * 4).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  const mesh = new T.SkinnedMesh(geo, new T.MeshStandardMaterial()); mesh.name = 'Body'; g.name = 'Hero'; g.add(bone, mesh); mesh.bind(new T.Skeleton([bone]));
  s.content.add(g); g.updateMatrixWorld(true); s.select(g.uuid);
  const weights = Float32Array.from(geo.attributes.skinWeight.array), out = s.sculptExport();
  assert.equal(out.rigged, true);
  const parsed = parseObj(out.text);
  parsed[0].positions[0] += 0.4;
  const text = vertsObj([{ name: 'Body', positions: parsed[0].positions }]);
  const res = s.sculptApply(text);
  assert.equal(res.mode, 'in-place');
  assert.deepEqual(Float32Array.from(mesh.geometry.attributes.skinWeight.array), weights);
  assert.ok(mesh.isSkinnedMesh && s.content.children[0] === g);
});

test('sculptExport: nothing selected and no single object - a plain error; a bone cannot be selected', () => {
  const s = new FakeStudio();
  s.content.add(new T.Group(), new T.Group());
  assert.throws(() => s.sculptExport(), /Select a model/);
  const bone = new T.Bone(); s.content.add(bone); s.selected = bone;
  assert.throws(() => s.sculptExport(), /bone/);
});
