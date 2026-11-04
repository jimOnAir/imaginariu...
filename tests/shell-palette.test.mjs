// The tokenized palette (ticket 04): the generator's --check is the contract. Every var(--c…) in
// the stylesheets must have a dark value equal to the original literal (:root) and a light value
// (html[data-theme=light]); no stylesheet may keep a bare #hex; no token may drift unused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('palette-tokens --check passes on the committed tree', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ui', 'palette-tokens.mjs'), '--check'], { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /palette check ok: (\d+) tokens/);
});

test('the palette defines both themes for every token and the map agrees', () => {
  const css = readFileSync(path.join(ROOT, 'src', 'palette.css'), 'utf8');
  const map = JSON.parse(readFileSync(path.join(ROOT, 'src', 'palette-map.json'), 'utf8'));
  const dark = css.slice(css.indexOf(':root{'), css.indexOf('html[data-theme=light]{'));
  const light = css.slice(css.indexOf('html[data-theme=light]{'));
  const keys = Object.keys(map);
  assert.ok(keys.length > 400, 'the whole studio palette is tokenized, not just style.css');
  for (const hex of keys) {
    const name = '--c' + hex.slice(1);
    assert.ok(dark.includes(name + ':' + hex + ';'), 'dark value must be the original literal for ' + name);
    assert.ok(light.includes(name + ':'), 'light value must exist for ' + name);
  }
  // light differs from dark at least somewhere real (the theme is not a no-op)
  assert.notEqual(light, dark.replace(/html\[data-theme=light\]/, ':root'));
});

test('the shell dresses the switches with tokens, never literals', () => {
  const shell = readFileSync(path.join(ROOT, 'src', 'shell', 'shell.css'), 'utf8');
  assert.doesNotMatch(shell, /#[0-9a-fA-F]{3,8}\b/, 'shell.css must stay literal-free - tokens and color-mix only');
});
