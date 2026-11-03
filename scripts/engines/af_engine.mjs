#!/usr/bin/env node
// AstraForge <-> game engines (Unity, Godot): projects, asset delivery and background tests - no editor windows.
//
//   node scripts/engines/af_engine.mjs status
//   node scripts/engines/af_engine.mjs projects
//   node scripts/engines/af_engine.mjs create --engine unity|godot --name <Name> [--path <folder>] [--pipeline urp|builtin]
//                                             [--renderer forward_plus|mobile|gl_compatibility] [--with-mcp]
//   node scripts/engines/af_engine.mjs link   --path <project folder> [--name <Name>]
//   node scripts/engines/af_engine.mjs send   --project <name|folder> [--engine unity|godot] <package | export.zip> [...] [--build]
//   node scripts/engines/af_engine.mjs test   --project <name|folder> [--engine unity|godot] [--shots] [--playmode] [--scene res://...]
//   node scripts/engines/af_engine.mjs scaffold --project <name|folder> [--engine ...] --kind player --asset <asset_id> [--force]
//   node scripts/engines/af_engine.mjs mcp-register        # UnityMCP + godot in Claude Code (user scope), idempotent
//
// Projects are remembered in <engines home>/projects.json (name, engine, path, versions); the home is
// ASTRA_ENGINES_HOME, C:\AstraForge\engines on Windows and <app>/data/engines elsewhere. Unity runs only in
// -batchmode, Godot only --headless; Godot screenshots come from a window placed off-screen. When the project
// is open in the Unity editor, batchmode is impossible: the result says so and points at the UnityMCP tools.
// Godot is found via ASTRA_GODOT (paths-env idiom), then the Windows default, then PATH (godot, godot4).
import { promises as fs, existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(HERE, '..', '..');
const IS_WIN = process.platform === 'win32';
export const ENGINES_HOME = process.env.ASTRA_ENGINES_HOME || (IS_WIN ? 'C:/AstraForge/engines' : path.join(APP_DIR, 'data', 'engines'));
export const REGISTRY = path.join(ENGINES_HOME, 'projects.json');
export const DEFAULT_PROJECTS_DIR = path.join(ENGINES_HOME, 'projects');
const UNITY_EDITORS = 'C:/Program Files/Unity/Hub/Editor';
const UNITY_DEFAULT = '6000.0.64f1';
export const GODOT_EXE = godotExe();
const GODOT_MCP = process.env.ASTRA_GODOT_MCP || 'C:/Dorn/Dops media/tools/godot-mcp/build/index.js';
const UVX = process.env.ASTRA_UVX || (IS_WIN ? 'C:/Users/doron/AppData/Local/hermes/bin/uvx.exe' : 'uvx');
const CHECK_GD = path.join(HERE, 'godot', 'af_engine_check.gd');

/** ASTRA_GODOT wins; then the vendored Windows console build; then PATH (the Linux idiom of docs/linux.md). */
function godotExe() {
  if (process.env.ASTRA_GODOT && existsSync(process.env.ASTRA_GODOT)) return process.env.ASTRA_GODOT;
  if (IS_WIN && existsSync('C:/Dorn/Game Dev/Godot_v4.5.1-stable_win64_console.exe')) return 'C:/Dorn/Game Dev/Godot_v4.5.1-stable_win64_console.exe';
  for (const name of ['godot', 'godot4']) {
    const found = spawnSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8' });
    const p = found.status === 0 && found.stdout.split(/\r?\n/)[0];
    if (p && existsSync(p.trim())) return p.trim();
  }
  return null;
}

/** The Unity sender belongs to the Unity line (scripts/unity); loaded only when a Unity command runs. */
async function unitySender() {
  try {
    return await import('../unity/af_unity_send.mjs');
  } catch {
    throw new Error('The Unity importer (scripts/unity/af_unity_send.mjs) is not available on this install.');
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
  return null;
}

function unityVersionOf(dir) {
  try { return /m_EditorVersion:\s*(\S+)/.exec(readFileSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8'))?.[1] || null; } catch { return null; }
}

export function unityExe(version) {
  const env = process.env.ASTRA_UNITY;
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
  if (!found) throw new Error(`Not a Unity or Godot project: ${dir}`);
  return { name: byName?.name || path.basename(dir), engine: found, path: dir };
}

// ------------------------------------------------------------------ create / link

export async function createProject({ engine, name, dir, pipeline = 'urp', renderer = 'forward_plus', withMcp = false, log = () => {} }) {
  if (!['unity', 'godot'].includes(engine)) throw new Error('engine: unity or godot.');
  const projName = slug(name);
  const target = path.resolve(dir || path.join(DEFAULT_PROJECTS_DIR, `${projName}_${engine === 'unity' ? 'Unity' : 'Godot'}`));
  if (existsSync(target) && (await fs.readdir(target)).length) {
    const existing = detectEngine(target);
    if (existing) throw new Error(`The folder already holds a ${existing} project: ${target}. Bind it with link.`);
    throw new Error(`The folder is not empty: ${target}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (engine === 'unity') {
    const exe = unityExe(UNITY_DEFAULT);
    if (!exe) throw new Error('Unity not found (Unity Hub/Editor or ASTRA_UNITY).');
    const { sendToUnity, UNITY_MCP_VERSION } = await unitySender();
    const tplDir = path.join(path.dirname(exe), 'Data', 'Resources', 'PackageManager', 'ProjectTemplates');
    const tplPrefix = pipeline === 'hdrp' ? 'com.unity.template.3d-high-end-' : pipeline === 'urp' ? 'com.unity.template.3d-cross-platform-' : null;
    const tpl = tplPrefix && existsSync(tplDir) ? (await fs.readdir(tplDir)).filter((n) => n.startsWith(tplPrefix) && n.endsWith('.tgz')).sort().pop() : null;
    const logFile = path.join(os.tmpdir(), `af_unity_create_${Date.now()}.log`);
    log(`Unity: creating project ${target} (${pipeline}${tpl ? `, template ${tpl}` : ''}) in batchmode...`);
    const r = run(exe, ['-batchmode', '-createProject', target, ...(tpl ? ['-cloneFromTemplate', path.join(tplDir, tpl)] : []), '-logFile', logFile, '-quit']);
    const logText = existsSync(logFile) ? await fs.readFile(logFile, 'utf8') : '';
    if (/No valid Unity Editor license|Please activate your license/.test(logText)) throw new Error('Unity without a license: sign in in Unity Hub (Preferences -> Licenses).');
    if (!detectEngine(target)) throw new Error(`Unity did not create the project (code ${r.code}); log ${logFile}`);
    const sent = await sendToUnity({ project: target, sources: [], withMcp, build: false, log });
    if (!withMcp) log('The AstraForge importer is installed; for live work use --with-mcp.');
    const entry = await saveProject({ name: name || projName, engine, path: target, unity: unityVersionOf(target), pipeline, importer: sent.importer.version, unity_mcp: withMcp ? UNITY_MCP_VERSION : null });
    return { ...entry, seconds: r.seconds };
  }
  // Godot: a project is a folder with project.godot; the first --import builds .godot/
  if (!GODOT_EXE) throw new Error('Godot not found (ASTRA_GODOT or godot on PATH).');
  const method = { forward_plus: 'forward_plus', mobile: 'mobile', gl_compatibility: 'gl_compatibility' }[renderer] || 'forward_plus';
  const feature = { forward_plus: 'Forward Plus', mobile: 'Mobile', gl_compatibility: 'GL Compatibility' }[method];
  await fs.mkdir(path.join(target, 'astraforge'), { recursive: true });
  for (const d of ['scenes', 'scripts', 'tests']) await fs.mkdir(path.join(target, d), { recursive: true });
  await fs.writeFile(path.join(target, 'project.godot'), [
    '; Engine configuration file.', '; Created by AstraForge (scripts/engines/af_engine.mjs).', '', 'config_version=5', '',
    '[application]', '', `config/name="${String(name || projName).replace(/"/g, '\\"')}"`, `config/features=PackedStringArray("4.5", "${feature}")`, '',
    '[rendering]', '', `renderer/rendering_method="${method}"`, `renderer/rendering_method.mobile="${method === 'forward_plus' ? 'mobile' : method}"`, '',
  ].join('\n'));
  await fs.writeFile(path.join(target, 'astraforge', 'README.md'),
    '# AstraForge\n\nStudio asset packages (godot_package): `res://astraforge/<asset_id>/<asset_id>.tscn`. Updated by `af_engine.mjs send`.\n');
  await fs.writeFile(path.join(target, '.gitignore'), '.godot/\n*.translation\n');
  const r = run(GODOT_EXE, ['--headless', '--path', target, '--import'], { timeoutMs: 10 * 60 * 1000 });
  log(`Godot: project ${target} (${feature}), import ${r.seconds} s`);
  const entry = await saveProject({ name: name || projName, engine, path: target, godot: '4.5', renderer: method });
  return { ...entry, seconds: r.seconds };
}

export async function linkProject({ dir, name }) {
  const target = path.resolve(dir);
  const engine = detectEngine(target);
  if (!engine) throw new Error(`Not a Unity or Godot project: ${target}`);
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

/** Packages into a registered/linked project: Unity - af_unity.json packages, Godot - af_package.json packages. */
export async function sendPackages({ project, engine = null, sources, build = false, withMcp = false, log = () => {} }) {
  const p = await resolveProject(project, engine);
  if (p.engine === 'unity') {
    const { sendToUnity } = await unitySender();
    const res = await sendToUnity({ project: p.path, sources, build, withMcp, log });
    return { engine: 'unity', project: p, ...res };
  }
  if (!GODOT_EXE) throw new Error('Godot not found (ASTRA_GODOT or godot on PATH).');
  const packages = [];
  const tmp = [];
  try {
    for (const src of sources) {
      let root = path.resolve(src);
      if (root.toLowerCase().endsWith('.zip')) {
        const t = await fs.mkdtemp(path.join(os.tmpdir(), 'af_godot_send_'));
        tmp.push(t);
        root = await unzipTo(root, t);
      }
      const found = await findWith(root, 'af_package.json');
      if (!found.length) throw new Error(`${src} has no af_package.json - not a studio Godot package (profiles godot, space_quest).`);
      for (const dir of found) {
        const meta = await readJson(path.join(dir, 'af_package.json'), {});
        const id = meta.asset_id || path.basename(dir);
        const dest = path.join(p.path, 'astraforge', id);
        const files = await copyOver(dir, dest);
        packages.push({ asset_id: id, dest, scene: `res://astraforge/${id}/${id}.tscn`, files });
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
 * Background tests. Unity: AstraForge package check (AFBatch.Validate: prefabs, materials, avatars, clips, sockets,
 * FX, LOD, sizes, screenshots) + the project's own EditMode tests (Unity Test Framework) - both in -batchmode.
 * Godot: headless import + af_engine_check.gd (every scene under res://astraforge and res://scenes loads, instances
 * and runs N frames; animations, errors) + tests/run_tests.gd when present; --shots renders off-screen.
 */
export async function testProject({ project, engine = null, shots = false, scene = null, frames = 120, playMode = false, log = () => {} }) {
  const p = await resolveProject(project, engine);
  const outDir = path.join(ENGINES_HOME, 'reports', `${slug(p.name)}_${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.mkdir(outDir, { recursive: true });
  if (p.engine === 'unity') {
    if (unityOpen(p.path)) {
      return { ok: null, engine: 'unity', project: p, open_in_editor: true,
        note: 'The project is open in the Unity editor: batchmode is impossible. Run tests through UnityMCP (run_tests, read_console) or close the editor.' };
    }
    const exe = unityExe(unityVersionOf(p.path));
    if (!exe) throw new Error('No Unity editor of this version.');
    const shotsDir = path.join(outDir, 'shots');
    const report = path.join(outDir, 'astraforge_report.json');
    log('Unity: AstraForge package check (batchmode)...');
    const v = run(exe, ['-batchmode', '-projectPath', p.path, '-executeMethod', 'AstraForge.Editor.AFBatch.Validate',
      '-afReport', report, ...(shots ? ['-afShots', shotsDir] : []), '-logFile', path.join(outDir, 'validate.log'), '-quit']);
    const af = await readJson(report, null);
    const results = {};
    for (const platform of playMode ? ['EditMode', 'PlayMode'] : ['EditMode']) {
      log(`Unity: ${platform} tests (batchmode)...`);
      const xml = path.join(outDir, `tests_${platform}.xml`);
      const t = run(exe, ['-batchmode', '-projectPath', p.path, '-runTests', '-testPlatform', platform, '-testResults', xml,
        '-logFile', path.join(outDir, `tests_${platform}.log`)]);
      results[platform] = existsSync(xml) ? parseNUnit(await fs.readFile(xml, 'utf8')) : { result: 'NoResults', exit: t.code };
    }
    const assetsOk = !af || af.assets.length === 0 || af.ok;
    const testsOk = Object.values(results).every((r) => r && (r.failed || 0) === 0 && r.result !== 'NoResults');
    return { ok: assetsOk && testsOk, engine: 'unity', project: p, report_dir: outDir,
      astraforge: af ? { ok: af.ok, pipeline: af.pipeline, assets: af.assets.map((a) => ({ asset_id: a.asset_id, ok: a.ok, failed: a.checks.filter((c) => !c.ok && c.severity === 'error').map((c) => `${c.name}: ${c.value}`) })), console_errors: af.console_errors.slice(0, 10), contact_sheet: af.contact_sheet } : { exit: v.code },
      tests: results, seconds: v.seconds };
  }
  // Godot
  if (!GODOT_EXE) throw new Error('Godot not found (ASTRA_GODOT or godot on PATH).');
  const checkRes = 'res://.astraforge_check.gd';
  const checkFile = path.join(p.path, '.astraforge_check.gd');
  await fs.copyFile(CHECK_GD, checkFile);
  const resultFile = path.join(outDir, 'godot_check.json');
  try {
    log('Godot: import (headless)...');
    const imp = run(GODOT_EXE, ['--headless', '--path', p.path, '--import'], { timeoutMs: 15 * 60 * 1000 });
    log('Godot: AstraForge and project scenes (headless)...');
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

export const TEMPLATES_DIR = path.join(APP_DIR, 'ai', 'skills', 'astraforge-integrator', 'templates');

/**
 * Game logic for an AstraForge asset: kind 'player' = character controller + smoke tests (Unity: Assets/Game with
 * asmdefs and EditMode tests; Godot: res://scripts/player_controller.gd + res://tests/run_tests.gd). Existing files are
 * kept unless force; __PLAYER_ID__ becomes the asset id.
 */
export async function scaffold({ project, engine = null, kind = 'player', assetId, force = false, log = () => {} }) {
  if (kind !== 'player') throw new Error('kind: only the player template exists so far (character controller + tests).');
  if (!/^[a-z][a-z0-9_]*$/.test(assetId || '')) throw new Error(`A character asset_id is required (snake_case): ${assetId}`);
  const p = await resolveProject(project, engine);
  const src = path.join(TEMPLATES_DIR, p.engine);
  const dst = p.engine === 'unity' ? path.join(p.path, 'Assets') : p.path;
  const need = p.engine === 'unity' ? path.join(p.path, 'Assets', 'AstraForge', assetId) : path.join(p.path, 'astraforge', assetId);
  if (!existsSync(need)) throw new Error(`Asset ${assetId} is not in the project (${need}): send it first.`);
  const written = []; const kept = [];
  async function walk(from, to) {
    await fs.mkdir(to, { recursive: true });
    for (const e of await fs.readdir(from, { withFileTypes: true })) {
      const s = path.join(from, e.name); const d = path.join(to, e.name);
      if (e.isDirectory()) { await walk(s, d); continue; }
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
  return {
    unity: { editors, default: editors.includes(UNITY_DEFAULT) ? UNITY_DEFAULT : editors.sort().at(-1) || null,
      license_modified: existsSync(lic) ? (await fs.stat(lic)).mtime.toISOString() : null },
    godot: { exe: GODOT_EXE, found: !!GODOT_EXE },
    mcp: { astraforge: servers.includes('astraforge'), UnityMCP: servers.includes('UnityMCP'), godot: servers.includes('godot'),
      note: servers.includes('UnityMCP') && servers.includes('godot') ? null : 'Engine MCP servers are missing: node scripts/engines/af_engine.mjs mcp-register' },
    projects: await listProjects(),
    registry: REGISTRY,
  };
}

/** Idempotent: UnityMCP (MCP for Unity, stdio, telemetry off) and godot (Godot MCP) in the user scope of Claude Code. */
export async function registerMcp({ log = () => {} } = {}) {
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
  for (const d of done) log(`${d.server}: ${d.ok ? 'registered' : 'failed'} - ${d.out}`);
  if (!done.length) log('UnityMCP and godot are already registered.');
  return { registered: done, servers: Object.keys(claudeConfig().mcpServers || {}).filter((s) => ['astraforge', 'UnityMCP', 'godot'].includes(s)) };
}

// ------------------------------------------------------------------ CLI

function parse(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['with-mcp', 'build', 'shots', 'json', 'playmode', 'force'].includes(k)) flags[k] = true;
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
    case 'mcp-register': res = await registerMcp({ log }); break;
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      return cmd ? 2 : 0;
  }
  console.log(flags.json ? JSON.stringify(res, null, 2) : JSON.stringify(res, null, 1).slice(0, 6000));
  return res && res.ok === false ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}
