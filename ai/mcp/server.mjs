#!/usr/bin/env node
// AstraForge MCP: a stdio server that drives the local studio over its HTTP API (Express 127.0.0.1:3210).
// Run: node ai/mcp/server.mjs   (ASTRA_URL — studio address, ASTRA_APP — app folder; see README.md)
// The studio knows nothing about MCP: every tool is a thin wrapper over the real routes
// (/api/jobs, /api/views, /api/forge, /api/vfx-tools, /api/projects). Blender and Godot are never called directly.
// Agent-facing strings (tool descriptions, error texts, notes) are the shipped tool-surface contract and
// stay Russian; the reference node suite asserts many of them.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { existsSync, openAsBlob, promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.ASTRA_APP || path.join(HERE, '..', '..'));
const BASE = (process.env.ASTRA_URL || 'http://127.0.0.1:3210').replace(/\/+$/, '');
const MAX_TEXT = 60000;                       // cap of one tool answer, in characters
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ studio HTTP client

class StudioError extends Error {
  constructor(message, { status = null, code = null } = {}) { super(message); this.name = 'StudioError'; this.status = status; this.code = code; }
}
const DOWN_HINT = `Запустите Start.cmd в папке студии или вызовите инструмент studio_start.`;

/** One studio request. Always with x-astra-client: studio and no Origin (fetch in Node does not set it). */
async function call(method, url, { json, form, timeout = 60000, raw = false } = {}) {
  const headers = { 'x-astra-client': 'studio' };
  let body;
  if (form) body = form;
  else if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  let res;
  try {
    res = await fetch(BASE + url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new StudioError(`Студия не ответила за ${Math.round(timeout / 1000)} с (${method} ${url}). Возможно, она занята видеокартой; повторите позже.`);
    throw new StudioError(`Студия AstraForge не отвечает (${BASE}): ${err?.cause?.code || err?.message}. ${DOWN_HINT}`, { code: 'studio_down' });
  }
  if (raw) {
    if (!res.ok) throw await httpError(res);
    return res;
  }
  if (!res.ok) throw await httpError(res);
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { text }; }
}
async function httpError(res) {
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  const msg = data?.error ? `${data.error}${data.code ? ` [${data.code}]` : ''}` : `HTTP ${res.status}: ${text.slice(0, 300)}`;
  return new StudioError(msg, { status: res.status, code: data?.code || null });
}
const get = (url, opts) => call('GET', url, opts);
const post = (url, json, opts) => call('POST', url, { json: json ?? {}, ...opts });
const enc = encodeURIComponent;

// ------------------------------------------------------------------ tool replies

function clip(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + `… [ответ обрезан: ${text.length} символов; сузьте выборку через limit/offset или фильтры]`;
  return text;
}
const reply = (value) => ({ content: [{ type: 'text', text: clip(value) }] });
const failReply = (err) => ({ isError: true, content: [{ type: 'text', text: `Ошибка: ${err?.message || err}` }] });

const server = new McpServer({ name: 'astraforge', version: '0.1.0' });
/** Tool registration: thrown errors become isError replies with a Russian text. */
function tool(name, description, shape, handler) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try { return reply(await handler(args || {})); } catch (err) { return failReply(err); }
  });
}
function page(items, { limit = 20, offset = 0 } = {}) {
  return { total: items.length, offset, limit, items: items.slice(offset, offset + limit) };
}
const LIMIT = z.number().int().min(1).max(200).default(20).describe('Сколько элементов вернуть (1–200, по умолчанию 20).');
const OFFSET = z.number().int().min(0).default(0).describe('Сколько элементов пропустить с начала.');
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
const absFile = (p, what = 'Файл') => {
  const abs = path.resolve(String(p));
  if (!existsSync(abs)) throw new StudioError(`${what} не найден: ${abs}`);
  return abs;
};

/** Polls fetchFn until isDone or the timeout. Returns {value, timedOut}. */
async function poll(fetchFn, isDone, { timeoutSec = 120, everySec = 3 } = {}) {
  const until = Date.now() + timeoutSec * 1000;
  let value = await fetchFn();
  while (!isDone(value) && Date.now() < until) { await sleep(everySec * 1000); value = await fetchFn(); }
  return { value, timedOut: !isDone(value) };
}
const WAIT = z.boolean().default(false).describe('Ждать завершения (опрос раз в несколько секунд).');
const TIMEOUT = z.number().int().min(1).max(7200).default(120).describe('Сколько секунд ждать при wait=true (по умолчанию 120). По истечении вернётся текущее состояние, задача продолжится на сервере.');

// ------------------------------------------------------------------ studio: status, start

tool('studio_status',
  'Состояние студии AstraForge: версия, движки (Pixal3D, ComfyUI/Hunyuan), Ollama, видеокарта, а также Blender, Godot, библиотека клипов и очередь Кузницы. Если студия выключена, вернёт ошибку с подсказкой Start.cmd / studio_start.',
  {}, async () => {
    const health = await get('/api/health');
    const [st, forge] = await Promise.all([get('/api/status', { timeout: 15000 }).catch((e) => ({ error: e.message })), get('/api/forge/status').catch((e) => ({ error: e.message }))]);
    return {
      url: BASE, app: health?.app, version: health?.version,
      pixal3d: st.pixal3d ? pick(st.pixal3d, ['installed', 'running', 'url', 'missing', 'message', 'estimate']) : undefined,
      comfy: st.comfy ? { online: st.comfy.online, ready: st.comfy.ready } : undefined,
      ollama: st.ollama ? { online: st.ollama.online, models: st.ollama.models } : undefined,
      gpu: st.gpu ? pick(st.gpu, ['name', 'vram_total', 'vram_free']) : null,
      modelDownload: st.modelDownload, statusError: st.error,
      forge: forge?.error ? { error: forge.error } : forge,
    };
  });

tool('studio_start',
  'Запускает студию (Windows: scripts/Start.ps1 -NoBrowser через PowerShell; Linux: scripts/start.sh) и ждёт /api/health до timeoutSec секунд (по умолчанию 90). Если студия уже работает, ничего не делает. Только для локального адреса (127.0.0.1 / localhost).',
  { timeoutSec: z.number().int().min(5).max(300).default(90).describe('Сколько секунд ждать ответа /api/health.') },
  async ({ timeoutSec }) => {
    const healthy = async () => { try { const h = await get('/api/health', { timeout: 2000 }); return h?.app === 'AstraForge' ? h : null; } catch { return null; } };
    const already = await healthy();
    if (already) return { started: false, alreadyRunning: true, url: BASE, version: already.version };
    const host = new URL(BASE).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new StudioError(`ASTRA_URL указывает на ${host}: запускать можно только локальную студию.`);
    // platform gate (ADR-0002): the shipped launcher is Start.ps1 on Windows, start.sh on Linux
    const isWin = process.platform === 'win32';
    const script = path.join(APP, 'scripts', isWin ? 'Start.ps1' : 'start.sh');
    if (!existsSync(script)) throw new StudioError(`Не найден ${script}. Проверьте ASTRA_APP (сейчас ${APP}).`);
    const child = isWin
      ? spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-NoBrowser'], { cwd: APP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('bash', [script], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    let exit = null;
    child.on('exit', (code) => { exit = code; });
    child.on('error', (err) => { exit = -1; output += err.message; });
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutSec * 1000) {
      const h = await healthy();
      if (h) return { started: true, url: BASE, version: h.version, seconds: Math.round((Date.now() - t0) / 1000) };
      if (exit !== null && exit !== 0) throw new StudioError(`${path.basename(script)} завершился с кодом ${exit}: ${output.trim().slice(0, 500)}`);
      await sleep(1000);
    }
    throw new StudioError(`Студия не ответила на /api/health за ${timeoutSec} с. ${output.trim().slice(0, 300)} Журнал: ${path.join(APP, 'data', 'runtime', 'server-error.log')}`);
  });

tool('studio_open',
  'Возвращает адрес интерфейса студии и подсказку, как показать его пользователю. Ничего не запускает и не открывает: откройте URL во встроенном браузере (Browser pane / preview_start с url).',
  {}, async () => {
    let running = false;
    try { running = (await get('/api/health', { timeout: 2000 }))?.app === 'AstraForge'; } catch { /* down */ }
    return { url: BASE, running, hint: running ? 'Откройте этот URL во встроенном браузере Claude Code (preview_start с параметром url) или в обычном браузере.' : 'Студия сейчас выключена: сначала вызовите studio_start.' };
  });

// ------------------------------------------------------------------ studio assets (/api/assets, /api/exports)

const UPLOAD_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.glb', '.obj', '.stl'];
const post_form = (url, form) => call('POST', url, { form, timeout: 300000 });
tool('asset_upload',
  'Загружает локальный файл в студию (POST /api/assets): PNG, JPG, WEBP (концепт) или GLB, OBJ, STL (модель), до 100 МБ. Возвращает {id, extension, name, url}; id нужен для generate_3d (imageId), views_create и forge_create (fromAsset).',
  { path: z.string().describe('Абсолютный путь к файлу на этом компьютере.') },
  async ({ path: file }) => {
    const abs = absFile(file);
    const ext = path.extname(abs).toLowerCase();
    if (!UPLOAD_EXT.includes(ext)) throw new StudioError(`Формат ${ext || '(без расширения)'} не поддерживается: нужен ${UPLOAD_EXT.join(', ')}.`);
    const st = await fs.stat(abs);
    if (st.size > 100 * 1024 * 1024) throw new StudioError('Файл больше 100 МБ: студия его не примет.');
    const form = new FormData();
    form.append('file', await openAsBlob(abs), path.basename(abs));
    return post_form('/api/assets', form);
  });

const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'model/gltf-binary': '.glb', 'application/zip': '.zip', 'application/json': '.json', 'video/webm': '.webm', 'model/obj': '.obj' };
const ID = z.string().min(1).max(80);
tool('asset_info',
  'Сведения о файле студии без скачивания: тип, размер, URL. kind: asset (/api/assets/:id — загрузки и результаты генерации), export (/api/exports/:id — экспорты из интерфейса), auto — сначала asset, затем export.',
  { id: ID.describe('UUID ассета или экспорта.'), kind: z.enum(['auto', 'asset', 'export']).default('auto') },
  async ({ id, kind }) => {
    const tries = kind === 'auto' ? ['asset', 'export'] : [kind];
    let lastErr;
    for (const k of tries) {
      const url = (k === 'asset' ? '/api/assets/' : '/api/exports/') + enc(id);
      try {
        const res = await call('GET', url, { raw: true });
        const info = { id, kind: k, url, contentType: res.headers.get('content-type'), bytes: Number(res.headers.get('content-length')) || null, fileName: dispositionName(res) };
        await res.body?.cancel().catch(() => {});
        return info;
      } catch (e) { lastErr = e; if (e.status !== 404 && e.status !== 400) throw e; }
    }
    throw lastErr;
  });

function dispositionName(res) {
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}
const safeFile = (n) => String(n).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(-150) || 'file';

/** Downloads a studio URL into a folder; returns {path, bytes}. */
async function downloadTo(url, dir, nameHint) {
  const res = await call('GET', url, { raw: true, timeout: 600000 });
  await fs.mkdir(dir, { recursive: true });
  let name = nameHint || dispositionName(res) || path.basename(decodeURIComponent(url.split('?')[0]));
  const ext = MIME_EXT[(res.headers.get('content-type') || '').split(';')[0]];
  if (!path.extname(name) && ext) name += ext;
  const dest = path.join(dir, safeFile(name));
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  return { path: dest, bytes: buf.length };
}

