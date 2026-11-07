// Ollama that runs itself (docs/product/ollama.md, 0.6.x wave ticket 14). An install or a reboot
// leaves Ollama configured but silent, and the assistant then only reported "not connected". The
// studio now finds the program, starts `ollama serve` when the local server is installed and
// missing, and always talks to a model that is actually on this machine - it never downloads one.
// Auto-start is for the loopback default address only: a remote Ollama is somebody else's process.
import { spawn } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root, pathsConfig, parseJson } from './storage.mjs';

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';
// The one address this module may start a process for. Anything else (another host, another port)
// is only probed. Parsed as a URL on purpose: comparing hostname and port beats a regex that has
// to re-learn every spelling of "this machine".
export const LOCAL_SERVE_PORT = '11434';
export const isLocalServeUrl = (url) => {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' && u.port === LOCAL_SERVE_PORT && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch { return false; }
};

/** Text-model filter: the assistant is a chat model, the vision and embedding ones answer elsewhere. */
export const NON_TEXT_MODEL = /(vl\b|vl:|vision|embed|rerank|cloud|llava|moondream|minicpm)/i;
/**
 * Which chat model is "the best" is not this module's opinion - it is the table the installer
 * already uses to decide what to PULL (installer/manifest.json, `llm.byVram`: qwen3:4b/8b/14b
 * with the memory each wants). Using one card for both decisions keeps the promise coherent: the
 * assistant asks for the biggest model from that table this card can hold, so it only ever talks
 * to a model the same install could have offered. Small-to-big order is built here, whatever
 * order the manifest happens to list.
 */
export function chatLadder({ appRoot = root, readFn = readFileSync } = {}) {
  try {
    const man = parseJson(readFn(path.join(appRoot, 'installer', 'manifest.json'), 'utf8'));
    return (man?.llm?.byVram || []).slice().sort((a, b) => a.minVramMiB - b.minVramMiB);
  } catch { return []; }
}
export const CHAT_LADDER = chatLadder();

const isExe = (p, exists = existsSync) => {
  try { return exists(p) && (process.platform === 'win32' || (statSync(p).mode & 0o111) !== 0); } catch { return false; }
};
const inPath = (name, env = process.env) => {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (isExe(p)) return p;
  }
  return '';
};

/**
 * Where the `ollama` program is: ASTRA_OLLAMA_EXE, then config/paths.json (key `ollama`, the same
 * key the installer's scan writes), then the usual locations, then PATH. First hit or null.
 */
export function ollamaExecutable({ env = process.env, appRoot = root, exists = existsSync } = {}) {
  const win = process.platform === 'win32';
  const name = win ? 'ollama.exe' : 'ollama';
  const std = win
    ? [path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Ollama', name)]
    : ['/usr/local/bin/' + name, '/usr/bin/' + name, path.join(os.homedir(), '.ollama', 'bin', name)];
  const candidates = [env.ASTRA_OLLAMA_EXE, pathsConfig(appRoot).ollama, ...std, inPath(name, env)].filter(Boolean);
  for (const c of candidates) if (isExe(String(c), exists)) return String(c);
  return null;
}

// One place for "ask Ollama, get JSON, treat any failure as no answer": a dead port, a busy
// server and a broken body all mean the same thing to the callers.
const trimTrailingSlash = (u) => String(u).replace(/\/+$/, '');
async function askJson(fetchFn, url, opts) {
  try {
    const answer = await fetchFn(url, opts);
    return answer?.ok ? await answer.json() : null;
  } catch { return null; }
}

/** /api/tags models as objects, or null when Ollama does not answer (it is not the same as "empty"). */
export async function ollamaTags(url = OLLAMA_DEFAULT_URL, fetchFn = fetch) {
  const body = await askJson(fetchFn, `${trimTrailingSlash(url)}/api/tags`, { signal: AbortSignal.timeout(3000) });
  return Array.isArray(body?.models) ? body.models : null;
}
export const ollamaModels = async (url = OLLAMA_DEFAULT_URL, fetchFn = fetch) => {
  const listed = await ollamaTags(url, fetchFn);
  return listed ? listed.map((m) => m.name) : null;
};

/**
 * The model to talk to: the configured one when it is installed (a `name:latest` tag counts),
 * otherwise the biggest chatLadder model that is installed and this card can hold, otherwise any
 * installed text model, otherwise null - which the caller turns into a sentence, never into a
 * silent failure. `vramMiB = 0` means "the card is not read": do not filter by size then.
 */
export function pickChatModel(configured, installed = [], vramMiB = 0) {
  const names = installed.map(String);
  const tagged = (wanted) => names.find((n) => n === wanted || n === `${wanted}:latest`) || null;
  if (configured) { const own = tagged(String(configured).trim()); if (own) return own; }
  const usable = CHAT_LADDER.filter((row) => !vramMiB || row.minVramMiB <= vramMiB)
    .map((row) => tagged(row.model)).filter(Boolean);
  return usable.at(-1) || names.find((n) => !NON_TEXT_MODEL.test(n)) || null;
}

// What each model can do is Ollama's own answer (POST /api/show -> capabilities). Asking costs a
// round trip per model, so an answer is remembered against `digest + name`: re-pulling rewrites
// both halves, so a memo can never outlive the model it describes. An Ollama too old to report
// capabilities leaves the name as the only witness - guessVisionFromName decides then.
const SHOW_TIMEOUT_MS = 6000;
const capabilityMemo = new Map();
async function visionFlag(rootUrl, model, fetchFn, guessVisionFromName) {
  const stamp = `${model.digest || 'no-digest'}+${model.name}`;
  if (capabilityMemo.has(stamp)) return capabilityMemo.get(stamp);
  const shown = await askJson(fetchFn, `${rootUrl}/api/show`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: model.name }),
    signal: AbortSignal.timeout(SHOW_TIMEOUT_MS),
  });
  const flags = Array.isArray(shown?.capabilities) ? shown.capabilities : null;
  const seen = flags === null ? !!guessVisionFromName(model.name) : flags.includes('vision');
  capabilityMemo.set(stamp, seen);
  return seen;
}
/**
 * Everything installed in Ollama, for the two pickers in Connections: {name,size,family,params,
 * vision}. null when Ollama does not answer.
 */
