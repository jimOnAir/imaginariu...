// The NATTEN wheel matrix and the GPU kernel probe (0.6.x wave ticket 11): selection is keyed by
// (torch, CUDA, compute capability) - the older-card branch is proven here through the seam, no
// GTX needs to die for it. The forward pass itself needs real hardware and is demonstrated live
// on the 5070 (evidence on the ticket); readEnv is tested against a scripted spawner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseWheel, pickNatten, readEnv, probe } from '../installer/pixal3d/af_natten_probe.mjs';

const MAN = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'installer', 'pixal3d', 'manifest.json'), 'utf8'));
const MATRIX = MAN.linux.nattenMatrix.map((r) => ({ ...r, ...MAN.linux.natten }));

test('parseWheel: the release-asset name carries torch, CUDA, python and arch', () => {
  assert.deepEqual(parseWheel('natten-0.21.5+torch290cu128-cp312-cp312-linux_x86_64.whl'), { version: '0.21.5', torch: '2.9', cuda: 12.8, py: 'cp312', arch: 'linux_x86_64' });
  assert.deepEqual(parseWheel('natten-0.21.5%2Btorch2100cu126-cp311-cp311-linux_aarch64.whl'), { version: '0.21.5', torch: '2.10', cuda: 12.6, py: 'cp311', arch: 'linux_aarch64' });
  assert.equal(parseWheel('cumesh-1.0-cp312-cp312-linux_x86_64.whl'), null);
  assert.equal(parseWheel('natten-0.21.5-cp312-cp312-win_amd64.whl'), null, 'Windows wheels are not this matrix');
});

test('pickNatten: the live-verified row covers this branch\'s stack from Turing to Blackwell', () => {
  for (const cc of [7.5, 8.6, 8.9, 9.0, 12.0]) {
    const p = pickNatten({ cc, torch: '2.9.1', cuda: 12.8, matrix: MATRIX });
    assert.equal(p.verdict, 'row', 'cc ' + cc);
    assert.equal(p.wheel.file, MAN.linux.natten.file, 'cc ' + cc);
  }
});

test('pickNatten: Blackwell refuses a CUDA-12.6-era build (the 0.6.4 "no kernel image" class)', () => {
  const m = [...MATRIX, { id: 'torch290cu126', torch: '2.9', cuda: 12.6, py: ['cp312'], file: 'a.whl' }];
  const p = pickNatten({ cc: 12.0, torch: '2.9', cuda: 12.6, matrix: m });
  assert.equal(p.verdict, 'no-row');
  assert.match(p.reason, /CUDA 12\.8/);
  assert.equal(p.wheel.file, MAN.linux.natten.file, 'degrade = keep the pinned wheel, never a wrong one');
  const g = pickNatten({ cc: 12.0, torch: '2.9', cuda: 12.9, matrix: [{ id: 'cu126row', torch: '2.9', cuda: 12.6, py: ['cp312'], file: 'a.whl' }] });
  assert.equal(g.verdict, 'no-row');
  assert.match(g.reason, /Blackwell/, 'a matching-but-old row is still refused on sm_120');
});

test('pickNatten: pre-Turing cards get the honest lighter recommendation, not a wheel', () => {
  for (const cc of [6.1, 7.0]) {
    const p = pickNatten({ cc, torch: '2.9', cuda: 12.8, matrix: MATRIX });
    assert.equal(p.verdict, 'lite-recommendation', 'cc ' + cc);
    assert.equal(p.wheel, null);
    assert.match(p.reason, /no NATTEN kernels|lighter set/);
  }
});

test('pickNatten: unknown GPU, unknown torch, and rows for another torch all degrade loudly, not silently', () => {
  assert.equal(pickNatten({ cc: null, torch: '2.9', cuda: 12.8, matrix: MATRIX }).verdict, 'unknown-gpu');
  assert.match(pickNatten({ cc: null, torch: '2.9', cuda: 12.8, matrix: MATRIX }).reason, /pinned wheel/);
  assert.equal(pickNatten({ cc: 8.6, torch: null, cuda: 12.8, matrix: MATRIX }).verdict, 'unknown-torch');
  const p = pickNatten({ cc: 8.6, torch: '2.8', cuda: 12.8, matrix: MATRIX });
  assert.equal(p.verdict, 'no-row');
  assert.match(p.reason, /no NATTEN wheel row for torch 2\.8/);
});

test('readEnv: parses the venv\'s one-line JSON past import chatter; a silent death reports its exit code, a missing python stays null', () => {
  const spawnFn = (py, args) => ({ status: 0, stdout: 'Welcome to torch...\nwarmup done\n' + JSON.stringify({ torch: '2.9.1', cuda: 12.8, cc: '12.0', forward: true }) + '\n' });
  assert.deepEqual(readEnv('/venv/bin/python', { forward: true, spawnFn }), { torch: '2.9.1', cuda: 12.8, cc: '12.0', forward: true });
  // ticket 23: garbage on stdout now carries the exit code of the death, not nothing
  assert.deepEqual(readEnv('/venv/bin/python', { spawnFn: () => ({ status: 137, stdout: 'Killed\n', stderr: '' }) }),
    { probeFailed: true, exitCode: 137, signal: null, stderr: '' });
  const boom = () => { throw new Error('python missing'); };
  assert.equal(readEnv('/venv/bin/python', { spawnFn: boom }), null, 'no python at all is still a plain null');
});

test('a probe that dies silently names the exit code and the 570 driver floor in its reason', async () => {
  const r = await probe('/venv', { spawnFn: () => ({ status: 139, signal: 'SIGSEGV', stdout: 'chatter', stderr: 'segfault tail' }), env: {} });
  assert.equal(r.verdict, 'probe-failed');
  assert.match(r.reason, /python probe died without answering \(exit 139, signal SIGSEGV\)/);
  assert.match(r.reason, /keeping the pinned wheel/);
  assert.match(r.reason, /NVIDIA driver below 570/);
});
