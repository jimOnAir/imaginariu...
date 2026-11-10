// Ticket 43 (0.7.1 wave): the paging watchdog. Windows 0.7's low-VRAM post-mortem: one MV-Adapter
// step ran 24 minutes (the 8 GB card was swapping) and the job waited out its 20-minute cap
// doing nothing. The branch rule: a ComfyUI step whose progress goes nowhere for > stepMaxMs
// (default 300 s) is interrupted and reported as paging - honestly, at once. A real local
// HTTP + WebSocket fake engine drives both directions; nothing here waits 5 minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { runWorkflow } from '../scripts/views/comfy_client.mjs';

function fakeEngine({ sendProgress = true, stall = false, completeAfterMs = null, stepFramesMs = 60 } = {}) {
  const seen = [];
  const state = { complete: false };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && url.pathname === '/prompt') { seen.push(['prompt', body]); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ prompt_id: 'p-1' })); return; }
      if (req.method === 'POST' && url.pathname === '/interrupt') { seen.push(['interrupt', body]); res.end('{}'); return; }
      if (url.pathname === '/history/p-1') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state.complete ? { 'p-1': { status: { completed: true }, outputs: { '9': { images: [] } } } } : {})); return; }
      if (url.pathname === '/queue') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ queue_running: [['p-1']], queue_pending: [] })); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  const wss = new WebSocketServer({ server: srv });
  let timer = null;
  wss.on('connection', (socket) => {
    if (!sendProgress) return;
    if (stall) { socket.send(JSON.stringify({ type: 'progress', data: { value: 0, max: 30, prompt_id: 'p-1', node: '5' } })); return; }
    let v = 0;
    timer = setInterval(() => {
      v += 1;
      socket.send(JSON.stringify({ type: 'progress', data: { value: v % 30, max: 30, prompt_id: 'p-1', node: '5' } }));
      if (completeAfterMs && v * stepFramesMs >= completeAfterMs) { state.complete = true; clearInterval(timer); }
    }, stepFramesMs);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`, seen,
    close: () => { clearInterval(timer); wss.close(); srv.close(); },
  })));
}

test('a stalled progress step trips the watchdog: interrupt fired, paging named, no waiting out the cap', async () => {
  const e = await fakeEngine({ stall: true });
  const t0 = Date.now();
  await assert.rejects(
    runWorkflow(e.url, { '5': { class_type: 'X', inputs: {} } }, { stepMaxMs: 700, timeoutMs: 60000 }),
    (err) => /paging/.test(err.message) && /step 0\/30/.test(err.message) && /stopped/.test(err.message));
  assert.ok(Date.now() - t0 < 8000, 'fails at the watchdog, not at the outer cap');
  const ints = e.seen.filter((x) => x[0] === 'interrupt');
  assert.equal(ints.length, 1, 'the engine is interrupted like on cancel');
  assert.deepEqual(JSON.parse(ints[0][1]), { prompt_id: 'p-1' });
  e.close();
});

test('a stepping engine never trips it; the job completes with the watchdog attached', async () => {
  const e = await fakeEngine({ completeAfterMs: 700 });
  const r = await runWorkflow(e.url, { '5': { class_type: 'X', inputs: {} } }, { stepMaxMs: 5000, timeoutMs: 30000 });
  assert.equal(r.promptId, 'p-1');
  assert.equal(e.seen.filter((x) => x[0] === 'interrupt').length, 0);
  e.close();
});

test('no websocket traffic (old/no progress): the guard lies dormant, the outer cap still rules', async () => {
  const e = await fakeEngine({ sendProgress: false });
  await assert.rejects(
    runWorkflow(e.url, { '5': { class_type: 'X', inputs: {} } }, { stepMaxMs: 300, timeoutMs: 1200 }),
    /timed out/);
  e.close();
});

test('stepMaxMs=0 disables the watchdog; the env names the default', async () => {
  const e = await fakeEngine({ stall: true });
  await assert.rejects(
    runWorkflow(e.url, { '5': { class_type: 'X', inputs: {} } }, { stepMaxMs: 0, timeoutMs: 1200 }),
    /timed out/); // capped out the normal way: watchdog off
  e.close();
  const src = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../scripts/views/comfy_client.mjs', import.meta.url), 'utf8'));
  assert.match(src, /ASTRA_VIEWS_STEP_MAX_SEC \|\| 300/);
});
