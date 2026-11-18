// The Unreal Engine 5 line at the data level (ticket 05): the package contract (ima_unreal.json),
// the engine bridge (create/link/send/test verbs against a stubbed editor), the plugin tree, and
// the studio wiring. There is no Unreal Editor on the verification machine: `test` must answer
// with a plain, actionable absence - never a crash - and the in-editor pass is flagged
// unverified-by-design (docs/product/unreal.md). Fresh Unity/Godot behavior is untouched.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'scripts', 'engines', 'imaginarium_engine.mjs');
const tmp = mkdtempSync(path.join(tmpdir(), 'imaginarium-unreal-'));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));

function af(args, env = {}) {
  return spawnSync(process.execPath, [ENGINE, ...args], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, IMAGINARIUM_ENGINES_HOME: path.join(tmp, 'engines-home'), IMAGINARIUM_UNREAL: '', ...env },
  });
}

function packageFixture(name = 'sm_test_asset') {
  const dir = path.join(tmp, 'pkg-' + name);
  mkdirSync(path.join(dir, 'Textures'), { recursive: true });
  const man = {
    format: 'imaginarium-unreal-package/1',
    asset: { id: name.replace(/^sm_/i, '').toLowerCase(), name: 'Test asset', kind: 'ship' },
    units: 'cm', axes: { up: 'Z', forward: '+X', handed: 'left', source_forward_glb: '-Z', root_rotation_z_deg: 0, fbx_axes: { forward: '-Y', up: 'Z' } },
    fbx: name + '.fbx', main: { mesh: name, rig: 'static' },
    meshes: [{ mesh: name, materials: ['MI_' + name.slice(3) + '_Hull'], lods: [] }],
    materials: [{ name: 'MI_' + name.slice(3) + '_Hull', textures: { baseColor: 'T_x_BaseColor.png', orm: 'T_x_ORM.png' }, normal_space: null, params: { metallic: 0, roughness: 0.5 } }],
    collision: [{ render: name, ucx: 'UCX_' + name + '_00', kind: 'convex', triangles: 12 }],
    sockets: [], animations: [], fps: 30, master_material: 'M_Imaginarium', actor_blueprint: 'A_' + name.slice(3), passport: {}, studio: {},
  };
  writeFileSync(path.join(dir, 'ima_unreal.json'), JSON.stringify(man, null, 2));
  writeFileSync(path.join(dir, name + '.fbx'), 'fake fbx bytes for wiring tests');
  writeFileSync(path.join(dir, 'Textures', 'T_x_BaseColor.png'), 'png');
  return dir;
}

