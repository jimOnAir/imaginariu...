#!/usr/bin/env node
// Retroactive similarity audit (ADR-0004, ticket 09; docs/product/similarity-audit-0-5-1.md).
//
// Deterministic, re-runnable comparison of this repository's tracked files against the
// QUARANTINED reference trees (the extracted shipped Windows payloads, work papers excluded by
// default). For every tracked file it reports the longest contiguous token run shared with any
// reference file and the 8-gram containment in the best-matching reference file, bucketed per
// module, with the files added by the audited per-ticket wave (0.5.1) split out from the
// pre-existing tree. Nothing here judges "allowed" vs "expression": the tool numbers, the report
// classifies (license boilerplate, grandfathered verbatim artifacts, interface facts, defects).
//
//   node scripts/audit/similarity-audit.mjs [--ref <dir>] [--out <json>] [--k 8] [--trees 0.4.16,0.5.3]
//
// --ref defaults to ~/github/Imaginarium-0.4.16-ref ; the work papers (CHANGE*, CHANGED*, notes/,
// EXCLUDED.md, README.md at its root) are included only with --papers. Exit code is 0 unless the
// scan itself failed; findings never change the exit code (the suite must stay green over this).
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const REF = path.resolve(arg('ref', path.join(os.homedir(), 'github', 'Imaginarium-0.4.16-ref')));
const OUT = arg('out', null);
const K = parseInt(arg('k', '8'), 10);
const TREES = arg('trees', '0.4.16,0.5.0,0.5.1,0.5.3').split(',');
const WITH_PAPERS = argv.includes('--papers');
const MAX_TARGET = 4 * 1024 * 1024;   // skip giant tracked files (locks, minified bundles)
const POS_CAP = 64;                   // a shingle at more than this many public positions is boilerplate: not extended
const EXT_CAP = 300000;               // extension work per reference file before it is flagged boilerplate-heavy

const TEXT_EXT = new Set(['.mjs', '.js', '.jsx', '.ts', '.tsx', '.py', '.ps1', '.sh', '.bash', '.cs', '.gd',
  '.json', '.md', '.txt', '.html', '.css', '.yaml', '.yml', '.ini', '.cfg', '.toml', '.csv', '.spec', '.uplugin', '']);
const isText = (p) => { const e = path.extname(p); return TEXT_EXT.has(e) || e === '' || e === '.cmd'; };
const skipTracked = (p) => p.startsWith('.scratch/') || p.includes('node_modules/') || /(^|\/)(package-lock\.json|yarn\.lock)$/.test(p)
  || p.startsWith('assets/fonts/') || /\.(woff2?|ttf|png|jpg|jpeg|webp|glb|zip|zst|mp4|ico|blend)$/.test(p);

// The wave's own files: ADDED on this branch since the release base (files merely touched by the
// wave keep their pre-existing content and stay in the retroactive scope; their diffs were
// audited per ticket). The default a3c959d is the v0.5.0 tip (0.5.1-era runs); later waves pass
// --base with their release tag's commit (0.6.6 wave: 886ca18's predecessor, 0.6.12 wave: 886ca18).
const BASE = arg('base', 'a3c959d');
const waveFiles = new Set();
{
  const log = execFileSync('git', ['log', '--diff-filter=A', '--format=', '--name-only', `${BASE}..HEAD`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 });
  for (const f of log.split('\n')) if (f.trim()) waveFiles.add(f.trim());
}

const tokenize = (text) => text.toLowerCase().match(/[a-z0-9_а-яёё.-]+|[^\sa-z0-9_а-яё]/gi) || [];

const walk = (dir, prefix = '') => readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n);
  if (statSync(p).isDirectory()) return walk(p, prefix ? prefix + '/' + n : n);
  return [prefix ? prefix + '/' + n : n].map((rel) => ({ rel, abs: p }));
});

// - - - - - - target: the tracked public tree, shingle-indexed
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }).split('\n').filter(Boolean)
  .filter((p) => isText(p) && !skipTracked(p));
