// GET /api/about: identity + license texts the About panel shows. The Windows build also hands
// out subscription/purchase links from here — this tree (ADR-0003) has no subscription, so only
// the project links and the license files are served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson } from '../server/storage.mjs';

const PORT = 39873;
const base = `http://127.0.0.1:${PORT}`;

async function withServer(fn) {
  // a test server must not boot the GPU engine: a detached ComfyUI would outlive the killed child
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: new URL('../', import.meta.url).pathname, env: { ...process.env, PORT: String(PORT), ASTRA_ENGINE_AUTOSTART: '0' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 80; i++) {
      try { const h = await fetch(`${base}/api/health`); if (h.ok) break; } catch {}
      await delay(250);
    }
    await fn();
  } finally {
    child.kill();
    await delay(150);
  }
}

test('GET /api/about reports the package version and the license texts', async () => {
  await withServer(async () => {
    const pkg = await readJson(new URL('../package.json', import.meta.url).pathname, {});
    const res = await fetch(`${base}/api/about`);
    assert.equal(res.status, 200);
    const about = await res.json();
    assert.equal(about.app, 'AstraForge');
    assert.equal(about.version, pkg.version, 'the About panel must show the real package version');
    assert.match(about.notices, /Hunyuan/, 'third-party notices list the engines');
    assert.match(about.licenseText, /MIT/, 'the studio license is shown');
    assert.ok(!JSON.stringify(about).toLowerCase().includes('lemonsqueezy'), 'no subscription stack in the free Linux tree (ADR-0003)');
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.version, pkg.version, 'health and about report the same version');
  });
});
