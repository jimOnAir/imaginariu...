// venv self-repair (0.6.10 wave ticket 25). Everything real: scratch venvs built with the very
// uv the branch's installer uses and the branch's bundled CPython where available, otherwise any
// python3 uv can find. The failure classes are produced on disk the way they happen (rm the entry,
// point the symlink at a deleted interpreter), never simulated by a stub - the point of the module
// is that a stat-passing spawn still dies.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync, unlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  checkVenv, linkTarget, pythonFailText, repairStudioVenvs, studioVenvs, venvCfgFile, venvPythonPath, venvSpawnFailText,
} from '../server/venv-health.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'imaginarium-venvh-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// the uv + base python the real installs use, with honest skips when a dev box has neither
const uvCandidates = [process.env.IMAGINARIUM_TEST_UV, path.join(REPO, 'runtime', 'uv', 'uv'), (spawnSync('sh', ['-c', 'command -v uv'], { encoding: 'utf8' }).stdout || '').trim()];
const UV = uvCandidates.find((c) => c && (() => { try { return statSync(c).isFile(); } catch { return false; } })());
const basePy = [path.join(REPO, 'runtime', 'python', 'cpython-3.12-linux-x86_64-gnu', 'bin', 'python3.12'),
  process.env.IMAGINARIUM_TEST_PY, (spawnSync('sh', ['-c', 'command -v python3.12 || command -v python3'], { encoding: 'utf8' }).stdout || '').trim()]
  .find((c) => c && (() => { try { return statSync(c).isFile(); } catch { return false; } })());
const HAVE = Boolean(UV && basePy);