tool('asset_download',
  'Скачивает файл студии в указанную папку: ассет (/api/assets/:id), экспорт (/api/exports/:id) или любой путь студии вида /api/... (например, url архива из forge_asset_show → exports[].url). Укажите либо id, либо url.',
  {
    dir: z.string().describe('Папка назначения (создаётся при необходимости).'),
    id: ID.optional().describe('UUID ассета или экспорта.'),
    kind: z.enum(['auto', 'asset', 'export']).default('auto').describe('Откуда брать id.'),
    url: z.string().regex(/^\/api\//).optional().describe('Путь студии, начинающийся с /api/.'),
    fileName: z.string().optional().describe('Имя файла; по умолчанию из ответа студии.'),
  },
  async ({ dir, id, kind, url, fileName }) => {
    if (!id && !url) throw new StudioError('Укажите id или url.');
    const target = path.resolve(dir);
    if (url) return downloadTo(url, target, fileName);
    for (const k of kind === 'auto' ? ['asset', 'export'] : [kind]) {
      try { return await downloadTo((k === 'asset' ? '/api/assets/' : '/api/exports/') + enc(id), target, fileName); } catch (e) { if (e.status !== 404 || k === 'export' || kind !== 'auto') throw e; }
    }
    return null;
  });

// ------------------------------------------------------------------ 3D generation (/api/jobs)

const JOB_KEYS = ['id', 'status', 'progress', 'message', 'engine', 'quality', 'seed', 'imageId', 'viewSetId', 'asset', 'error', 'validation', 'createdAt', 'updatedAt'];
const slimJob = (j) => ({ ...pick(j, JOB_KEYS), prompt: j.prompt ? String(j.prompt).slice(0, 120) : undefined });
const jobDone = (j) => ['completed', 'failed', 'cancelled'].includes(j?.status);
const findJob = async (id) => {
  const j = (await get('/api/jobs')).find((x) => x.id === id);
  if (!j) throw new StudioError(`Задание генерации ${id} не найдено.`);
  return j;
};

tool('generate_3d',
  'Запускает генерацию 3D-модели (POST /api/jobs, нагружает видеокарту): по картинке (imageId из asset_upload), по описанию (prompt, сначала SDXL) или по набору ракурсов (viewSetId из views_create; imageId — вид спереди). engine: pixal3d (основной), hunyuan (по умолчанию в API), auto. Для pixal3d quality/shapeModel/meshLevel не используются. Возвращает задание; ход — job_get.',
  {
    imageId: z.string().uuid().optional().describe('Концепт-картинка (id из asset_upload).'),
    prompt: z.string().max(4000).optional().describe('Описание, если нет картинки.'),
    engine: z.enum(['pixal3d', 'hunyuan', 'auto']).default('pixal3d'),
    quality: z.enum(['draft', 'standard', 'high']).default('standard').describe('Только для hunyuan.'),
    seed: z.number().int().min(0).max(2147483647).default(42),
    viewSetId: z.string().uuid().optional().describe('Набор ракурсов: геометрия по нескольким видам.'),
    shapeModel: z.enum(['default', 'hunyuan21']).optional(),
    meshLevel: z.number().min(-1).max(1).optional().describe('Уровень поверхности, только hunyuan.'),
    backgroundMode: z.enum(['auto', 'alpha', 'keep']).optional(),
    hazeFilter: z.enum(['auto', 'on', 'off']).optional(),
  },
  async (a) => {
    if (!a.imageId && !a.viewSetId && !(a.prompt || '').trim()) throw new StudioError('Нужен imageId, viewSetId или prompt.');
    return slimJob(await post('/api/jobs', clean(a)));
  });

tool('jobs_list',
  'Список заданий генерации 3D (GET /api/jobs), новые сверху. Фильтр по статусу: queued, running, completed, failed, cancelled.',
  { status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(), limit: LIMIT, offset: OFFSET },
  async ({ status, limit, offset }) => {
    let jobs = await get('/api/jobs');
    if (status) jobs = jobs.filter((j) => j.status === status);
    jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return page(jobs.map(slimJob), { limit, offset });
  });

tool('job_get',
  'Задание генерации 3D по id. С wait=true опрашивает до completed / failed / cancelled или таймаута. Готовая модель — в поле asset ({id, url}); скачать: asset_download, в Кузницу: forge_create с fromJob.',
  { id: z.string().uuid(), wait: WAIT, timeoutSec: TIMEOUT, full: z.boolean().default(false).describe('Вернуть все поля задания, а не краткую сводку.') },
  async ({ id, wait, timeoutSec, full }) => {
    const { value, timedOut } = wait ? await poll(() => findJob(id), jobDone, { timeoutSec }) : { value: await findJob(id), timedOut: false };
    return { ...(full ? value : slimJob(value)), ...(timedOut ? { waitTimedOut: true, note: 'Время ожидания вышло, задание продолжается.' } : {}) };
  });

tool('job_cancel', 'Отменяет задание генерации 3D (POST /api/jobs/:id/cancel).', { id: z.string().uuid() }, ({ id }) => post(`/api/jobs/${enc(id)}/cancel`));

// ------------------------------------------------------------------ generator: управление генеративным сервисом
// Scope boundary (ADR-0004, ticket 06). This branch runs ComfyUI (plus the separate Pixal3D
// ComfyUI on :8191) as the generation backend, so the family covers observing and driving THAT
// service: status, nodes, graphs, run, restart. The engine-management verbs of the deferred
// AstraForge Engine line (generator_plugins, generator_plugin_new, generator_plugin_install,
// generator_plugin_toggle, generator_learn_status, generator_learn_run, generator_learn_activate)
// and the owner-gated generator_graph_edit are deliberately absent here - the MCP README and the
// astraforge-integrator skill list them by name with the reason, so an agent discovers the
// boundary from docs instead of trial and error.

tool('generator_status',
  'Состояние генеративного сервиса за студией: ComfyUI (порт из настроек) - отвечает ли, готов ли чекпойнт формы, какие чекпойнты загружены; отдельно Pixal3D; видеокарта и RAM; идёт ли докачка модели; сколько заданий в работе и в очереди. От studio_status отличается фокусом на бэкенде генерации, а не на студии целиком.',
  {}, async () => {
    const st = await get('/api/status', { timeout: 15000 });
    const jobs = await get('/api/jobs').catch(() => []);
    return clean({
      comfy: st.comfy ? { online: !!st.comfy.online, ready: !!st.comfy.ready, checkpoints: st.comfy.checkpoints } : undefined,
      pixal3d: st.pixal3d ? pick(st.pixal3d, ['installed', 'running', 'url', 'missing', 'message']) : undefined,
      gpu: st.gpu ? pick(st.gpu, ['name', 'vram_total', 'vram_free']) : null,
      ram: st.ram, modelDownload: !!st.modelDownload,
      queue: { running: jobs.filter((j) => j.status === 'running').length, queued: jobs.filter((j) => j.status === 'queued').length },
    });
  });

tool('generator_nodes',
  'Классы узлов ComfyUI, отвечающего на адресе из настроек (GET /api/runtime/nodes, проба /object_info): имена отсортированы, есть число. contains фильтрует по подстроке (например Hunyuan или SaveGLB). Когда ComfyUI молчит - online=false и пустой список, это не ошибка: сервис поднимет generator_restart или первая же генерация.',
  { contains: z.string().max(60).optional().describe('Фильтр по подстроке имени узла.'), limit: LIMIT, offset: OFFSET },
  async ({ contains, limit, offset }) => {
    const r = await get('/api/runtime/nodes' + (contains ? `?contains=${enc(contains)}` : ''));
    const out = page(r.classes || [], { limit, offset });
    return { online: !!r.online, total: r.count ?? out.total, ...out };
  });

tool('generator_graphs',
  'Графы генерации, которые этот бэкенд умеет запускать (GET /api/runtime/graphs): концепт по описанию (SDXL), форма Hunyuan3D по одной картинке, вариант 2.1, форма по набору ракурсов (2mv), форма Pixal3D в один и несколько видов. Для каждого - когда применяется и классы узлов. Каталог построен из самих билдеров графа; запуск - через generator_run / generate_3d, не по имени графа.',
  {}, async () => (await get('/api/runtime/graphs')).graphs);

tool('generator_run',
  'Запуск генерации через слой заданий студии (POST /api/jobs) - тот же путь, что кнопка «Генерировать»: по imageId, prompt или viewSetId; движок pixal3d / hunyuan / auto; quality, seed и прочее как в generate_3d. Задание сразу видно в jobs_list; с wait=true дожидается completed / failed / cancelled и возвращает job с asset и validation (предупреждения проверки сетки не теряются).',
  {
    imageId: z.string().uuid().optional().describe('Концепт-картинка (id из asset_upload).'),
    prompt: z.string().max(4000).optional().describe('Описание, если нет картинки: сначала строится концепт (SDXL).'),
    viewSetId: z.string().uuid().optional().describe('Набор ракурсов: геометрия по нескольким видам.'),
    engine: z.enum(['pixal3d', 'hunyuan', 'auto']).default('hunyuan').describe('Бэкенд формы; auto выбирает по готовности.'),
    quality: z.enum(['draft', 'standard', 'high']).optional(),
    shapeModel: z.enum(['default', 'hunyuan21']).optional(),
    meshLevel: z.number().min(-1).max(1).optional(),
    backgroundMode: z.enum(['auto', 'alpha', 'keep']).optional(),
    hazeFilter: z.enum(['auto', 'on', 'off']).optional(),
    seed: z.number().int().min(0).max(2147483647).optional(),
    wait: WAIT, timeoutSec: TIMEOUT,
  },
  async ({ wait, timeoutSec, ...body }) => {
    if (!body.imageId && !body.viewSetId && !(body.prompt || '').trim()) throw new StudioError('Нужен imageId, viewSetId или prompt.');
    let job = await post('/api/jobs', clean(body));
    let timedOut = false;
    if (wait) {
      const r = await poll(() => findJob(job.id), jobDone, { timeoutSec });
      job = r.value; timedOut = r.timedOut;
    }
    return { ...slimJob(job), ...(timedOut ? { waitTimedOut: true, note: 'Ожидание закончилось, генерация продолжается на сервере.' } : {}) };
  });

tool('generator_restart',
  'Перезапуск генеративного сервиса (POST /api/runtime/restart): ComfyUI, который подняла сама студия, останавливается и запускается заново на тех же папках; идёт до 60 с. Если на порту чужой ComfyUI (запущен вне студии) - его не трогают, ответ это говорит. Если сервис был выключен - он просто стартует. Помогает при заевшей очереди, OOM или после установки чекпойнта вручную.',
  {}, async () => post('/api/runtime/restart', null, { timeout: 90000 }));

// ------------------------------------------------------------------ views (/api/views)

tool('views_status', 'Какие провайдеры ракурсов готовы: codex (картинки через ChatGPT Codex) и mvadapter (ComfyUI) (GET /api/views/status).', {}, () => get('/api/views/status'));

tool('views_create',
  'Создаёт набор ракурсов из концепта (POST /api/views): вид спереди берётся из картинки. Тот же концепт возвращает тот же набор. Слоты: front, left, back, right (+ frontLeft, frontRight для сборки не нужны).',
  { imageId: z.string().uuid().describe('Картинка из asset_upload.') }, ({ imageId }) => post('/api/views', { imageId }));

tool('views_generate',
  'Достраивает недостающие ракурсы (POST /api/views/:id/generate; одновременно идёт одна генерация). provider: codex (ChatGPT Codex, лучше по стилю) или mvadapter (ComfyUI, нагружает видеокарту). Без slots заполняются все пустые.',
  {
    id: z.string().uuid().describe('Номер набора из views_create.'),
    provider: z.enum(['codex', 'mvadapter']),
    slots: z.array(z.enum(['left', 'back', 'right', 'frontLeft', 'frontRight'])).min(1).max(5).optional(),
    overwrite: z.boolean().default(false).describe('Перегенерировать уже заполненные слоты.'),
    seed: z.number().int().min(0).max(2147483647).optional(),
    size: z.number().int().min(512).max(768).optional(),
    steps: z.number().int().min(8).max(60).optional(),
    note: z.string().max(500).optional().describe('Подсказка генератору.'),
  },
  ({ id, ...body }) => post(`/api/views/${enc(id)}/generate`, clean(body)));

tool('views_get',
  'Набор ракурсов: слоты, источники, готовность к 3D (canBuild), текущая задача (task). С wait=true ждёт окончания генерации.',
  { id: z.string().uuid(), wait: WAIT, timeoutSec: TIMEOUT },
  async ({ id, wait, timeoutSec }) => {
    const fetchSet = () => get(`/api/views/${enc(id)}`);
    if (!wait) return fetchSet();
    const { value, timedOut } = await poll(fetchSet, (s) => !s.task || s.task.status !== 'running', { timeoutSec });
    return timedOut ? { ...value, waitTimedOut: true } : value;
  });

tool('views_cancel', 'Снимает идущую генерацию ракурсов (POST /api/views/:id/cancel).', { id: z.string().uuid() }, ({ id }) => post(`/api/views/${enc(id)}/cancel`));

// ------------------------------------------------------------------ the forge (/api/forge)

const FORGE_KINDS = ['humanoid', 'creature', 'item', 'ship', 'prop'];
const JOB_DONE_FORGE = ['completed', 'failed', 'cancelled'];
const forgeDone = (j) => JOB_DONE_FORGE.includes(j?.status);
function slimForgeJob(j) {
  return {
    ...pick(j, ['id', 'type', 'assetId', 'version', 'status', 'error', 'createdAt']),
    steps: (j.steps || []).map((s) => clean({
      index: s.index, step: s.step, status: s.status, progress: s.progress || undefined, message: s.message,
      error: s.status === 'failed' ? s.result?.error : undefined, outputs: s.result?.outputs, warnings: s.warnings?.length ? s.warnings : (s.result?.warnings?.length ? s.result.warnings : undefined),
      logFile: s.status === 'failed' ? s.logFile : undefined,
    })),
  };
}
const forgeJob = async (id, { wait, timeoutSec, full }) => {
  const fetchJob = () => get(`/api/forge/jobs/${enc(id)}`);
  const { value, timedOut } = wait ? await poll(fetchJob, forgeDone, { timeoutSec, everySec: 2 }) : { value: await fetchJob(), timedOut: false };
  return { ...(full ? value : slimForgeJob(value)), ...(timedOut ? { waitTimedOut: true, note: 'Время ожидания вышло, задача продолжается на сервере.' } : {}) };
};

tool('forge_steps',
  'Реестр шагов Кузницы: ремонт, риг, клипы, предметы, эффекты, спрайты, пакет Godot… Без step — краткий список (имя, название, типы, GPU, таймаут, имена параметров). С step — полное описание шага со всеми параметрами, диапазонами и умолчаниями.',
  { step: z.string().optional().describe('Имя шага, например render_sprites.'), limit: z.number().int().min(1).max(200).default(60), offset: OFFSET },
  async ({ step, limit, offset }) => {
    const steps = await get('/api/forge/steps');
    if (step) {
      const s = steps.find((x) => x.step === step);
      if (!s) throw new StudioError(`Нет шага «${step}». Доступны: ${steps.map((x) => x.step).join(', ')}.`);
      return s;
    }
    return page(steps.map((s) => ({ ...pick(s, ['step', 'title', 'kinds', 'gpu', 'timeoutSec']), params: Object.keys(s.params || {}) })), { limit, offset });
  });

tool('forge_presets',
  'Готовые конвейеры Кузницы (GET /api/forge/presets): id, тип, название и шаги. С id — полный рецепт со всеми параметрами шагов.',
  { id: z.string().optional(), limit: z.number().int().min(1).max(200).default(60), offset: OFFSET },
  async ({ id, limit, offset }) => {
    const presets = await get('/api/forge/presets');
    if (id) {
      const p = presets.find((x) => x.id === id);
      if (!p) throw new StudioError(`Нет пресета «${id}». Доступны: ${presets.map((x) => x.id).join(', ')}.`);
      return p;
    }
    return page(presets.map((p) => ({ ...pick(p, ['id', 'kind', 'title']), steps: (p.steps || []).map((s) => s.step) })), { limit, offset });
  });

tool('forge_assets',
  'Паспорта ассетов Кузницы (GET /api/forge/assets): id, имя, тип, статус последней версии. Фильтры: kind, подстрока имени query.',
  { kind: z.enum(FORGE_KINDS).optional(), query: z.string().optional().describe('Подстрока в имени, без учёта регистра.'), limit: LIMIT, offset: OFFSET },
  async ({ kind, query, limit, offset }) => {
    let list = await get('/api/forge/assets');
    if (kind) list = list.filter((a) => a.kind === kind);
    if (query) list = list.filter((a) => String(a.name).toLowerCase().includes(query.toLowerCase()));
    list.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    return page(list.map((a) => pick(a, ['id', 'name', 'kind', 'updated', 'lastStatus'])), { limit, offset });
  });

tool('forge_asset_show',
  'Паспорт ассета: источник, профиль, версии (шаги и статус), конвейер, клипы, предметы, экспорты (с url архивов), приёмка. По умолчанию краткая сводка; full=true — весь asset.json.',
  { assetId: ID, full: z.boolean().default(false) },
  async ({ assetId, full }) => {
    const m = await get(`/api/forge/assets/${enc(assetId)}`);
    if (full) return m;
    return {
      ...pick(m, ['id', 'name', 'kind', 'created', 'updated', 'source', 'profile', 'qa']),
      versions: (m.versions || []).map((v) => pick(v, ['version', 'status', 'base', 'steps'])),
      pipelineTail: (m.pipeline || []).slice(-12).map((e) => clean({ version: e.version, step: e.step, status: e.status, error: e.result?.error })),
      clips: (m.clips || []).length, props: (m.props || []).length, fx: (m.fx || []).length,
      exports: (m.exports || []).map((e) => pick(e, ['profile', 'version', 'jobId', 'path', 'url', 'bytes', 'at'])),
    };
  });

const STEPS = z.array(z.object({ step: z.string(), params: z.record(z.string(), z.any()).optional() })).min(1).describe('Свой конвейер: [{step, params}]. Имена шагов и параметры — forge_steps.');
tool('forge_create',
  'Создаёт паспорт ассета в Кузнице (POST /api/forge/assets) и, если указан preset или steps, сразу запускает конвейер. Источник — ровно один: fromGlb (локальный GLB/FBX/OBJ, до 300 МБ), fromJob (id задания generate_3d), fromAsset (id ассета студии) или ничего (params для генераторов без файла: item_kit, ship_gen, turret_gen). Возвращает паспорт и run {jobId, version, warnings}; ход — forge_job.',
  {
    kind: z.enum(FORGE_KINDS).describe('Тип: humanoid, creature, item, ship, prop.'),
    name: z.string().max(120).optional(),
    fromGlb: z.string().optional().describe('Абсолютный путь к локальному GLB/FBX/OBJ.'),
    fromJob: z.string().uuid().optional().describe('Завершённое задание generate_3d.'),
    fromAsset: z.string().optional().describe('id ассета студии (asset_upload / результат job).'),
    params: z.record(z.string(), z.any()).optional().describe('Параметры для генераторов без входного файла.'),
    profile: z.record(z.string(), z.any()).optional().describe('Профиль паспорта, например {height_m: 1.8}.'),
    preset: z.string().optional().describe('id готового конвейера (forge_presets).'),
    steps: STEPS.optional(),
  },
  async (a) => {
    const sources = [a.fromGlb, a.fromJob, a.fromAsset].filter(Boolean).length;
    if (sources > 1) throw new StudioError('Укажите только один источник: fromGlb, fromJob или fromAsset.');
    if (a.preset && a.steps) throw new StudioError('Укажите либо preset, либо steps.');
    const meta = clean({ name: a.name, kind: a.kind, profile: a.profile });
    let manifest;
    if (a.fromGlb) {
      const form = new FormData();
      const abs = absFile(a.fromGlb, 'Файл модели');
      form.append('name', meta.name || path.basename(abs, path.extname(abs)));
      form.append('kind', meta.kind);
      form.append('source', JSON.stringify({ type: 'upload' }));
      if (meta.profile) form.append('profile', JSON.stringify(meta.profile));
      form.append('file', await openAsBlob(abs), path.basename(abs));
      manifest = await post_form('/api/forge/assets', form);
    } else {
      meta.source = a.fromJob ? { type: 'job', jobId: a.fromJob } : a.fromAsset ? { type: 'asset', assetId: a.fromAsset } : { type: 'params', params: a.params || {} };
      manifest = await post('/api/forge/assets', meta);
    }
    const out = { asset: pick(manifest, ['id', 'name', 'kind', 'source']) };
    if (a.preset || a.steps) out.run = await post(`/api/forge/assets/${enc(manifest.id)}/run`, { ...(a.preset ? { preset: a.preset } : { steps: a.steps }), from: 'source' });
    return out;
  });

tool('forge_run',
  'Запускает конвейер на ассете (POST /api/forge/assets/:id/run): готовый preset или свой список steps. Создаёт новую версию v00N (старые не перезаписываются). from: source (по умолчанию), latest (итог последней версии) или v003. Возвращает {jobId, version, warnings}.',
  {
    assetId: ID, preset: z.string().optional(), steps: STEPS.optional(),
    from: z.string().regex(/^(source|latest|v\d{3,})$/).default('source').describe('С чего начинать: source | latest | v003.'),
  },
  async ({ assetId, preset, steps, from }) => {
    if (!preset && !steps) throw new StudioError('Укажите preset или steps.');
    if (preset && steps) throw new StudioError('Укажите либо preset, либо steps.');
    return post(`/api/forge/assets/${enc(assetId)}/run`, { ...(preset ? { preset } : { steps }), from });
  });

tool('forge_job',
  'Задача Кузницы по id: статус, шаги (прогресс, сообщения, выходы, ошибки, предупреждения). С wait=true ждёт completed / failed / cancelled.',
  { id: ID, wait: WAIT, timeoutSec: TIMEOUT, full: z.boolean().default(false).describe('Все поля задачи (журналы, пути).') },
  (a) => forgeJob(a.id, a));

tool('forge_jobs', 'Последние задачи Кузницы (GET /api/forge/jobs), опционально по одному ассету.',
  { assetId: ID.optional(), limit: LIMIT },
  async ({ assetId, limit }) => {
    const jobs = await get(`/api/forge/jobs?limit=${limit}${assetId ? `&assetId=${enc(assetId)}` : ''}`);
    return jobs.map((j) => ({ ...pick(j, ['id', 'type', 'assetId', 'version', 'status', 'createdAt']), steps: (j.steps || []).map((s) => `${s.step}:${s.status}`) }));
  });

tool('forge_job_cancel', 'Отменяет задачу Кузницы; процесс Blender снимается вместе с дочерними.', { id: ID }, ({ id }) => post(`/api/forge/jobs/${enc(id)}/cancel`));

// ------------------------------------------------------------------ self-learning (docs/forge/LEARN.md)
// The production journal, feedback and class recipes. When a running studio predates the /learn routes
// (an old process) or is down, these tools read and write the library files through the same
// server/forge-learn.mjs module; the feedback then lands only in the journal, not on the «Приёмка» card.

let localEngine = null;
async function localForge() {
  if (!localEngine) {
    const { ForgeEngine } = await import(pathToFileURL(path.join(APP, 'server', 'forge-pipeline.mjs')).href);
    localEngine = new ForgeEngine({ root: APP, host: 'mcp' });
  }
  return localEngine;
}
const routeMissing = (err) => err?.code === 'studio_down' || (err?.status === 404 && /маршрут/.test(err?.message || ''));
/** HTTP to the studio; when the route does not exist, the same call in this process. */
async function learnCall(http, local) {
  try {
    return await http();
  } catch (err) {
    if (!routeMissing(err)) throw err;
    const value = await local(await localForge());
    return { ...(value && typeof value === 'object' && !Array.isArray(value) ? value : { value }), servedBy: 'library', note: 'Студия без маршрутов самообучения (перезапустите её) или выключена: данные прочитаны и записаны прямо в библиотеке.' };
  }
}
const qsOf = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  return p.toString() ? `?${p}` : '';
};
const CLASS = z.string().regex(/^(\*|[a-z0-9][a-z0-9_-]{0,39})$/).describe('Класс ассета: zombie, weapon, building, vehicle, tree, humanoid, creature, item, ship, prop или свой; «*» — для всех.');
const VERDICT = z.enum(['accepted', 'rework', 'rejected', 'cleared']).describe('accepted — принято, rework — на доработку, rejected — брак, cleared — снять прежний отзыв.');

