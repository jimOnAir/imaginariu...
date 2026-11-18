// Sound tab (behavior per ADR-0004, ticket 04): the install message names what to put on disk, the
// worker argv contract for both engines, the queue that follows SOUND_* lines into the library,
// the library's trash-not-delete rule, per-asset event bindings, and the export guard that keeps
// released audio free of provenance marks. The real GPU runs are the live demo in the ticket.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { soundArgs, soundConfig, soundInstallState, soundLibrary, soundPresets, soundStatus, addSoundToLibrary, trashSound, loadBindings, setBinding, exportSoundBank, createSoundTask, soundTask, findAudioMarks, SOUND_REQUIREMENTS, SOUND_EVENTS } from '../server/sound.mjs';

const tmp = mkdtempSync(path.join(tmpdir(), 'imaginarium-sound-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A cfg whose install folder really holds every SOUND_REQUIREMENTS file, plus a private data dir. */
function fakeInstall(name) {
  const dir = path.join(tmp, name);
  for (const [rel] of SOUND_REQUIREMENTS) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    if (!existsSync(p)) writeFileSync(p, 'x');
  }
  return soundConfig({ env: { IMAGINARIUM_SOUND_DIR: dir }, appRoot: dir, dataDir: path.join(dir, 'data') });
}

/** A stand-in worker: writes a WAV, then replays the given stdout lines and exits. */
function fakeWorker(lines, { writeOut = true, code = 0 } = {}) {
  return (_python, argv) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.emit('exit', -9); };
    const out = argv[argv.indexOf('--out') + 1];
    setImmediate(() => {
      // the real worker writes the WAV and only then reports SOUND_RESULT, so the fake does the same
      if (writeOut && lines.some((l) => l.startsWith("SOUND_RESULT"))) {
        mkdirSync(path.dirname(out), { recursive: true });
        writeFileSync(out, plainWav());
        writeFileSync(out.replace(/\.wav$/, ".ogg"), Buffer.from("OggS", "latin1"));
      }
      for (const line of lines) child.stdout.write(line + '\n');
      child.stdout.end();
      child.emit('exit', code);
    });
    return child;
  };
}

/** the smallest file a WAV reader accepts: RIFF + fmt  + data, nothing else */
function plainWav() {
  const pcm = Buffer.alloc(4, 0);
  const head = Buffer.concat([
    Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WAVE', 'latin1'),
    Buffer.from('fmt ', 'latin1'), Buffer.from([16, 0, 0, 0]),
    Buffer.from([1, 0, 1, 0, 0x80, 0x3a, 0x09, 0x00, 0x00, 0x77, 0x01, 0x00, 2, 0, 16, 0], 'latin1'),
    Buffer.from('data', 'latin1'), Buffer.from([4, 0, 0, 0]),
  ]);
  head.writeInt32LE(head.length + pcm.length - 8, 4);
  return Buffer.concat([head, pcm]);
}

const settle = (task) => new Promise((resolve) => {
  const check = () => {
    const t = soundTask(task.id);
    if (t && !['queued', 'running'].includes(t.status)) return resolve(t);
    setTimeout(check, 20);
  };
  check();
});

// - - - - - - - - - - the install message and the status - - - - - - - - - - - - - - - - - - - - - -

test('an absent Sound worker says exactly what is missing and how to install it', () => {
  const cfg = soundConfig({ env: { IMAGINARIUM_SOUND_DIR: path.join(tmp, 'nowhere') }, appRoot: tmp });
  const state = soundInstallState(cfg, () => false);
  assert.equal(state.installed, false);
  assert.deepEqual(state.missing.map((m) => m.path), SOUND_REQUIREMENTS.map(([p]) => p));
  assert.match(state.message, /Sound is not ready/);
  assert.match(state.message, /install\.sh -Only sound/);
  for (const [, label] of SOUND_REQUIREMENTS) assert.ok(state.message.includes(label), `message names ${label}`);
  const st = soundStatus({ cfg, exists: () => false });
  assert.equal(st.installed, false);
  assert.equal(st.running, false, 'a task is a subprocess, never a service');
  assert.deepEqual(st.missing.length, SOUND_REQUIREMENTS.length);
});

test('the install check is satisfied by the files the installer lays down', () => {
  const cfg = fakeInstall('install-ok');
  assert.equal(soundInstallState(cfg).installed, true);
  assert.equal(soundStatus({ cfg }).installed, true);
});

