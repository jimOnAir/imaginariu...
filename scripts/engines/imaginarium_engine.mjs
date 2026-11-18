#!/usr/bin/env node
// Imaginarium <-> game engines (Unity, Godot, Unreal Engine 5): projects, asset delivery and background tests - no editor windows.
//
//   node scripts/engines/imaginarium_engine.mjs status
//   node scripts/engines/imaginarium_engine.mjs projects
//   node scripts/engines/imaginarium_engine.mjs create --engine unity|godot|unreal|bevy --name <Name> [--path <folder>] [--pipeline urp|builtin]
//                                             [--renderer forward_plus|mobile|gl_compatibility] [--with-mcp]
//   node scripts/engines/imaginarium_engine.mjs link   --path <project folder> [--name <Name>]
//   node scripts/engines/imaginarium_engine.mjs send   --project <name|folder> [--engine unity|godot|unreal|bevy] <package | export.zip> [...] [--build]
//   node scripts/engines/imaginarium_engine.mjs test   --project <name|folder> [--engine unity|godot|unreal|bevy] [--shots] [--playmode] [--scene res://...]
//   node scripts/engines/imaginarium_engine.mjs scaffold --project <name|folder> [--engine ...] --kind player --asset <asset_id> [--force]
//   node scripts/engines/imaginarium_engine.mjs mcp-register [--install-bevy-brp]  # UnityMCP + godot + unreal-mcp + bevy bridge in Claude Code (user scope), idempotent
//
// Projects are remembered in <engines home>/projects.json (name, engine, path, versions); the home is
// IMAGINARIUM_ENGINES_HOME, C:\Imaginarium\engines on Windows and <app>/data/engines elsewhere. Unity runs only in
// -batchmode, Godot only --headless; Godot screenshots come from a window placed off-screen. When the project
// is open in the Unity editor, batchmode is impossible: the result says so and points at the UnityMCP tools.
// Godot is found via IMAGINARIUM_GODOT (paths-env idiom), then the Windows default, then PATH (godot, godot4).
// Unreal: sources unreal/Imaginarium; create makes a minimal .uproject with the plugin and PythonScriptPlugin
// enabled; send puts ima_unreal.json packages into <project>/ImaginariumPackages/<asset_id>; test runs
// UnrealEditor-Cmd -run=pythonscript over the importer with a per-project lock (.ima_unreal.lock) so a second
// background run refuses instead of fighting an open editor. Found via IMAGINARIUM_UNREAL (UnrealEditor-Cmd), then
// ~/UnrealEngine / /opt/UnrealEngine / Epic Games, then PATH. The in-editor pass is unverified where no Unreal
// Editor exists (docs/product/unreal.md) - the package contract is what this machine proves.
import { promises as fs, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(HERE, '..', '..');
const IS_WIN = process.platform === 'win32';
export const ENGINES_HOME = process.env.IMAGINARIUM_ENGINES_HOME || (IS_WIN ? 'C:/Imaginarium/engines' : path.join(APP_DIR, 'data', 'engines'));
export const REGISTRY = path.join(ENGINES_HOME, 'projects.json');
export const DEFAULT_PROJECTS_DIR = path.join(ENGINES_HOME, 'projects');
const UNITY_EDITORS = 'C:/Program Files/Unity/Hub/Editor';
const UNITY_DEFAULT = '6000.0.64f1';
export const GODOT_EXE = godotExe();
const GODOT_MCP = process.env.IMAGINARIUM_GODOT_MCP || 'C:/Dorn/Dops media/tools/godot-mcp/build/index.js';
const UNREAL_MCP = process.env.IMAGINARIUM_UNREAL_MCP || '';
const UNREAL_DIRS = [process.env.IMAGINARIUM_UNREAL_ROOTS, path.join(os.homedir(), 'UnrealEngine'), '/opt/UnrealEngine', 'C:/Program Files/Epic Games'].filter(Boolean);
const UVX = process.env.IMAGINARIUM_UVX || (IS_WIN ? 'C:/Users/doron/AppData/Local/hermes/bin/uvx.exe' : 'uvx');
const CHECK_GD = path.join(HERE, 'godot', 'imaginarium_engine_check.gd');

/** IMAGINARIUM_GODOT wins; then the vendored Windows console build; then PATH (the Linux idiom of docs/linux.md). */
function godotExe() {
  if (process.env.IMAGINARIUM_GODOT && existsSync(process.env.IMAGINARIUM_GODOT)) return process.env.IMAGINARIUM_GODOT;
  if (IS_WIN && existsSync('C:/Dorn/Game Dev/Godot_v4.5.1-stable_win64_console.exe')) return 'C:/Dorn/Game Dev/Godot_v4.5.1-stable_win64_console.exe';
  for (const name of ['godot', 'godot4']) {
    const found = spawnSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8' });
    const p = found.status === 0 && found.stdout.split(/\r?\n/)[0];
    if (p && existsSync(p.trim())) return p.trim();
  }
  return null;
}

/** The Bevy driver (scripts/engines/bevy.mjs): the Rust toolchain is this engine's editor, so
 * the whole line - project, send, headless check, MCP bridge - lives there; loaded on demand. */
const bevyLib = () => import('./bevy.mjs');

/** The Unity sender belongs to the Unity line (scripts/unity); loaded only when a Unity command runs. */
async function unitySender() {
  try {
    return await import('../unity/imaginarium_unity_send.mjs');
  } catch {
    throw new Error('The Unity importer (scripts/unity/imaginarium_unity_send.mjs) is not available on this install.');
  }
}

// ------------------------------------------------------------------ helpers

async function readJson(p, fallback = null) {
  try { return JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, '')); } catch { return fallback; }
}
async function writeJson(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n');
}
const slug = (s) => String(s || '').trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Game';
const now = () => new Date().toISOString();