tool('forge_feedback',
  'Отзыв на версию ассета Кузницы: принято / на доработку / брак, оценка 1–5, теги брака и комментарий. Студия учится на отзывах: рецепт класса (лучшие параметры шагов) и известные грабли пересчитываются сразу, следующий запуск ассета того же класса стартует с рецепта. Версия по умолчанию — последняя с запусками. Теги: acid_colors, washed_out, too_dark, outline, pixel_noise, off_cell, wrong_orientation, unlike_concept, foil, muddy_texture, extra_features, torn_mesh, bad_rig, bad_animation, prop_not_in_hand, wrong_scale, floating, other (или свои слова). step — если отзыв про один шаг (например render_sprites).',
  {
    assetId: ID.optional().describe('Ассет; или targets для пачки.'), version: z.string().regex(/^v\d{3,}$/).optional(), step: z.string().optional(), verdict: VERDICT,
    targets: z.array(z.object({ assetId: ID, version: z.string().regex(/^v\d{3,}$/).optional() })).max(500).optional()
      .describe('Один вердикт сразу многим версиям (пачка): [{assetId, version?}].'),
    rating: z.number().int().min(1).max(5).optional(), tags: z.array(z.string().max(60)).max(20).default([]),
    comment: z.string().max(2000).default(''), by: z.string().max(60).default('claude'),
  },
  (a) => {
    if (!a.assetId && !a.targets?.length) throw new StudioError('Укажите assetId или targets.');
    return learnCall(
      () => post('/api/forge/learn/feedback', { ...a, source: 'mcp' }),
      async (engine) => ({ ok: true, feedback: await engine.learn.addFeedback({ ...a, source: 'mcp' }), mirrored: false }),
    );
  });

