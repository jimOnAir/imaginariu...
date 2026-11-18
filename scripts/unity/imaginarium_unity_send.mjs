#!/usr/bin/env node
// Send Imaginarium Unity packages into a Unity project (an explicit owner request only: it writes into that project).
//
//   node scripts/unity/imaginarium_unity_send.mjs --project <Unity project> <package dir | export .zip> [...]
//        [--build]   rebuild the prefabs right away with Unity -batchmode (the project must be closed in the editor)
//        [--with-mcp] also add MCP for Unity (CoplayDev, MIT, pinned UNITY_MCP_VERSION) to the project in stdio mode,
//                    so Claude Code (server UnityMCP, docs/forge/unity.md) can drive the open editor
//        [--json]
//
// What it does:
//   1. the importer package unity/dev.imaginarium3d.unity is copied into <project>/Packages/dev.imaginarium3d.unity
//      (embedded package: the project keeps working on any machine; its .meta files keep script GUIDs stable);
//   2. every package (a folder with ima_unity.json, or an export zip of the unity profile) is copied into
//      <project>/Assets/Imaginarium/<asset_id>/ over the previous copy (files are overwritten, .meta kept, so
//      prefabs and materials keep their GUIDs and scene references survive an update);
//   3. an open editor imports the files on focus and the importer builds <asset_id>.prefab by itself;
//      --build does it now in batchmode.
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(HERE, '..', '..');
export const IMPORTER_DIR = path.join(APP_DIR, 'unity', 'dev.imaginarium3d.unity');
// Unity Hub installs editors under these roots (the same rule as scripts/blender/steps/_unity_lib.py)
export const UNITY_HUB_EDITORS = process.platform === 'win32'
  ? 'C:/Program Files/Unity/Hub/Editor' : path.join(os.homedir(), 'Unity', 'Hub', 'Editor');
const UNITY_EXE_NAME = process.platform === 'win32' ? 'Unity.exe' : 'Unity';
// MCP for Unity: the version the owner approved on 31.10.2026 (Unity package + PyPI mcpforunityserver)
export const UNITY_MCP_VERSION = '10.3.0';
export const UNITY_MCP_PACKAGE = `https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v${UNITY_MCP_VERSION}`;

async function readJson(p) {
  return JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
}

/** Folders that hold ima_unity.json under root (the package itself or an unpacked export). */
async function findPackages(root) {
  const out = [];
  async function walk(dir, depth) {
    if (existsSync(path.join(dir, 'ima_unity.json'))) { out.push(dir); return; }
    if (depth > 3) return;
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('_')) await walk(path.join(dir, e.name), depth + 1);
    }
  }
  await walk(root, 0);
  return out;
}

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

/** Copy src over dst: files are overwritten, nothing in dst is deleted (keeps Unity's .meta files). */
async function copyOver(src, dst, skip = () => false) {
  let n = 0;
  await fs.mkdir(dst, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) n += await copyOver(s, d, skip);
    else { await fs.copyFile(s, d); n += 1; }
  }
  return n;
}

function versionOf(v) {
  return String(v || '0').split('.').map((x) => parseInt(x, 10) || 0);
}

