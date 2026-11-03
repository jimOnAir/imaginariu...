// face_match / face_fix_loop: the qa registry entries and the preset that runs the fix loop, plus the report
// summary of scripts/qa/face_step.py (the stdlib-only parser the Blender steps use to turn face_report.json
// into stats and checks). The report text itself is a machine-parsed contract and stays Russian.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blenderParams, defaultParams, getPreset, isGpuStep, listSteps, normalizeParams, normalizeSteps, pathParams, timeoutFor,
} from '../server/forge-steps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACE_STEP = path.join(ROOT, 'scripts', 'qa', 'face_step.py');
const tmp = mkdtempSync(path.join(tmpdir(), 'af-face-'));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));

const DEFAULT_THRESHOLDS = { ssim_gray: 0.85, feature_mask_iou_min: 0.8, landmark_max_px_share: 0.02, diff_area_share_max: 0.01, silhouette_iou: 0.93 };

/** A system Python 3 for the stdlib-only parser (python3 / python on PATH), or null. */
function findPython() {
  for (const [cmd, args] of [['python3', ['-I']], ['python', ['-I']]]) {
    try {
      const r = spawnSync(cmd, [...args, '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 20000 });
      if (r.status === 0 && r.stdout.trim() === '3') return { cmd, args };
    } catch { /* not installed */ }
  }
  return null;
}

const runSummary = (python, file, extra = []) => spawnSync(python.cmd, [...python.args, FACE_STEP, 'summary', file, ...extra],
  { encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });

test('face_match and face_fix_loop: registered after paint_from_concept, reference folder is a path param, thresholds checked; the preset runs the loop before the rig', () => {
  const steps = listSteps();
  const names = steps.map((s) => s.step);
  assert.ok(names.indexOf('paint_from_concept') < names.indexOf('face_match'), 'the gate comes after the paint step');
  assert.ok(names.indexOf('face_match') < names.indexOf('face_fix_loop'));
  for (const name of ['face_match', 'face_fix_loop']) {
    const s = steps.find((x) => x.step === name);
    assert.ok(s, name);
    assert.equal(s.module, 'qa');
    assert.match(s.title, /Face/);
    assert.match(s.help, /reference/);
    assert.deepEqual(s.inputs.slots, ['blend', 'mesh'], `${name}: the .blend of the chain first`);
    assert.deepEqual(s.inputs.formats, ['glb', 'blend']);
    assert.deepEqual(s.kinds, ['humanoid']);
    assert.equal(s.gpu, false, 'no GPU lock: the VLM frees ComfyUI itself, like paint_from_concept QA');
    assert.equal(isGpuStep(name), false);
    assert.ok(pathParams(name).includes('refs_dir'), `${name}: refs_dir is refused over HTTP`);
    assert.ok(pathParams(name).includes('python'));
    assert.doesNotThrow(() => normalizeParams(name, defaultParams(name)), `${name}: defaults valid`);
    assert.deepEqual(normalizeParams(name, { refs_dir: null }).explicit, {}, 'empty path = face_refs/ next to the asset or the model');
    assert.throws(() => normalizeParams(name, { thresholds: { ssim: 0.9 } }), /unknown threshold/);
    assert.throws(() => normalizeParams(name, { thresholds: { ssim_gray: 2 } }), /from 0 to 1/);
    assert.throws(() => normalizeParams(name, { thresholds: [0.9] }), /an object/);
    assert.throws(() => normalizeParams(name, { vlm: 'always' }), /allowed values/);
    assert.throws(() => normalizeParams(name, { min_score: 101 }), /at most 100/);
    assert.deepEqual(normalizeParams(name, { thresholds: { ssim_gray: 0.8, diff_area_share_max: 0.02 } }).explicit.thresholds, { ssim_gray: 0.8, diff_area_share_max: 0.02 });
    // the step reads the paths itself: path params are not server-only, nothing is stripped on the way to Blender
    assert.deepEqual(blenderParams(name, { refs_dir: '/home/u/refs', vlm: 'off' }), { refs_dir: '/home/u/refs', vlm: 'off' });
  }
  const gate = steps.find((x) => x.step === 'face_match');
  assert.deepEqual(gate.outputs, ['face_report', 'face_report_jpg', 'face_match_dir']);
  const gd = defaultParams('face_match');
  assert.equal(gd.gate, true, 'a failing face stops the chain by default');
  assert.equal(gd.min_score, null);
  assert.equal(gd.vlm, 'auto');
  assert.equal(gd.iteration, 0);
  assert.equal(timeoutFor('face_match'), 30 * 60);
  const loop = steps.find((x) => x.step === 'face_fix_loop');
  for (const k of ['blend', 'glb', 'face_report', 'face_report_jpg', 'texture_check', 'loop_state', 'loop_log']) assert.ok(loop.outputs.includes(k), k);
  assert.ok(pathParams('face_fix_loop').includes('body_refs_dir'));
  const ld = defaultParams('face_fix_loop');
  assert.equal(ld.max_iter, 6);
  assert.equal(ld.plateau, 2);
  assert.equal(ld.require_pass, false, 'the best model goes on by default; pass against four GPT references at once is not reachable');
  assert.equal(ld.vlm, 'auto');
  assert.equal(timeoutFor('face_fix_loop'), 6 * 60 * 60);
  assert.throws(() => normalizeParams('face_fix_loop', { max_iter: 0 }), /at least 1/);
  assert.throws(() => normalizeParams('face_fix_loop', { plateau: 11 }), /at most 10/);
  // the preset: colour, then the loop, then the rig on the fixed .blend
  const p = getPreset('humanoid_face_checked');
  assert.ok(p, 'preset registered');
  assert.equal(p.kind, 'humanoid');
  assert.match(p.title, /face check/i);
  assert.deepEqual(p.steps.map((s) => s.step), ['cleanup', 'paint_from_concept', 'face_fix_loop', 'rig_humanoid', 'retarget', 'godot_package']);
  assert.deepEqual(normalizeSteps(p.steps).warnings, [], 'only registry params');
  assert.equal(p.steps[2].params.max_iter, 6);
  assert.equal(p.steps[0].params.height_m, 1.8);
  assert.equal(p.steps[4].params.root_motion, 'extract');
  assert.deepEqual(getPreset('humanoid_from_mesh').steps.map((s) => s.step), ['cleanup', 'rig_humanoid', 'retarget', 'godot_package'], 'the plain preset is unchanged');
});

test('face_step.py summary: score, pass, failed thresholds per view, defect counts, Russian instructions and the gate check from face_report.json', (t) => {
  const python = findPython();
  if (!python) { t.skip('no system Python (python3 -I / python -I) for the report parser'); return; }
  const file = path.join(tmp, 'face_report.json');
  writeFileSync(file, JSON.stringify({
    model: '/home/u/iter_05/fix/painted.blend', reference_set: '/home/u/in', iteration: 6, score: 56.8, pass: false, thresholds: DEFAULT_THRESHOLDS,
    views: {
      front: { score: 70.6, pass: false, metrics: { ssim_gray: 0.8181, silhouette_iou: 0.9358, diff_area_share: 0.1214, landmark_max_share: 0.0,
        feature_mask_iou: { skin: 0.9453, hair: 0.7913, headband: 0.8764, dark_features: 0.8112 }, vlm: { face_readable: true, hair_solid: false, same_person: true } } },
      face34_left: { score: 43.0, pass: false, metrics: { ssim_gray: 0.9, silhouette_iou: 0.95, diff_area_share: 0.005, landmark_max_share: 0.05,
        feature_mask_iou: { skin: 0.9, hair: 0.85 } } },
      back: { score: 47.4, pass: true, metrics: { ssim_gray: 0.9, silhouette_iou: 0.95, diff_area_share: 0.005, landmark_max_share: 0.5,
        feature_mask_iou: { skin: 0.9, hair: 0.85, headband: null } } },
    },
    defects: [
      { id: 'd1', view: 'back', zone: 'hair_top', kind: 'hole', severity: 'blocker', instruction: { action: 'inpaint_from_ref', text_ru: 'залить просвет волос сверху' } },
      { id: 'd2', view: 'front', zone: 'hair_left', kind: 'texture_smear', severity: 'major', instruction: { action: 'reproject', text_ru: 'перепроецировать анфас целиком' } },
      { id: 'd3', view: 'front', zone: 'mouth', kind: 'colour_off', severity: 'minor', instruction: { action: 'recolor', text_ru: 'перекрасить рот в цвет референса' } },
    ],
    vlm: { used: true, requests: 5 }, seconds: 237.8,
  }));
  const r = runSummary(python, file);
  assert.equal(r.status, 1, `fail -> exit 1\n${r.stderr}`);
  const s = JSON.parse(r.stdout);
  assert.equal(s.ok, true);
  assert.equal(s.pass, false);
  assert.equal(s.score, 56.8);
  assert.equal(s.iteration, 6);
  assert.equal(s.vlm_used, true);
  assert.deepEqual(s.defects, { blocker: 1, major: 1, minor: 1, total: 3 });
  assert.equal(s.blocking, 2);
  assert.deepEqual([...s.views.front.failed].sort(), ['diff_area_share_max', 'feature_mask_iou_min', 'ssim_gray']);
  assert.deepEqual(s.views.face34_left.failed, ['landmark_max_px_share'], 'landmarks count on the face views');
  assert.deepEqual(s.views.back.failed, [], 'no landmark threshold for the back of the head; null mask IoU ignored');
  assert.equal(s.views.front.feature_mask_iou_min, 0.7913);
  assert.deepEqual(s.views.front.vlm_no, ['hair_solid']);
  assert.equal(s.views.front.ru, 'анфас');
  assert.equal(s.views.face34_left.ru, '3/4 слева');
  assert.deepEqual(s.instructions.map((i) => i.text_ru), ['залить просвет волос сверху', 'перепроецировать анфас целиком', 'перекрасить рот в цвет референса']);
  assert.deepEqual(s.instructions.map((i) => i.action), ['inpaint_from_ref', 'reproject', 'recolor']);
  assert.match(s.summary_ru, /score 56\.8 {2}FAIL {2}дефектов 3 \(blocker 1, major 1, minor 1\)/);
  assert.match(s.summary_ru, /анфас — diff_area_share_max, feature_mask_iou_min, ssim_gray|анфас — ssim_gray/);
  assert.equal(s.check.name, 'face_match_pass');
  assert.equal(s.check.ok, false);
  assert.equal(s.check.severity, 'error');
  assert.match(s.check.note, /не совпадает с референсом/);
  assert.deepEqual(s.check.value, { score: 56.8, pass: false, blocking: 2, defects: 3 });
  // a sufficient score passes the gate without pass
  const ok = runSummary(python, file, ['--min-score', '50']);
  assert.equal(ok.status, 0, ok.stderr);
  const so = JSON.parse(ok.stdout);
  assert.equal(so.check.ok, true);
  assert.equal(so.check.limit.min_score, 50);
  assert.match(so.check.note, /не ниже достаточного 50/);
  // the error form face_match.py writes when it crashes
  const errFile = path.join(tmp, 'face_report_error.json');
  writeFileSync(errFile, JSON.stringify({ model: 'x.blend', error: 'RuntimeError: Blender не найден', pass: false, score: 0 }));
  const e = runSummary(python, errFile, ['--min-score', '0']);
  assert.equal(e.status, 1, 'an error never passes, whatever min_score');
  const es = JSON.parse(e.stdout);
  assert.equal(es.ok, false);
  assert.match(es.error, /Blender/);
  assert.deepEqual(es.views, {});
  assert.deepEqual(es.defects, { blocker: 0, major: 0, minor: 0, total: 0 });
  assert.match(es.summary_ru, /ошибка проверяльщика/);
  assert.equal(es.check.ok, false);
});