tool('forge_recipes',
  'Рецепты класса ассетов и известные грабли: лучшие параметры каждого шага (по отзывам «принято»), отвергнутые наборы параметров с причинами (брак, теги, комментарии, отличия от рецепта), закреплённые владельцем рецепты и заметки (путь производства, грабли, советы). Читай ПЕРЕД заданием. format: md — сводка Markdown, json — данные.',
  { class: CLASS.optional(), format: z.enum(['md', 'json']).default('md') },
  async ({ class: cls, format }) => {
    if (format === 'md') {
      const r = await learnCall(
        async () => ({ markdown: (await get(`/api/forge/learn/digest${qsOf({ class: cls })}`))?.text ?? '' }),
        async (engine) => ({ markdown: await engine.learn.digest({ cls: cls || null }) }),
      );
      return (r.note ? `> ${r.note}\n\n` : '') + r.markdown;
    }
    const slim = (r) => ({
      ...pick(r, ['class', 'runs', 'feedback', 'pinned', 'notes']),
      groups: (r.groups || []).filter((g) => g.best || g.pitfalls.length).map((g) => ({
        class: g.class, stepKey: g.stepKey, runs: g.runs, verdicts: g.verdicts,
        recipe: g.best ? { params: g.best.params, accepted: g.best.accepted, rejected: g.best.rejected, score: g.best.score, examples: g.best.examples } : null,
        pitfalls: g.pitfalls.slice(0, 6).map((p) => ({ params: p.params, diff: p.diff, rejected: p.rejected, rework: p.rework, checksFailed: p.checksFailed, tags: p.tags, comments: p.comments })),
      })),
    });
    return slim(await learnCall(() => get(`/api/forge/learn/recipes${qsOf({ class: cls })}`), (engine) => engine.learn.recipes({ cls: cls || null })));
  });

tool('forge_journal',
  'Журнал производства Кузницы: каждый запуск шага (класс ассета, параметры, рецепт, проверки, превью, время). view: versions — версии ассетов с превью и последним вердиктом (pending=true — ещё без отзыва); runs — отдельные запуски шагов. Без фильтров — всё, новые сначала.',
  {
    view: z.enum(['versions', 'runs']).default('versions'), class: CLASS.optional(), step: z.string().optional(), assetId: ID.optional(),
    pending: z.boolean().default(false), limit: LIMIT,
  },
  async ({ view, class: cls, step, assetId, pending, limit }) => {
    if (view === 'versions') {
      return learnCall(
        () => get(`/api/forge/learn/versions${qsOf({ class: cls, step, assetId, limit, pending: pending ? 1 : undefined })}`),
        (engine) => engine.learn.versions({ cls, step, assetId, limit, pending }),
      );
    }
    const r = await learnCall(
      () => get(`/api/forge/learn/journal${qsOf({ class: cls, step, assetId, limit })}`),
      async (engine) => { const runs = await engine.learn.runs({ cls, step, assetId }); return { total: runs.length, items: runs.slice(0, limit) }; },
    );
    return { ...r, items: (r.items || []).map((x) => pick(x, ['id', 'at', 'class', 'assetId', 'assetName', 'version', 'stepKey', 'status', 'params', 'recipe', 'failed', 'error', 'seconds', 'previews'])) };
  });

tool('forge_plan',
  'Что сделает запуск конвейера, не запуская его (POST /api/forge/assets/:id/plan): класс ассета и итоговые параметры каждого шага с подставленным рецептом класса (какие ключи пришли из рецепта и откуда). Явные параметры всегда главнее рецепта; recipes=false — без рецептов; assetClass — взять рецепт другого класса.',
  {
    assetId: ID, preset: z.string().optional(), steps: STEPS.optional(),
    from: z.string().regex(/^(source|latest|v\d{3,})$/).default('source'),
    assetClass: CLASS.optional(), recipes: z.boolean().default(true),
  },
  async ({ assetId, preset, steps, from, assetClass, recipes }) => {
    if (!preset === !steps) throw new StudioError('Укажите preset или steps (одно из двух).');
    const body = { ...(preset ? { preset } : { steps }), from, ...(assetClass ? { assetClass } : {}), ...(recipes ? {} : { recipes: false }) };
    return learnCall(() => post(`/api/forge/assets/${enc(assetId)}/plan`, body), (engine) => engine.planRun(assetId, body));
  });

tool('forge_recipe_pin',
  'Закрепить рецепт шага для класса (решение владельца, главнее рецепта из журнала того же уровня): params — только стиль и качество (пути, клипы, размеры не входят); params=null — снять. class «*» — для всех классов (слой под классом). variant — профиль шага (pixel, heroes_gates, iso8…).',
  {
    class: CLASS, step: z.string(), variant: z.string().max(40).default(''),
    params: z.record(z.string(), z.any()).nullable(), note: z.string().max(2000).default(''), by: z.string().max(60).default('owner'),
  },
  (a) => learnCall(
    () => post('/api/forge/learn/pin', a),
    (engine) => engine.learn.pin({ cls: a.class, step: a.step, variant: a.variant, params: a.params, note: a.note, by: a.by }),
  ));

tool('forge_learn_note',
  'Заметка класса ассетов в базе знаний студии: kind route — рабочий путь производства (чем делать), pitfall — грабли (что ломается и почему), tip — совет. Агенты читают их перед заданием (forge_recipes).',
  { class: CLASS, kind: z.enum(['route', 'pitfall', 'tip']).default('pitfall'), text: z.string().min(1).max(3000), steps: z.array(z.string()).max(10).default([]), by: z.string().max(60).default('claude') },
  (a) => learnCall(
    () => post('/api/forge/learn/notes', a),
    (engine) => engine.learn.addNote({ cls: a.class, kind: a.kind, text: a.text, steps: a.steps, by: a.by }),
  ));

const PROFILES = ['godot', 'space_quest', 'heroes_gates', 'iso8', 'unity'];
/** Downloads the export archives of job jobId (or all latest ones) and unpacks them with the system tar. */
async function fetchExports(assetId, jobId, out, unzip) {
  const m = await get(`/api/forge/assets/${enc(assetId)}`);
  let list = m.exports || [];
  if (jobId) list = list.filter((e) => e.jobId === jobId);
  if (!list.length) return { exported: [], note: 'Архивов экспорта нет (шаг мог завершиться без архива: смотрите предупреждения в forge_job).' };
  const dir = path.resolve(out);
  const exported = [];
  for (const e of list) {
    const got = await downloadTo(e.url, dir, path.basename(e.path || e.url));
    const item = { profile: e.profile, version: e.version, zip: got.path, bytes: got.bytes };
    if (unzip && got.path.toLowerCase().endsWith('.zip')) {
      const target = path.join(dir, path.basename(got.path, '.zip'));
      await fs.mkdir(target, { recursive: true });
      try {
        await new Promise((res, rej) => execFile('tar', ['-xf', got.path, '-C', target], { windowsHide: true }, (err) => (err ? rej(err) : res())));
        item.unpacked = target;
      } catch (err) { item.unpackError = `Не удалось распаковать (${err.message}); архив сохранён как есть.`; }
    }
    exported.push(item);
  }
  return { exported };
}