test('presets carry the pickers and the event kinds the UI renders', () => {
  const p = soundPresets();
  assert.deepEqual(p.sfx.durations, [2, 5, 10, 20, 30]);
  assert.ok(p.sfx.ideas.length >= 3 && p.loop.ideas.length >= 3);
  assert.deepEqual(p.loop.bars, [2, 4, 8]);
  assert.deepEqual(p.events, SOUND_EVENTS);
  assert.ok(SOUND_EVENTS.includes('footstep') && SOUND_EVENTS.includes('impact') && SOUND_EVENTS.includes('spell'));
});

// - - - - - - - - - - - - - - - - the worker contract - - - - - - - - - - - - - - - - - - - - - - - -

test('worker argv: MOSS for an effect, ACE-Step for a loop, the same out path every time', () => {
  const cfg = fakeInstall('argv');
  const sfx = soundArgs(cfg, { id: 'a', kind: 'sfx', prompt: 'door creak', seconds: 5, seed: 3 });
  assert.equal(sfx[1].endsWith(path.join('scripts', 'sound', 'sound_run.py')), true, 'our worker script');
  assert.deepEqual(sfx.slice(sfx.indexOf('--engine'), sfx.indexOf('--engine') + 2), ['--engine', 'moss']);
  assert.deepEqual(sfx.slice(sfx.indexOf('--seconds'), sfx.indexOf('--seconds') + 2), ['--seconds', '5']);
  assert.deepEqual(sfx.slice(sfx.indexOf('--seed'), sfx.indexOf('--seed') + 2), ['--seed', '3']);
  assert.deepEqual(sfx.slice(sfx.indexOf('--steps'), sfx.indexOf('--steps') + 2), ['--steps', '100']);
  assert.deepEqual(sfx.slice(sfx.indexOf('--weights'), sfx.indexOf('--weights') + 2), ['--weights', path.join(cfg.dir, 'models')], 'the worker only reads the install folder');
  assert.deepEqual(sfx.slice(sfx.indexOf('--src'), sfx.indexOf('--src') + 2), ['--src', path.join(cfg.dir, 'src')]);
  const loop = soundArgs(cfg, { id: 'b', kind: 'loop', prompt: 'tavern', bpm: 140, bars: 8, seed: 9 });
  assert.deepEqual(loop.slice(loop.indexOf('--engine'), loop.indexOf('--engine') + 2), ['--engine', 'acestep']);
  assert.deepEqual(loop.slice(loop.indexOf('--bpm'), loop.indexOf('--bpm') + 2), ['--bpm', '140']);
  assert.deepEqual(loop.slice(loop.indexOf('--bars'), loop.indexOf('--bars') + 2), ['--bars', '8']);
  assert.deepEqual(loop.slice(loop.indexOf('--steps'), loop.indexOf('--steps') + 2), ['--steps', '8'], 'turbo runs eight steps');
  assert.ok(!loop.includes('--seconds'), 'a loop is measured in bars, not seconds');
});

test('a queued effect follows the worker lines and lands WAV + OGG in the library', async () => {
  const cfg = fakeInstall('queue-sfx');
  const created = createSoundTask({ kind: 'sfx', prompt: 'sword unsheathing', seconds: 5, seed: 42 },
    { cfg, spawnFn: fakeWorker(['SOUND_PROGRESS 12 Generating the sound', 'SOUND_PROGRESS 90 MOSS denoising step 100/100', 'SOUND_RESULT {"engine":"moss-soundeffect-v2","seconds":5,"sampleRate":48000,"seed":42}']) });
  assert.equal(created.status, 'queued');
  const done = await settle(created);
  assert.equal(done.status, 'completed', done.error || done.message);
  assert.equal(done.progress, 100);
  assert.equal(done.item.kind, 'sfx');
  assert.equal(done.item.engine, 'moss-soundeffect-v2');
  assert.equal(done.item.seconds, 5);
  const lib = soundLibrary(cfg);
  assert.equal(lib.length, 1);
  assert.equal(lib[0].wav, `/api/sound/library/${lib[0].id}/wav`);
  assert.equal(lib[0].ogg, `/api/sound/library/${lib[0].id}/ogg`);
  assert.equal(readFileSync(path.join(soundPathsOf(cfg).lib, lib[0].id + '.json'), 'utf8').includes('"prompt": "sword unsheathing"'), true);
});