function run(exe, args, { timeoutMs = 30 * 60 * 1000, cwd } = {}) {
  const t0 = Date.now();
  const cp = spawnSync(exe, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { code: cp.status, out: `${cp.stdout || ''}\n${cp.stderr || ''}`, seconds: Math.round((Date.now() - t0) / 100) / 10, error: cp.error?.message };
}

export function detectEngine(dir) {
  if (existsSync(path.join(dir, 'project.godot'))) return 'godot';
  if (existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt')) && existsSync(path.join(dir, 'Assets'))) return 'unity';
  if (findUproject(dir)) return 'unreal';
  // a cargo project that depends on the studio crate is a Bevy project (scripts/engines/bevy.mjs)
  try {
    if (existsSync(path.join(dir, 'Cargo.toml')) && /imaginarium_bevy\b/.test(readFileSync(path.join(dir, 'Cargo.toml'), 'utf8'))) return 'bevy';
  } catch { /* unreadable folder */ }
  return null;
}

/** The .uproject file name of an Unreal project folder (or null when the folder is not one). */
const UPROJECT_RE = /\.uproject$/i;
export function findUproject(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { /* unreadable folder */ }
  return names.find((n) => UPROJECT_RE.test(n)) ?? null;
}

/** IMAGINARIUM_UNREAL wins (point at UnrealEditor-Cmd); then the usual engine folders; then PATH. */
export function unrealExe() {
  const env = process.env.IMAGINARIUM_UNREAL;
  if (env && existsSync(env)) return env;
  for (const base of UNREAL_DIRS) {
    let versions = [];
    try { versions = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const v of versions.sort().reverse()) {
      for (const rel of [['Engine', 'Binaries', 'Linux', 'UnrealEditor-Cmd'], ['Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe']]) {
        const p = path.join(base, v, ...rel);
        if (existsSync(p)) return p;
      }
    }
  }
  const found = spawnSync(IS_WIN ? 'where' : 'which', ['UnrealEditor-Cmd'], { encoding: 'utf8' });
  const p = found.status === 0 && found.stdout.split(/\r?\n/)[0];
  return p && existsSync(p.trim()) ? p.trim() : null;
}

function unityVersionOf(dir) {
  try { return /m_EditorVersion:\s*(\S+)/.exec(readFileSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8'))?.[1] || null; } catch { return null; }
}

export function unityExe(version) {
  const env = process.env.IMAGINARIUM_UNITY;
  if (env && existsSync(env)) return env;
  for (const v of [version, UNITY_DEFAULT]) {
    const p = v && path.join(UNITY_EDITORS, v, 'Editor', 'Unity.exe');
    if (p && existsSync(p)) return p;
  }
  return null;
}

export function unityOpen(dir) {
  // Temp/UnityLockfile stays locked while an editor holds the project; removing it succeeds only when none does
  const lf = path.join(dir, 'Temp', 'UnityLockfile');
  if (!existsSync(lf)) return false;
  try { rmSync(lf); return false; } catch { return true; }
}

// ------------------------------------------------------------------ registry

export async function listProjects() {
  const reg = await readJson(REGISTRY, { projects: [] });
  return reg.projects.map((p) => ({ ...p, exists: existsSync(p.path), open_in_unity: p.engine === 'unity' && existsSync(p.path) ? unityOpen(p.path) : undefined }));
}

async function saveProject(entry) {
  const reg = await readJson(REGISTRY, { projects: [] });
  const i = reg.projects.findIndex((p) => path.resolve(p.path) === path.resolve(entry.path));
  if (i >= 0) reg.projects[i] = { ...reg.projects[i], ...entry, updated: now() };
  else reg.projects.push({ ...entry, created: entry.created || now() });
  await writeJson(REGISTRY, reg);
  return entry;
}

export async function resolveProject(ref, engine = null) {
  if (!ref) throw new Error('Name a project: a registry name or an engine project folder.');
  const reg = await readJson(REGISTRY, { projects: [] });
  // one game may have both a Unity and a Godot project under the same name: engine picks one
  const byName = reg.projects.find((p) => p.name.toLowerCase() === String(ref).toLowerCase() && (!engine || p.engine === engine));
  const dir = byName ? byName.path : path.resolve(ref);
  const found = detectEngine(dir);
  if (!found) throw new Error(`Not a Unity, Godot, Unreal or Bevy project: ${dir}`);
  return { name: byName?.name || path.basename(dir), engine: found, path: dir };
}

// ------------------------------------------------------------------ create / link

export async function createProject({ engine, name, dir, pipeline = 'urp', renderer = 'forward_plus', withMcp = false, log = () => {} }) {
  if (!['unity', 'godot', 'unreal', 'bevy'].includes(engine)) throw new Error('engine: unity, godot, unreal or bevy.');
  const projName = slug(name);
  const target = path.resolve(dir || path.join(DEFAULT_PROJECTS_DIR, `${projName}_${({ unity: 'Unity', unreal: 'Unreal', bevy: 'Bevy' })[engine] || 'Godot'}`));
  if (existsSync(target) && (await fs.readdir(target)).length) {
    const existing = detectEngine(target);
    if (existing) throw new Error(`The folder already holds a ${existing} project: ${target}. Bind it with link.`);
    throw new Error(`The folder is not empty: ${target}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (engine === 'bevy') {
    const bevy = await bevyLib();
    const r = await bevy.createBevyProject({ name: path.basename(target), dir: path.dirname(target) });
    log(`Bevy: project ${r.dir} (player starter + path-dep into the studio's imaginarium_bevy crate)`);
    if (!r.status.hasCargo) log('cargo is not on PATH: the project is fine, but packages will travel unchecked until Rust is installed (docs/linux.md).');
    const entry = await saveProject({ name: name || projName, engine, path: r.dir, bevy: r.status.bevy, cargo: r.status.cargoVersion });
    return { ...entry, cargo: r.status };
  }
  if (engine === 'unreal') {
    // A minimal Unreal project needs no editor: .uproject + the Imaginarium importer plugin + Python.
    if (!existsSync(path.join(APP_DIR, 'unreal', 'Imaginarium'))) throw new Error(`Imaginarium importer plugin not found: ${path.join(APP_DIR, 'unreal', 'Imaginarium')}`);
    await fs.mkdir(path.join(target, 'Content'), { recursive: true });
    await fs.mkdir(path.join(target, 'Config'), { recursive: true });
    await copyTree(path.join(APP_DIR, 'unreal', 'Imaginarium'), path.join(target, 'Plugins', 'Imaginarium'));
    await writeJson(path.join(target, `${projName}.uproject`), { FileVersion: 3, EngineAssociation: process.env.IMAGINARIUM_UNREAL_ENGINE || '',
      Plugins: [{ Name: 'PythonScriptPlugin', Enabled: true }, { Name: 'Imaginarium', Enabled: true }] });
    await fs.writeFile(path.join(target, 'Config', 'DefaultEngine.ini'), '[/Script/EngineSettings.GameMapsSettings]\n');
    await fs.writeFile(path.join(target, '.gitignore'), 'Binaries/\nDerivedDataCache/\nIntermediate/\nSaved/\nDerivedDataMetadata/\n.ima_unreal.lock\n');
    const entry = await saveProject({ name: name || projName, engine, path: target, unreal: { uproject: `${projName}.uproject`, plugin: '0.1.0' } });
    log(`Unreal: created ${target} (Imaginarium plugin enabled; no editor was run)`);
    return { ...entry, editor: unrealExe(), note: unrealExe() ? null : 'Unreal Editor not found: create and send still work; test needs IMAGINARIUM_UNREAL (docs/product/unreal.md).' };
  }
  if (engine === 'unity') {
    const exe = unityExe(UNITY_DEFAULT);
    if (!exe) throw new Error('Unity not found (Unity Hub/Editor or IMAGINARIUM_UNITY).');
    const { sendToUnity, UNITY_MCP_VERSION } = await unitySender();
    const tplDir = path.join(path.dirname(exe), 'Data', 'Resources', 'PackageManager', 'ProjectTemplates');
    const tplPrefix = pipeline === 'hdrp' ? 'com.unity.template.3d-high-end-' : pipeline === 'urp' ? 'com.unity.template.3d-cross-platform-' : null;
    const tpl = tplPrefix && existsSync(tplDir) ? (await fs.readdir(tplDir)).filter((n) => n.startsWith(tplPrefix) && n.endsWith('.tgz')).sort().pop() : null;
    const logFile = path.join(os.tmpdir(), `imaginarium_unity_create_${Date.now()}.log`);
    log(`Unity: creating project ${target} (${pipeline}${tpl ? `, template ${tpl}` : ''}) in batchmode...`);
    const r = run(exe, ['-batchmode', '-createProject', target, ...(tpl ? ['-cloneFromTemplate', path.join(tplDir, tpl)] : []), '-logFile', logFile, '-quit']);
    const logText = existsSync(logFile) ? await fs.readFile(logFile, 'utf8') : '';
    if (/No valid Unity Editor license|Please activate your license/.test(logText)) throw new Error('Unity without a license: sign in in Unity Hub (Preferences -> Licenses).');
    if (!detectEngine(target)) throw new Error(`Unity did not create the project (code ${r.code}); log ${logFile}`);
    const sent = await sendToUnity({ project: target, sources: [], withMcp, build: false, log });
    if (!withMcp) log('The Imaginarium importer is installed; for live work use --with-mcp.');
    const entry = await saveProject({ name: name || projName, engine, path: target, unity: unityVersionOf(target), pipeline, importer: sent.importer.version, unity_mcp: withMcp ? UNITY_MCP_VERSION : null });
    return { ...entry, seconds: r.seconds };
  }
  // Godot: a project is a folder with project.godot; the first --import builds .godot/
  if (!GODOT_EXE) throw new Error('Godot not found (IMAGINARIUM_GODOT or godot on PATH).');
  const method = { forward_plus: 'forward_plus', mobile: 'mobile', gl_compatibility: 'gl_compatibility' }[renderer] || 'forward_plus';
  const feature = { forward_plus: 'Forward Plus', mobile: 'Mobile', gl_compatibility: 'GL Compatibility' }[method];
  await fs.mkdir(path.join(target, 'imaginarium'), { recursive: true });
  for (const d of ['scenes', 'scripts', 'tests']) await fs.mkdir(path.join(target, d), { recursive: true });
  await fs.writeFile(path.join(target, 'project.godot'), [
    '; Engine configuration file.', '; Created by Imaginarium (scripts/engines/imaginarium_engine.mjs).', '', 'config_version=5', '',
    '[application]', '', `config/name="${String(name || projName).replace(/"/g, '\\"')}"`, `config/features=PackedStringArray("4.5", "${feature}")`, '',
    '[rendering]', '', `renderer/rendering_method="${method}"`, `renderer/rendering_method.mobile="${method === 'forward_plus' ? 'mobile' : method}"`, '',
  ].join('\n'));
  await fs.writeFile(path.join(target, 'imaginarium', 'README.md'),
    '# Imaginarium\n\nStudio asset packages (godot_package): `res://imaginarium/<asset_id>/<asset_id>.tscn`. Updated by `imaginarium_engine.mjs send`.\n');
  await fs.writeFile(path.join(target, '.gitignore'), '.godot/\n*.translation\n');
  const r = run(GODOT_EXE, ['--headless', '--path', target, '--import'], { timeoutMs: 10 * 60 * 1000 });
  log(`Godot: project ${target} (${feature}), import ${r.seconds} s`);
  const entry = await saveProject({ name: name || projName, engine, path: target, godot: '4.5', renderer: method });
  return { ...entry, seconds: r.seconds };
}

export async function linkProject({ dir, name }) {
  const target = path.resolve(dir);
  const engine = detectEngine(target);
  if (!engine) throw new Error(`Not a Unity, Godot, Unreal or Bevy project: ${target}`);
  if (engine === 'bevy') {
    const bevy = await bevyLib();
    return saveProject({ name: name || path.basename(target), engine, path: target, linked: true, bevy: bevy.bevyVersionOf(target) || bevy.BEVY_VERSION });
  }
  return saveProject({ name: name || path.basename(target), engine, path: target, linked: true,
    ...(engine === 'unity' ? { unity: unityVersionOf(target) } : { godot: '4.5' }) });
}

// ------------------------------------------------------------------ send

async function unzipTo(zipPath, target) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await fs.readFile(zipPath));
  for (const entry of Object.values(zip.files)) {
    const rel = entry.name.replace(/\\/g, '/');
    const abs = path.resolve(target, rel);
    if (rel.split('/').includes('..') || !abs.startsWith(path.resolve(target) + path.sep)) continue;
    if (entry.dir) { await fs.mkdir(abs, { recursive: true }); continue; }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, await entry.async('nodebuffer'));
  }
  return target;
}

async function findWith(root, marker, depth = 0, out = []) {
  if (existsSync(path.join(root, marker))) { out.push(root); return out; }
  if (depth > 3) return out;
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('_') && e.name !== '.godot') await findWith(path.join(root, e.name), marker, depth + 1, out);
  }
  return out;
}

async function copyTree(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyTree(s, d); else if (!e.name.endsWith('.pyc')) await fs.copyFile(s, d);
  }
}

