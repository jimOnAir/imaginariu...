// Port contract of the studio (0.7.9 fold wave ticket 60 item 2, the 0.7.5 note). Since start.sh
// may take a port after 3210 (a foreign program held it - and says its name when ss may see it),
// every consumer must resolve the same answer: scripts/studio-port.mjs is that one question.
// Tested live for real: the resolver runs as a real node process against scratch trees, and the
// take_port loop is extracted from scripts/start.sh verbatim and driven against REAL listeners -
// a raw socket that is not HTTP (the "another application" case, the port must ADVANCE past it)
// and a fake studio answering /api/health with our signature (the second-launch case: the port
// stays, the existing window opens). Structural asserts keep the writer and the consumers wired
// to the same file the resolver reads.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RESOLVER = path.join(ROOT, 'scripts', 'studio-port.mjs');
const START_SH = path.join(ROOT, 'scripts', 'start.sh');
const tmp = mkdtempSync(path.join(tmpdir(), 'imaginarium-port-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const ask = (env = {}) => {
  const r = spawnSync(process.execPath, [RESOLVER], { encoding: 'utf8', env: { ...process.env, IMAGINARIUM_ROOT: tmp, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const putPort = (contents) => {
  const dir = path.join(tmp, 'data', 'runtime');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'port.json'), contents);
};

test('the resolver: IMAGINARIUM_PORT wins, then the recorded port.json, then the usual 3210', () => {
  rmSync(path.join(tmp, 'data'), { recursive: true, force: true });
  assert.equal(ask(), '3210', 'nothing recorded yet - the usual port');
  putPort(JSON.stringify({ port: 3317, pid: 42, at: new Date().toISOString() }));
  assert.equal(ask(), '3317', 'the studio recorded a moved port - follow it');
  assert.equal(ask({ IMAGINARIUM_PORT: '4101' }), '4101', 'the explicit environment wins over the file');
  assert.equal(ask({ IMAGINARIUM_PORT: '0' }), '3317', 'IMAGINARIUM_PORT=0 is not a port, the file still decides');
});

test('the resolver survives a broken or nonsense port.json with the honest fallback', () => {
  for (const junk of ['{ not json', '', JSON.stringify({ pid: 1 }), JSON.stringify({ port: 0 }), JSON.stringify({ port: 'web' })]) {
    putPort(junk);
    assert.equal(ask(), '3210', `garbage in port.json (${JSON.stringify(junk).slice(0, 20)}) must answer 3210, never crash`);
  }
});

// ---- the take_port loop, extracted verbatim from scripts/start.sh, against real listeners

function listen(port) {   // raw TCP listener: held, and NOT our studio
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}
function listenStudio(port) {   // answers /api/health with the studio signature
  return new Promise((resolve, reject) => {
    const s = httpServer((req, res) => {
      if (req.url === '/api/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"app":"Imaginarium","ok":true}'); return; }
      res.writeHead(404); res.end();
    });
    s.on('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}
function runTakePort(port, extra = '') {
  // async spawn on purpose: a synchronous one would block THIS event loop, and the fake
  // studio listener above runs in it - curl would time out on a studio that is perfectly alive
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', `
      set -u
      PORT=${port}; URL="http://127.0.0.1:\${PORT}"; NO_BROWSER=1
      health() { curl -sf -m 2 "$URL/api/health" 2>/dev/null || true; }
      ${extra}
      eval "$(awk '/^port_listening\\(\\)/,/^take_port$/' ${JSON.stringify(START_SH)} | grep -v '^take_port$')"
      take_port; echo "GATE=\$?"; echo "PORT=\$PORT"; echo "URL=\$URL"
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const freeBase = 39300 + (process.pid % 50);   // test-local playground, away from 3210

test('a foreign listener holds no studio: it is named when visible, and the port ADVANCES', async () => {
  const base = freeBase;
  const a = await listen(base), b = await listen(base + 1);
  try {
    const r = await runTakePort(base);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /GATE=0/);
    const moved = Number(r.stdout.match(/PORT=(\d+)/)[1]);
    assert.equal(moved, base + 2, 'both held ports advance over, the loop stops at the first free one');
    assert.match(r.stderr, /Port .* is in use by/, 'the blocking application is named (or plainly called another application)');
    assert.equal(r.stdout.match(/URL=http:\/\/127\.0\.0\.1:(\d+)/)[1], String(moved), 'URL follows PORT');
  } finally { a.close(); b.close(); }
});

test('our own studio answering on the port: keep it, open the existing window (second launch)', async () => {
  const studio = await listenStudio(freeBase);
  try {
    const r = await runTakePort(freeBase);
    // take_port answers this case with exit 0 inside the function - by design: the launcher's
    // job is over, the window is opened, the server must NOT start a second time. The proof of
    // "did not move" is exactly this: the echo after take_port never runs.
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'the launcher stopped at the open window, no server launch followed');
    assert.doesNotMatch(r.stderr, /is in use by/, 'nothing to complain about: this is the documented second launch');
  } finally { studio.close(); }
});

test('the loop is bounded: twenty held ports stop the launch with a sentence, never spin forever', async () => {
  const sockets = [];
  for (let i = 0; i < 20; i++) sockets.push(await listen(freeBase + i));
  try {
    const r = await runTakePort(freeBase);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /No free port/);
  } finally { for (const s of sockets) s.close(); }
});

// ---- wiring: the writer and every consumer read the port this contract defines

test('the server records the live port, and stop.sh / forge.mjs / ai/mcp follow it', () => {
  const index = readFileSync(path.join(ROOT, 'server', 'index.mjs'), 'utf8');
  assert.match(index, /runtime.{1,4}port\.json/, 'index.mjs writes data/runtime/port.json when it starts listening');
  const start = readFileSync(START_SH, 'utf8');
  assert.match(start, /take_port\n/, 'start.sh runs the gate before launching the server');
  const stop = readFileSync(path.join(ROOT, 'scripts', 'stop.sh'), 'utf8');
  assert.match(stop, /scripts\/studio-port\.mjs/, 'stop.sh stops the port the studio answered on');
  const forge = readFileSync(path.join(ROOT, 'scripts', 'forge.mjs'), 'utf8');
  assert.match(forge, /runtime.{1,4}port\.json/, 'the forge CLI follows the recorded port');
  assert.doesNotMatch(forge, /process\.env\.PORT \|\| 3210`;/, 'no leftover hardcoded 3210 default in the CLI base');
  const mcp = readFileSync(path.join(ROOT, 'ai', 'mcp', 'server.mjs'), 'utf8');
  assert.match(mcp, /runtime.{1,4}port\.json/, 'the MCP server knocks on the recorded port');
  assert.match(mcp, /IMAGINARIUM_URL \|\| `http:\/\/127\.0\.0\.1:\$\{studioPort\(\) \|\| 3210\}`/, 'IMAGINARIUM_URL still wins for MCP');
});
