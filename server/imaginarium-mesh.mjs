// Ticket 46 (0.7.9 performance wave): the spawn helper for the studio's own GLB decimator,
// imaginarium-mesh-rs (native/imaginarium_mesh_rs — Rust over vendored, pinned meshoptimizer). The salvage fast
// path: what the Blender cleanup takes minutes for, this takes seconds, and it carries the
// vertex attributes through the collapse verbatim (the crate's carry-contract, proven by its
// own cargo tests).
//
// The absence posture is bevy.mjs's (ticket 30): no binary — the studio was installed without
// cargo, or the build failed — and every consumer stays on exactly the behavior from before the
// ticket. Nothing here ever downloads anything: the binary is built from source by
// installer/install.sh or by the developer, never fetched.
//
// Where the binary is: IMAGINARIUM_MESH_EXE (an explicit path, the IMAGINARIUM_* idiom of every other
// external tool), then config/paths.json (key meshTool, written by the installer build step),
// then the in-repo release build.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { root, pathsConfig } from './storage.mjs';

export const Imaginarium_MESH_REPO_BUILD = path.join('native', 'imaginarium_mesh_rs', 'target', 'release', 'imaginarium-mesh-rs');

/** Which imaginarium-mesh-rs this studio would run: { exe, source, found }. Never throws. */
export function imaginariumMeshConfig({ env = process.env, appRoot = root, exists = existsSync } = {}) {
  const forced = (env.IMAGINARIUM_MESH_EXE || '').trim();
  if (forced) return { exe: forced, source: 'env', found: exists(forced) };
  const paths = pathsConfig(appRoot);
  if (typeof paths.meshTool === 'string' && paths.meshTool.trim()) {
    const p = paths.meshTool.trim();
    return { exe: p, source: 'paths.json', found: exists(p) };
  }
  const p = path.join(appRoot, Imaginarium_MESH_REPO_BUILD);
  return { exe: p, source: 'default', found: exists(p) };
}

export function imaginariumMeshAvailable(cfg = imaginariumMeshConfig()) {
  return cfg.found;
}

/** One simplify run is seconds even on multi-million meshes; the ceiling is a guard against a
 *  wedged process, not a budget. IMAGINARIUM_MESH_EXE_TIMEOUT_S overrides (seconds). */
export function imaginariumMeshTimeoutMs(env = process.env) {
  return (Number(env.IMAGINARIUM_MESH_EXE_TIMEOUT_S) || 120) * 1000;
}

/**
 * Spawn imaginarium-mesh-rs with the given argv and collect its streams. Resolves { code, stdout,
 * stderr, timedOut } and never rejects — the caller judges, like runCargo in bevy.mjs. A run
 * past timeoutMs gets SIGKILL and timedOut: true.
 */
export function runImaginariumMesh({ exe = imaginariumMeshConfig().exe, args = [], timeoutMs = imaginariumMeshTimeoutMs(), spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String((e && e.message) || e), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, Math.max(250, timeoutMs));
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: killed });
    };
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += String((e && e.message) || e); settle(-1); });
    child.on('close', (code) => settle(code === null ? -1 : code));
  });
}

/** The `--version --json` handshake: { name, version } or null (absent / not imaginarium-mesh-rs). */
export async function imaginariumMeshInfo({ cfg = imaginariumMeshConfig(), run = runImaginariumMesh } = {}) {
  if (!cfg.found) return null;
  const r = await run({ exe: cfg.exe, args: ['--version', '--json'] });
  if (r.code !== 0) return null;
  try {
    const v = JSON.parse(r.stdout);
    return v && v.name === 'imaginarium-mesh-rs' ? v : null;
  } catch {
    return null;
  }
}