/** Build <dir>/.venv with a marker package, like the installer's env steps do. */
function mkVenv(dir, { pkg = true } = {}) {
  const r = spawnSync(UV, ['venv', '--python', basePy, path.join(dir, '.venv')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `uv venv failed: ${r.stderr}`);
  const py = venvPythonPath(dir);
  statSync(py);
  if (pkg) {
    // ask the venv where its packages live instead of assuming the minor version
    const pure = spawnSync(py, ['-c', "import sysconfig; print(sysconfig.get_paths()['purelib'])"], { encoding: 'utf8' }).stdout.trim();
    mkdirSync(pure, { recursive: true });
    writeFileSync(path.join(pure, 'astra_marker.py'), 'VALUE = 42\n');
  }
  return py;
}
const markerImport = 'import astra_marker; print(astra_marker.VALUE)';

test('linkTarget: plain file, good symlink, dangling symlink - each named as itself', async () => {
  const f = path.join(tmp, 'lt');
  writeFileSync(f, 'x');
  assert.deepEqual(await linkTarget(f), { exists: true, isLink: false, target: null, targetExists: true });
  const link = path.join(tmp, 'lt-link');
  symlinkSync('nope-gone', link);
  const dang = await linkTarget(link);
  assert.equal(dang.isLink, true);
  assert.equal(dang.targetExists, false, 'the copied-flat/cleaned-away class');
  assert.equal((await linkTarget(path.join(tmp, 'nope'))).exists, false);
});

test('checkVenv: healthy passes on the real spawn; a missing/dangling/non-executable/dead entry each gets its own reason', async (t) => {
  if (!HAVE) return t.skip('no uv + python3.12 on this machine');
  const ok = path.join(tmp, 'ok'); mkdirSync(ok, { recursive: true });
  mkVenv(ok);
  assert.equal((await checkVenv(ok)).ok, true, 'a real venv answers healthy from a real probe');

  const gone = path.join(tmp, 'gone'); mkdirSync(gone, { recursive: true });
  const py = mkVenv(gone); unlinkSync(py);
  let r = await checkVenv(gone);
  assert.equal(r.ok, false); assert.match(r.why, /no python entry at all/);

  const dang = path.join(tmp, 'dang'); mkdirSync(dang, { recursive: true });
  mkVenv(dang);
  const dp = venvPythonPath(dang); const saved = readFileSync(venvCfgFile(dang), 'utf8'); void saved;
  unlinkSync(dp); symlinkSync(path.join(tmp, 'cpython-deleted-by-a-cleaner', 'bin', 'python3.12'), dp);
  r = await checkVenv(dang);
  assert.equal(r.ok, false); assert.match(r.why, /symlink to .*, which no longer exists/);

  const noexec = path.join(tmp, 'noexec'); mkdirSync(noexec, { recursive: true });
  const np = mkVenv(noexec);
  unlinkSync(np); writeFileSync(np, '#!/bin/sh\nexit 0\n'); chmodSync(np, 0o644);   // a REAL file, never chmod through the venv symlink (that would hit the shared interpreter)
  r = await checkVenv(noexec);
  assert.match(r.why, /not executable/);
  chmodSync(np, 0o755);
  assert.equal((await checkVenv(noexec)).ok, true, 'the same entry executable passes');

  // the stat-passes-but-spawn-dies class: a python that exists and runs the shell's spawn but exits nonzero
  const dead = path.join(tmp, 'dead'); mkdirSync(path.join(dead, '.venv', 'bin'), { recursive: true });
  writeFileSync(venvPythonPath(dead), '#!/bin/sh\nexit 3\n');
  chmodSync(venvPythonPath(dead), 0o755);
  r = await checkVenv(dead);
  assert.equal(r.ok, false); assert.match(r.why, /present but does not run \(exit 3/);
});

test('repairStudioVenvs: a healthy venv costs one probe; a deleted python entry is recreated in place - packages survive', async (t) => {
  if (!HAVE) return t.skip('no uv + python3.12 on this machine');
  const dir = path.join(tmp, 'repair'); mkdirSync(dir, { recursive: true });
  mkVenv(dir);
  const list = [{ dir, what: 'Test stack', ids: ['testid'], label: 'test' }];
  const before = await repairStudioVenvs({ appRoot: REPO, list });
  assert.deepEqual(before, [{ label: 'test', verdict: 'healthy', why: '' }]);

  const py = venvPythonPath(dir);
  unlinkSync(py);                                     // the cleaner did its thing
  const r = await repairStudioVenvs({ appRoot: REPO, list });
  assert.equal(r[0].verdict, 'repaired');
  assert.equal((await checkVenv(dir)).ok, true, 'the recreated entry really runs');
  const back = spawnSync(venvPythonPath(dir), ['-c', markerImport], { encoding: 'utf8' });
  assert.equal(back.stdout.trim(), '42', 'site-packages survived the in-place repair - no re-download');
});

test('repairStudioVenvs: when the base interpreter is gone the answer is the install command, and nothing is deleted', async (t) => {
  if (!HAVE) return t.skip('no uv + python3.12 on this machine');
  const dir = path.join(tmp, 'hopeless'); mkdirSync(dir, { recursive: true });
  mkVenv(dir);
  const py = venvPythonPath(dir);
  unlinkSync(py); symlinkSync('/nowhere/python3.12', py);
  const cfg = venvCfgFile(dir);
  const cfgText = readFileSync(cfg, 'utf8').replace(/^home = .*$/m, 'home = /nowhere/bin');
  writeFileSync(cfg, cfgText);                          // and the record points at the gone interpreter too
  const treeBefore = statSync(path.join(dir, '.venv', 'lib')).mtimeMs;
  const r = await repairStudioVenvs({ appRoot: REPO, list: [{ dir, what: 'Pixal3D', ids: ['pixal3d'], label: 'pixal3d' }] });
  assert.equal(r[0].verdict, 'needs-installer');
  assert.match(r[0].why, /Python it was built from is gone/);
  assert.match(r[0].text, /Pixal3D stopped working.*its python is a symlink to \/nowhere\/python3\.12, which no longer exists.*run installer\/install\.sh -Yes -Only pixal3d and it will recreate that environment \(your models and settings stay\)/s);
  assert.equal(statSync(path.join(dir, '.venv', 'lib')).mtimeMs, treeBefore, 'the studio never deletes anything');
});

test('repairStudioVenvs: a folder that is not installed is skipped silently; the studio list covers the four owned venvs', async () => {
  const r = await repairStudioVenvs({ appRoot: REPO, list: [{ dir: path.join(tmp, 'not-here'), what: 'X', ids: ['x'], label: 'x' }] });
  assert.deepEqual(r, [{ label: 'x', verdict: 'skip', why: 'not installed' }]);
  const v = studioVenvs({ env: {}, appRoot: '/app' });
  assert.deepEqual(v.map((x) => x.label), ['comfy', 'pixal3d', 'triposg', 'sound']);
  assert.equal(v[0].dir, '/app/runtime/ComfyUI');
  // the env seams the config readers honor ride through the same list:
  assert.equal(studioVenvs({ env: { IMAGINARIUM_COMFY_DIR: '/else/comfy' }, appRoot: '/app' })[0].dir, '/else/comfy');
});

test('pythonFailText / venvSpawnFailText: name the broken thing and the exact fixing command', () => {
  const t = pythonFailText('Sound', ['sound'], 'its python entry is not executable');
  assert.match(t, /Sound stopped working: its Python environment is broken \(its python entry is not executable\)/);
  assert.match(t, /run installer\/install\.sh -Yes -Only sound and it will recreate that environment/);
  assert.match(t, /does not download several gigabytes behind your back/);
  const s = venvSpawnFailText('/app/runtime/ComfyUI/.venv/bin/python', 'UV unwrapping');
  assert.match(s, /UV unwrapping needs the studio's Python at \/app\/runtime\/ComfyUI\/\.venv\/bin\/python, and it does not start/);
  assert.match(s, /-Only comfydeps/);
});

// ---------------------------------------------------------------- the spawn sites answer in sentences

test('the wrapped spawn sites (uv unwrap, preprocess, comfy client) trade ENOENT for the sentence', async () => {
  const comfy = path.join(tmp, 'empty-comfy'); mkdirSync(path.join(comfy, '.venv', 'bin'), { recursive: true });
  const savedComfy = process.env.IMAGINARIUM_COMFY_DIR;
  process.env.IMAGINARIUM_COMFY_DIR = comfy;                 // every reader resolves the venv through this seam
  try {
    const { unwrapUV } = await import('../server/uv.mjs');
    const mesh = { id: '00000000-0000-4000-8000-000000000001', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
    await assert.rejects(
      unwrapUV({ meshes: [mesh] }, new AbortController().signal),
      /needs the studio's Python at .* and it does not start/,
      'ENOENT from a dead venv, answered as the fix command',
    );

    const { runPython } = await import('../scripts/views/comfy_client.mjs');
    await assert.rejects(runPython('x.py', []), /needs the studio's Python at .* it does not start/);
  } finally {
    if (savedComfy === undefined) delete process.env.IMAGINARIUM_COMFY_DIR; else process.env.IMAGINARIUM_COMFY_DIR = savedComfy;
  }
});

// ------------------------------------------------------ the installer's reinstall-recreates path
// VenvRecreateIfBroken is sourced straight out of installer/install.sh (the script guards its
// main flow against sourcing) and driven against real scratch venvs.
test('installer reinstall: a damaged venv is recreated from scratch, a healthy one is left alone', (t) => {
  if (!HAVE) return t.skip('no uv + python3.12 on this machine');
  const run = (dir) => spawnSync('bash', ['-c', `
    set -u
    say() { printf 'SAY: %s\\n' "$*"; }
    eval "$(awk '/^VenvRecreateIfBroken/,/^}/' ${JSON.stringify(REPO).slice(1, -1)}/installer/install.sh)"
    VenvRecreateIfBroken "$1" 'Test'
    [ -e "$1/.venv" ] && echo kept || echo gone
  `, 'bash', dir], { encoding: 'utf8' });
  const good = path.join(tmp, 'inst-good'); mkdirSync(good, { recursive: true }); mkVenv(good);
  let r = run(good);
  assert.match(r.stdout, /kept/, r.stderr);
  assert.doesNotMatch(r.stdout, /SAY/);

  const broken = path.join(tmp, 'inst-broken'); mkdirSync(broken, { recursive: true });
  mkVenv(broken);
  unlinkSync(venvPythonPath(broken));                       // the dangling/missing entry class
  r = run(broken);
  assert.match(r.stdout, /SAY:\s+the Test Python environment is damaged - recreating it from scratch/);
  assert.match(r.stdout, /gone/, 'the broken skeleton is removed so the install step rebuilds it');
});