tool('forge_export',
  'Экспорт ассета в профиль (POST /api/forge/assets/:id/export): godot / space_quest (пакет Godot: GLB + .tscn + скрипт + эффекты), heroes_gates (спрайты «Врат Героев», 8 направлений), iso8 (изометрические спрайты), unity (FBX + текстуры + af_unity.json; импортёр com.astraforge.unity собирает префаб; дальше unity_send). Берёт последнюю завершённую версию. Экспорт долгий (рендер): по умолчанию возвращает jobId. Если задан out — ждёт задачу (timeoutSec) и скачивает архив в папку out с распаковкой.',
  {
    assetId: ID, profile: z.enum(PROFILES),
    params: z.record(z.string(), z.any()).optional().describe('Параметры шага экспорта (godot_package или render_sprites), см. forge_steps.'),
    out: z.string().optional().describe('Папка назначения: включает ожидание и скачивание архива.'),
    unzip: z.boolean().default(true), timeoutSec: z.number().int().min(1).max(7200).default(1800),
  },
  async ({ assetId, profile, params, out, unzip, timeoutSec }) => {
    const started = await post(`/api/forge/assets/${enc(assetId)}/export`, clean({ profile, params }));
    if (!out) return { ...started, note: 'Экспорт запущен. Ход: forge_job; архив: forge_export_fetch.' };
    const job = await forgeJob(started.jobId, { wait: true, timeoutSec, full: false });
    if (job.status !== 'completed') return { ...started, job };
    return { ...started, job: pick(job, ['id', 'status']), ...(await fetchExports(assetId, started.jobId, out, unzip)) };
  });

tool('forge_export_fetch',
  'Скачивает готовые архивы экспорта ассета в папку out (и распаковывает). jobId — только архивы этой задачи экспорта, иначе все архивы паспорта.',
  { assetId: ID, out: z.string(), jobId: ID.optional(), unzip: z.boolean().default(true) },
  ({ assetId, out, jobId, unzip }) => fetchExports(assetId, jobId, out, unzip));

tool('forge_batch',
  'Пакетная сборка по файлу items.json (POST /api/forge/batch): {"items":[{name, kind, source, preset|steps}]}. У элемента source {type:"upload", path:"…"} путь относительно папки файла (файл загружается), либо {type:"job"|"asset"|"params", …}. С wait=true опрашивает GET /api/forge/batch/:id.',
  { file: z.string().describe('Путь к items.json (или массив элементов).'), wait: WAIT, timeoutSec: z.number().int().min(1).max(14400).default(600) },
  async ({ file, wait, timeoutSec }) => {
    const abs = absFile(file, 'Файл пакета');
    const data = JSON.parse((await fs.readFile(abs, 'utf8')).replace(/^\uFEFF/, ''));
    const items = Array.isArray(data) ? data : data.items;
    if (!Array.isArray(items) || !items.length) throw new StudioError('В файле пакета нет items.');
    const files = [];
    const prepared = items.map((item) => {
      const it = structuredClone(item);
      if (it.source?.type === 'upload') {
        const p = path.resolve(path.dirname(abs), String(it.source.path || ''));
        if (!it.source.path || !existsSync(p)) throw new StudioError(`Файл элемента «${it.name || '?'}» не найден: ${p}`);
        it.source = { type: 'upload', fileIndex: files.length };
        files.push(p);
      }
      return it;
    });
    let started;
    if (files.length) {
      const form = new FormData();
      form.append('items', JSON.stringify(prepared));
      for (const f of files) form.append('files[]', await openAsBlob(f), path.basename(f));
      started = await post_form('/api/forge/batch', form);
    } else started = await post('/api/forge/batch', { items: prepared });
    if (!wait) return started;
    const { value, timedOut } = await poll(() => get(`/api/forge/batch/${enc(started.batchId)}`), (b) => b.status !== 'running', { timeoutSec, everySec: 3 });
    return { batchId: started.batchId, ...pick(value, ['status', 'counts']), items: (value.items || []).map((i) => pick(i, ['name', 'assetId', 'jobId', 'status', 'error'])), ...(timedOut ? { waitTimedOut: true } : {}) };
  });

tool('clips_list',
  'Библиотека клипов анимации (GET /api/forge/clips): id, категория, число кадров, имя. Фильтры: query (подстрока id/имени), category.',
  { query: z.string().optional(), category: z.string().optional(), limit: LIMIT, offset: OFFSET },
  async ({ query, category, limit, offset }) => {
    const index = await get('/api/forge/clips');
    let clips = index?.clips || [];
    if (category) clips = clips.filter((c) => String(c.category || '').toLowerCase() === category.toLowerCase());
    if (query) clips = clips.filter((c) => `${c.id} ${c.name || ''}`.toLowerCase().includes(query.toLowerCase()));
    return page(clips.map((c) => pick(c, ['id', 'category', 'frames', 'name', 'tags'])), { limit, offset });
  });

tool('clips_import',
  'Импортирует FBX-клипы из локальной папки в библиотеку (POST /api/forge/clips; до 50 файлов за раз, проверка сигнатуры FBX). Возвращает задачу импорта; ход — forge_job.',
  { folder: z.string().describe('Папка с файлами .fbx.'), wait: WAIT, timeoutSec: TIMEOUT },
  async ({ folder, wait, timeoutSec }) => {
    const dir = path.resolve(folder);
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new StudioError(`Папка не найдена: ${dir}`);
    const names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.fbx')).sort().slice(0, 50);
    if (!names.length) throw new StudioError(`В папке нет файлов .fbx: ${dir}`);
    const form = new FormData();
    for (const n of names) form.append('files[]', await openAsBlob(path.join(dir, n)), n);
    const started = await post_form('/api/forge/clips', form);
    const brief = { jobId: started.jobId ?? started.id, files: started.files, rejected: started.rejected };
    return wait && brief.jobId ? { ...brief, job: await forgeJob(brief.jobId, { wait: true, timeoutSec, full: false }) } : brief;
  });

// ------------------------------------------------------------------ sprites (the render_sprites step)

tool('sprites_render',
  'Рендер спрайтов ассета: обёртка над шагом render_sprites (запускает forge_run со steps [{step:"render_sprites", params}]). Профили: iso8 (по умолчанию: 8 направлений, изометрия 30°, EEVEE, 100 px/м), heroes_gates (ячейка 320/448, 25°, Cycles, 12 кадров, событие удара; kind unit|hero), custom (свои направления [[имя, угол°],…]), pixel (пиксель-арт-профиль; параметры передаются как есть). Любые остальные параметры шага (cell, anchor, height_m, in_place, shadow, grade, engine, samples, cols, event_frames, keep_frames…) — в params; полный перечень — forge_steps со step=render_sprites. Пакет: листы PNG, sprites.json, SpriteFrames .tres. Берёт текущий .blend/GLB ассета (rig + клипы).',
  {
    assetId: ID,
    profile: z.string().default('iso8').describe('iso8 | heroes_gates | custom | pixel (пиксель-арт).'),
    directions: z.array(z.any()).optional().describe('iso8: подмножество S, SW, W, NW, N, NE, E, SE; custom: [[имя, угол°], …].'),
    clips: z.union([z.literal('all'), z.array(z.string())]).optional().describe("'all' или список имён клипов (например ['idle','walk','attack'])."),
    fps: z.number().int().min(1).max(60).optional().describe('Кадров в секунду (iso8 по умолчанию 12; heroes_gates всегда 12).'),
    pixels_per_meter: z.number().min(8).max(1024).optional().describe('Масштаб, пикселей на метр (по умолчанию 100).'),
    params: z.record(z.string(), z.any()).optional().describe('Остальные параметры render_sprites, передаются как есть и перекрывают поля выше.'),
    from: z.string().regex(/^(source|latest|v\d{3,})$/).default('latest').describe('С какой версии брать модель (по умолчанию latest).'),
  },
  async ({ assetId, profile, directions, clips, fps, pixels_per_meter, params, from }) => {
    const stepParams = { ...clean({ profile, directions, clips, fps, pixels_per_meter }), ...(params || {}) };
    return post(`/api/forge/assets/${enc(assetId)}/run`, { steps: [{ step: 'render_sprites', params: stepParams }], from });
  });

// ------------------------------------------------------------------ sculpt (the sculpt step)

const SCULPT_HELP = 'ops — список операций по порядку, каждая {op, region?, symmetry?, …свои параметры}; размеры в метрах в системе модели (Z вверх, лицом в −Y, риг в позе покоя; рост и габариты — forge_asset_show / inspect). ' +
  'op: smooth {iterations 5, factor 0.5}; relax {iterations, factor, keep_volume} — сглаживание без усадки; inflate / deflate {amount} — сдвиг вдоль нормали; flatten {strength, plane}; pinch / expand {amount 0..1}; grab {offset: [x, y, z]}; ' +
  'transfer {source_asset, method project|nearest, strength, align auto|none|bbox} — форма с другой сетки; remesh {mode voxel|quad, voxel_size} (нужен keep_uv: false); subdivide {cuts}; decimate {ratio}; symmetrize {axis x, direction "+"|"-"}. ' +
  'region: {type: "all"} | {type: "sphere", center: [x, y, z], radius, falloff} | {type: "box", center, extents: [hx, hy, hz], feather} | {type: "vertex_group", name} | {type: "bone", name, children}; falloff smooth|linear|sharp|constant; invert: true — обратная маска. ' +
  'Примеры: [{"op": "inflate", "amount": 0.01, "region": {"type": "sphere", "center": [0, -0.1, 1.6], "radius": 0.15}}]; [{"op": "smooth", "iterations": 4}, {"op": "relax", "iterations": 3}]; [{"op": "grab", "offset": [0, 0, 0.02], "region": {"type": "bone", "name": "mixamorig:LeftHand"}}, ' +
  '{"op": "symmetrize", "axis": "x"}]. Арматура, веса и клипы сохраняются (preserve_rig), UV — тоже (keep_uv).';
const SCULPT_STEP_KEYS = ['smooth', 'relax', 'inflate', 'deflate', 'flatten', 'pinch', 'expand', 'grab', 'transfer', 'remesh', 'subdivide', 'decimate', 'symmetrize'];

/** Runs the sculpt step and (wait) awaits it: status, outputs, checks and a summary instead of the raw job. */
async function runSculpt(assetId, params, { from, wait, timeoutSec }) {
  const started = await post(`/api/forge/assets/${enc(assetId)}/run`, { steps: [{ step: 'sculpt', params }], from });
  if (!wait) return { ...started, note: 'Запущено. Ход: forge_job; результат — новая версия ассета (forge_asset_show).' };
  const job = await forgeJob(started.jobId, { wait: true, timeoutSec, full: true });
  const step = (job.steps || []).find((x) => x.step === 'sculpt') || {};
  const r = step.result || {};
  const st = r.stats || {};
  return clean({
    jobId: started.jobId, version: started.version ?? job.version, status: job.status,
    error: job.status === 'failed' ? (r.error || step.error || job.error) : undefined,
    outputs: r.outputs || undefined,
    checks: (r.checks || []).map((c) => clean({ name: c.name, ok: c.ok, severity: c.severity, value: c.value, limit: c.limit })),
    stats: clean({
      tris_before: st.before?.tris, tris_after: st.after?.tris, verts_before: st.before?.verts, verts_after: st.after?.verts,
      ops: st.ops?.map((o) => clean({ op: o.op, region: o.region, seconds: o.seconds, objects: o.objects })), transfer: st.transfer, seconds: st.timings_s?.total,
    }),
    warnings: [...(started.warnings || []), ...(step.warnings || r.warnings || [])],
    waitTimedOut: job.waitTimedOut,
  });
}
const SCULPT_WAIT = z.boolean().default(true).describe('Ждать результата (по умолчанию да); false — вернуть jobId сразу, дальше forge_job.');
const SCULPT_TIMEOUT = z.number().int().min(1).max(7200).default(600).describe('Сколько секунд ждать (по умолчанию 600; ремеш и перенос на больших сетках — минуты). По истечении задача продолжается на сервере.');
const SCULPT_FROM = z.string().regex(/^(source|latest|v\d{3,})$/).default('latest').describe('С какой версии брать модель (по умолчанию latest).');

