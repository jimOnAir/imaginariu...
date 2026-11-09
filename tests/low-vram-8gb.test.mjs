// Ticket 37 (0.6.18 wave): the 8 GB card release. Low-VRAM seam facts, the /interrupt that
// makes Cancel/timeout actually stop ComfyUI (real local HTTP server), the Ollama unload +
// GPU-holder hand-over (injected fetch), and the installer's Full-profile skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LOW_VRAM_CEILING_MIB, MVA_MAX_WAIT_MS, isLowVram, currentVramMib } from '../server/low-vram.mjs';
import { runWorkflow } from '../scripts/views/comfy_client.mjs';
import { handoverTo, unloadOllamaModels, listGpuHolders } from '../server/gpu-handover.mjs';

const REPO = path.resolve(import.meta.dirname, '..');

// ---------- low-vram facts ----------
test('8 GB-class detection: below the 9216 MiB seam is small; unknown is never small', () => {
  assert.equal(LOW_VRAM_CEILING_MIB, 9216);
  assert.equal(MVA_MAX_WAIT_MS, 20 * 60 * 1000);
  assert.equal(isLowVram(8192), true);
  assert.equal(isLowVram('8192'), true);
  assert.equal(isLowVram(8193), true);
  assert.equal(isLowVram(9215), true);
  assert.equal(isLowVram(9216), false);
  assert.equal(isLowVram(12227), false);
  assert.equal(isLowVram(null), false);
  assert.equal(isLowVram(0), false);
  assert.equal(isLowVram('unknown'), false);
});

test('the seams agree: scan constant, installer bash and this module call the same class small', async () => {
  const { TRIPOSG_AUTO_MAX_VRAM_MIB } = await import('../server/triposg.mjs');
  assert.equal(TRIPOSG_AUTO_MAX_VRAM_MIB, LOW_VRAM_CEILING_MIB);
  const install = readFileSync(path.join(REPO, 'installer', 'install.sh'), 'utf8');
  assert.match(install, /Is8gbVram\(\) \{ \[ "\$\{S_VRAM:-0\}" -gt 0 \] 2>\/dev\/null && \[ "\$\{S_VRAM:-0\}" -lt 9216 \] 2>\/dev\/null; \}/);
  assert.equal(isLowVram(9215), true);   // installer would skip; the engine adapts too
  assert.equal(isLowVram(9216), false);  // and neither fires at the seam itself
});

test('currentVramMib honors the ASTRA_VRAM_MIB seam (ticket 21) with refresh', () => {
  const saved = process.env.ASTRA_VRAM_MIB;
  try {
    process.env.ASTRA_VRAM_MIB = '8192';
    assert.equal(currentVramMib({ refresh: true }), 8192);
    assert.equal(isLowVram(currentVramMib({ refresh: true })), true);
  } finally {
    if (saved === undefined) delete process.env.ASTRA_VRAM_MIB; else process.env.ASTRA_VRAM_MIB = saved;
  }
});

// ---------- runWorkflow -> /interrupt ----------
function fakeComfy() {
  const seen = [];
  const state = { complete: false, never: true };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && url.pathname === '/prompt') { seen.push(['prompt', body]); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ prompt_id: 'pid-1' })); return; }
      if (req.method === 'POST' && url.pathname === '/interrupt') { seen.push(['interrupt', body]); res.statusCode = 200; res.end('{}'); return; }
      if (url.pathname === '/history/pid-1') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state.complete ? { 'pid-1': { status: { completed: true }, outputs: { '3': { images: [] } } } } : {})); return; }
      if (url.pathname === '/queue') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ queue_running: [], queue_pending: [['pid-1']] })); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, seen, state, close: () => srv.close() })));
}

test('Cancel interrupts the engine job: runWorkflow POSTs /interrupt with the prompt id', async () => {
  const srv = await fakeComfy();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 120);
  await assert.rejects(
    runWorkflow(srv.url, { '1': { class_type: 'X', inputs: {} } }, { signal: ac.signal }),
    (e) => e.name === 'AbortError');
  const ints = srv.seen.filter((x) => x[0] === 'interrupt');
  assert.equal(ints.length, 1);
  assert.deepEqual(JSON.parse(ints[0][1]), { prompt_id: 'pid-1' });
  srv.close();
});