test('a loop task reports bars and BPM; a worker error fails the task with its message', async () => {
  const cfg = fakeInstall('queue-loop');
  const ok = createSoundTask({ kind: 'loop', prompt: 'tavern lute', bpm: 120, bars: 4 },
    { cfg, spawnFn: fakeWorker(['SOUND_RESULT {"engine":"ace-step-1.5","seconds":8,"sampleRate":48000,"seed":42,"bars":4,"bpm":120}']) });
  const done = await settle(ok);
  assert.equal(done.status, 'completed', done.error || done.message);
  assert.equal(done.item.bars, 4);
  assert.equal(done.item.bpm, 120);

  const bad = createSoundTask({ kind: 'sfx', prompt: 'thunder', seconds: 5 },
    { cfg, spawnFn: fakeWorker(['SOUND_ERROR {"message":"CUDA out of memory"}'], { writeOut: false }) });
  const failed = await settle(bad);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /CUDA out of memory/);
  assert.equal(soundLibrary(cfg).length, 1, 'the failed task added nothing to the library');
});

test('the queue refuses impossible requests before it ever spawns', () => {
  const cfg = fakeInstall('validate');
  assert.throws(() => createSoundTask({ kind: 'sfx', prompt: '  ' }, { cfg }), /Describe the sound/);
  assert.throws(() => createSoundTask({ kind: 'sfx', prompt: 'x', seconds: 45 }, { cfg }), /1\.\.30/);
  assert.throws(() => createSoundTask({ kind: 'loop', prompt: 'x', bars: 16 }, { cfg }), /1\.\.8 bars/);
  const empty = soundConfig({ env: { IMAGINARIUM_SOUND_DIR: path.join(tmp, 'nowhere') }, appRoot: tmp });
  assert.throws(() => createSoundTask({ kind: 'sfx', prompt: 'x', seconds: 5 }, { cfg: empty }), (e) => e.code === 'sound_not_installed');
});

// - - - - - - - - - - - - - - the library: trash, never delete - - - - - - - - - - - - - - - - - - - -

test('removing a sound moves WAV + OGG + record to the trash folder and unlists them', () => {
  const cfg = fakeInstall('trash');
  const { lib, trash } = soundPathsOf(cfg);
  mkdirSync(lib, { recursive: true });
  writeFileSync(path.join(lib, 'x.wav'), 'never');
  const item = addSoundToLibrary(path.join(lib, 'x.wav'), { kind: 'sfx', prompt: 'test', seconds: 1 }, cfg);
  assert.equal(existsSync(path.join(lib, item.id + '.wav')), true);
  assert.equal(trashSound('not-an-id', cfg), null);
  assert.equal(trashSound('00000000-0000-4000-8000-000000000000', cfg), null, 'an unknown id is not a crash');
  assert.equal(trashSound(item.id, cfg), item.id);
  assert.equal(existsSync(path.join(lib, item.id + '.wav')), false);
  assert.equal(existsSync(path.join(trash, item.id + '.wav')), true, 'the sound itself survives in the trash');
  assert.equal(existsSync(path.join(trash, item.id + '.json')), true);
  assert.equal(soundLibrary(cfg).length, 0);
  assert.ok(readdirSync(trash).some((f) => f === item.id + '.wav'));
});

test('event bindings store per-asset choices and clear them again', () => {
  const cfg = fakeInstall('bindings');
  const asset = '11111111-1111-4111-8111-111111111111';
  const sound = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(setBinding(asset, 'footstep', sound, cfg), { footstep: sound });
  assert.deepEqual(setBinding(asset, 'impact', sound, cfg), { footstep: sound, impact: sound });
  assert.equal(setBinding(asset, 'impact', null, cfg).impact, undefined);
  assert.deepEqual(loadBindings(cfg)[asset], { footstep: sound });
  setBinding(asset, 'footstep', null, cfg);
  assert.equal(loadBindings(cfg)[asset], undefined, 'an emptied asset drops out of the file');
  assert.throws(() => setBinding(asset, 'laser', sound, cfg), /Unknown asset or event kind/);
  assert.throws(() => setBinding('nope', 'footstep', sound, cfg), /Unknown asset or event kind/);
  assert.throws(() => setBinding(asset, 'footstep', 'nope', cfg), /Unknown sound id/);
});

// - - - - - - - - - - - - - - - - - - the export guard - - - - - - - - - - - - - - - - - - - - - - - -

