// Ticket 46 (0.7.9 performance wave): imaginarium-mesh-rs is the salvage fast path — the spawn helper
// and the chain must be provable WITHOUT the binary, exactly like the Blender lane is provable
// without Blender. A fake spawnImpl answers runAfMesh; a fake run answers the salvage maker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afMeshConfig, afMeshInfo, runAfMesh } from '../server/imaginarium-mesh.mjs';
import { makeAfMeshSimplify, makeSalvageSimplify } from '../server/mesh-salvage.mjs';
import { maxMeshTriangles } from '../server/mesh-validation.mjs';

// A validator-shaped GLB assembled with an explicit binary layout: a 20-byte header, one JSON
// chunk padded to 4 (0x20), no BIN — the validator reads the JSON chunk only, and the fixture
// needs nothing more. Offsets are named so the layout reads as documentation, not magic.
function glb(indexCount) {
  const body = Buffer.from(JSON.stringify({
    asset: { version: '2.0' },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { count: 3, type: 'VEC3', componentType: 5126 },
      { count: indexCount, type: 'SCALAR', componentType: 5125 },
    ],
  }));
  const chunkLen = (body.length + 3) & ~3;
  const out = Buffer.alloc(20 + chunkLen);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0x46546c67, true); // 'glTF' magic, little-endian
  view.setUint32(4, 2, true); // glTF 2
  view.setUint32(8, out.length, true); // whole file
  view.setUint32(12, chunkLen, true); // JSON chunk
  view.setUint32(16, 0x4e4f534a, true); // 'JSON' chunk type
  body.copy(out, 20);
  out.fill(0x20, 20 + body.length); // the JSON chunk pads with spaces
  return out;
}
const OVER = glb(maxMeshTriangles * 3 + 3);
const SMALL = glb(300);

function fakeChild({ code = 0, stdout = '', stderr = '', error = null, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.killed = false;
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); };
  if (error) { setImmediate(() => child.emit('error', error)); return child; }
  if (hang) return child;
  setImmediate(() => {
    if (stdout) child.stdout.push(Buffer.from(stdout));
    if (stderr) child.stderr.push(Buffer.from(stderr));
    child.stdout.push(null); child.stderr.push(null);
  });
  setTimeout(() => child.emit('close', code), 10);
  return child;
}

test('afMeshConfig: IMAGINARIUM_AF_MESH, then paths.json afMesh, then the in-repo build', async () => {
  const appRoot = path.join(os.tmpdir(), 'imaginarium-mesh-lane-' + randomUUID());
  await fs.mkdir(path.join(appRoot, 'config'), { recursive: true });
  const env = { ...process.env };
  delete env.IMAGINARIUM_AF_MESH;
  const def = afMeshConfig({ env, appRoot });
  assert.equal(def.source, 'default');
  assert.equal(def.found, false, 'a scratch appRoot has no build');

  await fs.writeFile(path.join(appRoot, 'config', 'paths.json'), JSON.stringify({ afMesh: process.execPath }));
  const fromCfg = afMeshConfig({ env, appRoot });
  assert.equal(fromCfg.source, 'paths.json');
  assert.equal(fromCfg.exe, process.execPath);
  assert.equal(fromCfg.found, true);

  const forced = afMeshConfig({ env: { ...env, IMAGINARIUM_AF_MESH: '/nowhere/imaginarium-mesh-rs' }, appRoot });
  assert.equal(forced.source, 'env');
  assert.equal(forced.found, false, 'an explicit path that is not there is reported honestly');
  await fs.rm(appRoot, { recursive: true, force: true });
});

test('runAfMesh: streams and exit code are collected, argv is passed through', async () => {
  let seen = null;
  const r = await runAfMesh({
    exe: '/fake/imaginarium-mesh-rs', args: ['simplify', '--in', 'a.glb'], timeoutMs: 1000,
    spawnImpl: (exe, args) => { seen = { exe, args }; return fakeChild({ code: 0, stdout: '{"ok":true}', stderr: 'note' }); },
  });
  assert.equal(seen.exe, '/fake/imaginarium-mesh-rs');
  assert.deepEqual(seen.args, ['simplify', '--in', 'a.glb']);
  assert.deepEqual(r, { code: 0, stdout: '{"ok":true}', stderr: 'note', timedOut: false });
});

test('runAfMesh: a wedged run is SIGKILLed at the timeout and reported, never left hanging', async () => {
  let kid = null;
  const t = Date.now();
  const r = await runAfMesh({ exe: '/fake', args: ['simplify'], timeoutMs: 300, spawnImpl: () => (kid = fakeChild({ hang: true })) });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, -1);
  assert.equal(kid.killed, true, 'the timeout actually kills the child');
  assert.ok(Date.now() - t >= 250);
});

test('runAfMesh: a missing binary resolves, it never rejects', async () => {
  const thrown = await runAfMesh({ exe: '/nowhere', args: [], spawnImpl: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });
  assert.equal(thrown.code, -1);
  assert.match(thrown.stderr, /ENOENT/);
  const er = await runAfMesh({ exe: '/fake', args: [], spawnImpl: () => fakeChild({ error: new Error('spawn failed') }) });
  assert.equal(er.code, -1);
});

test('afMeshInfo: the --version --json handshake, name-checked', async () => {
  assert.equal(await afMeshInfo({ cfg: { found: false } }), null, 'absent binary: no spawn at all');
  const ok = await afMeshInfo({ cfg: { found: true, exe: '/fake' }, run: async () => ({ code: 0, stdout: '{"name":"imaginarium-mesh-rs","version":"0.7.9"}' }) });
  assert.equal(ok.version, '0.7.9');
  assert.equal(await afMeshInfo({ cfg: { found: true, exe: '/fake' }, run: async () => ({ code: 0, stdout: '{"name":"something-else"}' }) }), null);
  assert.equal(await afMeshInfo({ cfg: { found: true, exe: '/fake' }, run: async () => ({ code: 1, stdout: '' }) }), null);
});

