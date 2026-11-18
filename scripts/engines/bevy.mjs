#!/usr/bin/env node
// Imaginarium <-> Bevy 0.20 (0.6.10 wave ticket 30): the engine driver. Godot/Unity/Unreal get
// their engine through a downloaded editor binary; Bevy's "editor" is the Rust toolchain: a
// package is validated by compiling a small app around it and running that headless-ish. When
// cargo is on PATH the studio checks every Bevy package (the crate's own imaginarium_bevy_check binary)
// and captures preview frames; when it is not, the export is byte-identical minus the check -
// the same honest absence line the Godot and Unreal columns use.
//
//   node scripts/engines/bevy.mjs status
//   node scripts/engines/bevy.mjs create --name <Name> --path <folder>
//   node scripts/engines/bevy.mjs send   --project <folder> <package|export.zip> [...]
//   node scripts/engines/bevy.mjs test   --project <folder> --slug <asset_id> [--out <dir>]
//   node scripts/engines/bevy.mjs check-package --package <pkg dir> --out <dir>
//        (used by the bevy_package forge step: a scratch scaffold + imaginarium_bevy_check, prints the
//         final 'IMAGINARIUM_BEVY_CHECK {json}' line; task ids imaginarium_bevy_check, imaginarium_bevy_send_<slug>)
//
// Everything cargo speaks streams into a log file with an idle-kill: a stuck toolchain (a lock
// another build holds) must never hang the forge job - after IMAGINARIUM_CARGO_IDLE_MIN of silence
// the whole process group dies and the check answers "idle-killed". IMAGINARIUM_CARGO_TIMEOUT_MIN is
// the hard ceiling. The build cache (IMAGINARIUM_CARGO_TARGET_DIR) is shared across checks, so the
// first package pays the minutes-long Bevy compile and every package after it pays seconds.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(HERE, '..', '..');

export const BEVY_VERSION = '0.20';
export const BEVY_CRATE_DIR = path.join(APP_DIR, 'bevy', 'imaginarium_bevy');
export const BEVY_TEMPLATE_DIR = path.join(APP_DIR, 'ai', 'skills', 'imaginarium-integrator', 'templates', 'bevy');

export function cargoTargetDir(env = process.env) {
  return env.IMAGINARIUM_CARGO_TARGET_DIR || path.join(APP_DIR, 'data', 'engines', 'bevy', 'target');
}
export function cargoTimeoutMin(env = process.env) { return Number(env.IMAGINARIUM_CARGO_TIMEOUT_MIN) || 25; }
export function cargoIdleMin(env = process.env) { return Number(env.IMAGINARIUM_CARGO_IDLE_MIN) || 4; }

/** IMAGINARIUM_CARGO wins; then PATH (the `which` idiom of the other drivers); then rustup's home. */
export function findCargo({ env = process.env } = {}) {
  const forced = env.IMAGINARIUM_CARGO;
  if (forced) return existsSync(forced) ? forced : null;
  const found = spawnSync('which', ['cargo'], { encoding: 'utf8', env });
  const p = found.status === 0 && found.stdout.trim().split(/\r?\n/)[0];
  if (p && existsSync(p)) return p;
  const rustup = path.join(os.homedir(), '.cargo', 'bin', 'cargo');
  return existsSync(rustup) ? rustup : null;
}

/**
 * Run cargo, tailing everything into `out` (and onLine). A process group, so kill takes rustc
 * with it. Silence for idleMs (no line, any stream) or an alive time past timeoutMs ends it.
 * Resolves {code, timedOut, idle, log}; never rejects - the callers judge the code.
 */
