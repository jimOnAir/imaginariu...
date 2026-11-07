// Startup resilience (behavior per ADR-0004, tickets 02 and 17): a corrupt job-history file or a
// corrupt data/config.json must never stop the studio. Unreadable job files are quarantined to
// jobs/broken/ and skipped. A config.json that is not JSON at all is moved aside untouched as
// config.json.broken-<timestamp> and defaults take over; one that IS JSON but carries a foreign key
// or a bad value is read field by field (ticket 17) - the usable settings survive. Nothing is deleted.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadJobs, allJobs } from '../server/jobs.mjs';
import { loadConfig, bootConfig, configSchema, defaults } from '../server/schema.mjs';

const tmp = mkdtempSync(path.join(tmpdir(), 'af-jobsload-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const iso = () => new Date().toISOString();
const writeJob = (dir, name, text) => writeFileSync(path.join(dir, name), text, 'utf8');

test('loadJobs survives a folder of unreadable job files and keeps every readable one', async () => {
  const dir = path.join(tmp, 'jobs');
  mkdirSync(dir, { recursive: true });
  const done = { id: randomUUID(), status: 'done', progress: 100, message: 'Ready', createdAt: iso(), updatedAt: iso() };
  const running = { id: randomUUID(), status: 'running', progress: 40, message: 'Working', createdAt: iso(), updatedAt: iso() };
  writeJob(dir, done.id + '.json', JSON.stringify(done));
  writeJob(dir, running.id + '.json', JSON.stringify(running));
  writeJob(dir, randomUUID() + '.json', '{broken');                       // corrupt
  writeJob(dir, randomUUID() + '.json', '');                               // empty
  writeJob(dir, randomUUID() + '.json', JSON.stringify(done).slice(0, 40));// truncated
  writeJob(dir, randomUUID() + '.json', '\uFEFF{oops');                    // BOM + garbage
  writeJob(dir, randomUUID() + '.json', '42');                             // valid JSON, not an object
  writeJob(dir, randomUUID() + '.json', '[]');                             // valid JSON, not an object
  writeJob(dir, randomUUID() + '.json', JSON.stringify({ noId: true }));   // object, not a job record
  const warnings = [];
  const moved = await loadJobs(dir, (m) => warnings.push(m));
  assert.equal(moved, 7, 'every unreadable or non-job file is quarantined');
  assert.deepEqual(readdirSync(path.join(dir, 'broken')).sort().length, 7);
  assert.ok(allJobs().some((j) => j.id === done.id), 'the finished job is loaded');
  const revived = allJobs().find((j) => j.id === running.id);
  assert.equal(revived.status, 'failed', 'an interrupted job is reported as failed');
  assert.match(revived.message, /interrupted by a restart/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, running.id + '.json'), 'utf8')).status, 'failed', 'the flip is written back to the file it was read from');
  assert.equal(warnings.length, 7);
  assert.ok(warnings.some((w) => /not readable/.test(w)) && warnings.some((w) => /not a job record/.test(w)));
});

test('loadConfig starts on defaults when config.json is not JSON at all, moving the file aside untouched', async () => {
  const cases = ['{oops', '', '42', '[]', '\uFEFF{broken'];
  for (const text of cases) {
    const dir = mkdtempSync(path.join(tmp, 'cfg-'));
    const file = path.join(dir, 'config.json');
    writeFileSync(file, text, 'utf8');
    const logs = [];
    const cfg = await loadConfig(file, (m) => logs.push(m));
    assert.deepEqual(cfg, defaults, 'defaults take over for: ' + JSON.stringify(text.slice(0, 24)));
    const aside = readdirSync(dir).filter((f) => f.startsWith('config.json.broken-'));
    assert.equal(aside.length, 1, 'the bad file was moved aside exactly once for: ' + JSON.stringify(text.slice(0, 24)));
    assert.equal(readFileSync(path.join(dir, aside[0]), 'utf8'), text, 'quarantined untouched');
    assert.ok(!existsSync(file));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /moved aside to config\.json\.broken-/);
  }
});

