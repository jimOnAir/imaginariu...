// Ollama that runs itself (docs/product/ollama.md, 0.6.x wave ticket 14): where the program is,
// starting it when it is silent, and picking models that are ACTUALLY installed - assistant and
// review both, older generations included. Nothing here may download or guess a model name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ollamaExecutable, isLocalServeUrl, pickChatModel, ollamaTags, ollamaModels, ollamaCatalog, ensureOllama, NO_TEXT_MODEL_HINT, CHAT_LADDER } from '../server/ollama-run.mjs';
import { isVisionModelName, pickReviewModel, publishQaModel, FALLBACK_REVIEW_MODEL } from '../server/vlm.mjs';

const mkTmp = () => mkdtempSync(path.join(tmpdir(), 'af-ollama-'));
const exeFile = (p) => { writeFileSync(p, '#!/bin/sh\n'); chmodSync(p, 0o755); return p; };
const M = (name, extra = {}) => ({ name, size: 6.2e9, digest: 'sha256:' + name, details: { family: 'qwen3vl', parameter_size: '8.2B' }, ...extra });
const tagsBody = (models) => ({ ok: true, json: async () => ({ models }) });
const offline = { ok: false, json: async () => ({}) };

// ------------------------------------------------------------------ where ollama lives

test('isLocalServeUrl: only the loopback default port may ever be auto-started', () => {
  for (const u of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://127.0.0.1:11434/', 'http://[::1]:11434']) assert.ok(isLocalServeUrl(u), u);
  for (const u of ['http://127.0.0.1:11435', 'http://127.0.0.1', 'http://192.168.1.9:11434', 'https://127.0.0.1:11434', 'https://ollama.com', '', null]) assert.ok(!isLocalServeUrl(u), String(u));
});

test('ollamaExecutable: ASTRA_OLLAMA_EXE, then config/paths.json (ollama), then PATH', () => {
  const dir = mkTmp();
  try {
    const fromEnv = exeFile(path.join(dir, 'env-ollama'));
    const fromCfg = exeFile(path.join(dir, 'cfg-ollama'));
    const fromBin = exeFile(path.join(dir, 'ollama'));
    const app = path.join(dir, 'app');
    mkdirSync(path.join(app, 'config'), { recursive: true });
    writeFileSync(path.join(app, 'config', 'paths.json'), JSON.stringify({ ollama: fromCfg }));
    // only files inside the sandbox count, so this test behaves the same on a machine that has Ollama
    const exists = (p) => p.startsWith(dir);
    assert.equal(ollamaExecutable({ env: { ASTRA_OLLAMA_EXE: fromEnv, PATH: dir }, appRoot: app, exists }), fromEnv, 'env wins');
    assert.equal(ollamaExecutable({ env: { PATH: dir }, appRoot: app, exists }), fromCfg, 'the installer-written path wins over PATH');
    assert.equal(ollamaExecutable({ env: { PATH: dir }, appRoot: path.join(dir, 'empty'), exists }), fromBin, 'PATH is the fallback');
    assert.equal(ollamaExecutable({ env: {}, appRoot: path.join(dir, 'empty'), exists: () => false }), null, 'not installed is null, never a guess');
    // a path in paths.json that does not exist is skipped, not reported as found
    writeFileSync(path.join(app, 'config', 'paths.json'), JSON.stringify({ ollama: path.join(dir, 'gone') }));
    assert.equal(ollamaExecutable({ env: { PATH: dir }, appRoot: app, exists }), fromBin);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ the assistant model

test('the chat ladder is the installer own byVram table, in small-to-big order', () => {
  assert.ok(CHAT_LADDER.length >= 2, 'installer/manifest.json llm.byVram loaded');
  const byModel = Object.fromEntries(CHAT_LADDER.map((r) => [r.model, r.minVramMiB]));
  assert.ok(byModel['qwen3:8b'] > 0 && byModel['qwen3:14b'] > byModel['qwen3:8b'], JSON.stringify(byModel));
  assert.ok(CHAT_LADDER.every((r, i) => i === 0 || r.minVramMiB >= CHAT_LADDER[i - 1].minVramMiB), 'sorted');
});

test('pickChatModel: the configured model when installed, otherwise the best installed text model', () => {
  const installed = ['qwen3-vl:8b', 'qwen3:8b', 'qwen2.5-coder:7b'];
  assert.equal(pickChatModel('qwen3:8b', installed), 'qwen3:8b', 'the configured one');
  assert.equal(pickChatModel('  qwen2.5-coder:7b ', installed), 'qwen2.5-coder:7b', 'spaces are the user, not a different model');
  assert.equal(pickChatModel('qwen2.5-coder', ['qwen2.5-coder:7b', 'qwen2.5-coder:latest']), 'qwen2.5-coder:latest', ':latest counts as the same model');
  assert.equal(pickChatModel('qwen3:14b', installed), 'qwen3:8b', 'a configured model that is not here does not break the request');
  assert.equal(pickChatModel('', installed), 'qwen3:8b', 'empty = Auto takes the biggest installed card-safe model, never the vision one');
  assert.equal(pickChatModel('', ['qwen2.5-coder:7b', 'minicpm-v:8b']), 'qwen2.5-coder:7b', 'and any text model beats none');
  assert.equal(pickChatModel('', ['qwen3-vl:8b', 'llava:7b']), null, 'vision-only has no chat model - the caller says so in words');
  assert.equal(pickChatModel('', []), null, 'nothing installed says null, not a model name nobody pulled');
  // the card filters the ladder: 14b wants 16 GiB, a 12 GiB card gets the 4b it can hold
  assert.equal(pickChatModel('', ['qwen3:4b', 'qwen3:14b'], 12288), 'qwen3:4b');
  assert.equal(pickChatModel('', ['qwen3:4b', 'qwen3:14b'], 24576), 'qwen3:14b', 'a 24 GiB card takes the biggest installed');
});

test('NO_TEXT_MODEL_HINT points at the installer row and the Connections screen', () => {
  assert.match(NO_TEXT_MODEL_HINT, /Components/);
  assert.match(NO_TEXT_MODEL_HINT, /-Only llm/);
});

// ------------------------------------------------------------------ what the machine has (catalog)

test('ollamaTags / ollamaModels: null is "does not answer", [] is "empty"', async () => {
  assert.deepEqual(await ollamaModels('u', async () => tagsBody([M('qwen3:8b'), M('qwen3-vl:8b')])), ['qwen3:8b', 'qwen3-vl:8b']);
  assert.equal(await ollamaModels('u', async () => offline), null, 'HTTP failure');
  assert.equal(await ollamaModels('u', async () => { throw new Error('ECONNREFUSED'); }), null, 'no server');
  assert.deepEqual(await ollamaTags('u', async () => tagsBody([])), [], 'a running Ollama with zero models is not offline');
});

test('ollamaCatalog: Ollama own capabilities decide vision; name fallback; cached per digest', async () => {
  let shows = 0;
  const fetchFn = async (url, opts) => {
    if (String(url).endsWith('/api/tags')) return tagsBody([M('qwen3-vl:8b'), M('qwen3:8b'), M('retro-vision:1b')]);
    if (String(url).endsWith('/api/show')) {
      shows++;
      if (opts.body.includes('qwen3-vl')) return { ok: true, json: async () => ({ capabilities: ['completion', 'vision'] }) };
      if (opts.body.includes('qwen3:8b')) return { ok: true, json: async () => ({ capabilities: ['completion'] }) };
      throw new Error('this Ollama has no /api/show');
    }
    throw new Error('unexpected ' + url);
  };
  const cat = await ollamaCatalog('u', fetchFn, (n) => n.startsWith('retro-'));
  assert.deepEqual(cat.map((m) => [m.name, m.vision]), [['qwen3-vl:8b', true], ['qwen3:8b', false], ['retro-vision:1b', true]]);
  assert.equal(cat[0].size, 6.2e9); assert.equal(cat[0].params, '8.2B'); assert.equal(cat[0].family, 'qwen3vl');
  assert.equal(shows, 3, 'every model asked once');
  await ollamaCatalog('u', fetchFn, (n) => n.startsWith('retro-'));
  assert.equal(shows, 3, 'same name@digest: asked once, cached');
  assert.equal(await ollamaCatalog('u', async () => { throw new Error('down'); }, () => false), null, 'offline is null, not an empty list');
});

// ------------------------------------------------------------------ starting it

test('ensureOllama: answers already - nothing to do; remote address - never a process here', async () => {
  let spawned = 0;
  const spawnFn = () => { spawned++; return { unref() {} }; };
  const up = await ensureOllama({ fetchFn: async () => tagsBody([M('qwen3:8b')]), spawnFn });
  assert.deepEqual(up, { running: true, started: false, exe: null, reason: '' });
  const remote = await ensureOllama({ url: 'http://192.168.1.9:11434', fetchFn: async () => { throw new Error('down'); }, spawnFn });
  assert.equal(remote.running, false); assert.equal(remote.started, false, 'a remote Ollama is somebody else process');
  assert.match(remote.reason, /192\.168\.1\.9:11434/); assert.match(remote.reason, /127\.0\.0\.1:11434/);
  assert.equal(spawned, 0);
});

test('ensureOllama: starts the installed program and waits; one start attempt per address', async () => {
  const dir = mkTmp();
  try {
    const exe = exeFile(path.join(dir, 'ollama'));
    let spawned = 0, calls = 0;
    const spawnFn = () => { spawned++; return { unref() {} }; };
    const fetchFn = async () => (++calls > 3 ? tagsBody([M('qwen3:8b')]) : offline);
    const opts = { url: 'http://127.0.0.1:11434', appRoot: dir, env: { ASTRA_OLLAMA_EXE: exe, PATH: '' }, exists: (p) => p.startsWith(dir), fetchFn, spawnFn, waitMs: 5000, sleepFn: async () => {} };
    const [a, b] = await Promise.all([ensureOllama(opts), ensureOllama(opts)]);   // two requests while it is down
    assert.equal(a.running, true); assert.equal(a.started, true); assert.equal(a.exe, exe);
    assert.deepEqual(b, a, 'the second caller waits for the same start, it does not spawn a second server');
    assert.equal(spawned, 1, 'single flight: one `ollama serve` for concurrent callers');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ensureOllama honest failures: not installed, and started-but-silent', async () => {
  const dir = mkTmp();
  try {
    const exe = exeFile(path.join(dir, 'ollama'));
    const none = await ensureOllama({ appRoot: dir, env: { PATH: '' }, exists: () => false, fetchFn: async () => offline, spawnFn: () => assert.fail('must not spawn') });
    assert.equal(none.running, false); assert.equal(none.started, false);
    assert.match(none.reason, /not installed/i); assert.match(none.reason, /install\.sh/);
    let spawned = 0;
    const slow = await ensureOllama({
      appRoot: dir, env: { ASTRA_OLLAMA_EXE: exe, PATH: '' }, exists: (p) => p.startsWith(dir), fetchFn: async () => offline,
      spawnFn: () => { spawned++; return { unref() {} }; }, waitMs: 40, everyMs: 5,
      now: (() => { let t = 0; return () => (t += 25); })(), sleepFn: async () => {},
    });
    assert.equal(slow.running, false); assert.equal(slow.started, true); assert.equal(spawned, 1);
    assert.match(slow.reason, /did not answer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ the review model

test('pickReviewModel: env, then the configured pick, then the card tier', () => {
  const big = 12288, small = 8192;
  const byEnv = pickReviewModel(big, ['qwen3.5:9b'], { ASTRA_REVIEW_VLM: 'my-vl:2b' }, 'qwen3.5:9b');
  assert.deepEqual([byEnv.model, byEnv.installed], ['my-vl:2b', false], 'the env override wins even over an installed tier model');
  assert.equal(pickReviewModel(big, ['my-vl:2b'], { ASTRA_REVIEW_VLM: 'my-vl:2b' }, '').model, 'my-vl:2b');

  const chosen = pickReviewModel(big, ['qwen2.5-vl:7b', 'qwen3.5:9b'], {}, 'qwen2.5-vl:7b');
  assert.deepEqual([chosen.model, chosen.reason], ['qwen2.5-vl:7b', 'chosen in Connections'], 'the user pick, whatever generation it is');
  assert.equal(pickReviewModel(big, ['qwen3.5:9b'], {}, 'ghost-vl:9b').model, 'qwen3.5:9b', 'a configured model that is gone falls back to auto');

  assert.equal(pickReviewModel(big, ['qwen3.5:9b', 'qwen3.5:4b'], {}, '').model, 'qwen3.5:9b', '12 GB card takes the big tier');
  assert.equal(pickReviewModel(small, ['qwen3.5:9b', 'qwen3.5:4b'], {}, '').model, 'qwen3.5:4b', '8 GB card takes the small tier');
  const byCard = pickReviewModel(big, ['qwen3.5:9b'], {}, '');
  assert.match(byCard.reason, /video memory 12 GB/);
});

test('pickReviewModel: older installed vision models are used, not demanded again', () => {
  const old = pickReviewModel(12288, ['qwen2.5-vl:3b'], {}, '');
  assert.equal(old.model, 'qwen2.5-vl:3b');
  assert.equal(old.installed, true);
  assert.match(old.reason, /qwen3\.5:9b is not installed - taking the installed qwen2\.5-vl:3b/);
  const fb = pickReviewModel(12288, [FALLBACK_REVIEW_MODEL, 'qwen3:8b'], {}, '');
  assert.equal(fb.model, 'qwen3-vl:8b', 'the installer vlm row model is still a tier-list member');
  assert.equal(pickReviewModel(12288, ['qwen3:8b'], {}, '').installed, false, 'text-only really means none');
  assert.match(pickReviewModel(12288, ['qwen3:8b'], {}, '').reason, /install\.sh -Only vlm/);
});

test('isVisionModelName covers the older generations the name fallback has to catch', () => {
  for (const n of ['qwen3-vl:8b', 'qwen2.5-vl:7b', 'qwen2-vl:2b', 'llava:7b', 'minicpm-v:8b', 'moondream:1.8b', 'gemma3:4b', 'qwen3.5:9b', 'myVisionModel:1b']) assert.ok(isVisionModelName(n), n);
  for (const n of ['qwen3:8b', 'qwen2.5-coder:7b', 'nomic-embed-text:latest', 'deepseek-r1:8b']) assert.ok(!isVisionModelName(n), n);
});

test('publishQaModel hands the pick to the Blender step - but never overwrites a hand-set variable', () => {
  const env = {};
  const pick = { model: 'qwen2.5-vl:3b', installed: true, reason: 'x' };
  assert.deepEqual(publishQaModel(pick, env), { published: true, model: 'qwen2.5-vl:3b', reason: '' });
  assert.equal(env.ASTRA_QA_VLM, 'qwen2.5-vl:3b');

  const kept = { ASTRA_QA_VLM: 'my-vl:1b' };
  assert.equal(publishQaModel(pick, kept, 'my-vl:1b').published, false, 'a variable from the real process environment');
  assert.equal(kept.ASTRA_QA_VLM, 'my-vl:1b', 'set by hand wins');
  publishQaModel({ model: 'other-vl:2b', installed: true }, kept, 'my-vl:1b');
  assert.equal(kept.ASTRA_QA_VLM, 'my-vl:1b', 'and the next republish does not touch it either');

  const gone = { ASTRA_QA_VLM: 'stale-vl:1b' };
  const r = publishQaModel({ model: 'qwen3.5:9b', installed: false, reason: 'not installed: install.sh' }, gone);
  assert.equal(r.model, null); assert.match(r.reason, /install\.sh/);
  assert.equal(gone.ASTRA_QA_VLM, undefined, 'with no usable model the step must say so, not review with a name nobody has');
});