export function runCargo({ cargo, args, cwd, env = process.env, out, onLine = () => {},
  timeoutMin = cargoTimeoutMin(env), idleMin = cargoIdleMin(env), spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const log = [];
    const record = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        log.push(line);
        onLine(line);
      }
    };
    let child;
    try {
      child = spawnImpl(cargo, args, { cwd, env: { ...env, CARGO_TERM_COLOR: 'never', TERM: 'dumb' },
        detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { resolve({ code: -1, timedOut: false, idle: false, log: [`spawn failed: ${e.message}`] }); return; }
    child.stdout?.on('data', record);
    child.stderr?.on('data', record);
    let lastBeat = Date.now();
    // an error event (a vanished cargo) never produces an exit - settle it here or the caller waits forever
    child.on('error', (e) => { record(`spawn failed: ${e.code || e.message}`); finish('spawn'); });
    const hard = setTimeout(() => finish('timeout'), Math.max(0.05, timeoutMin) * 60000);
    const idleCheck = setInterval(() => {
      if (Date.now() - lastBeat > Math.max(0.05, idleMin) * 60000) finish('idle');
    }, 1000);
    function finish(killed) {
      clearInterval(idleCheck); clearTimeout(hard);
      if (killed && killed !== 'spawn') {   // normal exit: cargo reaped its own rustcs, nobody to kill
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
        record(`(cargo ${killed === 'idle' ? 'went quiet' : 'ran past its time limit'} - killed)`);
      }
      done(killed);
    }
    let closed = false;
    const done = (killed) => {
      if (closed) return; closed = true;
      const logText = log.join('\n');
      if (out) { try { writeFileSync(out, logText); } catch { /* the log is not worth a crash */ } }
      resolve({ code: killed ? -1 : lastCode, timedOut: killed === 'timeout', idle: killed === 'idle', log: logText });
    };
    let lastCode = null;
    child.on('exit', (code) => { lastCode = code; finish(null); });
    child.stdout?.on('data', () => { lastBeat = Date.now(); });
    child.stderr?.on('data', () => { lastBeat = Date.now(); });
  });
}

/** {hasCargo, cargo, cargoVersion, bevy, targetDir, crate, template, reason} - what the studio says about this machine. */
export async function bevyStatus({ env = process.env } = {}) {
  const cargo = findCargo({ env });
  let cargoVersion = null;
  if (cargo) {
    const v = spawnSync(cargo, ['--version'], { encoding: 'utf8', env });
    if (v.status === 0) cargoVersion = v.stdout.trim().split(/\s+/)[1] || v.stdout.trim();
  }
  const crate = existsSync(path.join(BEVY_CRATE_DIR, 'Cargo.toml'));
  const template = existsSync(path.join(BEVY_TEMPLATE_DIR, 'Cargo.toml'));
  return {
    hasCargo: !!cargo, cargo, cargoVersion, bevy: BEVY_VERSION,
    targetDir: cargoTargetDir(env), crate, template,
    reason: cargo ? (!crate ? `the imaginarium_bevy crate is missing at ${BEVY_CRATE_DIR}` : null)
      : 'cargo is not on PATH - Bevy packages export unchanged and stay unchecked here',
  };
}

/** Does this folder hold a cargo project that uses the crate? */
export function isBevyProject(dir) {
  try { return /imaginarium_bevy\b/.test(readFileSync(path.join(dir, 'Cargo.toml'), 'utf8')); } catch { return false; }
}

/** The bevy version a project pinned (Cargo.toml dependency, then Cargo.lock), or null. */
export function bevyVersionOf(dir) {
  try {
    const toml = readFileSync(path.join(dir, 'Cargo.toml'), 'utf8');
    const m = /(?<![A-Za-z0-9_-])bevy\s*=\s*(?:\{[^}]*?version\s*=\s*"([^"]+)"|"([^"]+)")/.exec(toml);
    if (m) return m[1] || m[2];
  } catch { /* below */ }
  try {
    const lock = readFileSync(path.join(dir, 'Cargo.lock'), 'utf8');
    const m = /name\s*=\s*"bevy"\nversion\s*=\s*"([^"]+)"/.exec(lock);
    if (m) return m[1];
  } catch { /* no lock */ }
  return null;
}

/** Copy the integrator template into <dir>/<Name>: the player starter, aimed at THIS crate. */
export async function createBevyProject({ name, dir, env = process.env } = {}) {
  if (!name || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new Error('createBevyProject: --name is required (letters, digits, dash, underscore).');
  const target = path.join(dir || path.join(APP_DIR, 'data', 'engines', 'bevy'), name);
  if (existsSync(path.join(target, 'Cargo.toml'))) throw new Error(`createBevyProject: ${target} already holds a project.`);
  mkdirSync(target, { recursive: true });
  cpSync(BEVY_TEMPLATE_DIR, target, { recursive: true, filter: (src) => !/(^|\/)(target|Cargo\.lock)$/.test(src.slice(BEVY_TEMPLATE_DIR.length)) });
  const tomlFile = path.join(target, 'Cargo.toml');
  let toml = readFileSync(tomlFile, 'utf8');
  toml = toml.replace(/^name\s*=\s*"[^"]*"/m, `name = "${name}"`);
  const rel = path.relative(target, BEVY_CRATE_DIR).split(path.sep).join('/');
  toml = toml.replace(/imaginarium_bevy\s*=\s*\{[^}]*\}/, `imaginarium_bevy = { path = ${JSON.stringify(rel)}, version = "0.20" }`);
  writeFileSync(tomlFile, toml);
  return { dir: target, name, bevy: bevyVersionOf(target), status: await bevyStatus({ env }) };
}

