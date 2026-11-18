// The installer never stamps its own version literal: it announces the app version in package.json,
// -v prints it, the interactive and scan runs show it, and the machine contract (-ScanList) stays
// banner-free. If someone hardcodes a version into installer/install.sh, the mutated-tree case fails.
// (Behavior per ADR-0004, ticket 03 - the Linux twin of the shipped build refusing to stamp 0.4.17.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_SH = path.join(ROOT, 'installer', 'install.sh');
const repoVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const run = (script, cwd) => spawnSync('bash', [script, '--version'], { encoding: 'utf8', cwd: cwd || ROOT, timeout: 30000 });

test('install.sh -v prints exactly the package.json version', () => {
  const r = spawnSync('bash', [INSTALL_SH, '-v'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `Imaginarium installer ${repoVersion}`);
});

test('the announced version follows package.json, not a literal in the script (drift guard)', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'imaginarium-ver-'));
  try {
    // an app folder copy with only the two files the version read needs, carrying a different version
    mkdirTree(tmp);
    cpSync(INSTALL_SH, path.join(tmp, 'installer', 'install.sh'));
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'imaginarium-local', version: '9.9.9-mutation' }, null, 2) + '\n');
    const r = run(path.join(tmp, 'installer', 'install.sh'), tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'Imaginarium installer 9.9.9-mutation', 'the installer reads package.json at run time');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('the interactive and -ScanOnly runs announce the version; -ScanList stays machine-clean', () => {
  const scan = spawnSync('bash', [INSTALL_SH, '-ScanList'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(scan.status, 0, scan.stderr);
  assert.doesNotMatch(scan.stdout, /Imaginarium installer/, 'the ##ITEM contract carries no human banner');
  const only = spawnSync('bash', [INSTALL_SH, '-ScanOnly'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(only.status, 0, only.stderr);
  assert.match(only.stdout, new RegExp(`Imaginarium installer ${repoVersion.replace(/\./g, '\\.')}`));
});

function mkdirTree(tmp) {
  mkdirSync(path.join(tmp, 'installer'), { recursive: true });
}