const targets = [];                                   // {file, toks, shingles:Map<hash, positions[]>}
const index = new Map();                              // hash -> packed (targetIdx<<20 | pos)
for (const file of tracked) {
  let text;
  try { if (statSync(path.join(ROOT, file)).size > MAX_TARGET) continue; text = readFileSync(path.join(ROOT, file), 'utf8'); } catch { continue; }
  const toks = tokenize(text);
  if (toks.length < K) continue;
  const tIdx = targets.length;
  targets.push({ file, toks, maxRun: 0, best: null, containment: 0, shingleCount: toks.length - K + 1 });
  const h = shingleHasher();
  for (let i = 0; i + K <= toks.length; i++) {
    const key = h(toks, i);
    let list = index.get(key);
    if (!list) index.set(key, list = []);
    if (list.length < POS_CAP) list.push(((tIdx << 20) | i) >>> 0);
    else list.push(-1);                              // boilerplate marker
  }
}
function shingleHasher() {
  return (toks, i) => {
    let a = 0x811c9dc5, b = 0x01000193;
    for (let j = i; j < i + K; j++) {
      const t = toks[j];
      for (let c = 0; c < t.length; c++) { a = ((a ^ t.charCodeAt(c)) * 0x01000193) >>> 0; b = ((b + t.charCodeAt(c) * 31) * 0x811c9dc5) >>> 0; }
    }
    return a * 4096 + (b % 4096);
  };
}

// - - - - - - corpus: every text file under the selected reference trees (+ work papers)
const corpusDirs = TREES.map((t) => path.join(REF, t)).filter(existsSync);
if (!corpusDirs.length) { console.error(`no reference trees under ${REF} (looked for ${TREES.join(',')})`); process.exit(2); }
const papers = WITH_PAPERS ? [{ rel: '_papers/CHANGE-0.5.x.md', abs: path.join(REF, 'CHANGE-0.5.x.md') },
  ...((existsSync(path.join(REF, 'notes')) ? walk(path.join(REF, 'notes')) : []).map((f) => ({ rel: '_papers/' + f.rel, abs: f.abs }))),
  ...TREES.flatMap((t) => ['CHANGED-' + t + '.txt'].map((n) => ({ rel: '_papers/' + n, abs: path.join(REF, n) })))]
  .filter((f) => existsSync(f.abs)) : [];
const corpusFiles = corpusDirs.flatMap((d) => walk(d).map((f) => ({ rel: f.rel, abs: f.abs }))).concat(papers);

let scanned = 0, unreadable = 0;
for (const cf of corpusFiles) {
  let text;
  try { if (statSync(cf.abs).size > 8 * 1024 * 1024) continue; text = readFileSync(cf.abs, 'utf8'); } catch { unreadable++; continue; }
  const toks = tokenize(text);
  if (toks.length < K) continue;
  scanned++;
  const h = shingleHasher();
  let work = 0, heavy = false;
  for (let i = 0; i + K <= toks.length && !heavy; i++) {
    const list = index.get(h(toks, i));
    if (!list) continue;
    for (const packed of list) {
      if (packed < 0) continue;                      // boilerplate shingle
      const tIdx = packed >>> 20, pos = packed & ((1 << 20) - 1);
      const t = targets[tIdx];
      work++;
      if (work > EXT_CAP) { heavy = true; break; }
      // verify & extend forward
      let run = 0;
      while (run + i < toks.length && run + pos < t.toks.length && t.toks[run + pos] === toks[run + i]) run++;
      if (run < K) continue;
      if (run > t.maxRun) {
        t.maxRun = run;
        t.best = { ref: cf.rel, refPos: i, pos, excerpt: toks.slice(i, i + Math.min(run, 40)).join(' ') };
      }
    }
  }
  if (heavy) console.error(`heavy: ${cf.rel}`);
}
// second pass for containment: shingle-set intersection against the best reference file per target
const bestCache = new Map();
for (const t of targets) {
  if (!t.best) continue;
  let set = bestCache.get(t.best.ref);
  if (!set) {
    const abs = corpusFiles.find((c) => c.rel === t.best.ref)?.abs;
    set = new Set();
    if (abs) {
      const h = shingleHasher();
      try { const toks = tokenize(readFileSync(abs, 'utf8')); for (let i = 0; i + K <= toks.length; i++) set.add(h(toks, i)); } catch { /* keep empty */ }
    }
    bestCache.set(t.best.ref, set);
  }
  const h = shingleHasher();
  let hit = 0; const own = new Set();
  for (let i = 0; i + K <= t.toks.length; i++) { const key = h(t.toks, i); if (!own.has(key)) { own.add(key); if (set.has(key)) hit++; } }
  t.containment = own.size ? hit / own.size : 0;
}