/** Add the crate as a path dependency to an existing project (the studio's crate is the source). */
export function installCrate({ project }) {
  const tomlFile = path.join(project, 'Cargo.toml');
  let toml; try { toml = readFileSync(tomlFile, 'utf8'); } catch { throw new Error(`installCrate: ${project} has no Cargo.toml.`); }
  if (/imaginarium_bevy\b/.test(toml)) return { added: false, project };
  const rel = path.relative(project, BEVY_CRATE_DIR).split(path.sep).join('/');
  if (!/^\[dependencies\]/m.test(toml)) { toml += '\n[dependencies]\n'; }
  toml = toml.replace(/^\[dependencies\]\s*$/m, `[dependencies]\nimaginarium_bevy = { path = ${JSON.stringify(rel)}, version = "0.20" }`);
  writeFileSync(tomlFile, toml);
  return { added: true, project };
}

/**
 * Put an exported package (a folder or the studio's export.zip of one) into the project's
 * assets/imaginarium/<asset_id>/, replacing the previous copy. Returns the task id the UI can
 * show while more sends queue up.
 */
export async function sendBevy({ project, sources }) {
  if (!isBevyProject(project)) throw new Error(`sendBevy: ${project} is not a Bevy project with imaginarium_bevy (engine_project_create or installCrate first).`);
  const list = Array.isArray(sources) ? sources : [sources];
  const sent = [];
  for (const src of list) {
    let dir = src;
    if (src.toLowerCase().endsWith('.zip')) {
      dir = await unzipToTemp(src);
      const inner = findAfBevy(dir);
      if (inner) dir = inner; else throw new Error(`sendBevy: ${src} has no ima_bevy.json inside.`);
    }
    let man; try { man = JSON.parse(readFileSync(path.join(dir, 'ima_bevy.json'), 'utf8')); }
    catch { throw new Error(`sendBevy: ${src} is not a Bevy package (no ima_bevy.json).`); }
    const slug = String(man.asset_id || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'asset';
    const dest = path.join(project, 'assets', 'imaginarium', slug);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(dir, dest, { recursive: true });
    sent.push({ id: `imaginarium_bevy_send_${slug}`, asset_id: slug, dest });
  }
  return sent;
}

/** Run the crate's check binary over a project's package: the full user-shaped validation. */
export async function testBevy({ project, slug, out, env = process.env, onLine = () => {} }) {
  const cargo = findCargo({ env });
  if (!cargo) return { ok: false, skipped: 'cargo not found', report: null };
  const pkg = path.join(project, 'assets', 'imaginarium', slug);
  if (!existsSync(path.join(pkg, 'ima_bevy.json'))) throw new Error(`testBevy: ${project} has no package ${slug} (send it first).`);
  return runCheck({ slug, assetsRoot: project, out: out || path.join(pkg, '_bevy_check'), cargo, env, onLine });
}

/** The check-package verb the forge step uses: a throwaway scaffold holding ONLY this package. */
export async function checkPackage({ packageDir, out, env = process.env, onLine = () => {} }) {
  const cargo = findCargo({ env });
  if (!cargo) {
    return { ok: false, skipped: 'cargo not found - the package exports unchecked here (install Rust to validate)', report: null };
  }
  const slug = String((safeJson(readFileSync(path.join(packageDir, 'ima_bevy.json'), 'utf8')) || {}).asset_id || '').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'asset';
  const scaffold = path.join(out, '_bevy_check');
  rmSync(scaffold, { recursive: true, force: true });
  const assetsDest = path.join(scaffold, 'assets', 'imaginarium', slug);
  mkdirSync(assetsDest, { recursive: true });
  cpSync(packageDir, assetsDest, { recursive: true });
  return runCheck({ slug, assetsRoot: scaffold, out, cargo, env, onLine });
}

/** cargo run --features check --bin imaginarium_bevy_check with cwd=the folder whose assets/ hold the package. */
async function runCheck({ slug, assetsRoot, out, cargo, env, onLine }) {
  mkdirSync(out, { recursive: true });
  const target = cargoTargetDir(env);
  mkdirSync(target, { recursive: true });
  const r = await runCargo({
    cargo,
    args: ['run', '--quiet', '--manifest-path', path.join(BEVY_CRATE_DIR, 'Cargo.toml'),
      '--features', 'check', '--bin', 'imaginarium_bevy_check', '--', '--slug', slug, '--out', path.resolve(out)],
    cwd: assetsRoot,
    env: { ...env, CARGO_TARGET_DIR: target },
    out: path.join(out, 'bevy_log.txt'),
    onLine,
  });
  const line = r.log.split(/\r?\n/).reverse().find((l) => l.startsWith('IMAGINARIUM_BEVY '));
  const report = line ? safeJson(line.slice(7)) : null;
  if (report) report.log = path.join(out, 'bevy_log.txt');
  const taskId = 'imaginarium_bevy_check';   // the pinned task id of the check verb (spec T3-Bevy)
  if (r.timedOut || r.idle) return { ok: false, taskId, skipped: null, timedOut: r.timedOut, idle: r.idle, report, code: r.code };
  return { ok: !!report?.ok, taskId, skipped: null, report, code: r.code };
}

// ---------------------------------------------------------------- the MCP bridge (checksum-pinned)

/// The third-party Bevy bridge. Supply-chain rule (policies): the toolchain NEVER installs from
/// the index - the .crate file is downloaded, hashed, compared to the pinned crates.io record,
/// and only that verified file is unpacked and installed.
export const BRP_MCP = Object.freeze({
  crate: 'bevy_brp_mcp',
  version: '0.23.0',
  sha256: 'a6ec60a2b45471af92bf953372d56f269dbd7a3f7d76a151fda520635255af11',
  url: (version) => `https://static.crates.io/crates/bevy_brp_mcp/bevy_brp_mcp-${version}.crate`,
});

export function brpBinary({ env = process.env } = {}) {
  const name = (env.OS || process.env.OS || '').toLowerCase().includes('win') ? 'bevy_brp_mcp.exe' : 'bevy_brp_mcp';
  return path.join(env.CARGO_HOME || path.join(os.homedir(), '.cargo'), 'bin', name);
}

/** curl with the pinned argv shape: -o BEFORE `--` (curl treats everything after `--` as a
 *  URL - the shape from ticket 47's live session read "-o" as a host: "curl: (6) Could not
 *  resolve host: -o"). Testable against a file:// URL without the network. */
export function curlDownload(url, dest) {
  const d = spawnSync('curl', ['-fsSL', '-o', dest, '--', url], { encoding: 'utf8' });
  if (d.status !== 0) throw new Error(`download failed: ${(d.stderr || d.stdout || 'curl error').trim()}`);
}

/** Download -> sha256 vs pin -> unpack -> cargo install --path. Any mismatch throws before install. */
export async function installBrpMcp({ env = process.env, log = () => {}, cargo = findCargo({ env }),
  fetchImpl = null, version = BRP_MCP.version, sha256 = BRP_MCP.sha256 } = {}) {
  if (!cargo) throw new Error('installBrpMcp: cargo is not on PATH - the Bevy MCP bridge needs the Rust toolchain.');
  if (existsSync(brpBinary({ env }))) { log('bevy_brp_mcp: already installed'); return { installed: true, skipped: 'already installed' }; }
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'imaginarium_brp_'));
  try {
    const crateFile = path.join(tmpRoot, `bevy_brp_mcp-${version}.crate`);
    if (fetchImpl) await fetchImpl(BRP_MCP.url(version), crateFile);
    else {
      try { curlDownload(BRP_MCP.url(version), crateFile); }
      catch (e) { throw new Error(`installBrpMcp: ${e.message}`); }
    }
    const got = createHash('sha256').update(readFileSync(crateFile)).digest('hex');
    if (got !== sha256) {
      throw new Error(`installBrpMcp: checksum mismatch for bevy_brp_mcp ${version}: expected ${sha256}, got ${got} - refusing to install (the verified crates.io record is pinned in scripts/engines/bevy.mjs).`);
    }
    log(`bevy_brp_mcp ${version}: sha256 ${got} verified against the pinned crates.io record`);
    const x = spawnSync('tar', ['xzf', crateFile, '-C', tmpRoot], { encoding: 'utf8' });
    if (x.status !== 0) throw new Error(`installBrpMcp: cannot unpack the verified crate: ${(x.stderr || x.stdout).trim()}`);
    const src = path.join(tmpRoot, `bevy_brp_mcp-${version}`);
    if (!existsSync(path.join(src, 'Cargo.toml'))) throw new Error('installBrpMcp: the verified archive does not hold the expected crate folder.');
    // the shared target dir lets the bridge reuse the very bevy the studio's checks compiled
    const r = await runCargo({ cargo, args: ['install', '--path', src, '--locked'], cwd: tmpRoot,
      env: { ...env, CARGO_TARGET_DIR: cargoTargetDir(env) }, onLine: log });
    if (r.code !== 0) return { installed: false, code: r.code, log: String(r.log).split(/\r?\n/).slice(-3).join(' / ') };
    log(`bevy_brp_mcp ${version}: installed from the verified file`);
    return { installed: true, version, sha256: got };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- small shared helpers

function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }

