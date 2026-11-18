// Settings JSON may arrive with a UTF-8 BOM written by another tool (Windows PowerShell 5.1 is the classic:
// data/config.json from the 0.4.5-0.4.10 installers stopped the studio from starting at all, fixed in 0.4.11).
// The studio server and the Linux launcher must read such files, not die on them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, parseJson } from '../server/storage.mjs';
import { pixal3dConfig } from '../server/pixal3d.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'imaginarium-bom-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const mkdirp = (d) => mkdirSync(d, { recursive: true });

test('readJson strips a leading BOM — a config.json written by an external tool still boots the studio', async () => {
  const f = path.join(tmp, 'config.json');
  writeFileSync(f, '\uFEFF' + JSON.stringify({ provider: 'ollama', ollamaModel: 'qwen3:8b', ollamaUrl: 'http://127.0.0.1:11434' }), 'utf8');
  assert.deepEqual(await readJson(f, {}), { provider: 'ollama', ollamaModel: 'qwen3:8b', ollamaUrl: 'http://127.0.0.1:11434' });
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.equal(await readJson(path.join(tmp, 'nope.json'), 'fallback'), 'fallback');
  writeFileSync(f, '{broken');
  await assert.rejects(() => readJson(f, {}), SyntaxError, 'a corrupt file is still an error, not a silent fallback');
});

test('the Pixal3D folder written by the installer is not lost when paths.json carries a BOM', () => {
  const app = path.join(tmp, 'app');
  const dir = path.join(tmp, 'pixal3d');
  mkdirp(path.join(app, 'config'));
  mkdirp(dir);
  writeFileSync(path.join(app, 'config', 'paths.json'), '\uFEFF' + JSON.stringify({ pixal3dDir: dir }), 'utf8');
  const cfg = pixal3dConfig({ env: {}, appRoot: app });
  assert.equal(cfg.source, 'paths.json');
  assert.equal(cfg.dir, path.resolve(dir));
});

test('paths-env.mjs exports installer paths from a BOM file for start.sh', () => {
  const app = path.join(tmp, 'app2', 'config');
  mkdirp(app);
  const f = path.join(app, 'paths.json');
  writeFileSync(f, '\uFEFF' + JSON.stringify({ pixal3dDir: '/opt/pixal3d', node: '/opt/node/bin/node' }), 'utf8');
  const env = { ...process.env };
  delete env.IMAGINARIUM_PIXAL3D_DIR;
  delete env.IMAGINARIUM_NODE;
  delete env.IMAGINARIUM_NODE_PATH;
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'paths-env.mjs'), f], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /export IMAGINARIUM_PIXAL3D_DIR="\/opt\/pixal3d";/);
  assert.match(r.stdout, /export IMAGINARIUM_NODE_PATH="\/opt\/node\/bin\/node";/);
});