tool('sculpt',
  'Скульптурные операции над сеткой ассета без окна Blender: обёртка над шагом sculpt (forge_run со steps [{step: "sculpt", params}]). Создаёт новую версию ассета; риг, веса, клипы и UV сохраняются. ' +
  'Выходы: sculpt.glb, sculpt.blend, preview.png (до | после, спереди и три четверти). Ответ: статус, проверки (sculpt_manifold — сетка не разорвана, sculpt_uv_kept, sculpt_rig_kept, sculpt_symmetric, sculpt_changed — что-то сдвинулось; transfer_max_dist_m / transfer_mean_dist_m — расстояние до источника) и сводка по операциям. ' +
  SCULPT_HELP,
  {
    assetId: ID,
    ops: z.array(z.record(z.string(), z.any())).min(1).max(100).describe('Список операций по порядку, см. описание инструмента.'),
    symmetry: z.enum(['x', 'y', 'z', 'none']).optional().describe('Зеркалить маску и операцию по оси (мировая плоскость через ноль); по умолчанию none. У операции может быть своя symmetry.'),
    keep_uv: z.boolean().optional().describe('true (по умолчанию) — UV обязаны уцелеть, remesh при UV отклоняется; false — разрешить remesh, UV и текстура теряются.'),
    preserve_rig: z.boolean().optional().describe('true (по умолчанию) — арматура, клипы и веса остаются; false — статичная сетка без рига.'),
    params: z.record(z.string(), z.any()).optional().describe('Остальные параметры шага sculpt (objects, shade_auto_smooth_deg, tolerance_m, preview, preview_size…), передаются как есть.'),
    from: SCULPT_FROM, wait: SCULPT_WAIT, timeoutSec: SCULPT_TIMEOUT,
  },
  async ({ assetId, ops, symmetry, keep_uv, preserve_rig, params, from, wait, timeoutSec }) => {
    const bad = ops.map((o, i) => (SCULPT_STEP_KEYS.includes(String(o?.op || '').toLowerCase()) ? null : `№${i + 1}: «${o?.op}»`)).filter(Boolean);
    if (bad.length) throw new StudioError(`Неизвестные операции ${bad.join(', ')}. Допустимы: ${SCULPT_STEP_KEYS.join(', ')}.`);
    const stepParams = { ...clean({ ops, symmetry, keep_uv, preserve_rig }), ...(params || {}) };
    return runSculpt(assetId, stepParams, { from, wait, timeoutSec });
  });

tool('sculpt_transfer',
  'Переносит форму с другой сетки на модель ассета: обёртка над операцией transfer шага sculpt. Типичный путь: правка в SculptGL (вкладка «Скульпт») → экспорт OBJ → этот инструмент. UV, веса и риг модели сохраняются, форма берётся с источника (проекция вдоль нормали, для промахов — ближайшая точка), шов области сглаживается. ' +
  'source — путь к OBJ/GLB на этом компьютере (загрузится в студию как отдельный ассет) или sourceAsset — id уже загруженного ассета. align: auto (по умолчанию: если источник другого размера или сдвинут, подгоняет по габариту) | none | bbox. ' +
  'Проверки transfer_max_dist_m и transfer_mean_dist_m показывают, насколько вершины легли на поверхность источника. Область region — как у sculpt (по умолчанию вся сетка); пример: {"type": "sphere", "center": [0, -0.1, 1.6], "radius": 0.2, "falloff": "smooth"}.',
  {
    assetId: ID,
    source: z.string().optional().describe('Абсолютный путь к OBJ/GLB источника на этом компьютере.'),
    sourceAsset: ID.optional().describe('id ассета студии с источником (вместо source).'),
    region: z.record(z.string(), z.any()).optional().describe('Область переноса; пусто — вся сетка.'),
    method: z.enum(['project', 'nearest']).optional().describe('project (по умолчанию) — вдоль нормали, nearest — ближайшая точка.'),
    strength: z.number().min(0).max(1).optional().describe('Доля пути до источника (1 — полностью).'),
    align: z.enum(['auto', 'none', 'bbox']).optional(),
    seam_smooth: z.number().int().min(0).max(50).optional().describe('Проходов сглаживания шва у границы области (по умолчанию 2).'),
    symmetry: z.enum(['x', 'y', 'z', 'none']).optional(),
    params: z.record(z.string(), z.any()).optional().describe('Остальные параметры шага sculpt (tolerance_m, preview…).'),
    from: SCULPT_FROM, wait: SCULPT_WAIT, timeoutSec: SCULPT_TIMEOUT,
  },
  async ({ assetId, source, sourceAsset, region, method, strength, align, seam_smooth, symmetry, params, from, wait, timeoutSec }) => {
    if (!source === !sourceAsset) throw new StudioError('Укажите ровно одно: source (путь к OBJ/GLB) или sourceAsset (id ассета).');
    let srcId = sourceAsset;
    let uploaded;
    if (source) {
      const abs = absFile(source, 'Файл источника');
      const ext = path.extname(abs).toLowerCase();
      if (!['.obj', '.glb'].includes(ext)) throw new StudioError(`Источник ${ext || '(без расширения)'} не годится: нужен OBJ или GLB (экспорт SculptGL).`);
      const form = new FormData();
      form.append('name', `Источник скульпта: ${path.basename(abs, ext)}`);
      form.append('kind', 'prop');
      form.append('source', JSON.stringify({ type: 'upload' }));
      form.append('file', await openAsBlob(abs), path.basename(abs));
      uploaded = await post_form('/api/forge/assets', form);
      srcId = uploaded.id;
    }
    const op = { op: 'transfer', source_asset: srcId, ...clean({ region, method, strength, align, seam_smooth }) };
    const out = await runSculpt(assetId, { ops: [op], ...clean({ symmetry }), ...(params || {}) }, { from, wait, timeoutSec });
    return uploaded ? { sourceAsset: srcId, ...out } : out;
  });

// ------------------------------------------------------------------ effects (local, no studio needed)

async function loadFxPresets() {
  const file = path.join(APP, 'scripts', 'blender', 'data', 'fx_presets.json');
  if (!existsSync(file)) throw new StudioError(`Не найден ${file}. Проверьте ASTRA_APP (сейчас ${APP}).`);
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}
tool('fx_presets',
  'Пресеты эффектов Кузницы (scripts/blender/data/fx_presets.json: fire, smoke, sparks, magic_cast, aura, thruster_glow…). Для godot_package.params.fx: [{preset, socket, params}]. Без name — список с описаниями; с name — полный пресет. Студия для этого не нужна.',
  { name: z.string().optional() },
  async ({ name }) => {
    const data = await loadFxPresets();
    if (name) {
      if (!data.presets[name]) throw new StudioError(`Нет пресета «${name}». Доступны: ${Object.keys(data.presets).join(', ')}.`);
      return data.presets[name];
    }
    return { format: data.format, axes: data._axes, presets: Object.entries(data.presets).map(([id, p]) => ({ id, description: String(p.description || '').slice(0, 220), use: p.use })) };
  });

let fxModule = null;
const loadFxTextures = async () => fxModule || (fxModule = await import(pathToFileURL(path.join(APP, 'src', 'fx-textures.js')).href));

tool('fx_texture_types',
  'Генератор текстур эффектов (src/fx-textures.js, без DOM): типы (soft, spark, star, ring, smoke, flame, lightning, noise, trail, magic…), их параметры с диапазонами и готовые рецепты-пресеты. Студия не нужна.',
  { type: z.string().optional().describe('Тип: вернуть полный список параметров только для него.') },
  async ({ type }) => {
    const m = await loadFxTextures();
    const shape = (t) => ({ id: t.id, title: t.title, group: t.group, params: t.params.map((q) => clean({ key: q.key, label: q.label, type: q.type, min: q.min, max: q.max, default: q.default, options: q.options?.map(([v]) => v) })) });
    if (type) {
      const t = m.FX_TEXTURE_TYPES.find((x) => x.id === type);
      if (!t) throw new StudioError(`Нет типа «${type}». Доступны: ${m.FX_TEXTURE_TYPES.map((x) => x.id).join(', ')}.`);
      return shape(t);
    }
    return { types: m.FX_TEXTURE_TYPES.map((t) => ({ id: t.id, title: t.title, group: t.group })), sizes: m.FX_SIZES, presets: m.FX_TEXTURE_PRESETS.map((p) => ({ id: p.id, title: p.title, type: p.type })) };
  });

tool('fx_texture_generate',
  'Генерирует PNG процедурной текстуры эффекта локально (generateFxTexture + encodeFxPng из src/fx-textures.js): детерминированно по seed. Задайте preset (рецепт из fx_texture_types) либо type + params (size 64–1024, seed, flipbook 1x1/2x2/4x4/8x8, colorMode white|color, color1–3, contrast, gamma, invert…). Файл пишется в out (папка или .png-путь); по умолчанию — временная папка. Студия не нужна.',
  {
    preset: z.string().optional(), type: z.string().optional(),
    params: z.record(z.string(), z.any()).optional().describe('Параметры типа; поверх рецепта, если указан preset.'),
    out: z.string().optional().describe('Папка или полный путь .png; по умолчанию — временная папка (astraforge-fx).'),
  },
  async ({ preset, type, params, out }) => {
    const m = await loadFxTextures();
    let t = type, p = params || {};
    if (preset) {
      const r = m.FX_TEXTURE_PRESETS.find((x) => x.id === preset);
      if (!r) throw new StudioError(`Нет рецепта «${preset}». Доступны: ${m.FX_TEXTURE_PRESETS.map((x) => x.id).join(', ')}.`);
      t = r.type; p = { ...r.params, ...p };
    }
    if (!t) throw new StudioError('Укажите preset или type.');
    const tex = m.generateFxTexture(t, p);            // throws on an unknown type
    const png = await m.encodeFxPng(tex);
    const name = m.fxFileName(t, p);
    const target = out && /\.png$/i.test(out) ? path.resolve(out) : path.join(path.resolve(out || path.join(os.tmpdir(), 'astraforge-fx')), name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, png);
    return { path: target, bytes: png.length, width: tex.width, height: tex.height, flipbook: tex.flipbook, tileable: tex.tileable, type: t, params: m.resolveFxParams(t, p) };
  });

// ------------------------------------------------------------------ projects (/api/projects)

tool('projects_list', 'Сохранённые проекты студии (GET /api/projects): id, имя, дата. Миниатюры отброшены.',
  { query: z.string().optional(), limit: LIMIT, offset: OFFSET },
  async ({ query, limit, offset }) => {
    let list = await get('/api/projects');
    if (query) list = list.filter((p) => String(p.name).toLowerCase().includes(query.toLowerCase()));
    return page(list.map((p) => pick(p, ['id', 'name', 'updatedAt'])), { limit, offset });
  });

