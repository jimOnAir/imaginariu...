// venv self-repair at startup (0.6.10 wave ticket 25). The failure class upstream fixed: the
// studio's internal Python entry stops being a working executable when something COPIES, extracts
// or "cleans" the install folder - on Windows a broken trampoline spawn answered `os error 2` and
// Views/concepts/3D all died with it. The Linux shape is the same family with different parts:
// our venvs are uv-created and bin/python is a symlink into the bundled CPython
// (runtime/python/cpython-3.12-linux-x86_64-gnu) - a copy or a cleaner leaves a dangling symlink,
// a missing file, or a python that no longer starts. A spawn into that answers ENOENT - raw and
// meaningless to the user.
//
// Division of labor (deliberate):
//   * the STUDIO at startup diagnoses and does the CHEAP safe repair only: `uv venv
//     --allow-existing` recreates the interpreter skeleton (bin/ + pyvenv.cfg) INSIDE the existing
//     .venv, so site-packages (torch and friends) survive - no download, no deletion. Recorded
//     deviation: upstream re-links a junction; Linux has no junction, the honest equivalent is
//     this recreate-in-place.
//   * anything heavier (the interpreter itself is gone, the packages are gone) is NOT attempted at
//     boot - that would mean multi-GB downloads nobody asked for during a startup. The answer is
//     pythonFailText(): the plain sentence naming the component and the very command that rebuilds
//     it (installer/install.sh -Yes -Only <id>), which DOES recreate a damaged venv on purpose.
// Nothing here deletes or downloads; every step is one stat, one probe, or one uv venv re-link.
import { spawn } from 'node:child_process';
import { constants, statSync, promises as fs } from 'node:fs';
import path from 'node:path';

/** The PATH finder (same shape the installer scan uses, kept local so this module stands alone). */
function which(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const cand = path.join(dir, name);
    try { const st = statSync(cand); if (st.isFile() && (st.mode & 0o111)) return cand; } catch { /* next */ }
  }
  return '';
}

export const PY_PROBE = 'import sys, site';   // the cheapest truth: the interpreter starts AND its venv site works

/** <dir>/.venv/pyvenv.cfg - the venv's own record (upstream interface name). */
export function venvCfgFile(dir) { return path.join(dir, '.venv', 'pyvenv.cfg'); }