async function copyOver(src, dst) {
  let n = 0;
  await fs.mkdir(dst, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    if (e.name.startsWith('_') || e.name === 'unity_shots') continue;
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) n += await copyOver(s, d); else { await fs.copyFile(s, d); n += 1; }
  }
  return n;
}

/** Packages into a registered/linked project: Unity - ima_unity.json packages, Godot - ima_package.json packages. */
export async function sendPackages({ project, engine = null, sources, build = false, withMcp = false, log = () => {} }) {
  const p = await resolveProject(project, engine);
  if (p.engine === 'unity') {
    const { sendToUnity } = await unitySender();
    const res = await sendToUnity({ project: p.path, sources, build, withMcp, log });
    return { engine: 'unity', project: p, ...res };
  }
  if (p.engine === 'unreal') {
    // source packages ride into the project; the importer turns them into assets during test
    const packages = []; const tmp = [];
    try {
      for (const src of sources) {
        let root = path.resolve(src);
        if (root.toLowerCase().endsWith('.zip')) {
          const t = await fs.mkdtemp(path.join(os.tmpdir(), 'imaginarium_unreal_send_'));
          tmp.push(t);
          root = await unzipTo(root, t);
        }
        const found = await findWith(root, 'ima_unreal.json');
        if (!found.length) throw new Error(`${src} has no ima_unreal.json - not a studio Unreal package (profile unreal).`);
        for (const dir of found) {
          const man = await readJson(path.join(dir, 'ima_unreal.json'), {});
          const id = man?.asset?.id || path.basename(dir);
          const dest = path.join(p.path, 'ImaginariumPackages', id);
          const files = await copyOver(dir, dest);
          packages.push({ asset_id: id, dest, manifest: path.join(dest, 'ima_unreal.json'), files });
          log(`Package ${id}: ${files} files -> ${dest}`);
        }
      }
    } finally { for (const t of tmp) await fs.rm(t, { recursive: true, force: true }); }
    return { engine: 'unreal', project: p, packages, note: 'assets materialize on the next test run (UnrealEditor-Cmd -run=pythonscript)' };
  }
  if (p.engine === 'bevy') {
    // packages ride into the project's asset server; the headless check (or the honest skip) is part of every send
    const bevy = await bevyLib();
    const packages = await bevy.sendBevy({ project: p.path, sources });
    for (const s of packages) log(`${s.id}: ${s.dest}`);
    return { engine: 'bevy', project: p, packages, note: 'one app.add_imaginarium_asset line plays them (docs/forge/bevy.md)' };
  }
  if (!GODOT_EXE) throw new Error('Godot not found (IMAGINARIUM_GODOT or godot on PATH).');
  const packages = [];
  const tmp = [];
  try {
    for (const src of sources) {
      let root = path.resolve(src);
      if (root.toLowerCase().endsWith('.zip')) {
        const t = await fs.mkdtemp(path.join(os.tmpdir(), 'imaginarium_godot_send_'));
        tmp.push(t);
        root = await unzipTo(root, t);
      }
      const found = await findWith(root, 'ima_package.json');
      if (!found.length) throw new Error(`${src} has no ima_package.json - not a studio Godot package (profiles godot, space_quest).`);
      for (const dir of found) {
        const meta = await readJson(path.join(dir, 'ima_package.json'), {});
        const id = meta.asset_id || path.basename(dir);
        const dest = path.join(p.path, 'imaginarium', id);
        const files = await copyOver(dir, dest);
        packages.push({ asset_id: id, dest, scene: `res://imaginarium/${id}/${id}.tscn`, files });
        log(`Package ${id}: ${files} files -> ${dest}`);
      }
    }
  } finally {
    for (const t of tmp) await fs.rm(t, { recursive: true, force: true });
  }
  const r = run(GODOT_EXE, ['--headless', '--path', p.path, '--import'], { timeoutMs: 15 * 60 * 1000 });
  log(`Godot: import ${r.seconds} s (code ${r.code})`);
  return { engine: 'godot', project: p, packages, import: { code: r.code, seconds: r.seconds } };
}