test('create --engine unreal builds a plugin-enabled .uproject without any editor', () => {
  const r = af(['create', '--engine', 'unreal', '--name', 'AfTestGame', '--path', path.join(tmp, 'proj'), '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.engine, 'unreal');
  assert.ok(existsSync(path.join(tmp, 'proj', 'AfTestGame.uproject')));
  const up = JSON.parse(readFileSync(path.join(tmp, 'proj', 'AfTestGame.uproject'), 'utf8'));
  const plugins = up.Plugins.map((p) => p.Name);
  assert.ok(plugins.includes('Imaginarium') && plugins.includes('PythonScriptPlugin'), JSON.stringify(up.Plugins));
  assert.ok(existsSync(path.join(tmp, 'proj', 'Plugins', 'Imaginarium', 'Imaginarium.uplugin')), 'the importer plugin traveled into the project');
  assert.ok(existsSync(path.join(tmp, 'proj', 'Plugins', 'Imaginarium', 'Content', 'Python', 'imaginarium_unreal', '__init__.py')));
});

test('detectEngine sees a .uproject folder as unreal and resolve works by path', async () => {
  const mod = await import(ENGINE);
  assert.equal(mod.detectEngine(path.join(tmp, 'proj')), 'unreal');
  assert.equal(mod.detectEngine(tmp), null);
});

test('send copies ima_unreal.json packages into the project', () => {
  const pkg = packageFixture();
  const r = af(['send', '--project', path.join(tmp, 'proj'), pkg, '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.engine, 'unreal');
  assert.equal(res.packages.length, 1);
  assert.equal(res.packages[0].asset_id, 'test_asset');
  assert.ok(existsSync(path.join(tmp, 'proj', 'ImaginariumPackages', 'test_asset', 'ima_unreal.json')));
  assert.ok(existsSync(path.join(tmp, 'proj', 'ImaginariumPackages', 'test_asset', 'Textures', 'T_x_BaseColor.png')));
});

test('send refuses sources that are not Unreal packages', () => {
  const bogus = path.join(tmp, 'bogus');
  mkdirSync(bogus, { recursive: true });
  writeFileSync(path.join(bogus, 'whatever.txt'), 'x');
  const r = af(['send', '--project', path.join(tmp, 'proj'), bogus, '--json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /ima_unreal\.json/);
});

test('test without an Unreal Editor answers with the actionable absence, never a crash', () => {
  const r = af(['test', '--project', path.join(tmp, 'proj'), '--json'], { IMAGINARIUM_UNREAL: '' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.ok, false);
  assert.equal(res.engine, 'unreal');
  assert.match(res.error, /Unreal Editor not found/);
  assert.match(res.error, /IMAGINARIUM_UNREAL/);
  assert.match(res.error, /data level/);
});

test('the log-lock guard refuses a second background run while the lock exists', () => {
  const fake = path.join(tmp, 'fake-unreal-cmd');
  writeFileSync(fake, '#!/bin/sh\necho "AFUNREAL {}"\n');
  spawnSync('chmod', ['+x', fake]);
  writeFileSync(path.join(tmp, 'proj', '.ima_unreal.lock'), '{"pid":1}');
  const r = af(['test', '--project', path.join(tmp, 'proj'), '--json'], { IMAGINARIUM_UNREAL: fake });
  rmSync(path.join(tmp, 'proj', '.ima_unreal.lock'), { force: true });
  assert.equal(r.status, 1);
  const res = JSON.parse(r.stdout);
  assert.match(res.error, /\.ima_unreal\.lock/);
});

test('a present UnrealEditor-Cmd is driven over every sent package with the plugin script', () => {
  const calls = path.join(tmp, 'unreal-calls.txt');
  const fake = path.join(tmp, 'fake-unreal-cmd2');
  const proj = path.join(tmp, 'proj');
  writeFileSync(fake, [
    '#!/bin/sh',
    `echo "$@" >> ${JSON.stringify(calls)}`,
    `for m in ${JSON.stringify(proj)}/ImaginariumPackages/*/ima_unreal.json; do printf '{"ok":true,"stub":true}' > "$(dirname "$m")/unreal_check.json"; done`,
    'exit 0',
  ].join('\n'));
  spawnSync('chmod', ['+x', fake]);
  const r = af(['test', '--project', proj, '--json'], { IMAGINARIUM_UNREAL: fake });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].asset, 'test_asset');
  const args = readFileSync(calls, 'utf8');
  assert.match(args, /-run=pythonscript/);
  assert.match(args, /-nullrhi[\s\S]*-unattended[\s\S]*-nosplash/);
  assert.match(args, /AfTestGame\.uproject/);
  const script = res.results[0] && readFileSync(path.join(res.report_dir, 'import_test_asset.py'), 'utf8');
  assert.match(script, /imaginarium_unreal/);
  assert.match(script, /import_package/);
  assert.ok(!existsSync(path.join(tmp, 'proj', '.ima_unreal.lock')), 'the lock is released after the run');
});

test('mcp-register adds unreal-mcp only when its server is pointed at, via a stubbed claude CLI', () => {
  const home = path.join(tmp, 'fake-home');
  mkdirSync(home, { recursive: true });
  const bin = path.join(tmp, 'mcp-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do echo "ARG $1"; shift; done\nexit 0\n');
  spawnSync('chmod', ['+x', path.join(bin, 'claude')]);
  const mcpServer = path.join(tmp, 'unreal-mcp-server.js');
  writeFileSync(mcpServer, '// stub\n');
  const r = spawnSync(process.execPath, [ENGINE, 'mcp-register', '--json'], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: home, IMAGINARIUM_ENGINES_HOME: path.join(tmp, 'engines-home'), PATH: bin + ':' + process.env.PATH, IMAGINARIUM_UNREAL_MCP: mcpServer },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const res = JSON.parse(r.stdout);
  const got = res.registered.find((x) => x.server === 'unreal-mcp');
  assert.ok(got, 'unreal-mcp registration was attempted: ' + JSON.stringify(res.registered));
  assert.equal(got.ok, true);
});

test('the plugin imports outside the Unreal Editor and its helpers stay usable without the engine', () => {
  const r = spawnSync('python3', ['-c', [
    'import json, sys, tempfile, os',
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'unreal', 'Imaginarium', 'Content', 'Python'))})`,
    'import imaginarium_unreal as au',                        // must not touch engine APIs at import
    'd = tempfile.mkdtemp()',
    "p = os.path.join(d, 'ima_unreal.json')",
    "json.dump({'format': 'imaginarium-unreal-package/1', 'asset': {'id': 'x'}}, open(p, 'w'))",
    "assert au.load_manifest(p)['asset']['id'] == 'x'",
    "try:",
    "    au.load_manifest(os.path.join(d, 'nope.json')); raise SystemExit('missing file must raise')",
    "except FileNotFoundError:",
    "    pass",
    "print('helpers-stand-ok')",
  ].join('\n')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /helpers-stand-ok/);
});

test('the studio registry and export profiles carry the unreal line', async () => {
  const steps = await import(path.join(ROOT, 'server', 'forge-steps.mjs'));
  assert.ok(steps.stepNames().includes('unreal_package'), 'unreal_package is a known step');
  assert.equal(steps.EXPORT_PROFILES.unreal.step, 'unreal_package');
  const core = readFileSync(path.join(ROOT, 'src', 'forge', 'forge-core.js'), 'utf8');
  assert.match(core, /\{\s*id:\s*'unreal',\s*kinds:\s*ALL\s*\}/, 'the client list offers the unreal profile');
  const en = readFileSync(path.join(ROOT, 'src', 'i18n', 'en.js'), 'utf8');
  const ru = readFileSync(path.join(ROOT, 'src', 'i18n', 'ru.js'), 'utf8');
  assert.match(en, /core\.export\.unreal\.title/);
  assert.match(ru, /step\.unreal_package/);
});
