// Bevy engine driver (0.6.10 wave ticket 30). The toolchain itself is never assumed here:
// every cargo touch runs through a stub script that speaks just enough of the CLI (AFBEVY
// lines, the --slug/--out contract of af_bevy_check) for the driver's contract to be tested
// end to end - the real check is verified live on the machine. The absence rows (no Rust on
// PATH) and the kill timers (a stuck cargo must never hang a forge job) are the heart of it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BEVY_VERSION, BEVY_CRATE_DIR, findCargo, bevyStatus, isBevyProject, bevyVersionOf,
  createBevyProject, installCrate, sendBevy, checkPackage, runCargo,
} from '../scripts/engines/bevy.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'af-bevyeng-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function stubCargo(file, body) {
  const p = path.join(tmp, file);
  writeFileSync(p, '#!/usr/bin/env bash\n' + body);
  chmodSync(p, 0o755);
  return p;
}

// The af_bevy_check stand-in: answers the exact argv runCheck builds and writes the same
// artifacts to the same places the real binary does.
const CHECK_STUB = stubCargo('cargo-check', `
slug=""; out=""; prev=""
for a in "$@"; do
  case "$prev" in --slug) slug="$a";; --out) out="$a";; esac
  prev="$a"
done
if [ ! -f "assets/astraforge/$slug/af_bevy.json" ]; then
  echo 'AFBEVY {"ok":false,"slug":"'$slug'","code":2,"why":"no package in the scaffold","shots":[],"checks":[]}'
  exit 2
fi
mkdir -p "$out/shots"
printf 'PNGSTUB' > "$out/shots/forward.png"
echo '{"ok":true,"from":"stub"}' > "$out/bevy_check.json"
echo '{"up":"+Y","from":"stub"}' > "$out/bevy_forward.json"
echo "AFBEVY {\\"ok\\":true,\\"slug\\":\\"$slug\\",\\"code\\":0,\\"why\\":\\"\\",\\"shots\\":[\\"shots/forward.png\\"],\\"checks\\":[{\\"name\\":\\"scene_mounted\\",\\"ok\\":true,\\"detail\\":\\"stub\\"}]}"
exit 0
`);

test('findCargo honours ASTRA_CARGO and answers honestly without it', () => {
  assert.equal(findCargo({ env: { ASTRA_CARGO: path.join(tmp, 'nope') } }), null);
  assert.equal(findCargo({ env: { ASTRA_CARGO: CHECK_STUB } }), CHECK_STUB);
});

test('bevyStatus: the absence line the studio shows, and the version pins', async () => {
  const gone = await bevyStatus({ env: { ASTRA_CARGO: path.join(tmp, 'nope'), PATH: '/nonexistent' } });
  assert.equal(gone.hasCargo, false);
  assert.equal(gone.cargo, null);
  assert.match(gone.reason, /cargo is not on PATH/);
  assert.equal(gone.bevy, BEVY_VERSION);
  assert.equal(gone.crate, true, 'the studio ships the crate folder');
  assert.equal(gone.template, true);
  const vstub = stubCargo('cargo-version', 'echo "cargo 9.9.9 (deadbeef 2026-01-01)"');
  const here = await bevyStatus({ env: { ASTRA_CARGO: vstub } });
  assert.equal(here.hasCargo, true);
  assert.equal(here.cargoVersion, '9.9.9');
  assert.equal(here.reason, null);
});

test('runCargo idle-kills a silent toolchain (a cargo stuck on a lock cannot hang the forge job)', async () => {
  const silent = stubCargo('cargo-silent', 'sleep 120');
  const t0 = Date.now();
  const r = await runCargo({ cargo: silent, args: ['build'], cwd: tmp, env: {},
    out: path.join(tmp, 'idle-log.txt'), timeoutMin: 30, idleMin: 0.05 });
  assert.equal(r.idle, true, 'idle flag');
  assert.equal(r.timedOut, false);
  assert.equal(r.code, -1);
  assert.match(r.log, /went quiet - killed/);
  assert.ok(Date.now() - t0 < 20000, 'killed within seconds of the idle floor, not the 30-min ceiling');
  assert.match(readFileSync(path.join(tmp, 'idle-log.txt'), 'utf8'), /went quiet/);
});

test('runCargo timeout-kills a chatty runaway (beats reset idle, the ceiling still cuts)', async () => {
  const noisy = stubCargo('cargo-noisy', 'while true; do echo still-compiling; sleep 0.3; done');
  const r = await runCargo({ cargo: noisy, args: ['build'], cwd: tmp, env: {},
    out: path.join(tmp, 'hard-log.txt'), timeoutMin: 0.05, idleMin: 30 });
  assert.equal(r.timedOut, true);
  assert.equal(r.idle, false);
  assert.match(r.log, /still-compiling/);
  assert.match(r.log, /ran past its time limit - killed/);
});