test('timeout also interrupts before the studio hears about it', async () => {
  const srv = await fakeComfy();
  await assert.rejects(
    runWorkflow(srv.url, { '1': { class_type: 'X', inputs: {} } }, { timeoutMs: 400 }),
    /timed out/);
  assert.equal(srv.seen.filter((x) => x[0] === 'interrupt').length, 1);
  srv.close();
});

test('a completed job pays no interrupt', async () => {
  const srv = await fakeComfy();
  srv.state.complete = true;
  const r = await runWorkflow(srv.url, { '1': { class_type: 'X', inputs: {} } }, { timeoutMs: 5000 });
  assert.equal(r.promptId, 'pid-1');
  assert.equal(srv.seen.filter((x) => x[0] === 'interrupt').length, 0);
  srv.close();
});

// ---------- hand-over: Ollama unload + GPU holders ----------
function fakeNet() {
  const calls = [];
  const f = async (url, o = {}) => {
    calls.push([String(url), o.method || 'GET', o.body || '']);
    const u = String(url);
    const json = (v) => ({ ok: true, json: async () => v });
    if (u.endsWith('/queue')) return json({ queue_running: [], queue_pending: [] });
    if (u.endsWith('/free')) return json({});
    if (u.endsWith('/system_stats')) return json({ devices: [{ torch_vram_total: 6000 * 1024 * 1024 }] }); // never drops -> holders
    if (u.endsWith('/api/ps')) return json({ models: [{ name: 'qwen3:8b' }, { name: 'llama3:latest' }] });
    if (u.endsWith('/api/generate')) return json({ done: true });
    return json({});
  };
  return { f, calls };
}

test('handover on an 8 GB card unloads the resident Ollama models and names GPU holders', async () => {
  const net = fakeNet();
  const steps = [];
  const report = await handoverTo('hunyuan', {
    urls: { hunyuan: 'http://h:1', pixal3d: 'http://p:1' },
    fetchFn: net.f,
    sleep: async () => {},
    settleMs: 1, // one settle tick, then the holder path
    lowVram: true,
    ollamaUrl: 'http://o:1',
    holdersProbe: async () => 'python /game.py, 3000 MiB',
    onStep: (t) => steps.push(t),
  });
  assert.deepEqual(report.ollamaUnloaded, ['qwen3:8b', 'llama3:latest']);
  assert.match(steps.join('\n'), /Unloaded the assistant models/);
  assert.equal(report.heldBy, 'python /game.py, 3000 MiB');
  assert.match(steps.join('\n'), /Video memory is still held by: python \/game\.py/);
  const unloads = net.calls.filter((c) => c[0].endsWith('/api/generate'));
  assert.equal(unloads.length, 2);
  assert.deepEqual(JSON.parse(unloads[0][2]), { model: 'qwen3:8b', keep_alive: 0 });
});

test('a big card pays no Ollama round-trip and unknown VRAM stays big', async () => {
  const net = fakeNet();
  const report = await handoverTo('hunyuan', {
    urls: { hunyuan: 'http://h:1', pixal3d: 'http://p:1' },
    fetchFn: net.f, sleep: async () => {}, settleMs: 1, lowVram: false,
  });
  assert.equal(report.ollamaUnloaded, undefined);
  assert.ok(!net.calls.some((c) => String(c[0]).includes('/api/ps')));
});

test('unloadOllamaModels: silent Ollama is [] , listGpuHolders: unreadable probe is empty', async () => {
  assert.deepEqual(await unloadOllamaModels('http://x:1', async () => { throw new Error('refused'); }), []);
  assert.deepEqual(await unloadOllamaModels('http://x:1', async () => ({ ok: false, json: async () => ({}) })), []);
  assert.equal(await listGpuHolders(async () => { throw new Error('no nvidia-smi'); }), '');
  assert.equal(await listGpuHolders(async () => '  \n\n '), '');
});