tool('project_get',
  'Краткая сводка проекта (GET /api/projects/:id): число объектов, мешей, костей, геометрий, материалов, текстур, клипы, настройки эффектов и анимации. Саму сцену не возвращает. Сцена живёт в браузере; изменить проект через MCP нельзя.',
  { id: z.string().uuid() },
  async ({ id }) => {
    const p = await get(`/api/projects/${enc(id)}`, { timeout: 120000 });
    const counts = { objects: 0, meshes: 0, skinnedMeshes: 0, lights: 0, cameras: 0, groups: 0, bones: 0 };
    const names = [];
    const walk = (o, depth = 0) => {
      if (!o) return;
      counts.objects++;
      const t = o.type;
      if (t === 'SkinnedMesh') { counts.skinnedMeshes++; counts.meshes++; } else if (t === 'Mesh') counts.meshes++;
      else if (t === 'Bone') counts.bones++;
      else if (/Light$/.test(t)) counts.lights++;
      else if (/Camera$/.test(t)) counts.cameras++;
      else if (t === 'Group' || t === 'Object3D') counts.groups++;
      if (depth <= 2 && o.name && names.length < 30 && t !== 'Bone') names.push(o.name);
      for (const c of o.children || []) walk(c, depth + 1);
    };
    walk(p.scene?.object);
    const ed = p.editor || {};
    return {
      ...pick(p, ['id', 'name', 'updatedAt']), counts, topNames: names,
      geometries: p.scene?.geometries?.length || 0, materials: p.scene?.materials?.length || 0, textures: p.scene?.textures?.length || 0, skeletons: p.scene?.skeletons?.length || 0,
      editor: { ...pick(ed, ['duration', 'time', 'preset', 'effect', 'effectSize', 'clipName', 'rigMode']), tracks: Array.isArray(ed.tracks) ? ed.tracks.length : (ed.tracks ? Object.keys(ed.tracks).length : 0), savedClips: Array.isArray(ed.savedClips) ? ed.savedClips.map((c) => c?.name || c) : [] },
    };
  });

// ------------------------------------------------------------------ VFX (/api/vfx-tools)

tool('vfx_tools',
  'Каталог внешних генераторов VFX-текстур (GET /api/vfx-tools): id, название, вид (desktop / installer / web-local / web / file), лицензия, доступность на этом компьютере (скачан ли), адрес веб-генератора. fresh=true сбрасывает кэш поиска установленных программ.',
  { kind: z.string().optional().describe('Фильтр по виду: desktop, installer, web-local, web, file.'), fresh: z.boolean().default(false), full: z.boolean().default(false).describe('Все поля записей.'), limit: z.number().int().min(1).max(200).default(60), offset: OFFSET },
  async ({ kind, fresh, full, limit, offset }) => {
    const data = await get(`/api/vfx-tools${fresh ? '?fresh=1' : ''}`);
    let tools = data.tools || [];
    if (kind) tools = tools.filter((t) => t.kind === kind);
    return { root: data.root, rootExists: data.rootExists, webPort: data.webPort, webUrl: data.webUrl, webError: data.webError, ...page(full ? tools : tools.map((t) => clean({ ...pick(t, ['id', 'name', 'kind', 'license', 'tags', 'available', 'installed', 'present', 'status', 'webUrl']), ru: t.ru ? String(t.ru).slice(0, 120) : undefined })), { limit, offset }) };
  });

tool('vfx_textures',
  'Готовые текстуры из папки VFX (GET /api/vfx-tools/textures): имя, размер, дата, url; новые сверху. С importName копирует эту текстуру в ассеты студии и возвращает {id, url} (для накладывания на модель или generate_3d).',
  { importName: z.string().optional().describe('Имя файла из списка: импортировать в ассеты студии.'), limit: LIMIT, offset: OFFSET },
  async ({ importName, limit, offset }) => {
    if (importName) return post(`/api/vfx-tools/textures/${enc(importName)}/import`);
    return page(await get('/api/vfx-tools/textures'), { limit, offset });
  });

tool('vfx_tool_launch',
  'Запускает VFX-инструмент на компьютере владельца (POST /api/vfx-tools/:id/launch): откроется окно программы (desktop / installer) или файл-заготовка в Material Maker. Веб-генераторы запуску не подлежат: адрес в vfx_tools. Если инструмент не скачан, ответ подскажет, как установить.',
  { id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe('id инструмента из vfx_tools.') }, ({ id }) => post(`/api/vfx-tools/${enc(id)}/launch`));

// ------------------------------------------------------------------ sound (/api/sound/*, docs/product/sound.md)
// The family mirrors the Sound tab: MOSS-SoundEffect makes an effect from a description, ACE-Step a
// seamless loop of whole bars; both run locally in runtime/sound. A task is one worker subprocess,
// so "running" is never a service. Removing a sound moves it to the trash; exports carry no marks.

tool('sound_status',
  'Звуковой движок студии: установлены ли обе модели (MOSS-SoundEffect v2 — эффекты по описанию, ACE-Step 1.5 — музыкальные петли), где лежат, чего не хватает и как это поставить (-Only sound), сколько примерно идёт генерация, какие события (footstep, impact, spell…) доступны для привязки и какие пресеты длин/темпов предлагает вкладка «Звук». Это же состояние видно в studio_status в поле sound.',
  {}, async () => {
    const s = await get('/api/sound/status', { timeout: 20000 });
    return clean(pick(s, ['installed', 'running', 'dir', 'missing', 'message', 'estimate', 'busy', 'events', 'presets']));
  });

tool('sound_generate',
  'Сгенерировать звук локально (POST /api/sound/tasks): kind=sfx — эффект по описанию (MOSS-SoundEffect, 48 кГц моно, 1–30 с), kind=loop — замкнутая музыкальная петля на целое число тактов (ACE-Step, 48 кГц стерео; длина = bars*4*60/bpm, хвост подмешан в начало, поэтому петля повторяется без стыка). Готовый файл сам попадает в библиотеку проекта (WAV + OGG). Возвращает задачу; с wait=true дожидается и отдаёт запись библиотеки в item. Очередь одна: во время генерации видеокарта занята.',
  {
    kind: z.enum(['sfx', 'loop']).default('sfx').describe('sfx — эффект по описанию; loop — музыкальная петля по тактам.'),
    prompt: z.string().min(3).max(600).describe('Описание: «footsteps on gravel, steady pace» или «calm exploration theme, soft strings and piano».'),
    seconds: z.number().int().min(1).max(30).optional().describe('Для sfx: длительность 1–30 с (по умолчанию 10).'),
    bpm: z.number().int().min(40).max(240).optional().describe('Для loop: темп, 40–240 BPM (по умолчанию 120).'),
    bars: z.number().int().min(1).max(8).optional().describe('Для loop: тактов, 1–8 (по умолчанию 4).'),
    seed: z.number().int().min(0).max(2147483647).optional().describe('Зерно: одно и то же зерно + описание = тот же звук.'),
    wait: WAIT, timeoutSec: TIMEOUT,
  },
  async ({ kind, prompt, seconds, bpm, bars, seed, wait, timeoutSec }) => {
    const body = clean({ kind, prompt, seconds, bpm, bars, seed });
    const started = await post('/api/sound/tasks', body, { timeout: 30000 });
    if (!wait) return pick(started, ['id', 'kind', 'status', 'progress', 'message', 'createdAt']);
    const { value, timedOut } = await poll(() => get(`/api/sound/tasks/${enc(started.id)}`), (t) => ['completed', 'failed', 'cancelled'].includes(t?.status), { timeoutSec, everySec: 3 });
    const task = value || started;
    return clean({ id: task.id, kind: task.kind, status: task.status, progress: task.progress, message: task.message, error: task.error, timedOut, item: task.item });
  });

tool('sound_list',
  'Библиотека звука проекта (GET /api/sound/library): id, имя, вид (sfx|loop), описание, длительность или такты/темп, зерно, движок, дата, есть ли WAV и OGG. Фильтры: kind, query (подстрока имени/описания). Удалённые звуки здесь не показываются — они в data/sound/trash и возвращаются на место вручную.',
  { kind: z.enum(['sfx', 'loop']).optional(), query: z.string().max(80).optional(), limit: LIMIT, offset: OFFSET },
  async ({ kind, query, limit, offset }) => {
    let items = await get('/api/sound/library');
    if (kind) items = items.filter((x) => x.kind === kind);
    if (query) items = items.filter((x) => `${x.name || ''} ${x.prompt || ''}`.toLowerCase().includes(query.toLowerCase()));
    return page(items.map((x) => clean({ ...pick(x, ['id', 'name', 'kind', 'prompt', 'seconds', 'bpm', 'bars', 'seed', 'engine', 'createdAt']), has: { wav: !!x.wav, ogg: !!x.ogg } })), { limit, offset });
  });

tool('sound_bind',
  'Привязать звук к событию ассета (PUT /api/sound/bindings): assetId — id объекта из сцены/проекта, event — событие из sound_status (footstep, run, jump, attack, hit, death, impact, spell, ui_click, ambient), soundId — звук из sound_list. Пустой soundId снимает привязку. Возвращает все привязки этого ассета; если звук убрали в корзину, привязка остаётся видимой и ждёт выбора заново.',
  { assetId: ID, event: z.string().max(30).describe('Одно из событий sound_status.'), soundId: z.string().uuid().optional().describe('Звук из sound_list; пусто — снять привязку.') },
  async ({ assetId, event, soundId }) => {
    const st = await get('/api/sound/status', { timeout: 20000 }).catch(() => ({}));
    const events = st.events || [];
    if (events.length && !events.includes(event)) throw new StudioError(`Неизвестное событие «${event}». Доступны: ${events.join(', ')}.`);
    return call('PUT', '/api/sound/bindings', { json: { assetId, event, soundId: soundId || null }, timeout: 20000 });
  });

tool('sound_export',
  'Звуковой набор ассета как файлы: скачивает все привязанные к ассету звуки (sound_bind) в папку out и возвращает {folder, files:[{event,soundId,name,file,bytes}], missing:[{event,soundId,reason}]}. Файлы — обычный WAV/OGG без служебных меток (политика ветки). Формат: wav (по умолчанию), ogg, both. Если звук лежит в корзине, вместо файла придёт причина в missing.',
  { assetId: ID, out: z.string().describe('Папка, куда положить файлы (создаётся).'), format: z.enum(['wav', 'ogg', 'both']).default('wav'), limit: z.number().int().min(1).max(50).default(20) },
  async ({ assetId, out, format, limit }) => {
    const bindings = await get('/api/sound/bindings');
    const map = bindings?.[assetId] || {};
    const entries = Object.entries(map).slice(0, limit);
    if (!entries.length) return { folder: null, files: [], missing: [], note: 'У этого ассета нет привязанных звуков: сначала sound_bind.' };
    const dir = path.resolve(out);
    await fs.mkdir(dir, { recursive: true });
    const kinds = format === 'both' ? ['wav', 'ogg'] : [format];
    const files = [], missing = [];
    for (const [event, soundId] of entries) {
      for (const k of kinds) {
        try {
          const res = await call('GET', `/api/sound/library/${enc(soundId)}/${k}`, { raw: true, timeout: 60000 });
          const buf = Buffer.from(await res.arrayBuffer());
          const file = path.join(dir, `${assetId.slice(0, 8)}-${event}.${k}`);
          await fs.writeFile(file, buf);
          files.push({ event, soundId, format: k, file, bytes: buf.length });
        } catch (e) { missing.push({ event, soundId, format: k, reason: e.message }); }
      }
    }
    return { folder: dir, files, missing };
  });

// ------------------------------------------------------------------ Unity

const UNITY_EDITORS = 'C:/Program Files/Unity/Hub/Editor';
const UNITY_CHECK_PROJECT = process.env.ASTRA_UNITY_PROJECT || (process.platform === 'win32' ? 'C:/AstraForge/unity/AFUnityCheck' : path.join(APP, 'data', 'unity', 'AFUnityCheck'));