function newer(a, b) {
  const x = versionOf(a); const y = versionOf(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function projectVersion(project) {
  try {
    const txt = await fs.readFile(path.join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8');
    return /m_EditorVersion:\s*(\S+)/.exec(txt)?.[1] || null;
  } catch { return null; }
}

/**
 * @param {{project:string, sources:string[], build?:boolean, withMcp?:boolean, log?:(s:string)=>void}} opts
 * @returns {Promise<{project, importer:{action, version}, packages:[{asset_id, dest, files}], build?}>}
 */
export async function sendToUnity({ project, sources = [], build = false, withMcp = false, log = () => {} }) {
  const proj = path.resolve(project);
  if (!existsSync(path.join(proj, 'Assets')) || !existsSync(path.join(proj, 'ProjectSettings', 'ProjectVersion.txt'))) {
    throw new Error(`Not a Unity project (no Assets/ and ProjectSettings/ProjectVersion.txt): ${proj}`);
  }
  if (!sources?.length && !withMcp) throw new Error('No package given (a folder with ima_unity.json or a unity export archive).');

  // 1. the importer as an embedded package
  const ours = await readJson(path.join(IMPORTER_DIR, 'package.json'));
  const embedded = path.join(proj, 'Packages', 'dev.imaginarium3d.unity');
  let action = 'up-to-date';
  let theirs = null;
  if (existsSync(path.join(embedded, 'package.json'))) theirs = (await readJson(path.join(embedded, 'package.json'))).version;
  if (!theirs || newer(ours.version, theirs) || process.env.Imaginarium_UNITY_FORCE_IMPORTER) {
    await copyOver(IMPORTER_DIR, embedded);
    action = theirs ? `updated ${theirs} -> ${ours.version}` : `installed ${ours.version}`;
  }
  // a file: reference to the studio's folder in manifest.json would shadow the embedded copy: drop it
  const manifestPath = path.join(proj, 'Packages', 'manifest.json');
  if (existsSync(manifestPath)) {
    const m = await readJson(manifestPath);
    let changed = false;
    if (m.dependencies?.['dev.imaginarium3d.unity']) {
      delete m.dependencies['dev.imaginarium3d.unity'];
      changed = true;
    }
    if (withMcp && m.dependencies?.['com.coplaydev.unity-mcp'] !== UNITY_MCP_PACKAGE) {
      m.dependencies['com.coplaydev.unity-mcp'] = UNITY_MCP_PACKAGE;
      changed = true;
      log(`MCP for Unity ${UNITY_MCP_VERSION}: added to Packages/manifest.json`);
    }
    if (changed) await fs.writeFile(manifestPath, JSON.stringify(m, null, 2) + '\n');
  }
  log(`Importer dev.imaginarium3d.unity: ${action} (${embedded})`);

  // 2. packages
  const tmpRoots = [];
  const packages = [];
  try {
    for (const src of sources) {
      let root = path.resolve(src);
      if (!existsSync(root)) throw new Error(`No such path: ${root}`);
      if (root.toLowerCase().endsWith('.zip')) {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'imaginarium_unity_send_'));
        tmpRoots.push(tmp);
        root = await unzipTo(root, tmp);
      }
      const found = await findPackages(root);
      if (!found.length) throw new Error(`No ima_unity.json inside ${src}: not a studio Unity package (a unity profile export).`);
      for (const dir of found) {
        const pkg = await readJson(path.join(dir, 'ima_unity.json'));
        if (!/^[a-z][a-z0-9_]*$/.test(pkg.asset_id || '')) throw new Error(`Bad asset_id in ${dir}: ${pkg.asset_id}`);
        const dest = path.join(proj, 'Assets', 'Imaginarium', pkg.asset_id);
        const files = await copyOver(dir, dest, (name) => name.startsWith('_') || name === 'unity_shots');
        packages.push({ asset_id: pkg.asset_id, dest, files });
        log(`Package ${pkg.asset_id}: ${files} files -> ${dest}`);
      }
    }
  } finally {
    for (const t of tmpRoots) await fs.rm(t, { recursive: true, force: true });
  }

  // 3. the optional batchmode build (and the stdio switch of MCP for Unity)
  let buildResult;
  if (build || withMcp) {
    if (existsSync(path.join(proj, 'Temp', 'UnityLockfile'))) {
      buildResult = { ok: false, error: 'The project is open in the editor: the prefabs build themselves on focus.' };
    } else {
      const ver = await projectVersion(proj);
      const exe = process.env.IMAGINARIUM_UNITY && existsSync(process.env.IMAGINARIUM_UNITY) ? process.env.IMAGINARIUM_UNITY
        : ver ? path.join(UNITY_HUB_EDITORS, ver, 'Editor', UNITY_EXE_NAME) : null;
      if (!exe || !existsSync(exe)) {
        buildResult = { ok: false, error: `No Unity editor ${ver || ''} (Unity Hub/Editor or IMAGINARIUM_UNITY).` };
      } else {
        const logFile = path.join(proj, 'Logs', 'imaginarium_build.log');
        const method = build ? 'Imaginarium.Editor.ImaginariumBatch.BuildAll' : 'Imaginarium.Editor.ImaginariumSetup.ConfigureUnityMcp';
        const cp = spawnSync(exe, ['-batchmode', '-projectPath', proj, '-executeMethod', method,
          '-logFile', logFile, '-quit'], { stdio: 'ignore', timeout: 45 * 60 * 1000 });
        buildResult = { ok: cp.status === 0, exit: cp.status, log: logFile };
        if (cp.status === 0 && build && withMcp) {
          const cp2 = spawnSync(exe, ['-batchmode', '-projectPath', proj, '-executeMethod', 'Imaginarium.Editor.ImaginariumSetup.ConfigureUnityMcp',
            '-logFile', path.join(proj, 'Logs', 'imaginarium_mcp.log'), '-quit'], { stdio: 'ignore', timeout: 15 * 60 * 1000 });
          buildResult.mcp = cp2.status === 0;
        }
      }
    }
    log(buildResult.ok ? (build ? 'Prefabs built in batchmode.' : 'MCP for Unity switched to stdio mode.')
      : `Unity in batchmode: ${buildResult.error || `exit code ${buildResult.exit}, log ${buildResult.log}`}`);
  } else {
    log('Open the project in Unity (or switch to its window): the importer builds the prefabs itself.');
  }
  return { project: proj, importer: { action, version: ours.version }, packages, build: buildResult };
}

async function main(argv) {
  const sources = [];
  let project = null;
  let build = false;
  let json = false;
  let withMcp = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') project = argv[++i];
    else if (a === '--build') build = true;
    else if (a === '--json') json = true;
    else if (a === '--with-mcp') withMcp = true;
    else if (a === '--help' || a === '-h') {
      console.log('node scripts/unity/imaginarium_unity_send.mjs --project <Unity project> <package dir | export .zip> [...] [--build] [--with-mcp] [--json]');
      return 0;
    } else sources.push(a);
  }
  if (!project) { console.error('Specify --project <the Unity project folder>.'); return 2; }
  try {
    const res = await sendToUnity({ project, sources, build, withMcp, log: json ? () => {} : (s) => console.log(s) });
    if (json) console.log(JSON.stringify(res, null, 2));
    return res.build && !res.build.ok ? 1 : 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
