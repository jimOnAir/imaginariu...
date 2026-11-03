// Starting the studio (scripts/start.sh): when something is missing, the person sees in plain words
// what happened and what to do — the 0.4.14 class of reports ("Node.js was not found" plus raw
// interpreter noise). Node.js must also be found in the app's own runtime/node without any config.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, mkdirSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const skip = process.platform === 'win32' && 'the Linux launcher is not shipped for Windows';
const tmp = mkdtempSync(path.join(tmpdir(), 'af-start-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// PATH without Node.js but with the utilities start.sh needs before the checks fail (no noise, no real studio touched)
const bin = path.join(tmp, 'bin');
mkdirSync(bin, { recursive: true });
for (const tool of ['bash', 'curl', 'grep', 'sleep', 'seq', 'dirname', 'mkdir', 'nohup', 'printf']) {
  const src = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
  if (src) symlinkSync(src, path.join(bin, tool));
}
const env = { ...process.env, PATH: bin, PORT: '39871' };
for (const k of ['ASTRA_NODE', 'ASTRA_NODE_PATH']) delete env[k];

function app(name) {
  const root = path.join(tmp, name);
  cpSync(path.join(process.cwd(), 'scripts'), path.join(root, 'scripts'), { recursive: true });
  return root;
}
function start(root) {
  const r = spawnSync('bash', [path.join(root, 'scripts', 'start.sh'), '--no-browser'], { encoding: 'utf8', timeout: 60000, env, cwd: root });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('no Node.js anywhere: plain reason, remedy and log pointers in RU and EN — without shell noise', { skip }, () => {
  const root = app('no-node');
  const { code, out } = start(root);
  assert.equal(code, 1, out);
  assert.match(out, /AstraForge не запускается: не найден Node\.js/);
  assert.ok(out.includes(root), out);
  assert.match(out,/installer\/install\.sh/);
  assert.match(out, /install\.log/);
  assert.match(out, /AstraForge cannot start: Node\.js was not found/);
  assert.doesNotMatch(out, /start\.sh: line \d+.*(: command not found|syntax error|unbound variable)/, out);
});

test('Node.js in the app\'s own runtime/node is found without config/paths.json; the next gap is a plain message too', { skip }, () => {
  const root = app('own-node');
  mkdirSync(path.join(root, 'runtime', 'node', 'bin'), { recursive: true });
  copyFileSync(process.execPath, path.join(root, 'runtime', 'node', 'bin', 'node'));
  const { code, out } = start(root);
  assert.equal(code, 1, out);
  assert.doesNotMatch(out, /не найден Node\.js|Node\.js was not found/, out);
  assert.match(out, /не установлены библиотеки студии|studio libraries are missing/);
  assert.doesNotMatch(out, /start\.sh: line \d+.*(: command not found|syntax error|unbound variable)/, out);
});
