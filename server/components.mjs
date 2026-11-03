// The "Studio components" checklist inside the app (the 0.4.10 behavior re-derived from the 0.4.16
// reference tree, no code copied - ADR-0003). The reference ran installer\Install.ps1 -ScanList in
// powershell and installed with -Auto -Only; this Linux form calls the very same scan core the
// interactive installer uses (installer/af_scan.mjs, ticket 16) and installs in the background with
// `installer/install.sh -Yes -Profile <preset> -Only <ids>`, which streams ##PROGRESS lines and ends
// with ##DONE or ##FAILED <ids> (exit 1) - the same machine contract powershell printed.
// The reference opened the window once per version after an auto-update applied that version; this
// branch ships no auto-update mechanism, so "due" means: the studio starts on a version whose
// checklist has not been seen yet (data/update/checklist.json {version, at}).
// The reference also reported a failed background install through telemetry on finish - telemetry
// is excluded from this branch, so the job state simply carries the failed ids for the panel.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ID_RE = /^[a-z0-9]{2,20}$/;
const PROFILES = ['quick', 'full', 'lite'];

/**
 * '##ITEM' lines of the scan core: 13 tab-separated fields
 * (marker, id, group, status, have, need, bytes, name, license, presets, deps, only, note).
 * Short or foreign lines are skipped, exactly like the Setup.cs parser of the reference.
 */
export function parseScanList(text) {
  const items = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('##ITEM')) continue;
    const f = line.split('\t');
    if (f.length < 13) continue;
    items.push({
      id: f[1], group: f[2], status: f[3], have: f[4], need: f[5], size: Number(f[6]) || 0,
      name: f[7], license: f[8], presets: f[9],
      deps: f[10] ? f[10].split(',').filter(Boolean) : [],
      only: f[11] ? f[11].split(',').filter(Boolean) : [f[1]],
      note: f[12],
    });
  }
  return items;
}

export function createComponents({ appRoot, dataDir, appVersion, spawnImpl = spawn, importCore = null, log = () => {} }) {
  const updDir = path.join(dataDir, 'update');
  const readSoft = async (f) => { try { return JSON.parse((await fs.readFile(f, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; } };
  const core = importCore || (() => import(pathToFileURL(path.join(appRoot, 'installer', 'af_scan.mjs')).href));
  let job = null;
  let lastScan = null;

  const run = (args, onLine) => new Promise((resolve, reject) => {
    const child = spawnImpl('bash', [path.join(appRoot, 'installer', 'install.sh'), ...args], { cwd: appRoot });
    let out = '';
    let buf = '';
    child.stdout?.on('data', (d) => {
      const s = d.toString('utf8');
      out += s; buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        try { onLine?.(line); } catch { /* a bad line must not stop the stream */ }
      }
    });
    child.stderr?.on('data', () => {});
    child.on?.('error', reject);
    child.on?.('exit', (code) => resolve({ code, out }));
  });

  async function due() {
    const seen = await readSoft(path.join(updDir, 'checklist.json'));
    return seen?.version !== appVersion;
  }
  async function markSeen() {
    await fs.mkdir(updDir, { recursive: true });
    await fs.writeFile(path.join(updDir, 'checklist.json'), JSON.stringify({ version: appVersion, at: new Date().toISOString() }));
  }
  async function profile() {
    const p = (await readSoft(path.join(appRoot, 'config', 'paths.json')))?.profile;
    return PROFILES.includes(p) ? p : 'full';
  }

  async function scan() {
    if (job && job.code == null) throw new Error('A component install is running - wait for it to finish.');
    const c = await core();
    let lines;
    try { lines = c.itemLines(c.scanItems(c.scanComponents())); }
    catch (e) { throw new Error(`The component check failed: ${e.message} (the installer log: installer/install.log)`); }
    const items = parseScanList(lines.join('\n'));   // the panel gets exactly what the installer checklist parses
    if (!items.length) throw new Error('The component check returned nothing (the installer log: installer/install.log).');
    lastScan = { items, profile: await profile(), at: new Date().toISOString() };
    return lastScan;
  }

  /** Background install of the ticked ids; a running job is returned untouched (the reference rule). */
  async function install(ids, { profile: pr } = {}) {
    if (job && job.code == null) return state();
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((x) => ID_RE.test(x));
    if (!list.length) throw new Error('Nothing ticked.');
    const p = PROFILES.includes(pr) ? pr : await profile();
    job = { ids: list, profile: p, progress: 0, text: 'Preparing', code: null, failed: [], startedAt: new Date().toISOString() };
    await markSeen().catch(() => {});
    const cur = job;
    void run(['-Yes', '-Profile', p, '-Only', list.join(',')], (l) => {
      const m = /^##PROGRESS (\d+)\|(.*)$/.exec(l);
      if (m) { cur.progress = Number(m[1]); cur.text = m[2]; }
      else if (l.startsWith('##FAILED')) cur.failed = l.slice(8).trim().split(',').filter(Boolean);
      else if (l === '##DONE') { cur.progress = 100; cur.text = 'Done'; }
    }).then(({ code }) => {
      cur.code = code;
      cur.finishedAt = new Date().toISOString();
      log(`components: ${list.join(',')} -> code ${code}`);
    }, (e) => { cur.code = -1; cur.failed = list; cur.text = e.message; });
    return state();
  }

  async function state() {
    return { supported: true, due: await due(), scan: lastScan, job: job ? { ...job } : null };
  }

  return { due, markSeen, scan, install, state };
}

export function registerComponents(app, asyncRoute, { components }) {
  app.get('/api/components', asyncRoute(async (req, res) => res.json(await components.state())));
  app.post('/api/components/scan', asyncRoute(async (req, res) => res.json(await components.scan())));
  app.post('/api/components/install', asyncRoute(async (req, res) => res.json(await components.install(req.body?.ids, { profile: req.body?.profile }))));
  app.post('/api/components/dismiss', asyncRoute(async (req, res) => { await components.markSeen(); res.json(await components.state()); }));
}