async function unzipToTemp(src) {
  const { mkdtemp } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'imaginarium_bevy_send_'));
  const r = spawnSync('unzip', ['-o', '-q', path.resolve(src), '-d', dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sendBevy: unzip failed for ${src}: ${r.stderr || r.stdout}`);
  return dir;
}

/** The folder holding ima_bevy.json somewhere inside a freshly unzipped studio export. */
function findAfBevy(root, depth = 0) {
  if (existsSync(path.join(root, 'ima_bevy.json'))) return root;
  if (depth > 2) return null;
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findAfBevy(path.join(root, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- CLI

async function main() {
  const ARGS = process.argv.slice(2);
  const CMD = ARGS[0];
  const opt = (name, def = null) => { const i = ARGS.indexOf(`--${name}`); return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : def; };
  if (CMD === 'status') {
    console.log(JSON.stringify(await bevyStatus({ env: process.env })));
  } else if (CMD === 'create') {
    console.log(JSON.stringify(await createBevyProject({ name: opt('name'), dir: opt('path') ? path.resolve(opt('path')) : undefined })));
  } else if (CMD === 'send') {
    const project = path.resolve(opt('project'));
    const sources = ARGS.filter((a, i) => !a.startsWith('--') && i > 0 && ARGS[i - 1] !== '--project').map(path.resolve);
    console.log(JSON.stringify(await sendBevy({ project, sources }), null, 1));
  } else if (CMD === 'test') {
    const r = await testBevy({ project: path.resolve(opt('project')), slug: opt('slug'), out: opt('out') ? path.resolve(opt('out')) : undefined });
    console.log(JSON.stringify(r.report || r, null, 1));
    process.exitCode = r.ok || r.skipped ? 0 : 1;   // an honest skip is not a failed run
  } else if (CMD === 'check-package') {
    const r = await checkPackage({ packageDir: path.resolve(opt('package')), out: path.resolve(opt('out')) });
    console.log(`IMAGINARIUM_BEVY_CHECK ${JSON.stringify(r.report ? { ok: r.ok, skipped: r.skipped, shots: r.report.shots, checks: r.report.checks } : { ok: false, skipped: r.skipped || 'the check answered nothing' })}`);
    process.exitCode = r.ok || r.skipped ? 0 : 1;
  } else if (CMD === 'brp-install') {
    const r = await installBrpMcp({ log: (s) => console.log(s) });
    console.log(JSON.stringify(r));
    process.exitCode = r.installed ? 0 : 1;
  } else if (CMD) {
    console.error('bevy: unknown command ' + CMD + ' (status|create|send|test|check-package|brp-install)');
    process.exitCode = 2;
  } else {
    console.error('usage: bevy.mjs status | create --name N [--path dir] | send --project dir <pkg...> | test --project dir --slug id [--out dir] | check-package --package dir --out dir | brp-install');
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => {}, (e) => { console.error(e.message); process.exit(1); });
}