// - - - - - - aggregate per module
const MODULES = [['server/', 'server'], ['src/', 'src (UI)'], ['ai/', 'ai (mcp+skills)'], ['installer/', 'installer'],
  ['scripts/blender/', 'scripts/blender'], ['unity/', 'unity (C#)'], ['godot/', 'godot'], ['tests/', 'tests'],
  ['docs/', 'docs'], ['scripts/', 'scripts (other)']];
const moduleOf = (f) => (MODULES.find(([p]) => f.startsWith(p)) || [, 'root'])[1];
const byModule = new Map();
for (const t of targets) {
  const wave = waveFiles.has(t.file);
  const key = moduleOf(t.file) + (wave ? ' [wave]' : '');
  const m = byModule.get(key) || { files: 0, hit: 0, runs: [], worst: 0, rewrite: 0, review: 0 };
  m.files++;
  if (t.maxRun >= K) {
    m.hit++;
    m.runs.push(t.maxRun);
    m.worst = Math.max(m.worst, t.maxRun);
    if (t.maxRun >= 40 || t.containment >= 0.6) m.rewrite++; else m.review++;
  }
  byModule.set(key, m);
}
const sorted = [...byModule.entries()].sort((a, b) => (b[1].rewrite * 1e9 + b[1].worst) - (a[1].rewrite * 1e9 + a[1].worst));
console.log(`scanned ${scanned} reference files against ${targets.length} tracked files (k=${K}; bands: clean <${K} ≤ review <40 ≤ rewrite; containment ≥0.60 rewrite).`);
console.log('module                       files  hit>=8  worst  rewrite  review');
for (const [mod, m] of sorted) {
  console.log(mod.padEnd(28) + String(m.files).padStart(5) + String(m.hit).padStart(8) + String(m.worst).padStart(8) + String(m.rewrite).padStart(9) + String(m.review).padStart(8));
}
const offenders = targets.filter((t) => t.maxRun >= K).sort((a, b) => b.maxRun - a.maxRun).slice(0, parseInt(arg('top', '60'), 10));
console.log('\ntop offenders (maxRun tokens | containment | file -> reference):');
for (const t of offenders) console.log(`${String(t.maxRun).padStart(6)}  ${(t.containment || 0).toFixed(2)}  ${t.file}  ->  ${t.best.ref}  «${t.best.excerpt.slice(0, 120)}»`);
if (OUT) {
  const detail = targets.filter((t) => t.maxRun >= K).sort((a, b) => b.maxRun - a.maxRun)
    .map((t) => ({ file: t.file, wave: waveFiles.has(t.file), module: moduleOf(t.file), maxRun: t.maxRun, containment: +(t.containment || 0).toFixed(3), ref: t.best.ref, excerpt: t.best.excerpt.slice(0, 400) }));
  writeFileSync(OUT, JSON.stringify({ k: K, bands: { review: [K, 39], rewrite: [40, Infinity] }, scanned, files: targets.length, modules: Object.fromEntries(sorted), detail }, null, 1));
  console.log(`\nwrote ${OUT} (${detail.length} files with runs >= ${K})`);
}
