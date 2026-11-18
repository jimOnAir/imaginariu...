#!/usr/bin/env node
// Model weights already on this computer, connected without copying (0.7.1 wave ticket 40, after
// the Windows 0.7 note "weights other programs already downloaded are connected without copying").
// The branch's own shape: scan well-known Linux homes (extra folders the user names in
// IMAGINARIUM_WEIGHT_DIRS, a sibling ~/ComfyUI, the Hugging Face hub cache, a StabilityMatrix data
// folder, a sibling Imaginarium), match the installer manifest's model pins by NAME + BYTE SIZE
// first, verify the pinned sha256 only at ACCEPT time (hashing tens of GB at scan time is not
// free), and connect by a symlink in data/models + a weightLinks record in config/paths.json.
// The user's files are never moved, copied or touched; the studio's own download logic (imaginarium_scan
// status -> install.sh checklist / Components window) sees the model as installed and simply
// does not fetch it.
//
//   node installer/imaginarium_weights.mjs --report    JSON {items:[{id,file,bytes,source,target}],total}
//   node installer/imaginarium_weights.mjs --connect   same scan, then verify + link + record each one
// Exit 0 with empty items when nothing was found; exit 2 (stderr) only on a scan failure.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelState, scanComponents } from './imaginarium_scan.mjs';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sizeOf = (p) => { try { return statSync(p).size; } catch { return -1; } };

/** Where weights may already lie, given the user's HOME and their IMAGINARIUM_WEIGHT_DIRS. Every entry
 * is a FOLDER TO LOOK UNDER (a walk finds the file by name below it); non-existent ones drop out. */
export function weightSearchDirs({ env = process.env, home = env.HOME || os.homedir(), root = APP_ROOT } = {}) {
  const out = [];
  const push = (d) => { if (d) { const p = path.resolve(d); if (!out.includes(p)) out.push(p); } };
  for (const d of String(env.IMAGINARIUM_WEIGHT_DIRS || '').split(path.delimiter)) push(d);
  if (home) {
    push(path.join(home, 'ComfyUI', 'models'));             // the classic second ComfyUI
    push(path.join(home, 'comfyui', 'models'));
    push(path.join(home, '.cache', 'huggingface', 'hub'));  // HF cache: <org-model>/snapshots/<rev>/<file>
    push(path.join(home, 'StabilityMatrix', 'Data', 'Models'));
    push(path.join(home, '.stabilitymatrix'));
  }
  push(path.join(path.dirname(root), 'Imaginarium', 'data', 'models'));  // a sibling studio copy
  return out;
}

const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', '.git', '__pycache__', '.cache', 'dist', 'build']);
const WALK_MAX_DEPTH = 6;   // the HF cache alone is hub/<org>/<snapshots>/<rev>/<file>

/** Every file under `dir` (depth-capped) named `file` and (when `size` > 0) exactly `size` bytes. */
export function findByName(dir, file, size, { maxDepth = WALK_MAX_DEPTH } = {}) {
  const hits = [];
  const stack = [[dir, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name)) stack.push([p, depth + 1]);
      } else if (e.name === file && (size <= 0 || sizeOf(p) === size)) {
        hits.push(p);
      }
    }
  }
  return hits;
}

/** The first candidate for a manifest model across the search dirs (dir order = trust order). */
export function candidatesFor(dirs, m) {
  for (const d of dirs) {
    const hits = findByName(d, m.file, m.size || 0);
    if (hits.length) return hits;
  }
  return [];
}

/** Stream-hash a file - only ever called at accept time, never during the report walk. */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

/** Where the studio would keep this model's file - the same dirs modelState searches (the
 * checkpoints default, the manifest dir, and u2net's background home). */
export function studioTarget(root, id, m) {
  const sub = id === 'u2net' ? 'background' : (m.dir || 'checkpoints');
  return path.join(root, 'data', 'models', sub, m.file);
}

/**
 * The report: for every manifest model MISSING on disk, one name+size candidate the search dirs
 * hold. `outdated` files are deliberately not offered (that is a version question, not a reuse
 * one). Bigger savings first. Synchronous by design (install.sh calls it and reads stdout).
 */
export function reportWeights({ root = APP_ROOT, env = process.env } = {}) {
  const s = scanComponents({ root, env });
  const dirs = weightSearchDirs({ env, root });
  const items = [];
  for (const [id, m] of Object.entries(s.man.models || {})) {
    const st = modelState(root, s.comfy, s.man, id);
    if (st.st !== 'missing') continue;
    const cand = candidatesFor(dirs, m)[0];
    if (cand) items.push({ id, file: m.file, bytes: m.size || sizeOf(cand), source: cand, target: studioTarget(root, id, m) });
  }
  items.sort((a, b) => b.bytes - a.bytes);
  return { items, total: items.reduce((n, x) => n + x.bytes, 0), dirs };
}

/**
 * Connect one reported candidate: verify the pinned sha256 first (a manifest without a pin is
 * refused - this branch does not link what it cannot name), then place a symlink at the studio's
 * own target. Never writes anywhere but the target; an existing REAL file at the target is never
 * replaced, a stale link of ours is re-pointed to the same bytes.
 */
export async function connectWeight({ id, file, bytes, source, target, man }) {
  const pin = man.models?.[id]?.sha256;
  if (!pin) return { ok: false, id, file, reason: 'no sha256 pinned in the manifest - not linking files the studio cannot verify' };
  let real = source;
  try { real = realpathSync(source); } catch { /* reported path stands */ }
  const sum = await sha256File(real);
  if (sum !== pin) return { ok: false, id, file, reason: 'the sha256 does not match the pin - left untouched' };
  let t = null;
  try { t = lstatSync(target); } catch { /* free */ }
  if (t && !t.isSymbolicLink()) return { ok: false, id, file, reason: 'a real file already sits at the target - left in place' };
  if (t) rmSync(target);
  mkdirSync(path.dirname(target), { recursive: true });
  symlinkSync(real, target);
  return { ok: true, id, file, bytes, source: real, target };
}

/** Record of everything this connector created (for listing/cleanup; an additive paths.json key
 * the studio ignores and imaginarium_scan does not need - the links themselves carry the truth). */
export function recordLinks(root, rows) {
  if (!rows.length) return;
  const f = path.join(root, 'config', 'paths.json');
  let cfg = {};
  try { cfg = readJson(f); } catch { /* no config yet */ }
  const known = new Map((cfg.weightLinks || []).map((r) => [r.target, r]));
  for (const r of rows) known.set(r.target, { id: r.id, file: r.file, source: r.source, target: r.target, linkedAt: new Date().toISOString().slice(0, 10) });
  cfg.weightLinks = [...known.values()];
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify(cfg, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--connect') ? 'connect' : 'report';
  try {
    const rep = reportWeights();
    if (mode === 'report') {
      process.stdout.write(`${JSON.stringify({ items: rep.items, total: rep.total })}\n`);
      process.exit(0);
    }
    const man = readJson(path.join(APP_ROOT, 'installer', 'manifest.json'));
    const connected = [], failed = [];
    for (const it of rep.items) {
      const r = await connectWeight({ id: it.id, file: it.file, bytes: it.bytes, source: it.source, target: it.target, man });
      (r.ok ? connected : failed).push(r);
    }
    recordLinks(APP_ROOT, connected);
    process.stdout.write(`${JSON.stringify({ connected, failed, savedBytes: connected.reduce((n, x) => n + x.bytes, 0) })}\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`weights scan failed: ${e.message}\n`);
    process.exit(2);
  }
}