test('exports are plain audio: no afmk chunk, no product name in a RIFF chunk or an OGG field', () => {
  assert.deepEqual(findAudioMarks(plainWav()), []);
  // the encoder's own banner is not a provenance mark - this is what libsndfile really writes
  const ogg = Buffer.concat([
    Buffer.from('OggS', 'latin1'), Buffer.alloc(27),
    Buffer.from('\x03vorbis', 'latin1'), Buffer.from([4, 0, 0, 0]), Buffer.from('Xiph'), Buffer.from([1, 0, 0, 0]),
    Buffer.from([6, 0, 0, 0]), Buffer.from('ENCODER=libsndfile', 'latin1'),
  ]);
  assert.deepEqual(findAudioMarks(ogg), []);

  const marked = Buffer.concat([plainWav(), Buffer.from('afmk', 'latin1'), Buffer.from([4, 0, 0, 0]), Buffer.from('made')]);
  assert.deepEqual(findAudioMarks(marked).sort(), ['afmk', 'wav chunk afmk']);

  const listed = Buffer.concat([plainWav(), Buffer.from('LIST', 'latin1'), Buffer.from([4, 0, 0, 0]), Buffer.from('info')]);
  assert.deepEqual(findAudioMarks(listed), ['wav chunk LIST']);

  const vendor = Buffer.from('Imaginarium', 'latin1');
  const tagged = Buffer.concat([
    Buffer.from('OggS', 'latin1'), Buffer.alloc(27),
    Buffer.from('\x03vorbis', 'latin1'), Buffer.from([vendor.length, 0, 0, 0]), vendor, Buffer.from([0, 0, 0, 0]),
  ]);
  assert.deepEqual(findAudioMarks(tagged), ['Imaginarium', 'ogg field Imaginarium']);
});

test('the bevy sound bank export is exactly what the imaginarium_bevy crate parses (0.6.10 wave ticket 31)', () => {
  const cfg = fakeInstall('bank');
  const { lib } = soundPathsOf(cfg);
  mkdirSync(lib, { recursive: true });
  const asset = '33333333-3333-4333-8333-333333333333';
  writeFileSync(path.join(lib, 'seed1.wav'), 'WAV');
  const sfx = addSoundToLibrary(path.join(lib, 'seed1.wav'), { kind: 'sfx', name: 'sword hit' }, cfg);
  writeFileSync(path.join(lib, 'seed2.wav'), 'WAV2');
  writeFileSync(path.join(lib, 'seed2.ogg'), 'OGG2');
  const loop = addSoundToLibrary(path.join(lib, 'seed2.wav'), { kind: 'loop', name: 'battle ambience' }, cfg);
  setBinding(asset, 'attack', sfx.id, cfg);
  setBinding(asset, 'ambient', loop.id, cfg);

  const out = path.join(tmp, 'bank-out');
  const r = exportSoundBank({ assetId: asset, engine: 'bevy', out, cfg });
  assert.equal(r.folder, path.join(out, 'assets', 'imaginarium', 'sounds', r.slug));
  assert.equal(r.slug, '33333333_3333_4333_8333_333333333333', 'the bank slug follows the sendBevy slug rule');
  const man = JSON.parse(readFileSync(r.manifest, 'utf8'));
  assert.equal(man.format, 'imaginarium-soundbank/1', 'the versioned format the crate BankManifest demands');
  assert.deepEqual(man.sounds, [
    { name: 'ambient', file: `${r.slug}-ambient.ogg`, loop: true, gain: 1.0 },   // kind loop -> loop true
    { name: 'attack', file: `${r.slug}-attack.wav`, loop: false, gain: 1.0 },     // no ogg companion -> the wav travels
  ], 'entries sorted by name: the manifest is byte-stable for re-exports');
  assert.ok(existsSync(path.join(r.folder, `${r.slug}-attack.wav`)) && existsSync(path.join(r.folder, `${r.slug}-ambient.ogg`)));
  assert.deepEqual(r.missing, [], 'both sounds were bound and present');

  // the house rule: removing = trashing; a re-export replaces the bank, so a manifest can never
  // outlive one of its files (the crate would otherwise fail to load the whole bank)
  trashSound(loop.id, cfg);
  const r2 = exportSoundBank({ assetId: asset, engine: 'bevy', out, cfg });
  assert.equal(r2.files.length, 1);
  assert.deepEqual(r2.missing, [{ event: 'ambient', soundId: loop.id, reason: 'not in the library (trashed or never generated)' }]);
  assert.equal(existsSync(path.join(r2.folder, `${r2.slug}-ambient.ogg`)), false, 'the replaced bank holds only what its manifest names');

  assert.throws(() => exportSoundBank({ assetId: asset, engine: 'godot', out, cfg }), /no bank layout/);
  assert.throws(() => exportSoundBank({ engine: 'bevy', out, cfg }), /assetId is required/);
});

function soundPathsOf(cfg) {
  // the library folder lives under the cfg's data dir: recomputed here so a test can touch files directly
  const base = path.join(cfg.dataDir, 'sound');
  return { lib: path.join(base, 'library'), trash: path.join(base, 'trash'), bindingsFile: path.join(base, 'bindings.json') };
}