// ---------- installer bash lane ----------
const INSTALL = readFileSync(path.join(REPO, 'installer', 'install.sh'), 'utf8');
function bash(script, env = {}) {
  const r = spawnSync('bash', ['-c', `set -u\n${script}`], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
  return { out: r.stdout + r.stderr, code: r.status };
}

test('Is8gbVram: below 9216 is small, unknown and 16 GB are not; Is8gbSkip names the set', () => {
  const lines = INSTALL.split('\n');
  const h = lines.slice(lines.findIndex((l) => l.startsWith('Is8gbVram()')), lines.findIndex((l) => l.startsWith('Is8gbVram()')) + 2).join('\n');
  const r = bash(`
say(){ echo "SAY: $1"; }
${h}
S_VRAM=8192;   Is8gbVram && echo small8
S_VRAM=9215;   Is8gbVram && echo small9215
S_VRAM=9216;   Is8gbVram || echo big9216
S_VRAM=12288;  Is8gbVram || echo big12
Is8gbVram || echo unknown-not-small
for i in pixal3d pixal3dw qwenimg vlm; do Is8gbSkip "$i" && echo "skip $i"; done
Is8gbSkip comfy && echo BAD-comfy
Is8gbSkip llm && echo BAD-llm
`);
  assert.match(r.out, /small8\nsmall9215\nbig9216\nbig12\nunknown-not-small\nskip pixal3d\nskip pixal3dw\nskip qwenimg\nskip vlm/);
  assert.ok(!/BAD/.test(r.out));
});

test('ApplyPreset full on 8 GB unticks exactly the skip set and says why', () => {
  const lines = INSTALL.split('\n');
  const a = lines.findIndex((l) => l.startsWith('ApplyPreset()'));
  let b = a; while (lines[b] !== '}') b++;
  const APPLY = lines.slice(a, b + 1).join('\n');
  const h = lines.slice(lines.findIndex((l) => l.startsWith('Is8gbVram()')), lines.findIndex((l) => l.startsWith('Is8gbVram()')) + 2).join('\n');
  const r = bash(`
say(){ echo "SAY: $1"; }
IsMandatory() { return 1; }
${h}
${APPLY}
IT_ID=(comfy pixal3d pixal3dw qwenimg vlm llm)
IT_ST=(missing missing missing missing missing missing)
IT_PRE=(fq fq f f f fq)
IT_TICK=(0 0 0 0 0 0)
S_VRAM=8192
ApplyPreset f
echo "ticks: \${IT_TICK[*]}"
`);
  assert.match(r.out, /SAY:.*8 GB card: 'Full' skips what does not fit/);
  assert.match(r.out, /ticks: 1 0 0 0 0 1/);
});

test('the same checklist untouched on a 12 GB card; quick profile never gets the 8 GB line', () => {
  const lines = INSTALL.split('\n');
  const a = lines.findIndex((l) => l.startsWith('ApplyPreset()'));
  let b = a; while (lines[b] !== '}') b++;
  const APPLY = lines.slice(a, b + 1).join('\n');
  const h = lines.slice(lines.findIndex((l) => l.startsWith('Is8gbVram()')), lines.findIndex((l) => l.startsWith('Is8gbVram()')) + 2).join('\n');
  const r = bash(`
say(){ echo "SAY: $1"; }
IsMandatory() { return 1; }
${h}
${APPLY}
IT_ID=(comfy pixal3d vlm)
IT_ST=(missing missing missing)
IT_PRE=(fq fq f)
IT_TICK=(0 0 0)
S_VRAM=12288
ApplyPreset f
echo "big: \${IT_TICK[*]}"
S_VRAM=8192
ApplyPreset q
echo "quick: \${IT_TICK[*]}"
`);
  assert.match(r.out, /big: 1 1 1/);
  assert.match(r.out, /quick: 1 1 0/); // vlm is full-only anyway; the 8 GB hook never fires for q
  assert.ok(!/8 GB card/.test(r.out), 'neither run says the 8 GB line');
});

test('PresetPlan carries the same rule for -Yes runs (source pin)', () => {
  assert.match(INSTALL, /if \[ "\$Profile" = full \] && Is8gbVram; then/);
  assert.match(INSTALL, /for id in \$ids; do Is8gbSkip "\$id" \|\| kept="\$kept \$id"; done/);
});
