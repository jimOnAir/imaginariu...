// The Sculpt tab (server/sculpt.mjs): status, SculptGL statics on the web port (not the studio origin),
// CORS for reading an asset only for the sculpt origin.
// Isolated express apps on random ports and a temporary root; the studio and its assets are not needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { registerVfxTools } from '../server/vfx-tools.mjs';
import { registerSculpt, allowAssetCors, sculptOrigin, ASSET_PATH } from '../server/sculpt.mjs';
import { patchIndex, MARK } from '../scripts/sculpt/assemble.mjs';

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const root = mkdtempSync(path.join(tmpdir(), 'af-sculpt-root-'));
const emptyRoot = mkdtempSync(path.join(tmpdir(), 'af-sculpt-empty-'));
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
let app, appServer, appBase, vfx, sculpt, webBase, bare, bareBase, bareVfx, bareSculpt;

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
/** GET with an arbitrary Origin: fetch cannot set it reliably, so http.request. */
const get = (base, url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const u = new URL(url, base);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
  req.end();
});

// the Origin guard of server/index.mjs (its source line is checked below); the asset path is served like index.mjs does
function makeStudioApp(getSculpt) {
  const a = express();
  a.use((req, res, next) => {
    if (req.path.startsWith('/api') && req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && !getSculpt()?.assetCors(req, res)) return res.status(403).json({ error: 'Invalid request origin' });
    next();
  });
  a.get('/api/assets/:id', (req, res) => res.type('text/plain').send('ASSET'));
  a.post('/api/assets', (req, res) => res.json({ ok: true }));
  a.get('/api/config', (req, res) => res.json({ secret: 1 }));
  return a;
}

before(async () => {
  const web = path.join(root, 'web', 'sculptgl');
  mkdirSync(path.join(web, 'css'), { recursive: true });
  writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>SculptGL</title><script src="sculptgl-bridge.js"></script>');
  writeFileSync(path.join(web, 'sculptgl-bridge.js'), '// bridge');
  writeFileSync(path.join(web, 'css', 'yagui.css'), 'body{}');
  writeFileSync(path.join(root, 'secret.txt'), 'outside-web-folder');

  app = express();
  appServer = http.createServer(app);
  vfx = registerVfxTools(app, asyncRoute, { root, webPort: 0, searchRoots: [] });
  sculpt = registerSculpt(app, asyncRoute, { vfx });
  appBase = await listen(appServer);
  await vfx.startWeb();
  webBase = `http://127.0.0.1:${vfx.webPort}`;

  // an empty tools folder: SculptGL is not built
  const bareApp = express();
  bare = http.createServer(bareApp);
  bareVfx = registerVfxTools(bareApp, asyncRoute, { root: emptyRoot, webPort: 0, searchRoots: [] });
  bareSculpt = registerSculpt(bareApp, asyncRoute, { vfx: bareVfx });
  bareBase = await listen(bare);
});

after(async () => {
  await vfx.close();
  await bareVfx.close();
  await new Promise((r) => appServer.close(r));
  await new Promise((r) => bare.close(r));
  rmSync(root, { recursive: true, force: true });
  rmSync(emptyRoot, { recursive: true, force: true });
});

test('GET /api/sculpt/status: available, the address is the /sculpt/ page on the web port, not the studio port', async () => {
  const r = await get(appBase, '/api/sculpt/status');
  assert.equal(r.status, 200);
  const s = JSON.parse(r.body);
  assert.equal(s.available, true);
  assert.equal(s.url, `${webBase}/sculpt/`);
  assert.notEqual(new URL(s.url).port, new URL(appBase).port);
  assert.equal(s.bridge, 1);
});

test('GET /api/sculpt/status: SculptGL not built -> available false and a hint about install-vfx.sh', async () => {
  const s = JSON.parse((await get(bareBase, '/api/sculpt/status')).body);
  assert.equal(s.available, false);
  assert.equal(s.url, null);
  assert.match(s.hint, /install-vfx\.sh -Only sculptgl/);
});

test('the web port serves SculptGL: page, bridge, resources; /sculpt without the slash redirects', async () => {
  const page = await get(webBase, '/sculpt/');
  assert.equal(page.status, 200);
  assert.match(page.body, /sculptgl-bridge\.js/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal((await get(webBase, '/sculpt/sculptgl-bridge.js')).body, '// bridge');
  assert.equal((await get(webBase, '/sculpt/css/yagui.css')).status, 200);
  const redirect = await get(webBase, '/sculpt?studio=http%3A%2F%2F127.0.0.1%3A3210');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, '/sculpt/?studio=http%3A%2F%2F127.0.0.1%3A3210');
  // the same SculptGL is also reachable as a catalog web generator
  assert.equal((await get(webBase, '/vfx-web/sculptgl/')).status, 200);
});

test('the web port never releases files outside the SculptGL folder and rejects a foreign Host', async () => {
  for (const url of ['/sculpt/../secret.txt', '/sculpt/%2e%2e/secret.txt', '/sculpt/..%2fsecret.txt', '/sculpt/%2e%2e%2f%2e%2e%2fsecret.txt']) {
    const r = await get(webBase, url);
    assert.notEqual(r.status, 200, url);
    assert.ok(!r.body.includes('outside-web-folder'), url);
  }
  assert.equal((await get(webBase, '/sculpt/', { host: 'evil.example' })).status, 403);
});