test('createBevyProject copies the template, names it, and points the crate at this studio', async () => {
  const r = await createBevyProject({ name: 'Probe', dir: path.join(tmp, 'proj'), env: {} });
  const toml = readFileSync(path.join(r.dir, 'Cargo.toml'), 'utf8');
  assert.match(toml, /^name = "Probe"/m);
  assert.match(toml, new RegExp('astraforge_bevy = \\{ path = ".*bevy/astraforge_bevy"'), 'path-dep into THIS checkout');
  assert.ok(toml.includes(BEVY_CRATE_DIR.split(path.sep).join('/')), 'the relative path resolves to the studio crate');
  assert.equal(existsSync(path.join(r.dir, 'src', 'player.rs')), true, 'the player starter came along');
  assert.equal(existsSync(path.join(r.dir, 'Cargo.lock')), false, 'the studio lock never ships with the copy');
  assert.equal(isBevyProject(r.dir), true);
  assert.equal(isBevyProject(tmp), false);
  assert.equal(bevyVersionOf(r.dir), '0.20.1', "the template's pin, not astraforge_bevy's own version");
});

test('installCrate adds the path dependency exactly once', () => {
  const dir = path.join(tmp, 'hand-rolled');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "hand"\n\n[dependencies]\nserde = "1"\n');
  assert.equal(installCrate({ project: dir }).added, true);
  const once = readFileSync(path.join(dir, 'Cargo.toml'), 'utf8');
  assert.equal((once.match(/astraforge_bevy\s*=/g) || []).length, 1, 'the dependency key appears once (the path mentions the folder again)');
  assert.ok(once.includes('serde = "1"'), 'the existing dependencies survive');
  assert.equal(installCrate({ project: dir }).added, false, 'idempotent');
  assert.throws(() => installCrate({ project: path.join(tmp, 'nowhere') }), /no Cargo\.toml/);
});

test('sendBevy places packages and names the task ids', async () => {
  const project = path.join(tmp, 'send-proj');
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'Cargo.toml'), '[dependencies]\nastraforge_bevy = { path = "../crate", version = "0.20" }\n');
  const pkg = path.join(tmp, 'pkg_lantern');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, 'af_bevy.json'), JSON.stringify({ asset_id: 'Brass Lantern! 42', glb: 'model.glb' }));

  const sent = await sendBevy({ project, sources: [pkg] });
  assert.equal(sent[0].id, 'af_bevy_send_brass_lantern_42', 'slug sanitised, task id pinned');
  assert.ok(existsSync(path.join(sent[0].dest, 'af_bevy.json')));
  // a re-send replaces, does not merge
  writeFileSync(path.join(project, 'assets', 'astraforge', 'brass_lantern_42', 'left-over.txt'), 'from an older send');
  await sendBevy({ project, sources: [pkg] });
  assert.equal(existsSync(path.join(project, 'assets', 'astraforge', 'brass_lantern_42', 'left-over.txt')), false);

  await assert.rejects(() => sendBevy({ project: tmp, sources: [pkg] }), /not a Bevy project/);
  const junk = path.join(tmp, 'pkg_junk');
  mkdirSync(junk, { recursive: true });
  await assert.rejects(() => sendBevy({ project, sources: [junk] }), /not a Bevy package/);
});

test('checkPackage: no cargo - honest skip; stub cargo - the four contract outputs', async () => {
  const pkg = path.join(tmp, 'pkg_check');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, 'af_bevy.json'), JSON.stringify({ asset_id: 'check_box', clips: [] }));
  const env = { ASTRA_CARGO_TARGET_DIR: path.join(tmp, 'target') };

  const gone = await checkPackage({ packageDir: pkg, out: path.join(tmp, 'o-gone'), env: { ...env, ASTRA_CARGO: path.join(tmp, 'no') } });
  assert.equal(gone.ok, false);
  assert.match(gone.skipped, /cargo not found/);
  assert.equal(gone.report, null);

  const r = await checkPackage({ packageDir: pkg, out: path.join(tmp, 'o-stub'), env: { ...env, ASTRA_CARGO: CHECK_STUB } });
  assert.equal(r.ok, true);
  assert.equal(r.taskId, 'af_bevy_check', 'the pinned task id (spec T3-Bevy)');
  assert.equal(r.report.shots[0], 'shots/forward.png');
  assert.equal(r.report.checks[0].name, 'scene_mounted');
  const out = path.join(tmp, 'o-stub');
  for (const f of ['bevy_check.json', 'bevy_forward.json', 'bevy_log.txt', 'shots/forward.png']) {
    assert.ok(existsSync(path.join(out, f)), f);
  }
  assert.match(readFileSync(path.join(out, 'bevy_log.txt'), 'utf8'), /AFBEVY/);
  assert.ok(existsSync(path.join(out, '_bevy_check', 'assets', 'astraforge', 'check_box', 'af_bevy.json')),
    'the scaffold held exactly this package');
});

test('the CLI: status and check-package degrade honestly without Rust (T2-3)', () => {
  const env = { ...process.env, ASTRA_CARGO: path.join(tmp, 'no-cargo-here') };
  const st = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'engines', 'bevy.mjs'), 'status'], { env, encoding: 'utf8' });
  assert.equal(st.status, 0);
  assert.equal(JSON.parse(st.stdout).hasCargo, false);

  const pkg = path.join(tmp, 'pkg_cli');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, 'af_bevy.json'), '{"asset_id":"cli_box"}');
  const ck = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'engines', 'bevy.mjs'), 'check-package',
    '--package', pkg, '--out', path.join(tmp, 'o-cli')], { env, encoding: 'utf8' });
  assert.equal(ck.status, 0, 'an honest skip is not a failed export');
  assert.match(ck.stdout, /^AFBEVYCHECK /);
  assert.match(ck.stdout, /cargo not found/);
});