// ------------------------------------------------------------------ test

function parseNUnit(xmlText) {
  const m = /<test-run[^>]*>/.exec(xmlText || '');
  if (!m) return null;
  const attr = (n) => new RegExp(`${n}="([^"]*)"`).exec(m[0])?.[1];
  const failures = [...(xmlText.matchAll(/<test-case[^>]*fullname="([^"]+)"[^>]*result="Failed"[^>]*>[\s\S]*?<message><!\[CDATA\[([\s\S]*?)\]\]>/g))]
    .slice(0, 10).map((x) => ({ test: x[1], message: x[2].trim().slice(0, 300) }));
  return { result: attr('result'), total: +attr('total') || 0, passed: +attr('passed') || 0, failed: +attr('failed') || 0, skipped: +attr('skipped') || 0, failures };
}

/**
 * Background tests. Unity: Imaginarium package check (ImaginariumBatch.Validate: prefabs, materials, avatars, clips, sockets,
 * FX, LOD, sizes, screenshots) + the project's own EditMode tests (Unity Test Framework) - both in -batchmode.
 * Godot: headless import + imaginarium_engine_check.gd (every scene under res://imaginarium and res://scenes loads, instances
 * and runs N frames; animations, errors) + tests/run_tests.gd when present; --shots renders off-screen.
 */
export async function testProject({ project, engine = null, shots = false, scene = null, frames = 120, playMode = false, log = () => {} }) {
  const p = await resolveProject(project, engine);
  const outDir = path.join(ENGINES_HOME, 'reports', `${slug(p.name)}_${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.mkdir(outDir, { recursive: true });
  if (p.engine === 'bevy') {
    const bevy = await bevyLib();
    const root = path.join(p.path, 'assets', 'imaginarium');
    let slugs = [];
    try { slugs = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name); } catch { /* no packages yet */ }
    const results = [];
    for (const id of slugs) {
      const r = await bevy.testBevy({ project: p.path, slug: id, out: path.join(outDir, id), log });
      results.push({ slug: id, ok: !!r.ok, skipped: r.skipped || null, checks: r.report?.checks || [], shots: r.report?.shots || [] });
    }
    const allSkipped = results.length > 0 && results.every((r) => r.skipped);
    return { ok: results.every((r) => r.ok || r.skipped), engine: 'bevy', project: p, report_dir: outDir, results,
      note: !results.length ? 'no packages in the project yet: imaginarium_engine.mjs send first.'
        : allSkipped ? 'cargo is not on PATH - the check skipped everywhere; the packages themselves are unchanged.' : null };
  }
  if (p.engine === 'unreal') {
    const exe = unrealExe();
    if (!exe) return { ok: false, engine: 'unreal', project: p, report_dir: outDir,
      error: 'Unreal Editor not found: install UE 5.x or set IMAGINARIUM_UNREAL to UnrealEditor-Cmd. The package contract itself is proven by tests/unreal.test.mjs at the data level (docs/product/unreal.md).' };
    const lock = path.join(p.path, '.ima_unreal.lock');
    if (existsSync(lock)) return { ok: false, engine: 'unreal', project: p, report_dir: outDir,
      error: `Another background Unreal run holds ${lock}; if none is running, delete the file and retry.` };
    const pkgsRoot = path.join(p.path, 'ImaginariumPackages');
    const pkgDirs = existsSync(pkgsRoot) ? (await fs.readdir(pkgsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(pkgsRoot, d.name)) : [];
    const results = [];
    await writeJson(lock, { pid: process.pid, started: now() });
    try {
      for (const dir of pkgDirs) {
        const man = path.join(dir, 'ima_unreal.json');
        if (!existsSync(man)) continue;
        const script = path.join(outDir, `import_${path.basename(dir)}.py`);
        await fs.writeFile(script, [
          'import sys',
          `sys.path.insert(0, ${JSON.stringify(path.join(p.path, 'Plugins', 'Imaginarium', 'Content', 'Python'))})`,
          'import imaginarium_unreal as au',
          `report = au.import_package(${JSON.stringify(man)})`,
          'from imaginarium_unreal import check as ck',
          `ck.check_package(${JSON.stringify(man)})`,
          'print("IMAGINARIUM_UNREAL " + __import__("json").dumps(report))',
        ].join('\n'));
        log(`Unreal: importing ${path.basename(dir)} (UnrealEditor-Cmd -run=pythonscript)...`);
        const r = run(exe, [path.join(p.path, findUproject(p.path)), '-run=pythonscript', `-script=${script}`,
          '-nullrhi', '-unattended', '-nosplash', `-log-file=${path.join(outDir, `${path.basename(dir)}.log`)}`], { timeoutMs: 40 * 60 * 1000 });
        const check = await readJson(path.join(dir, 'unreal_check.json'), null);
        results.push({ asset: path.basename(dir), exit: r.code, seconds: r.seconds, check,
          log: path.join(outDir, `${path.basename(dir)}.log`),
          note: /already open|being used by another process|Failed to mount/i.test(r.out || '')
            ? 'The project may be open in the editor: close it and retry - the log-lock guard refuses a second background run.' : null });
      }
    } finally {
      rmSync(lock, { force: true });
    }
    return { ok: results.length > 0 && results.every((x) => x.check && x.check.ok), engine: 'unreal', project: p,
      report_dir: outDir, results, ...(results.length ? {} : { note: 'no sent packages to test: run send first' }) };
  }
  if (p.engine === 'unity') {
    if (unityOpen(p.path)) {
      return { ok: null, engine: 'unity', project: p, open_in_editor: true,
        note: 'The project is open in the Unity editor: batchmode is impossible. Run tests through UnityMCP (run_tests, read_console) or close the editor.' };
    }
    const exe = unityExe(unityVersionOf(p.path));
    if (!exe) throw new Error('No Unity editor of this version.');
    const shotsDir = path.join(outDir, 'shots');
    const report = path.join(outDir, 'imaginarium_report.json');
    log('Unity: Imaginarium package check (batchmode)...');
    const v = run(exe, ['-batchmode', '-projectPath', p.path, '-executeMethod', 'Imaginarium.Editor.ImaginariumBatch.Validate',
      '-imaReport', report, ...(shots ? ['-imaShots', shotsDir] : []), '-logFile', path.join(outDir, 'validate.log'), '-quit']);
    const unityReport = await readJson(report, null);
    const results = {};
    for (const platform of playMode ? ['EditMode', 'PlayMode'] : ['EditMode']) {
      log(`Unity: ${platform} tests (batchmode)...`);
      const xml = path.join(outDir, `tests_${platform}.xml`);
      const t = run(exe, ['-batchmode', '-projectPath', p.path, '-runTests', '-testPlatform', platform, '-testResults', xml,
        '-logFile', path.join(outDir, `tests_${platform}.log`)]);
      results[platform] = existsSync(xml) ? parseNUnit(await fs.readFile(xml, 'utf8')) : { result: 'NoResults', exit: t.code };
    }
    const assetsOk = !unityReport || ima.assets.length === 0 || ima.ok;
    const testsOk = Object.values(results).every((r) => r && (r.failed || 0) === 0 && r.result !== 'NoResults');
    return { ok: assetsOk && testsOk, engine: 'unity', project: p, report_dir: outDir,
      imaginarium: af ? { ok: ima.ok, pipeline: ima.pipeline, assets: ima.assets.map((a) => ({ asset_id: a.asset_id, ok: a.ok, failed: a.checks.filter((c) => !c.ok && c.severity === 'error').map((c) => `${c.name}: ${c.value}`) })), console_errors: ima.console_errors.slice(0, 10), contact_sheet: ima.contact_sheet } : { exit: v.code },
      tests: results, seconds: v.seconds };
  }
  // Godot
  if (!GODOT_EXE) throw new Error('Godot not found (IMAGINARIUM_GODOT or godot on PATH).');
  const checkRes = 'res://.imaginarium_check.gd';
  const checkFile = path.join(p.path, '.imaginarium_check.gd');
  await fs.copyFile(CHECK_GD, checkFile);
  const resultFile = path.join(outDir, 'godot_check.json');
  try {
    log('Godot: import (headless)...');
    const imp = run(GODOT_EXE, ['--headless', '--path', p.path, '--import'], { timeoutMs: 15 * 60 * 1000 });
    log('Godot: Imaginarium and project scenes (headless)...');
    const args = ['--headless', '--path', p.path, '--script', checkRes, '--', `--out=${resultFile}`, `--frames=${frames}`];
    if (scene) args.push(`--scene=${scene}`);
    const c = run(GODOT_EXE, args, { timeoutMs: 15 * 60 * 1000 });
    const res = await readJson(resultFile, null);
    const engineErrors = c.out.split('\n').filter((l) => /^\s*(ERROR|SCRIPT ERROR|USER ERROR|Parse Error)/.test(l)).slice(0, 20);
    let own = null;
    if (existsSync(path.join(p.path, 'tests', 'run_tests.gd'))) {
      log('Godot: tests/run_tests.gd (headless)...');
      const t = run(GODOT_EXE, ['--headless', '--path', p.path, '--script', 'res://tests/run_tests.gd'], { timeoutMs: 20 * 60 * 1000 });
      own = { exit: t.code, ok: t.code === 0, tail: t.out.trim().split('\n').slice(-15) };
    }
    const shotsOut = [];
    if (shots && res?.scenes?.length) {
      for (const s of res.scenes.filter((x) => x.ok).slice(0, 8)) {
        const png = path.join(outDir, 'shots', `${path.basename(s.path, '.tscn')}.png`);
        await fs.mkdir(path.dirname(png), { recursive: true });
        // a real window is needed to render, placed far off-screen: nothing appears on the owner's desktop
        const gui = IS_WIN ? GODOT_EXE.replace('_console.exe', '.exe') : GODOT_EXE;
        const sh = run(gui, ['--path', p.path, '--position', '-30000,-30000', '--resolution', '960x540',
          '--script', checkRes, '--', `--shot=${png}`, `--scene=${s.path}`, `--out=${path.join(outDir, 'shot.json')}`], { timeoutMs: 3 * 60 * 1000 });
        if (existsSync(png)) shotsOut.push(png);
        else log(`Frame of ${s.path} not taken (code ${sh.code}).`);
      }
    }
    const ok = !!res && res.ok && engineErrors.length === 0 && (!own || own.ok);
    return { ok, engine: 'godot', project: p, report_dir: outDir, import: { code: imp.code, seconds: imp.seconds }, check: res,
      engine_errors: engineErrors, own_tests: own, shots: shotsOut, seconds: c.seconds };
  } finally {
    await fs.rm(checkFile, { force: true });
    await fs.rm(checkFile + '.uid', { force: true });
  }
}

// ------------------------------------------------------------------ scaffold (game logic templates)

export const TEMPLATES_DIR = path.join(APP_DIR, 'ai', 'skills', 'imaginarium-integrator', 'templates');

/**
 * Game logic for an Imaginarium asset: kind 'player' = character controller + smoke tests (Unity: Assets/Game with
 * asmdefs and EditMode tests; Godot: res://scripts/player_controller.gd + res://tests/run_tests.gd). Existing files are
 * kept unless force; __PLAYER_ID__ becomes the asset id.
 */
export async function scaffold({ project, engine = null, kind = 'player', assetId, force = false, log = () => {} }) {
  if (kind !== 'player') throw new Error('kind: only the player template exists so far (character controller + tests).');
  if (!/^[a-z][a-z0-9_]*$/.test(assetId || '')) throw new Error(`A character asset_id is required (snake_case): ${assetId}`);
  const p = await resolveProject(project, engine);
  const src = p.engine === 'bevy' ? (await bevyLib()).BEVY_TEMPLATE_DIR : path.join(TEMPLATES_DIR, p.engine);
  const dst = p.engine === 'unity' ? path.join(p.path, 'Assets') : p.path;
  const need = p.engine === 'unity' ? path.join(p.path, 'Assets', 'Imaginarium', assetId)
    : p.engine === 'bevy' ? path.join(p.path, 'assets', 'imaginarium', assetId)
    : path.join(p.path, 'imaginarium', assetId);
  if (!existsSync(need)) throw new Error(`Asset ${assetId} is not in the project (${need}): send it first.`);
  const written = []; const kept = [];
  async function walk(from, to) {
    await fs.mkdir(to, { recursive: true });
    for (const e of await fs.readdir(from, { withFileTypes: true })) {
      const s = path.join(from, e.name); const d = path.join(to, e.name);
      if (e.isDirectory()) { await walk(s, d); continue; }
      if (p.engine === 'bevy' && e.name === 'Cargo.toml') continue;   // the project's manifest is its own - the template's must never clobber it
      if (existsSync(d) && !force) { kept.push(d); continue; }
      await fs.writeFile(d, (await fs.readFile(s, 'utf8')).replaceAll('__PLAYER_ID__', assetId));
      written.push(d);
    }
  }
  await walk(src, dst);
  log(`player logic for ${assetId} (${p.engine}): wrote ${written.length}, kept as-is ${kept.length}`);
  return { project: p, kind, asset_id: assetId, written, kept };
}

// ------------------------------------------------------------------ status, MCP registration

function claudeConfig() {
  try { return JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); } catch { return {}; }
}

export async function status() {
  const editors = existsSync(UNITY_EDITORS) ? (await fs.readdir(UNITY_EDITORS)).filter((v) => existsSync(path.join(UNITY_EDITORS, v, 'Editor', 'Unity.exe'))) : [];
  const servers = Object.keys(claudeConfig().mcpServers || {});
  const lic = path.join(process.env.LOCALAPPDATA || '', 'Unity', 'licenses', 'UnityEntitlementLicense.xml');
  const bevy = await (await bevyLib()).bevyStatus();
  return {
    unity: { editors, default: editors.includes(UNITY_DEFAULT) ? UNITY_DEFAULT : editors.sort().at(-1) || null,
      license_modified: existsSync(lic) ? (await fs.stat(lic)).mtime.toISOString() : null },
    godot: { exe: GODOT_EXE, found: !!GODOT_EXE },
    unreal: { exe: unrealExe(), found: !!unrealExe(), plugin: path.join(APP_DIR, 'unreal', 'Imaginarium'),
      note: unrealExe() ? null : 'Unreal Editor not found; packages build and travel anyway (docs/product/unreal.md).' },
    bevy,
    mcp: { imaginarium: servers.includes('imaginarium'), UnityMCP: servers.includes('UnityMCP'), godot: servers.includes('godot'),
      'unreal-mcp': servers.includes('unreal-mcp'), bevy_brp_mcp: servers.includes('bevy_brp_mcp'),
      note: servers.includes('UnityMCP') && servers.includes('godot') ? null : 'Engine MCP servers are missing: node scripts/engines/imaginarium_engine.mjs mcp-register' },
    projects: await listProjects(),
    registry: REGISTRY,
  };
}

/** Idempotent: UnityMCP (MCP for Unity, stdio, telemetry off) and godot (Godot MCP) in the user scope of Claude Code. */
export async function registerMcp({ log = () => {}, installBevyBrp = false } = {}) {
  const { UNITY_MCP_VERSION } = await unitySender();
  const have = Object.keys(claudeConfig().mcpServers || {});
  const done = [];
  const claude = IS_WIN ? 'claude.exe' : 'claude';
  const cli = (args) => spawnSync(claude, args, { encoding: 'utf8', windowsHide: true, shell: false });
  if (!have.includes('UnityMCP')) {
    const r = cli(['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'UnityMCP', '-e', 'UNITY_MCP_DISABLE_TELEMETRY=true',
      '-e', 'UNITY_MCP_TRANSPORT=stdio', '--', UVX, '--from', `mcpforunityserver==${UNITY_MCP_VERSION}`, 'mcp-for-unity', '--transport', 'stdio']);
    done.push({ server: 'UnityMCP', ok: r.status === 0, out: (r.stdout || r.stderr || r.error?.message || '').trim().split('\n')[0] });
  }
  if (!have.includes('godot') && GODOT_EXE && existsSync(GODOT_MCP)) {
    const r = cli(['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'godot', '-e', `GODOT_PATH=${GODOT_EXE}`, '--', 'node', GODOT_MCP]);
    done.push({ server: 'godot', ok: r.status === 0, out: (r.stdout || r.stderr || r.error?.message || '').trim().split('\n')[0] });
  }
  if (!have.includes('unreal-mcp')) {
    if (UNREAL_MCP && existsSync(UNREAL_MCP)) {
      const r = cli(['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'unreal-mcp', '--', 'node', UNREAL_MCP]);
      done.push({ server: 'unreal-mcp', ok: r.status === 0, out: (r.stdout || r.stderr || r.error?.message || '').trim().split('\n')[0] });
    } else {
      log('unreal-mcp: skipped - set IMAGINARIUM_UNREAL_MCP to the server entry point to register it (create/send/test work without MCP).');
    }
  }
  if (!have.includes('bevy_brp_mcp')) {
    const bevy = await bevyLib();
    const bridge = bevy.brpBinary();
    if (!existsSync(bridge) && installBevyBrp) {
      try { await bevy.installBrpMcp({ log }); }
      catch (e) { log(`bevy_brp_mcp: install refused/failed - ${e.message}`); }
    }
    if (existsSync(bridge)) {
      const r = cli(['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'bevy_brp_mcp', '--', bridge]);
      done.push({ server: 'bevy_brp_mcp', ok: r.status === 0, out: (r.stdout || r.stderr || r.error?.message || '').trim().split('\n')[0] });
    } else {
      log('bevy_brp_mcp: not installed - mcp-register with installBevyBrp (CLI --install-bevy-brp) installs it from the checksum-pinned crate; create/send/test work without the bridge.');
    }
  }
  for (const d of done) log(`${d.server}: ${d.ok ? 'registered' : 'failed'} - ${d.out}`);
  if (!done.length) log('UnityMCP and godot are already registered.');
  return { registered: done, servers: Object.keys(claudeConfig().mcpServers || {}).filter((s) => ['imaginarium', 'UnityMCP', 'godot', 'unreal-mcp', 'bevy_brp_mcp'].includes(s)) };
}

// ------------------------------------------------------------------ CLI

function parse(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['with-mcp', 'build', 'shots', 'json', 'playmode', 'force', 'install-bevy-brp'].includes(k)) flags[k] = true;
      else flags[k] = argv[++i];
    } else rest.push(a);
  }
  return { flags, rest };
}

async function main(argv) {
  const [cmd, ...more] = argv;
  const { flags, rest } = parse(more);
  const log = flags.json ? () => {} : (s) => console.log(s);
  let res;
  switch (cmd) {
    case 'status': res = await status(); break;
    case 'projects': res = await listProjects(); break;
    case 'create': res = await createProject({ engine: flags.engine, name: flags.name, dir: flags.path, pipeline: flags.pipeline || 'urp', renderer: flags.renderer, withMcp: !!flags['with-mcp'], log }); break;
    case 'link': res = await linkProject({ dir: flags.path || rest[0], name: flags.name }); break;
    case 'send': res = await sendPackages({ project: flags.project, engine: flags.engine || null, sources: rest, build: !!flags.build, withMcp: !!flags['with-mcp'], log }); break;
    case 'test': res = await testProject({ project: flags.project, engine: flags.engine || null, shots: !!flags.shots, scene: flags.scene || null, frames: +(flags.frames || 120), playMode: !!flags.playmode, log }); break;
    case 'scaffold': res = await scaffold({ project: flags.project, engine: flags.engine || null, kind: flags.kind || 'player', assetId: flags.asset, force: !!flags.force, log }); break;
    case 'mcp-register': res = await registerMcp({ log, installBevyBrp: !!flags['install-bevy-brp'] }); break;
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      return cmd ? 2 : 0;
  }
  console.log(flags.json ? JSON.stringify(res, null, 2) : JSON.stringify(res, null, 1).slice(0, 6000));
  return res && res.ok === false ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}