test('the main app (the studio port) does not serve the sculpt page: 404', async () => {
  for (const url of ['/sculpt/', '/sculpt/index.html', '/sculpt/sculptgl-bridge.js']) assert.equal((await get(appBase, url)).status, 404, url);
});

test('asset CORS: Access-Control-Allow-Origin only for the sculpt origin and only GET/HEAD /api/assets/<uuid>', async () => {
  const studio = makeStudioApp(() => sculpt);
  const server = http.createServer(studio);
  const base = await listen(server);
  try {
    const origin = sculptOrigin(vfx.webPort);
    assert.equal(origin, webBase);
    const ok = await get(base, '/api/assets/' + ID, { origin });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'ASSET');
    assert.equal(ok.headers['access-control-allow-origin'], origin);
    assert.match(ok.headers.vary, /Origin/i);
    assert.equal((await get(base, '/api/assets/' + ID, { origin }, 'HEAD')).headers['access-control-allow-origin'], origin);
    // without an Origin (the studio itself) there is no CORS header
    assert.equal((await get(base, '/api/assets/' + ID)).headers['access-control-allow-origin'], undefined);
    // a foreign origin, a foreign port, localhost instead of 127.0.0.1
    for (const other of ['http://evil.example', 'http://127.0.0.1:' + (vfx.webPort + 1), 'http://localhost:' + vfx.webPort, 'null']) {
      const r = await get(base, '/api/assets/' + ID, { origin: other });
      assert.equal(r.status, 403, other);
      assert.equal(r.headers['access-control-allow-origin'], undefined, other);
    }
    // with the sculpt origin everything else stays closed: other GETs, writes, non-UUID paths
    assert.equal((await get(base, '/api/config', { origin })).status, 403);
    assert.equal((await get(base, '/api/assets/not-a-uuid', { origin })).status, 403);
    assert.equal((await get(base, '/api/assets/' + ID, { origin }, 'POST')).status, 403);
    assert.equal((await get(base, '/api/assets/' + ID, { origin }, 'DELETE')).status, 403);
    assert.equal((await get(base, '/api/assets', { origin }, 'POST')).status, 403);
  } finally { await new Promise((r) => server.close(r)); }
});

test('allowAssetCors: with no web server running (origin null) nothing is allowed', () => {
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  assert.equal(allowAssetCors({ method: 'GET', path: '/api/assets/' + ID, headers: { origin: 'null' } }, res, null), false);
  assert.equal(allowAssetCors({ method: 'GET', path: '/api/assets/' + ID, headers: { origin: 'http://127.0.0.1:3211' } }, res, 'http://127.0.0.1:3211'), true);
  assert.deepEqual(Object.keys(headers).sort(), ['Access-Control-Allow-Origin', 'Vary']);
  assert.ok(ASSET_PATH.test('/api/assets/' + ID));
  assert.ok(!ASSET_PATH.test('/api/assets/' + ID + '/x'));
  assert.ok(!ASSET_PATH.test('/api/assets/../config'));
});

test('server/index.mjs uses the same guard: assetCors inside the Origin check, and registerSculpt', () => {
  const src = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("req.headers.origin!==`http://${req.headers.host}`&&!sculpt?.assetCors(req,res)"), 'the asset exception must stand inside the Origin check');
  assert.match(src, /sculpt=registerSculpt\(app,asyncRoute,\{vfx:registerVfxTools\(app,asyncRoute\)\}\)/);
});

test('assemble.patchIndex: no Google Fonts, window.sculptApp, the bridge after sculptgl.js; a second run duplicates nothing', () => {
  const html = `<head><link href='https://fonts.googleapis.com/css?family=Open+Sans:400,600' rel='stylesheet' type='text/css'>\n<title> SculptGL - A WebGL sculpting app </title><script>window.addEventListener('load', function () {\n    var app = new window.SculptGL();\n    app.start();\n  });</script></head><body><script src='sculptgl.js'></script></body>`;
  const out = patchIndex(html);
  assert.ok(!/googleapis/.test(out));
  assert.match(out, /app\.start\(\);\s+window\.sculptApp = app;/);
  assert.ok(out.indexOf('sculptgl.js') < out.indexOf('sculptgl-bridge.js'));
  assert.equal(patchIndex(out), out);
  assert.equal(out.split(MARK).length, 2);
  assert.throws(() => patchIndex('<html></html>'), /app\.start\(\)/);
});

test('the built SculptGL (when installed here) contains the bridge and pulls no external resources', () => {
  const appRoot = fileURLToPath(new URL('../', import.meta.url));
  const dir = path.join(process.env.ASTRA_VFX_TOOLS || path.join(appRoot, 'runtime', 'vfx'), 'web', 'sculptgl');
  let html;
  try { html = readFileSync(path.join(dir, 'index.html'), 'utf8'); } catch { return; }   // not built on this machine
  assert.ok(html.includes('sculptgl-bridge.js') && html.includes('window.sculptApp = app'));
  assert.ok(!/fonts\.googleapis|<script[^>]+src=['"]https?:/.test(html));
  assert.equal(readFileSync(path.join(dir, 'sculptgl-bridge.js'), 'utf8'), readFileSync(new URL('../scripts/sculpt/bridge.js', import.meta.url), 'utf8'), 'the bridge in the build is stale: run scripts/vfx/install-vfx.sh -Only sculptgl');
});