async function unityHubProjects() {
  const file = path.join(process.env.APPDATA || '', 'UnityHub', 'projects-v1.json');
  if (!existsSync(file)) return [];
  const data = JSON.parse(await fs.readFile(file, 'utf8')).data || {};
  return Object.values(data).map((p) => ({ title: p.title, path: p.path, version: p.version, lastModified: p.lastModified ? new Date(p.lastModified).toISOString() : null }));
}

tool('unity_status',
  'Unity на этой машине: установленные редакторы (Unity Hub), проекты Hub, проверочный проект студии (AFUnityCheck, URP), лицензия (дата файла), версия импортёра com.astraforge.unity в репозитории. Ничего не запускает; вне Windows отсутствующие пути дают пустые списки.',
  {},
  async () => {
    const editors = existsSync(UNITY_EDITORS) ? (await fs.readdir(UNITY_EDITORS)).filter((v) => existsSync(path.join(UNITY_EDITORS, v, 'Editor', 'Unity.exe'))) : [];
    const lic = path.join(process.env.LOCALAPPDATA || '', 'Unity', 'licenses', 'UnityEntitlementLicense.xml');
    const importer = path.join(APP, 'unity', 'com.astraforge.unity', 'package.json');
    const marker = path.join(UNITY_CHECK_PROJECT, 'ProjectSettings', 'af_check_project.json');
    return {
      editors, default_editor: editors.includes('6000.0.64f1') ? '6000.0.64f1' : editors.sort().at(-1) || null,
      license_file: existsSync(lic) ? { path: lic, modified: (await fs.stat(lic)).mtime.toISOString(), note: 'Пакетный режим требует входа в Unity Hub; файл обновляется Hub-ом.' } : null,
      check_project: { path: UNITY_CHECK_PROJECT, ready: existsSync(marker), open_in_editor: existsSync(path.join(UNITY_CHECK_PROJECT, 'Temp', 'UnityLockfile')) },
      importer: existsSync(importer) ? JSON.parse(await fs.readFile(importer, 'utf8')).version : null,
      hub_projects: await unityHubProjects(),
    };
  });

tool('unity_send',
  'Кладёт пакеты Unity из студии в проект Unity (только по просьбе владельца: пишет в этот проект). sources — папки пакетов (с af_unity.json) или архивы экспорта профиля unity. Импортёр com.astraforge.unity копируется в Packages/ проекта (встроенный пакет), пакет — в Assets/AstraForge/<asset_id>/ поверх прежнего (.meta сохраняются). Открытый редактор соберёт префаб сам; build=true собирает сразу в batchmode (проект должен быть закрыт).',
  {
    project: z.string().describe('Папка проекта Unity (с Assets/ и ProjectSettings/).'),
    sources: z.array(z.string()).min(1).describe('Папки пакетов или .zip экспорта unity.'),
    build: z.boolean().default(false),
  },
  async ({ project, sources, build }) => {
    const mod = await import(pathToFileURL(path.join(APP, 'scripts', 'unity', 'af_unity_send.mjs')).href);
    const log = [];
    const res = await mod.sendToUnity({ project, sources, build, log: (t) => log.push(t) });
    return { ...res, log };
  });

tool('unity_check',
  'Проверка пакетов Unity в проверочном проекте студии (Unity -batchmode, один запуск на все пакеты): префаб, материалы без «розового», Avatar Humanoid/Generic, клипы и петли, анимация играет, сокеты, эффекты, LOD, коллайдер, размер как в Godot, спрайты; скриншоты и contact_sheet.png. Долго (20 с … несколько минут при первом запуске).',
  {
    packages: z.array(z.string()).min(1).describe('Папки пакетов (с af_unity.json).'),
    out: z.string().describe('Папка для отчёта и скриншотов.'),
    timeoutSec: z.number().int().min(30).max(3600).default(1800),
  },
  async ({ packages, out, timeoutSec }) => {
    const script = path.join(APP, 'scripts', 'unity', 'unity_check.py');
    const outAbs = path.resolve(out);
    // platform gate: Windows ships the py launcher; Linux uses python3 (or ASTRA_PYTHON)
    const py = process.platform === 'win32' ? 'py' : (process.env.ASTRA_PYTHON || 'python3');
    const text = await new Promise((resolve) => {
      execFile(py, ['-I', script, ...packages.map((p) => path.resolve(p)), '--out', outAbs],
        { windowsHide: true, timeout: timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => resolve(`${stdout || ''}${stderr ? `\n${stderr}` : ''}${err && !stdout ? `\n${err.message}` : ''}`));
    });
    const reportPath = path.join(outAbs, '_unity_check', 'unity_report.json');
    const report = existsSync(reportPath) ? JSON.parse((await fs.readFile(reportPath, 'utf8')).replace(/^\uFEFF/, '')) : null;
    const sheet = path.join(outAbs, 'unity_shots', 'contact_sheet.png');
    return { ok: !!report?.ok, summary: text.trim().split('\n').slice(0, 120).join('\n'), report_file: report ? reportPath : null,
             contact_sheet: existsSync(sheet) ? sheet : null };
  });

// ------------------------------------------------------------------ engines: Unity and Godot projects in the background

const engineLib = () => import(pathToFileURL(path.join(APP, 'scripts', 'engines', 'af_engine.mjs')).href);
const ENGINE = z.enum(['unity', 'godot']);
const withLog = async (fn) => { const log = []; const res = await fn((t) => log.push(t)); return { ...res, log }; };

tool('engine_status',
  'Движки и связка: редакторы Unity (версии, дата лицензии), Godot, зарегистрированы ли MCP-серверы astraforge / UnityMCP / godot в Claude Code, проекты движков в реестре (ASTRA_ENGINES_HOME; C:/AstraForge/engines на Windows) и открыт ли проект в редакторе Unity. Ничего не запускает.',
  {}, async () => (await engineLib()).status());

tool('engine_project_create',
  'Создаёт проект движка в фоне, без окон: Unity — batchmode из шаблона URP редактора + импортёр com.astraforge.unity (+ MCP for Unity при withMcp); Godot — project.godot 4.5 + первый headless-импорт. Регистрирует проект в реестре под именем игры (у одной игры может быть и Unity-, и Godot-проект).',
  {
    engine: ENGINE, name: z.string().min(1).describe('Имя игры/проекта.'),
    path: z.string().optional().describe('Папка проекта; по умолчанию — папка projects в каталоге движков реестра.'),
    pipeline: z.enum(['urp', 'builtin', 'hdrp']).default('urp'),
    renderer: z.enum(['forward_plus', 'mobile', 'gl_compatibility']).default('forward_plus').describe('Godot: рендерер (gl_compatibility — веб и слабые ПК).'),
    withMcp: z.boolean().default(true).describe('Unity: поставить MCP for Unity (живое управление редактором через UnityMCP).'),
  },
  ({ engine, name, path: dir, pipeline, renderer, withMcp }) => withLog(async (log) => (await engineLib()).createProject({ engine, name, dir, pipeline, renderer, withMcp, log })));

tool('engine_project_link',
  'Привязывает существующий проект Unity или Godot владельца к реестру (движок определяется по папке). Ничего в проекте не меняет.',
  { path: z.string(), name: z.string().optional() },
  async ({ path: dir, name }) => (await engineLib()).linkProject({ dir, name }));

tool('engine_send',
  'Кладёт пакеты студии в проект движка: Unity — пакеты профиля unity (папки с af_unity.json или zip экспорта): импортёр в Packages/, ассет в Assets/AstraForge/<id>/; Godot — пакеты профилей godot / space_quest (af_package.json): res://astraforge/<id>/ + headless-импорт. Пишет в проект — только по просьбе владельца.',
  {
    project: z.string().describe('Имя из реестра или папка проекта.'), engine: ENGINE.optional().describe('Если под одним именем есть оба движка.'),
    sources: z.array(z.string()).min(1), build: z.boolean().default(false).describe('Unity: собрать префабы сразу (проект закрыт).'),
  },
  ({ project, engine, sources, build }) => withLog(async (log) => (await engineLib()).sendPackages({ project, engine, sources, build, log })));

tool('engine_scaffold',
  'Логика под ассет по шаблону скилла astraforge-integrator. kind=player: управление персонажем (Unity: Assets/Game/Scripts/PlayerController.cs + asmdef, Godot: res://scripts/player_controller.gd) и смоук-тесты (Unity EditMode, Godot res://tests/run_tests.gd). Существующие файлы не трогает без force.',
  { project: z.string(), engine: ENGINE.optional(), kind: z.enum(['player']).default('player'), assetId: z.string().describe('asset_id персонажа в проекте.'), force: z.boolean().default(false) },
  ({ project, engine, kind, assetId, force }) => withLog(async (log) => (await engineLib()).scaffold({ project, engine, kind, assetId, force, log })));

tool('engine_test',
  'Тесты проекта в фоне, без окон. Unity (batchmode): проверка пакетов AstraForge (префабы, материалы, Avatar, клипы, сокеты, эффекты, LOD, размер) + EditMode-тесты проекта (playMode — ещё PlayMode); если проект открыт в редакторе — подсказка про UnityMCP. Godot (headless): все сцены res://astraforge и res://scenes грузятся и работают N кадров + res://tests/run_tests.gd; shots — кадры из окна за пределами экрана. Отчёт и кадры — в папке reports каталога движков.',
  {
    project: z.string(), engine: ENGINE.optional(), shots: z.boolean().default(false), playMode: z.boolean().default(false),
    scene: z.string().optional().describe('Godot: проверить одну сцену res://…'), frames: z.number().int().min(1).max(3000).default(120),
  },
  ({ project, engine, shots, playMode, scene, frames }) => withLog(async (log) => (await engineLib()).testProject({ project, engine, shots, playMode, scene, frames, log })));

tool('engine_mcp_register',
  'Регистрирует в Claude Code (scope user) серверы движков, если их нет: UnityMCP (MCP for Unity 10.3.0, stdio, телеметрия выключена) и godot (Godot MCP, GODOT_PATH = найденный Godot). Новые инструменты появятся в следующей сессии Claude Code.',
  {}, async () => withLog(async (log) => (await engineLib()).registerMcp({ log })));

// ------------------------------------------------------------------ MCP resources

server.registerResource('astraforge-status', 'astraforge://status',
  { title: 'Состояние студии', description: 'Текущий /api/health + /api/status студии AstraForge (JSON).', mimeType: 'application/json' },
  async (uri) => {
    let body;
    try {
      const [health, st] = await Promise.all([get('/api/health', { timeout: 5000 }), get('/api/status', { timeout: 15000 }).catch(() => null)]);
      body = { running: true, url: BASE, health, status: st };
    } catch (err) { body = { running: false, url: BASE, error: err.message }; }
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 1) }] };
  });

server.registerResource('astraforge-skill', 'astraforge://skill',
  { title: 'Руководство AstraForge', description: 'Текст скилла ai/skills/astraforge/SKILL.md: роль студии, конвейер, правила работы.', mimeType: 'text/markdown' },
  async (uri) => {
    const file = path.join(APP, 'ai', 'skills', 'astraforge', 'SKILL.md');
    const text = existsSync(file) ? await fs.readFile(file, 'utf8') : `Файл ${file} не найден (ASTRA_APP=${APP}).`;
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
  });

// ------------------------------------------------------------------ start

await server.connect(new StdioServerTransport());