// Ticket 17: one bad field must not cost the user every other setting (behavior per ADR-0004).
test('bootConfig keeps what is usable: unknown keys dropped, bad values defaulted, the rest survives', () => {
  const logs = [];
  const cfg = bootConfig({ ollamaUrl: 'http://127.0.0.1:11434', comfyUrl: 'not-a-url', lmstudioUrl: 'http://127.0.0.1:1234', provider: 'ollama', ollamaModel: 'qwen3:4b', seed: true }, (m) => logs.push(m));
  assert.equal(cfg.ollamaUrl, 'http://127.0.0.1:11434', 'a valid setting the user did set is kept');
  assert.equal(cfg.ollamaModel, 'qwen3:4b', 'and so is the model choice');
  assert.equal(cfg.comfyUrl, defaults.comfyUrl, 'the broken one fell back to its default');
  assert.equal(cfg.provider, 'ollama');
  assert.equal(cfg.lmstudioUrl, undefined, 'a foreign key is gone, not carried along');
  assert.equal(cfg.seed, undefined, 'the boot loader neither invents nor leaks fields');
  assert.ok(logs.some((l) => /lmstudioUrl/.test(l) && /not a setting/.test(l)), logs.join(' | '));
  assert.ok(logs.some((l) => /comfyUrl/.test(l) && /using the default/.test(l)), logs.join(' | '));

  const quiet = [];
  assert.deepEqual(bootConfig({ ...defaults }, (m) => quiet.push(m)), { ...defaults });
  assert.deepEqual(quiet, [], 'a healthy file boots silently');

  // more than three unusable fields: one summary line instead of a wall of warnings
  const many = [];
  const out = bootConfig({ ...defaults, ollamaUrl: 'x', comfyUrl: 'y', provider: 'openai-max', shapeCheckpoint: {}, lmstudioUrl: 1 }, (m) => many.push(m));
  assert.equal(out.ollamaUrl, defaults.ollamaUrl); assert.equal(out.comfyUrl, defaults.comfyUrl);
  assert.equal(out.provider, defaults.provider); assert.equal(out.shapeCheckpoint, defaults.shapeCheckpoint);
  assert.equal(many.length, 1, many.join(' | '));
  assert.match(many[0], /5 settings were not usable at boot/);

  // the file cannot be trusted at all (a shape the schema rejects with no field to name): defaults, loudly
  const broken = [];
  assert.deepEqual(bootConfig(null, (m) => broken.push(m)), { ...defaults });
  assert.deepEqual(broken, []);
  const garbage = [];
  const g = bootConfig(JSON.parse(JSON.stringify({ provider: { deep: { nested: 'value' } }, ollamaModel: 'qwen3:4b' })), (m) => garbage.push(m));
  assert.equal(g.provider, defaults.provider);
  assert.ok(garbage.length >= 1);
});

test('loadConfig runs a schema-violating file through the tolerant path without touching it on disk', async () => {
  const dir = mkdtempSync(path.join(tmp, 'cfg-tolerant-'));
  const file = path.join(dir, 'config.json');
  const text = JSON.stringify({ ...defaults, comfyUrl: 'not-a-url', lmstudioUrl: 'http://127.0.0.1:1234' });
  writeFileSync(file, text, 'utf8');
  const logs = [];
  const cfg = await loadConfig(file, (m) => logs.push(m));
  assert.equal(cfg.comfyUrl, defaults.comfyUrl);
  assert.equal(cfg.ollamaUrl, defaults.ollamaUrl, 'the user address survives');
  assert.deepEqual(readdirSync(dir), ['config.json'], 'the tolerant path rewrites nothing at boot');
  assert.equal(readFileSync(file, 'utf8'), text, 'the file is exactly as it was - the next save cleans it');
  assert.ok(logs.length >= 2, logs.join(' | '));
  // and the strict path is still strict: the same body from the UI is refused, not healed
  assert.throws(() => configSchema.parse(JSON.parse(text)));
});

test('loadConfig: a normal BOM-prefixed settings file still loads; a missing file is the quiet first run', async () => {
  const dir = mkdtempSync(path.join(tmp, 'cfg-ok-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, '\uFEFF' + JSON.stringify({ ...defaults, provider: 'ollama', ollamaModel: 'qwen3:4b' }), 'utf8');
  const logs = [];
  const cfg = await loadConfig(file, (m) => logs.push(m));
  assert.equal(cfg.ollamaModel, 'qwen3:4b');
  assert.deepEqual(logs, [], 'a healthy file boots silently');
  const missing = await loadConfig(path.join(dir, 'nope', 'config.json'), () => assert.fail('must not warn on first run'));
  assert.deepEqual(missing, defaults);
});