export async function ollamaCatalog(url = OLLAMA_DEFAULT_URL, fetchFn = fetch, guessVisionFromName = () => false) {
  const listed = await ollamaTags(url, fetchFn);
  if (!listed) return null;
  const rootUrl = trimTrailingSlash(url);
  const seen = await Promise.all(listed.map((m) => visionFlag(rootUrl, m, fetchFn, guessVisionFromName)));
  return listed.map((m, at) => {
    const d = m.details || {};
    return { name: m.name, size: m.size || 0, family: d.family || '', params: d.parameter_size || '', vision: seen[at] };
  });
}

/** One start attempt per address at a time; everyone who asks while it runs waits for the same result. */
const starting = new Map();

/**
 * Make sure the local Ollama answers. Never kills anything, never downloads a model, and never
 * touches a non-loopback address. Returns {running, started, exe, reason}.
 */
export async function ensureOllama({ url = OLLAMA_DEFAULT_URL, appRoot = root, env = process.env, exists = existsSync, fetchFn = fetch, spawnFn = spawn, waitMs = 20000, everyMs = 500, now = () => Date.now(), sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!(await ollamaTags(url, fetchFn))) {
    if (!isLocalServeUrl(url)) {
      return { running: false, started: false, exe: null, reason: `Ollama does not answer at ${url}, and only ${OLLAMA_DEFAULT_URL} is started automatically - start the one at your address yourself.` };
    }
    const exe = ollamaExecutable({ env, appRoot, exists });
    if (!exe) {
      return { running: false, started: false, exe: null, reason: 'Ollama is not installed here. Install it with installer/install.sh (the ollama row), then the studio will start it itself.' };
    }
    if (!starting.has(url)) starting.set(url, (async () => {
      try {
        const child = spawnFn(exe, ['serve'], { detached: true, stdio: 'ignore', env: { ...env } });
        child?.unref?.();
      } catch { /* it may already be starting by hand - the poll below decides */ }
      const until = now() + waitMs;
      for (;;) {
        if (await ollamaTags(url, fetchFn)) return true;
        if (now() >= until) return false;
        await sleepFn(everyMs);
      }
    })().finally(() => starting.delete(url)));
    const running = await starting.get(url);
    return running
      ? { running: true, started: true, exe, reason: '' }
      : { running: false, started: true, exe, reason: `Ollama was started (${exe} serve) but did not answer within ${Math.round(waitMs / 1000)} s - it may be loading; try again in a moment.` };
  }
  return { running: true, started: false, exe: null, reason: '' };
}

/** The sentence the assistant shows when the machine has no text model at all (never a crash). */
export const NO_TEXT_MODEL_HINT = 'Ollama is running but has no text model here - add one in Components (the assistant row, installer/install.sh -Only llm), or pick a model in Connections → Local LLM.';