/** The python entry inside a venv (POSIX bin/, Windows Scripts/). */
export function venvPythonPath(dir) {
  return path.join(dir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
}

/**
 * The symlink truth for a file (Linux twin of the junction inspection upstream names):
 * { exists, isLink, target, targetExists } - a copy tool that "flattens" symlinks or a cleaner
 * that eats the CPython folder both show up here as a dangling link.
 */
export async function linkTarget(file) {
  try {
    const st = await fs.lstat(file);
    const isLink = st.isSymbolicLink();
    let target = null, targetExists = false;
    if (isLink) {
      target = await fs.readlink(file);
      try { await fs.stat(path.resolve(path.dirname(file), target)); targetExists = true; } catch { targetExists = false; }
    } else targetExists = true;
    return { exists: true, isLink, target, targetExists };
  } catch { return { exists: false, isLink: false, target: null, targetExists: false }; }
}

/**
 * One venv, honestly answered: { dir, python, ok, why }. ok=true only when the interpreter
 * actually STARTS (present + executable + `-c "import sys, site"` exits 0) - a stat that passes
 * while the spawn would die with ENOENT is exactly the bug this module prevents.
 * Seams: exists/access/readFile/exec, probeMs.
 */
export async function checkVenv(dir, { env = process.env, exec = spawn, probeMs = 15000, readFile = (f) => fs.readFile(f, 'utf8'), access = (f, m) => fs.access(f, m) } = {}) {
  const python = venvPythonPath(dir);
  const bad = (why, extra = {}) => ({ dir, python, ok: false, why, ...extra });
  let st = null;
  try { st = await fs.stat(python); } catch { }
  if (!st || !st.isFile()) {
    const link = await linkTarget(python);
    return bad(!link.exists ? 'the venv has no python entry at all'
      : link.isLink && !link.targetExists ? `its python is a symlink to ${link.target}, which no longer exists`
      : 'its python entry is not a file');
  }
  try { await access(python, constants.X_OK); } catch { return bad('its python entry is not executable'); }
  const started = await new Promise((resolve) => {
    try {
      const p = exec(python, ['-c', PY_PROBE], { stdio: 'ignore', env: { ...env, PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true });
      const timer = setTimeout(() => { try { p.kill(); } catch { } resolve('timeout'); }, probeMs);
      p.on('error', () => { clearTimeout(timer); resolve('spawn-failed'); });
      p.on('exit', (code, signal) => { clearTimeout(timer); resolve(code === 0 ? 'ok' : `exit ${code}${signal ? '/' + signal : ''}`); });
    } catch { resolve('spawn-failed'); }
  });
  if (started !== 'ok') return bad(`its python is present but does not run (${started})`, { probe: started });
  return { dir, python, ok: true, why: '' };
}

/**
 * What to tell the user when the venv cannot be helped at startup: name the broken thing, name
 * the command that rebuilds it honestly (the installer's component step recreates a damaged
 * venv on purpose - see VenvBroken in installer/install.sh). `what` is the friendly component
 * label, `ids` the -Only list that fixes it.
 */
export function pythonFailText(what, ids, why) {
  return `${what} stopped working: its Python environment is broken${why ? ` (${why})` : ''}. The studio does not download several gigabytes behind your back - run installer/install.sh -Yes -Only ${[...ids].join(',')} and it will recreate that environment (your models and settings stay).`;
}

/** The studio's venvs, through the branch's own config readers (same env seams everywhere). */
export function studioVenvs({ env = process.env, appRoot } = {}) {
  const e = env;
  const rt = path.join(appRoot, 'runtime');
  return [
    { dir: e.ASTRA_COMFY_DIR || path.join(rt, 'ComfyUI'), what: 'ComfyUI (the 3D and 2D engines)', ids: ['comfydeps'], label: 'comfy' },
    { dir: e.ASTRA_PIXAL3D_DIR || path.join(rt, 'ComfyUI-Pixal3D'), what: 'Pixal3D', ids: ['pixal3d'], label: 'pixal3d' },
    { dir: e.ASTRA_TRIPOSG_DIR || path.join(rt, 'triposg'), what: 'TripoSG', ids: ['triposg'], label: 'triposg' },
    { dir: e.ASTRA_SOUND_DIR || path.join(rt, 'sound'), what: 'Sound', ids: ['sound'], label: 'sound' },
  ];
}

/** Where uv lives (the installer's order: PATH, then the bundled runtime/uv/uv) - or null. */
export function findUv({ appRoot, env = process.env, pathExists = (f) => fs.stat(f).then(() => true, () => false) } = {}) {
  const fromPath = which('uv', env);
  if (fromPath) return Promise.resolve(fromPath);
  const bundled = path.join(appRoot, 'runtime', 'uv', 'uv');
  return pathExists(bundled).then((ok) => (ok ? bundled : null));
}

/** A tiny INI read of the venv's own record (home =, version_info =). */
async function readCfg(file, readFile) {
  try {
    const out = {};
    for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
      const m = /^(\w+)\s*=\s*(.*)$/.exec(line.trim());
      if (m) out[m[1].toLowerCase()] = m[2];
    }
    return out;
  } catch { return null; }
}

/**
 * The startup pass over the studio's venvs. For each: check -> when the entry is broken but the
 * venv RECORD and its site-packages are still there, recreate the skeleton in place with uv
 * (--allow-existing: nothing is deleted, nothing is downloaded) and check again -> report. A
 * missing dir (that venv is simply not installed) is skipped silently. Never throws: the studio
 * boots whatever it finds; the reports go to the log and pythonFailText answers the user when a
 * venv needs the installer.
 * @returns {Promise<Array<{label, verdict: 'healthy'|'repaired'|'skip'|'needs-installer', why, text?}>>}
 */
export async function repairStudioVenvs({
  appRoot, env = process.env, log = () => {}, checkFn = checkVenv, uvFn = findUv,
  exec = spawn, readFile = (f) => fs.readFile(f, 'utf8'), list = null,
} = {}) {
  const reports = [];
  for (const v of (list || studioVenvs({ env, appRoot }))) {
    try {
      try { await fs.stat(v.dir); } catch { reports.push({ label: v.label, verdict: 'skip', why: 'not installed' }); continue; }
      let st = await checkFn(v.dir, { env, exec, readFile });
      if (st.ok) { reports.push({ label: v.label, verdict: 'healthy', why: '' }); continue; }
      const cfg = await readCfg(venvCfgFile(v.dir), readFile);
      const homePy = cfg?.home ? path.join(cfg.home, `python${cfg.version_info ? cfg.version_info.split('.').slice(0, 2).join('.') : ''}`) : '';
      const hasHomePy = homePy && await fs.stat(homePy).then(() => true, () => false);
      const hasPackages = await fs.stat(path.join(v.dir, '.venv', 'lib')).then(() => true, () => false);
      const uv = hasHomePy && hasPackages ? await uvFn({ appRoot, env }) : null;
      if (!uv) {
        const why = !cfg ? 'the venv record is gone too' : !hasHomePy ? 'the Python it was built from is gone' : !hasPackages ? 'its installed packages are gone' : 'uv is not on this machine';
        const text = pythonFailText(v.what, v.ids, st.why + ' - ' + why);
        log(`venv-health: ${v.label}: ${text}`);
        reports.push({ label: v.label, verdict: 'needs-installer', why, text });
        continue;
      }
      // the cheap honest repair: recreate bin/ + pyvenv.cfg in place, site-packages untouched
      const done = await new Promise((resolve) => {
        try {
          const p = exec(uv, ['venv', '--allow-existing', '--python', homePy, path.join(v.dir, '.venv')], {
            stdio: 'ignore', env: { ...env, UV_PYTHON_INSTALL_DIR: path.join(appRoot, 'runtime', 'python'), UV_CACHE_DIR: path.join(appRoot, 'runtime', 'uv-cache') },
          });
          p.on('error', () => resolve(-1));
          p.on('exit', (code) => resolve(code));
        } catch { resolve(-1); }
      });
      st = done === 0 ? await checkFn(v.dir, { env, exec, readFile }) : { ok: false, why: `the repair command answered exit ${done}` };
      if (st.ok) { log(`venv-health: ${v.label}: repaired (the python entry was recreated in place)`); reports.push({ label: v.label, verdict: 'repaired', why: '' }); continue; }
      const text = pythonFailText(v.what, v.ids, st.why);
      log(`venv-health: ${v.label}: ${text}`);
      reports.push({ label: v.label, verdict: 'needs-installer', why: st.why, text });
    } catch (e) {
      reports.push({ label: v.label, verdict: 'needs-installer', why: e.message, text: pythonFailText(v.what, v.ids, e.message) });
    }
  }
  return reports;
}

/**
 * The message the spawn sites give instead of a raw ENOENT: they know only their own python path,
 * so this names the file and the one venv it belongs to.
 */
export function venvSpawnFailText(python, what = 'This step') {
  return `${what} needs the studio's Python at ${python}, and it does not start (its environment is broken or was moved). Run installer/install.sh -Yes -Only comfydeps to recreate it; your models and settings stay.`;
}
