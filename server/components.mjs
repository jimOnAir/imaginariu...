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
import { promises as fs, openSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
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

export function createComponents({ appRoot, dataDir, appVersion, spawnImpl = spawn, importCore = null, log = () => {},
  lockProbe = null } = {}) {
  const updDir = path.join(dataDir, 'update');
  // ticket 24 (0.6.10 wave): the run survives its studio. The installer gets its stdout ignored
  // (a broken pipe would kill it when the studio closes) and writes the truth to a status file
  // instead (WriteInstallStatus in installer/af_download.sh); a restarted studio re-attaches by
  // tailing that file and checking the run's pid, so a mid-install restart shows progress, not a
  // fetch error. The same installer/install.lock the run holds (flock) answers "already running".
  const runDir = path.join(updDir, 'install-run');
  const statusFile = path.join(runDir, 'status.jsonl');
  const pidFile = path.join(runDir, 'pid.json');
  const lockFile = path.join(appRoot, 'installer', 'install.lock');
  // exit codes of `flock -n file -c true`: 0 free, 1 held (busy - the answer we came for),
  // 66 the file could not even be opened (no installer folder is nobody's install).
  const probeLock = lockProbe || (() => new Promise((resolve) => {
    try {
      const c = nodeSpawn('flock', ['-n', lockFile, '-c', 'true']);
      c.on('error', () => resolve(false));
      c.on('exit', (code) => resolve(code === 1));
    } catch { resolve(false); }
  }));
  /** The newest JSON line the installer appended, or null (a torn last line is skipped). */
  async function tailStatus() {
    let text = '';
    try { text = await fs.readFile(statusFile, 'utf8'); } catch { return null; }
    let last = null;
    for (const l of text.split(/\r?\n/)) {
      if (!l.trim()) continue;
      try { const j = JSON.parse(l); if (!last || String(j.at) >= String(last.at)) last = j; } catch { /* a torn line */ }
    }
    return last;
  }
  async function readRun() { // last status line + pid truth -> a job shape, or null
    let info; try { info = JSON.parse(await fs.readFile(pidFile, 'utf8')); } catch { return null; }
    const last = await tailStatus();
    if (!last) return null;
    let alive = false;
    if (Number.isInteger(info.pid)) { try { process.kill(info.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
    if (alive || last.code != null) {
      return { ids: info.ids || [], profile: info.profile || '', progress: last.progress ?? 0,
        text: last.text || 'installing', code: alive ? null : last.code, at: last.at || null,
        failed: String(last.failed || '').split(',').filter(Boolean), startedAt: info.startedAt || null, external: true };
    }
    // the pid is gone and the status has no finish line: the run died (power, kill -9) mid-way
    return { ids: info.ids || [], profile: info.profile || '', progress: last.progress ?? 0,
      text: 'the install run ended without a finish line - installer/install.log has the story', code: -1, at: last.at || null,
      failed: info.ids || [], startedAt: info.startedAt || null, external: true };
  }
  const readSoft = async (f) => { try { return JSON.parse((await fs.readFile(f, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; } };
  const core = importCore || (() => import(pathToFileURL(path.join(appRoot, 'installer', 'af_scan.mjs')).href));
  let job = null;
  let lastScan = null;


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
    // a run this session does not own - the terminal, or a studio restart that orphaned nothing -
    // means the answer is "wait", never a second installer fighting over the same files (ticket 24)
    if (await probeLock()) {
      const ext = await readRun();
      if (ext && ext.code == null) return state();
      throw new Error('Another installer is already running (it holds installer/install.lock): the Components window shows its progress; start this one after it is done.');
    }
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((x) => ID_RE.test(x));
    if (!list.length) throw new Error('Nothing ticked.');
    const p = PROFILES.includes(pr) ? pr : await profile();
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(statusFile, '').catch(() => {});
    job = { ids: list, profile: p, progress: 0, text: 'Preparing', code: null, failed: [], startedAt: new Date().toISOString() };
    await markSeen().catch(() => {});
    const cur = job;
    const child = spawnImpl('bash', [path.join(appRoot, 'installer', 'install.sh'), '-Yes', '-Profile', p, '-Only', list.join(',')], {
      cwd: appRoot, detached: true, stdio: 'ignore',
      env: { ...process.env, ASTRA_INSTALL_STATUS: statusFile },
    });
    if (Number.isInteger(child?.pid)) await fs.writeFile(pidFile, JSON.stringify({ pid: child.pid, ids: list, profile: p, startedAt: job.startedAt })).catch(() => {});
    child?.unref?.();
    const finish = (code, text) => {
      cur.code = code; cur.finishedAt = new Date().toISOString();
      if (text) cur.text = text;
      // the installer wrote the closing line to the status file (it may not have flushed before
      // the exit event): re-take the final numbers from there, then forget the pid (ticket 24)
      void tailStatus().then((last) => {
        if (last) {
          cur.progress = last.progress ?? cur.progress;
          cur.text = last.text || cur.text;
          cur.failed = String(last.failed || '').split(',').filter(Boolean);
        }
        void fs.rm(pidFile, { force: true }).catch(() => {});
      });
      log(`components: ${list.join(',')} -> code ${code}`);
    };
    child?.on?.('exit', (code) => finish(code ?? 0));
    child?.on?.('error', (e) => finish(-1, e.message));
    if (!child?.on) finish(0);   // a spawn implementation without events (tests' immediate answer)
    return state();
  }

  async function state() {
    const activeOwn = job && job.code == null;
    let shown = job ? { ...job } : null;
    if (activeOwn) { const ext = await readRun(); if (ext) { shown.progress = ext.progress; shown.text = ext.text; shown.failed = ext.failed; shown.at = ext.at; } }
    else if (!job) shown = await readRun();
    const busy = !!shown && shown.code == null || (await probeLock());
    return { supported: true, due: await due(), scan: lastScan, job: shown, busy };
  }

  return { due, markSeen, scan, install, state };
}

export function registerComponents(app, asyncRoute, { components }) {
  app.get('/api/components', asyncRoute(async (req, res) => res.json(await components.state())));
  app.post('/api/components/scan', asyncRoute(async (req, res) => res.json(await components.scan())));
  app.post('/api/components/install', asyncRoute(async (req, res) => res.json(await components.install(req.body?.ids, { profile: req.body?.profile }))));
  app.post('/api/components/dismiss', asyncRoute(async (req, res) => { await components.markSeen(); res.json(await components.state()); }));
}