test('makeAfMeshSimplify: absent binary answers null without spawning (the ticket-30 posture)', async () => {
  const f = makeAfMeshSimplify({ cfg: { found: false }, run: async () => { throw new Error('must not spawn'); } });
  assert.equal(await f(OVER), null);
});

test('makeAfMeshSimplify: the spawn shape, the summary gate, the budget halving', async () => {
  const root = path.join(os.tmpdir(), 'imaginarium-mesh-lane-' + randomUUID());
  const calls = [];
  const run = async ({ exe, args }) => {
    calls.push({ exe, args });
    const dst = args[args.indexOf('--out') + 1];
    if (calls.length === 1) { await fs.writeFile(dst, OVER); return { code: 0, stdout: JSON.stringify({ trianglesBefore: maxMeshTriangles + 1, trianglesAfter: maxMeshTriangles + 1 }) }; }
    await fs.writeFile(dst, SMALL);
    return { code: 0, stdout: JSON.stringify({ trianglesBefore: maxMeshTriangles + 1, trianglesAfter: 100 }), stderr: '' };
  };
  const f = makeAfMeshSimplify({ root, cfg: { found: true, exe: '/fake/imaginarium-mesh-rs' }, run });
  // first pass declines (after >= before): the fast path bows out for the Blender fallback
  assert.equal(await f(OVER), null, 'a declined summary is not a success');
  calls.length = 0;
  const run2 = async ({ exe, args }) => {
    calls.push(args);
    const dst = args[args.indexOf('--out') + 1];
    if (calls.length === 1) { await fs.writeFile(dst, OVER); return { code: 0, stdout: JSON.stringify({ trianglesBefore: maxMeshTriangles + 1, trianglesAfter: maxMeshTriangles - 10 }) }; }
    await fs.writeFile(dst, SMALL);
    return { code: 0, stdout: JSON.stringify({ trianglesBefore: maxMeshTriangles + 1, trianglesAfter: 100 }) };
  };
  const g = makeAfMeshSimplify({ root, cfg: { found: true, exe: '/fake/imaginarium-mesh-rs' }, run: run2 });
  const out = await g(OVER);
  assert.ok(out && out.equals(SMALL), 'the second pass (halved budget) comes back');
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'simplify');
  assert.ok(calls[0].includes('--tris') && calls[0][calls[0].indexOf('--tris') + 1] === String(maxMeshTriangles));
  assert.ok(calls[0].includes('--json'));
  assert.ok(calls[0].includes('--in') && calls[0].includes('--out'));
  assert.equal(calls[1][calls[1].indexOf('--tris') + 1], String(Math.floor(maxMeshTriangles / 2)), 'the byte-gate halving survives into the fast path');
  const entries = await fs.readdir(root).catch(() => []);
  assert.deepEqual(entries, [], 'the temp workdir is cleaned up');
  await fs.rm(root, { recursive: true, force: true });
});

test('makeAfMeshSimplify: a refusal exit and unreadable summaries answer null', async () => {
  const root = path.join(os.tmpdir(), 'imaginarium-mesh-lane-' + randomUUID());
  assert.equal(await makeAfMeshSimplify({ root, cfg: { found: true, exe: '/fake' }, run: async () => ({ code: 1, stderr: 'refused' }) })(OVER), null);
  assert.equal(await makeAfMeshSimplify({ root, cfg: { found: true, exe: '/fake' }, run: async () => ({ code: 0, stdout: 'not json' }) })(OVER), null);
  assert.equal(await makeAfMeshSimplify({ root, cfg: { found: true, exe: '/fake' }, run: async () => { throw new Error('spawn exploded'); } })(OVER), null);
  await fs.rm(root, { recursive: true, force: true });
});

test('makeSalvageSimplify: imaginarium-mesh first, Blender as the fallback, IMAGINARIUM_SALVAGE forces Blender', async () => {
  let afCalls = 0, blCalls = 0;
  const afOk = () => async () => { afCalls++; return SMALL; };
  const afNo = () => async () => { afCalls++; return null; };
  const afBad = () => async () => { afCalls++; return OVER; }; // reduced but still over a cap
  const bl = () => async (b) => { blCalls++; return SMALL; };

  const chain1 = makeSalvageSimplify({ env: {}, makeAfMesh: afOk, makeBlender: bl });
  assert.ok((await chain1(OVER)).equals(SMALL));
  assert.equal(blCalls, 0, 'the fast path result stands, Blender never wakes up');

  const chain2 = makeSalvageSimplify({ env: {}, makeAfMesh: afNo, makeBlender: bl });
  await chain2(OVER);
  assert.equal(blCalls, 1, 'a declined fast path falls through to the Blender route');

  const chain3 = makeSalvageSimplify({ env: {}, makeAfMesh: afBad, makeBlender: bl });
  await chain3(OVER);
  assert.equal(blCalls, 2, 'reduced-but-still-oversize falls through too');

  let afBuilt = false;
  const chain4 = makeSalvageSimplify({ env: { IMAGINARIUM_SALVAGE: 'blender' }, makeAfMesh: () => { afBuilt = true; throw new Error('must not build'); }, makeBlender: bl });
  await chain4(OVER);
  assert.equal(afBuilt, false, 'IMAGINARIUM_SALVAGE=blender is the forced route — the fast path is not even constructed');
  assert.equal(blCalls, 3, 'the forced route is the Blender path');
});
