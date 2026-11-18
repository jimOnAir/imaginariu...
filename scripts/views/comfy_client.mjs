// Minimal ComfyUI HTTP client shared by the views scripts (the studio server has its own websocket-based one in
// server/jobs.mjs; scripts must also work with no studio running).
import { promises as fs, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { venvSpawnFailText } from '../../server/venv-health.mjs';
import { spawn } from 'node:child_process';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA = path.join(APP_ROOT, 'data');
export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8190';

// ComfyUI install: env IMAGINARIUM_COMFY_DIR, else <app>/runtime/ComfyUI
export function comfyDir() { return process.env.IMAGINARIUM_COMFY_DIR || path.join(APP_ROOT, 'runtime', 'ComfyUI'); }
// Windows venv layout is Scripts/python.exe, POSIX is bin/python (mirrors server/storage.mjs).
export function pythonExe() { return path.join(comfyDir(), '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])); }

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(20000) });
  let value;
  try { value = await res.json(); } catch { throw new Error('ComfyUI returned an invalid response.'); }
  if (!res.ok) throw new Error(value?.error?.message || JSON.stringify(value?.node_errors || value?.error || value).slice(0, 700));
  return value;
}

export async function comfyQueue(url) {
  try { return await jsonFetch(url + '/queue', { signal: AbortSignal.timeout(4000) }); } catch { return null; }
}

/** Throws if ComfyUI is down; returns object_info for the given node classes. */
export async function requireNodes(url, nodes) {
  let info;
  try { info = await jsonFetch(url + '/object_info', { signal: AbortSignal.timeout(15000) }); } catch {
    throw new Error('The local 3D engine is not running. Start Imaginarium (Start.cmd) or click "Start 3D engine" in Connections.');
  }
  for (const n of nodes) if (!info[n]) throw new Error('ComfyUI has no node ' + n + '. Restart the 3D engine (Stop.cmd, then Start.cmd): nodes are loaded at startup.');
  return info;
}

export async function uploadImage(url, file, name) {
  const form = new FormData();
  form.append('image', new Blob([await fs.readFile(file)]), name || path.basename(file));
  form.append('overwrite', 'true');
  const res = await jsonFetch(url + '/upload/image', { method: 'POST', body: form });
  return res.name;
}

/**
 * Queue a workflow and wait for it. Polls /history; a websocket is attached only for the
 * paging watchdog below (optional - without one every older path still works).
 * onProgress(text) gets coarse status lines. Returns the history `outputs` object.
 */
export async function runWorkflow(url, workflow, { signal, onProgress, timeoutMs = 60 * 60 * 1000, stepMaxMs } = {}) {
  // Ticket 43 (Windows 0.7 low-VRAM post-mortem, docs/forge/views-low-vram.md: on an 8 GB card
  // ONE step ran 24 minutes and the job waited out its cap having done nothing - "a step over
  // 5 minutes means the card is paging; stop the job at once with the real reason"). The
  // watchdog watches ComfyUI's own progress frames: a step that outlives stepMaxMs (default
  // 300 s, env IMAGINARIUM_VIEWS_STEP_MAX_SEC, 0 disables) is interrupted and reported honestly.
  const stepLimit = stepMaxMs === undefined
    ? Math.max(0, Number(process.env.IMAGINARIUM_VIEWS_STEP_MAX_SEC || 300)) * 1000
    : (Number(stepMaxMs) || 0);
  const clientId = randomUUID();
  const queued = await jsonFetch(url + '/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: clientId }), signal,
  });
  const id = queued.prompt_id;
  // Ticket 37 (Windows 0.6.15: "on timeout and on Cancel the engine job is actually stopped
  // (the card used to keep computing)"): stopping the poll is not stopping the job - tell
  // ComfyUI to interrupt it. Best effort: the studio-facing error below stays the point.
  const interrupt = () => fetch(url + '/interrupt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt_id: id }), signal: AbortSignal.timeout(3000),
  }).then(() => {}).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  let last = '';
  // the paging watchdog's step clock (null until the engine's first progress frame)
  let step = null;
  let ws = null;
  if (stepLimit > 0 && typeof WebSocket !== 'undefined') {
    try {
      ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws?clientId=' + clientId);
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data));
          const d = m.data || {};
          if (m.type === 'progress' && Number.isFinite(d.value) && Number.isFinite(d.max) && d.max > 0) {
            // a new step begins when the value restarts, goes backwards, or the total changes
            if (!step || d.value <= step.n || d.max !== step.of) step = { n: d.value, of: d.max, at: Date.now() };
            else step.n = d.value;
          }
        } catch { /* non-JSON frames: the poll loop is the source of truth anyway */ }
      };
      ws.onerror = () => {};
      ws.onclose = () => { ws = null; };
    } catch { ws = null; }   // no websocket in this runtime: the outer cap still guards the wait
  }
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (step && Date.now() - step.at > stepLimit) {
        const mins = Math.round((Date.now() - step.at) / 6000) / 10;
        throw new Error(`The graphics card is paging: step ${step.n}/${step.of} has run ${mins} minutes without finishing. A healthy step takes seconds, and a card that fits the model never does this - the wait would eat the whole budget for nothing. Fewer views, closing other GPU programs, or a bigger card helps; the job was stopped.`);
      }
      const history = await jsonFetch(url + '/history/' + id, { signal });
      const h = history[id];
      if (h) {
        const err = h.status?.messages?.find((m) => m[0] === 'execution_error');
        if (err) throw new Error(String(err[1]?.exception_message || 'Engine error').slice(0, 900));
        if (h.status?.status_str === 'error') throw new Error('ComfyUI could not run the job. See data/runtime/comfy.log.');
        if (h.status?.completed) return { outputs: h.outputs, promptId: id };
      } else {
        const q = await comfyQueue(url);
        const pos = q?.queue_pending?.findIndex((x) => x[1] === id);
        const text = pos >= 0 ? `engine queue position: ${pos + 1}` : 'running';
        if (text !== last) { last = text; onProgress?.(text); }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error('ComfyUI timed out.');
  } catch (e) {
    await interrupt(); // the card is freed before the caller hears about the failure
    throw e;
  } finally {
    try { ws?.close(); } catch { /* already gone */ }
  }
}

export async function downloadOutput(url, item, dest) {
  const params = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder || '', type: item.type || 'output' });
  const res = await fetch(url + '/view?' + params, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error('Could not fetch the result from ComfyUI.');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/** Run a script in the ComfyUI venv; resolves with the parsed `RESULT {json}` stdout line. */
export function runPython(script, args, { signal, timeoutMs = 600000, onLine } = {}) {
  const python = pythonExe();
  if (!existsSync(python)) return Promise.reject(new Error(venvSpawnFailText(python, 'This generation step')));   // ticket 25
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', script, ...args], {
      windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', U2NET_HOME: path.join(DATA, 'models', 'background'), NUMBA_CACHE_DIR: path.join(DATA, 'runtime', 'temp', 'numba') },
    });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b; onLine?.(String(b)); });
    child.stderr.on('data', (b) => { err = (err + b).slice(-2000); });
    const kill = () => { if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill(); };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error(venvSpawnFailText(python, 'This generation step')) : e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
      const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith('RESULT '));
      if (code !== 0 || !line) return reject(new Error(('Image processing failed. ' + (err || out)).trim().slice(-900)));
      try { resolve(JSON.parse(line.slice(7))); } catch { reject(new Error('The script returned an invalid response.')); }
    });
  });
}
