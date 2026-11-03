// Self-learning of the forge (docs/forge/LEARN.md), the Linux branch form.
//
// Every finished step run leaves a line in the production journal; the owner (any studio user, or
// an agent through MCP/CLI) leaves verdicts on asset versions. From both the studio derives, per
// asset class and step, the best known params - the class recipe - and the known pitfalls. A new
// run of that class starts from the recipe instead of the step defaults: the recipe only fills the
// params the caller did not give (explicit params and preset params always win).
//
//   <library>/learning/journal.jsonl   one line per step run (engine; `sync` adds runs from jobs/)
//   <library>/learning/feedback.jsonl  one line per verdict (API, review card, CLI, MCP)
//   <library>/learning/knowledge.json  hand-kept knowledge: pinned recipes, class rules, notes,
//                                      and the `journaling` switch of About -> Learning
//
// Everything is read from disk on demand (cached by mtime and size), so the server, the CLI
// (--direct) and the MCP server share the same files; journal and feedback lines are only appended.
//
// Behavior derived from the 0.4.16 reference tree, no code copied (ADR-0003). Deliberate
// differences on this branch: the shared community-recipe layer (server/learn-community.*) is
// excluded (EXCLUDED.md), so the lowest recipe layer here is the studio's own journal; nothing in
// this module ever touches the network - the journal stays on this computer, and About -> Learning
// toggles the local journaling itself (knowledge.json `journaling`), not a shipping consent.
//
// The tables that machines parse (VERDICT_ALIASES of user words, DEFECT_TAGS words/titles found in
// comments, BUILTIN_CLASSES match patterns) are the shipped contract and stay byte-identical; the
// prose this module writes for people and agents (errors, run notes) is English (branch policy).
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { KINDS, getStep, listSteps, normalizeParams, pathParams } from './forge-steps.mjs';

export const LEARN_DIR_NAME = 'learning';
export const VERDICTS = ['accepted', 'rework', 'rejected'];
export const VERDICT_TITLES = { accepted: 'принято', rework: 'на доработку', rejected: 'брак', cleared: 'отзыв снят' };
/** Verdict -> decision of the review card (manifest.qa.decision) and back. */
export const DECISION_OF = { accepted: 'approved', rework: 'rework', rejected: 'rejected' };
export const VERDICT_OF_DECISION = { approved: 'accepted', rework: 'rework', rejected: 'rejected' };

// Verdict words an agent or a user may type - the shipped parsing contract (both languages).
const VERDICT_ALIASES = {
  accepted: 'accepted', accept: 'accepted', approved: 'accepted', ok: 'accepted', good: 'accepted',
  'принято': 'accepted', 'принят': 'accepted', 'одобрено': 'accepted', 'хорошо': 'accepted',
  rejected: 'rejected', reject: 'rejected', defect: 'rejected', bad: 'rejected', 'брак': 'rejected', 'отклонено': 'rejected',
  rework: 'rework', 'доработка': 'rework', 'на доработку': 'rework',
  cleared: 'cleared', clear: 'cleared', 'снять': 'cleared',
};
// Weight of one run in the score of its params: accepted pulls the params up, rejected down.
const VERDICT_VALUE = { accepted: 1, rework: -0.5, rejected: -1 };
const CHECKS_FAILED_VALUE = -0.5; // a run stopped by its own red checks, without a verdict
const RATING_WEIGHT = 0.1; // rating 1..5 nudges the verdict value by (rating - 3) * 0.1

/** Defect tags offered by the review card, MCP and CLI; `steps` say which steps a tag usually blames. */
export const DEFECT_TAGS = [
  { id: 'acid_colors', title: 'кислотные цвета', steps: ['render_sprites', 'paint_from_concept'], words: ['кислот', 'вырвиглаз', 'пересвеч'] },
  { id: 'washed_out', title: 'блёклые цвета', steps: ['render_sprites', 'paint_from_concept'], words: ['блёкл', 'блекл', 'тускл', 'серост'] },
  { id: 'too_dark', title: 'слишком темно', steps: ['render_sprites', 'paint_from_concept'], words: ['темно', 'тёмн'] },
  { id: 'outline', title: 'контур теряется или лишний', steps: ['render_sprites'], words: ['контур теря', 'контур потер', 'нет контура', 'без контура', 'лишний контур'] },
  { id: 'pixel_noise', title: 'пиксельный шум, каша', steps: ['render_sprites'], words: ['шум', 'каша', 'дизер'] },
  { id: 'off_cell', title: 'вылезает из кадра', steps: ['render_sprites'], words: ['из кадра', 'обрез'] },
  { id: 'wrong_orientation', title: 'не та сторона или поворот', steps: ['render_sprites', 'godot_package'], words: ['поворот', 'не та сторона', 'боком'] },
  { id: 'unlike_concept', title: 'не похож на концепт', steps: [], words: ['не похож'] },
  { id: 'foil', title: '«фольга»: тонкая рваная оболочка', steps: ['paint_from_concept', 'cleanup'], words: ['фольг', 'оболочк'] },
  { id: 'muddy_texture', title: 'мыльная текстура', steps: ['paint_from_concept'], words: ['мыл', 'размаз'] },
  { id: 'extra_features', title: 'лишние глаза или морды', steps: ['paint_from_concept', 'face_fix_loop'], words: ['лишний глаз', 'лишние глаза', 'вторая морда', 'две морды'] },
  { id: 'torn_mesh', title: 'рвётся сетка или одежда', steps: ['motion_style', 'retarget', 'rig_humanoid', 'rig_creature'], words: ['рвётся', 'рвется', 'разрыв', 'плащ'] },
  { id: 'bad_rig', title: 'кривой скелет или нет скелета', steps: ['rig_humanoid', 'rig_creature'], words: ['нет скелета', 'кривой скелет', 'кости торчат'] },
  { id: 'bad_animation', title: 'плохая анимация', steps: ['retarget', 'motion_style', 'anim_creature'], words: ['плохая анимац', 'анимация дёрг', 'анимация дерг'] },
  { id: 'prop_not_in_hand', title: 'предмет не в руке', steps: ['attach_prop'], words: ['не в руке'] },
  { id: 'wrong_scale', title: 'не тот размер', steps: [], words: ['не тот размер', 'не тот масштаб'] },
  { id: 'floating', title: 'парит или проваливается', steps: [], words: ['парит', 'провал'] },
  { id: 'other', title: 'другое', steps: [], words: [] },
];
const TAG_BY_ID = new Map(DEFECT_TAGS.map((t) => [t.id, t]));

/**
 * Built-in class rules: the first rule whose `match` fits the asset name (or the original file name)
 * gives the class; `kinds` limits a rule to asset kinds. Without a match the class is the kind.
 * knowledge.json `classes` adds rules (a rule with the same id replaces the built-in one).
 */
export const BUILTIN_CLASSES = [
  // order matters: «zombie_panel_building_9f» is a building, «zciv_housewife» a zombie
  { id: 'building', title: 'Здание', match: '^bld_|building|^house|apartment|здани|^дом', kinds: ['prop', 'item'] },
  { id: 'zombie', title: 'Зомби', match: 'zciv_|zomb|зомби|^z_' },
  // a humanoid «holding weapons» is a character, not a weapon
  { id: 'weapon', title: 'Орудие', match: 'weapon|turret|gatling|cannon|flamer|rocket|^mg_|_mg$|gun|орудие|пушк|пулем', kinds: ['prop', 'item', 'ship'] },
  { id: 'vehicle', title: 'Машина', match: '^car_|vehicle|truck|^bus_|машин', kinds: ['prop', 'item'] },
  { id: 'tree', title: 'Дерево', match: 'tree|дерев|^bush|куст', kinds: ['prop', 'item'] },
];
const KIND_CLASS_TITLES = { humanoid: 'Гуманоид', creature: 'Существо', item: 'Предмет', ship: 'Корабль', prop: 'Реквизит' };
const CLASS_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

// Params that describe one particular asset (clip lists, sizes, file references, seeds) are not
// a class recipe: two zombies share colours and scale, not their clip list or their height.
const CONTENT_KEYS = new Set([
  'asset_id', 'clips', 'clip_names', 'ranges', 'event_frames', 'loop', 'fx', 'attachments', 'ops', 'points', 'markers',
  'region', 'part_asset', 'part_file', 'prop_asset', 'extracted', 'source_asset', 'comment', 'autoplay', 'seed',
  'height_m', 'length_m', 'sq_type', 'game_unit',
]);

const now = () => new Date().toISOString();
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const learnError = (message, status = 400, code = 'bad_request') => Object.assign(new Error(message), { status, code });

/** JSON with sorted keys: equal params give equal strings whatever the key order. */
export function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temp, file);
      return;
    } catch (err) {
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
}

/** Append-only JSON-lines file; reads are cached until the file changes. */
class JsonLines {
  constructor(file) {
    this.file = file;
    this.cache = null;
    this.chain = Promise.resolve();
  }

  async read() {
    let st;
    try { st = await fs.stat(this.file); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.rows;
    const text = await fs.readFile(this.file, 'utf8');
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r === 'object') rows.push(r);
      } catch { /* a line torn by a crash is skipped */ }
    }
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, rows };
    return rows;
  }

  append(records) {
    const list = [].concat(records).filter(Boolean);
    if (!list.length) return Promise.resolve();
    // one write per call: concurrent appenders (server, CLI) never interleave inside a line
    const text = list.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const run = this.chain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, text, 'utf8');
    });
    this.chain = run.catch(() => {});
    return run;
  }
}

// ------------------------------------------------------------------ pure helpers

/** Variant of a step run: the export profile when the step has one (render_sprites@pixel). */
export function variantOf(step, params = {}) {
  const spec = getStep(step)?.params?.profile;
  if (!spec) return '';
  const v = params?.profile ?? spec.default;
  return typeof v === 'string' ? v : '';
}

export const stepKeyOf = (step, variant) => (variant ? `${step}@${variant}` : step);

/** The part of the params that is a class recipe (style, scale, quality), not one asset's content. */
export function recipeParams(step, params = {}) {
  const spec = getStep(step)?.params || {};
  const skip = new Set(pathParams(step));
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || CONTENT_KEYS.has(k) || skip.has(k)) continue;
    if (spec[k]?.server || spec[k]?.auto) continue;
    if (k === 'frames' && typeof v !== 'number') continue; // {clip: frames} belongs to the clip list
    if (JSON.stringify(v).length > 2000) continue;
    out[k] = v;
  }
  return out;
}

/** Keys whose values differ between `a` (a rejected run) and `b` (the recipe). */
export function paramsDiff(a = {}, b = {}) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys
    .filter((k) => stableJson(a[k]) !== stableJson(b[k]))
    .map((k) => ({ key: k, value: a[k] === undefined ? null : a[k], unset: a[k] === undefined, recipe: b[k] === undefined ? null : b[k], recipeUnset: b[k] === undefined }));
}

/** Tag ids found in a free comment (the review-card rework presets, the owner's own words). */
export function tagsFromText(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return [];
  const out = [];
  for (const tag of DEFECT_TAGS) {
    if (tag.id === 'other') continue;
    if (t.includes(tag.title.toLowerCase()) || tag.words.some((w) => t.includes(w))) out.push(tag.id);
  }
  return out;
}

export function normalizeVerdict(v) {
  const key = String(v ?? '').trim().toLowerCase();
  return VERDICT_ALIASES[key] || null;
}

function normalizeTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw learnError('tags must be a list of strings.', 400, 'validation');
  if (tags.length > 20) throw learnError('No more than 20 defect tags.', 400, 'validation');
  const out = [];
  for (const raw of tags) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (s.length > 60) throw learnError('A defect tag is up to 60 characters.', 400, 'validation');
    const low = s.toLowerCase();
    const known = TAG_BY_ID.get(low) || DEFECT_TAGS.find((t) => t.title.toLowerCase() === low);
    const id = known ? known.id : low;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export const tagTitle = (id) => TAG_BY_ID.get(id)?.title || id;
const stepTitle = (step) => getStep(step)?.title || step;
const fmtValue = (v) => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10).split('-').reverse().join('.') : '—';
};

function compactChecks(checks) {
  return (Array.isArray(checks) ? checks : []).filter((c) => c && c.name).slice(0, 60).map((c) => {
    const o = { name: String(c.name), ok: c.ok !== false, severity: c.severity || 'error' };
    if (c.value !== undefined) {
      const text = JSON.stringify(c.value);
      if (text && text.length <= 160) o.value = c.value;
    }
    return o;
  });
}

const PREVIEW_KEY = /preview|compare|sheet|thumb|markers|poses|turn|contact/i;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** Up to four preview images among the step outputs (absolute paths). */
function previewPaths(outputs) {
  const found = [];
  const add = (p) => { if (typeof p === 'string' && IMAGE_EXT.test(p) && !found.includes(p)) found.push(p); };
  for (const key of ['preview', 'preview_frames', 'compare', 'markers_png', 'poses_png']) add(outputs?.[key]);
  for (const [k, v] of Object.entries(outputs || {})) if (PREVIEW_KEY.test(k)) add(v);
  const sheets = outputs?.sheets;
  if (sheets && typeof sheets === 'object') {
    const names = Object.keys(sheets).sort();
    add(sheets[names.find((n) => /^(idle|walk)\./.test(n)) || names[0]]);
  }
  return found.slice(0, 4);
}

const seconds = (a, b) => {
  const t = (Date.parse(b) - Date.parse(a)) / 1000;
  return Number.isFinite(t) && t >= 0 ? Math.round(t * 10) / 10 : null;
};

/** Class of an asset with the given rules (see ForgeLearn.classify). */
function classifyWith(rules, titles, manifest, override = null) {
  const pick = (id, from) => ({ id, title: titles[id] || id, from });
  for (const [value, from] of [[override, 'run'], [manifest?.profile?.class, 'profile']]) {
    if (value === undefined || value === null || value === '') continue;
    const id = String(value).trim().toLowerCase();
    if (!CLASS_ID.test(id)) throw learnError('Asset class: latin letters, digits, "_" and "-", up to 40 characters.', 400, 'bad_class');
    return pick(id, from);
  }
  const names = [manifest?.name, manifest?.source?.originalName].filter((n) => typeof n === 'string' && n);
  for (const rule of rules) {
    if (Array.isArray(rule.kinds) && rule.kinds.length && !rule.kinds.includes(manifest?.kind)) continue;
    let re;
    try { re = new RegExp(rule.match, 'i'); } catch { continue; }
    if (names.some((n) => re.test(n))) return pick(rule.id, `rule:${rule.id}`);
  }
  const kind = KINDS.includes(manifest?.kind) ? manifest.kind : 'prop';
  return pick(kind, 'kind');
}

// ------------------------------------------------------------------ recipe analysis

/**
 * Recipes and pitfalls from journal runs and verdicts (feedback oldest first: the last one wins).
 * A pure function of the records: the studio's journal and the tests share these exact rules.
 */
export function analyzeRecords({ runs = [], feedback = [], titles = {}, knowledge = { pinned: [], notes: [] } } = {}) {
  const fbByVersion = new Map();
  for (const f of feedback) {
    const k = `${f.assetId}|${f.version}`;
    if (!fbByVersion.has(k)) fbByVersion.set(k, []);
    fbByVersion.get(k).push(f);
  }
  const stepsByVersion = new Map();
  for (const r of runs) {
    const k = `${r.assetId}|${r.version}`;
    if (!stepsByVersion.has(k)) stepsByVersion.set(k, new Set());
    stepsByVersion.get(k).add(r.step);
  }
  // A verdict without a step blames the steps its tags point to (when the version has them), else all.
  const applies = (f, r) => {
    if (f.step) return f.step === r.step;
    const hinted = new Set((f.tags || []).flatMap((t) => TAG_BY_ID.get(t)?.steps || []));
    if (!hinted.size) return true;
    const have = stepsByVersion.get(`${r.assetId}|${r.version}`) || new Set();
    return [...hinted].some((s) => have.has(s)) ? hinted.has(r.step) : true;
  };
  const verdictOf = (r) => {
    let last = null;
    for (const f of fbByVersion.get(`${r.assetId}|${r.version}`) || []) if (applies(f, r)) last = f;
    return last && last.verdict !== 'cleared' ? last : null;
  };

  const groups = new Map();
  for (const r of runs) {
    if (!r.class || !r.step) continue;
    const gk = `${r.class}|${r.stepKey}`;
    if (!groups.has(gk)) {
      groups.set(gk, {
        class: r.class, classTitle: titles[r.class] || r.class, step: r.step, stepTitle: stepTitle(r.step), variant: r.variant || '',
        stepKey: r.stepKey, runs: 0, verdicts: { accepted: 0, rework: 0, rejected: 0 }, sigs: new Map(),
      });
    }
    const g = groups.get(gk);
    g.runs += 1;
    const params = recipeParams(r.step, r.params);
    const sk = stableJson(params);
    if (!g.sigs.has(sk)) g.sigs.set(sk, { params, runs: 0, score: 0, accepted: 0, rework: 0, rejected: 0, checksFailed: 0, blind: 0, lastAt: null, tags: new Map(), comments: [], examples: [] });
    const sig = g.sigs.get(sk);
    sig.runs += 1;
    if (!sig.lastAt || String(r.at) > sig.lastAt) sig.lastAt = String(r.at);
    const f = verdictOf(r);
    if (f) {
      g.verdicts[f.verdict] += 1;
      sig[f.verdict] += 1;
      sig.score += VERDICT_VALUE[f.verdict] + (f.rating ? (f.rating - 3) * RATING_WEIGHT : 0);
      // a defect without a step and without a tag that names one: the guilty step is unknown
      if (f.verdict !== 'accepted' && !f.step && !(f.tags || []).some((t) => TAG_BY_ID.get(t)?.steps?.length)) sig.blind += 1;
      for (const t of f.tags || []) sig.tags.set(t, (sig.tags.get(t) || 0) + 1);
      if (f.comment && !sig.comments.includes(f.comment) && sig.comments.length < 3) sig.comments.push(f.comment);
    } else if (r.status === 'failed' && (r.failed || []).length) {
      sig.checksFailed += 1;
      sig.score += CHECKS_FAILED_VALUE;
    }
    // examples: versions with a verdict first (a run without one only fills the gaps)
    const example = { assetId: r.assetId, assetName: r.assetName, version: r.version, verdict: f?.verdict || null };
    if (r.assetName && !sig.examples.some((e) => e.assetName === r.assetName)) {
      if (sig.examples.length < 3) sig.examples.push(example);
      else if (example.verdict) {
        const plain = sig.examples.findIndex((e) => !e.verdict);
        if (plain >= 0) sig.examples[plain] = example;
      }
    }
  }

  const out = [];
  for (const g of groups.values()) {
    const sigs = [...g.sigs.values()].map((s) => ({
      ...s,
      score: Math.round(s.score * 100) / 100,
      tags: [...s.tags].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, title: tagTitle(id), count })),
    }));
    const winners = sigs.filter((s) => s.accepted > 0 && s.score > 0)
      .sort((a, b) => b.score - a.score || String(b.lastAt).localeCompare(String(a.lastAt)));
    const best = winners[0] || null;
    const pitfalls = sigs
      .filter((s) => s !== best && (s.rejected + s.rework + s.checksFailed > 0))
      .sort((a, b) => a.score - b.score)
      .map((s) => ({ ...s, diff: best ? paramsDiff(s.params, best.params) : [] }));
    out.push({
      class: g.class, classTitle: g.classTitle, step: g.step, stepTitle: g.stepTitle, variant: g.variant, stepKey: g.stepKey,
      runs: g.runs, verdicts: g.verdicts, best, pitfalls, candidates: sigs.length,
    });
  }
  out.sort((a, b) => a.class.localeCompare(b.class) || a.stepKey.localeCompare(b.stepKey));
  return { groups: out, pinned: knowledge.pinned, notes: knowledge.notes, titles, runs: runs.length, feedback: feedback.length };
}

// ------------------------------------------------------------------ the store

export class ForgeLearn {
  /**
   * @param {{libraryDir:string, dir?:string, urlBase?:string}} opts
   *   dir defaults to <libraryDir>/learning; everything lives under the library folder of the studio.
   */
  constructor(opts = {}) {
    if (!opts.libraryDir && !opts.dir) throw new Error('ForgeLearn: libraryDir is required.');
    this.libraryDir = opts.libraryDir ? path.resolve(opts.libraryDir) : null;
    this.dir = path.resolve(opts.dir || path.join(this.libraryDir, LEARN_DIR_NAME));
    this.assetsDir = this.libraryDir ? path.join(this.libraryDir, 'assets') : null;
    this.jobsDir = this.libraryDir ? path.join(this.libraryDir, 'jobs') : null;
    this.urlBase = opts.urlBase ?? '/api/forge';
    this.journal = new JsonLines(path.join(this.dir, 'journal.jsonl'));
    this.feedback = new JsonLines(path.join(this.dir, 'feedback.jsonl'));
    this.knowledgeFile = path.join(this.dir, 'knowledge.json');
    this.knowledgeChain = Promise.resolve();
  }

  get files() {
    return { dir: this.dir, journal: this.journal.file, feedback: this.feedback.file, knowledge: this.knowledgeFile };
  }

  // ---------------------------------------------------------------- knowledge.json

  async knowledge() {
    const k = (await readJson(this.knowledgeFile, null)) || {};
    return {
      version: 1,
      journaling: k.journaling !== false,   // About -> Learning: local journaling on/off (this tree has no shipping)
      classes: Array.isArray(k.classes) ? k.classes : [],
      pinned: Array.isArray(k.pinned) ? k.pinned : [],
      notes: Array.isArray(k.notes) ? k.notes : [],
    };
  }

  /** About -> Learning: automatic journaling of step runs (explicit verdicts and notes stay allowed). */
  async journalingOn() {
    return (await this.knowledge()).journaling;
  }

  async setJournaling(on) {
    const k = await this._editKnowledge((kk) => { kk.journaling = !!on; });
    return { journaling: !!on, files: this.files, knowledge: k };
  }

  _editKnowledge(mutate) {
    const run = this.knowledgeChain.then(async () => {
      const k = await this.knowledge();
      const out = (await mutate(k)) || k;
      out.updated = now();
      await writeJsonAtomic(this.knowledgeFile, out);
      return out;
    });
    this.knowledgeChain = run.catch(() => {});
    return run;
  }

  /** Class rules: knowledge.json first (same id replaces a built-in rule), then the built-in ones. */
  async classRules() {
    const own = (await this.knowledge()).classes.filter((c) => c && CLASS_ID.test(String(c.id || '')));
    const ids = new Set(own.map((c) => c.id));
    return [...own, ...BUILTIN_CLASSES.filter((c) => !ids.has(c.id))];
  }

  async classTitles() {
    const titles = { ...KIND_CLASS_TITLES, '*': 'Все ассеты' };
    for (const c of await this.classRules()) titles[c.id] = c.title || c.id;
    return titles;
  }

  /**
   * Class of an asset: an explicit override (run body `assetClass`), then profile.class of the
   * passport, then the first matching rule, then the kind. Returns {id, title, from}.
   */
  async classify(manifest, override = null) {
    return classifyWith(await this.classRules(), await this.classTitles(), manifest, override);
  }

  /**
   * Journal lines keep the class they were written with; a class found by a rule or by the kind is
   * found again with the current rules (an edited rule applies to old runs too). A class given by
   * the passport or the run stays.
   */
  async _reclassifier() {
    const rules = await this.classRules();
    const titles = await this.classTitles();
    const cache = new Map();
    return (r) => {
      if (r.classFrom === 'profile' || r.classFrom === 'run' || !r.assetName) return r;
      const key = `${r.kind}|${r.assetName}`;
      if (!cache.has(key)) cache.set(key, classifyWith(rules, titles, { name: r.assetName, kind: r.kind }));
      const c = cache.get(key);
      return c.id === r.class && c.from === r.classFrom ? r : { ...r, class: c.id, classFrom: c.from };
    };
  }

  // ---------------------------------------------------------------- journal

  /** Journal line of a finished step of a job (pure: no I/O). */
  runRecord(job, s, { source = 'live' } = {}) {
    const result = s.result || {};
    const checks = compactChecks(result.checks);
    const failed = checks.filter((c) => !c.ok && c.severity === 'error').map((c) => c.name);
    const variant = variantOf(s.step, s.params);
    const previews = previewPaths(result.outputs).map((p) => ({ path: p, url: this.fileUrl(job.assetId, p) }));
    return {
      v: 1,
      type: 'run',
      id: `${job.id}:${s.index}`,
      at: s.finishedAt || job.finishedAt || now(),
      startedAt: s.startedAt || null,
      seconds: seconds(s.startedAt, s.finishedAt),
      jobId: job.id,
      jobType: job.type || 'run',
      batchId: job.batchId || null,
      assetId: job.assetId || null,
      assetName: job.assetName || null,
      kind: job.assetKind || null,
      class: job.assetClass || job.assetKind || null,
      classFrom: job.classFrom || null,
      version: job.version || null,
      index: s.index,
      step: s.step,
      variant,
      stepKey: stepKeyOf(s.step, variant),
      status: s.status,
      params: s.params || {},
      recipe: s.recipe || null,
      checks,
      failed,
      error: s.status === 'completed' ? null : (result.error ? String(result.error).slice(0, 600) : (s.message || null)),
      previews,
      renderSeconds: typeof result.seconds === 'number' ? result.seconds : null,
      warnings: (s.warnings || []).slice(0, 10).map((w) => String(w).slice(0, 300)),
      host: job.host || null,
      source,
    };
  }

  /** Engine hook: one finished step -> one journal line. Never throws (learning must not stop work). */
  async recordRun(job, s) {
    if (!job?.assetId || !s || !['completed', 'failed'].includes(s.status)) return null;
    try {
      if (!(await this.journalingOn())) return null;   // About -> Learning is off: nothing is recorded
      const rec = this.runRecord(job, s);
      await this.journal.append(rec);
      return rec;
    } catch (err) {
      console.warn('[forge-learn] journal write failed:', err?.message || err);
      return null;
    }
  }

  fileUrl(assetId, abs) {
    if (!this.assetsDir || !isUuid(assetId) || typeof abs !== 'string') return null;
    const dir = path.join(this.assetsDir, assetId.toLowerCase());
    const rel = path.relative(dir, path.resolve(abs));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return `${this.urlBase}/assets/${assetId}/files/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
  }

  /** Journal runs, one per step run (the latest line of an id wins), newest first. */
  async runs({ assetId, version, cls, step, stepKey, limit } = {}) {
    const byId = new Map();
    for (const r of await this.journal.read()) if (r?.type === 'run' && r.id) byId.set(r.id, r);
    let list = [...byId.values()].map(await this._reclassifier());
    if (assetId) list = list.filter((r) => r.assetId === assetId);
    if (version) list = list.filter((r) => r.version === version);
    if (cls) list = list.filter((r) => r.class === cls);
    if (step) list = list.filter((r) => r.step === step);
    if (stepKey) list = list.filter((r) => r.stepKey === stepKey);
    list.sort((a, b) => String(b.at).localeCompare(String(a.at)) || (b.index || 0) - (a.index || 0));
    return Number.isInteger(limit) && limit > 0 ? list.slice(0, limit) : list;
  }

  /**
   * Import finished steps of job records (<library>/jobs) that the journal does not have yet: runs
   * made before the journal existed, or by a studio process with older code; then the review
   * decisions already stored in passports (qa.decision) that have no verdict yet. Idempotent.
   */
  async sync({ jobsDir = this.jobsDir, since = null } = {}) {
    const runs = await this._syncRuns({ jobsDir, since });
    const decisions = await this._syncDecisions();
    return { ...runs, decisions, feedback: this.feedback.file };
  }

  /**
   * A decision of the review card made before the journal existed (or by an older studio) becomes
   * a verdict of the version that existed at the time of the decision.
   */
  async _syncDecisions() {
    if (!this.assetsDir) return 0;
    // newest verdict per asset: a passport decision not newer than it is already in the journal (the
    // review hook and the feedback mirror write both within milliseconds)
    const newest = new Map();
    for (const f of await this.feedback.read()) {
      if (f?.type === 'feedback' && (!newest.has(f.assetId) || String(f.at) > newest.get(f.assetId))) newest.set(f.assetId, String(f.at));
    }
    let names = [];
    try { names = await fs.readdir(this.assetsDir); } catch { names = []; }
    const add = [];
    for (const name of names) {
      if (!isUuid(name)) continue;
      const m = await readJson(path.join(this.assetsDir, name, 'asset.json'), null).catch(() => null);
      const verdict = VERDICT_OF_DECISION[m?.qa?.decision];
      if (!m?.id || !verdict) continue;
      const at = m.qa.at || m.qa.reviewedAt || m.updated || null;
      if (!at || (newest.has(m.id) && newest.get(m.id) >= String(at))) continue;
      const versions = (m.versions || []).filter((v) => v?.version);
      const then = versions.filter((v) => !v.createdAt || String(v.createdAt) <= String(at));
      const version = (then.length ? then : versions).map((v) => v.version).pop();
      if (!version) continue;
      const comment = String(m.qa.comment || '').trim().slice(0, 2000);
      const cls = await this.classify(m);
      add.push({
        v: 1, type: 'feedback', id: randomUUID(), at, group: null,
        assetId: m.id, assetName: m.name || null, kind: m.kind || null, class: cls.id,
        version, step: null, verdict, rating: null, tags: verdict === 'accepted' ? [] : tagsFromText(comment), comment,
        by: 'owner', source: 'review-import',
      });
    }
    add.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    await this.feedback.append(add);
    return add.length;
  }

  async _syncRuns({ jobsDir = this.jobsDir, since = null } = {}) {
    if (!jobsDir) throw learnError('The library has no jobs folder.', 400, 'no_library');
    if (!(await this.journalingOn())) return { scanned: 0, added: 0, journal: this.journal.file, skipped: 'journaling is off (About -> Learning)' };
    const known = new Set((await this.journal.read()).filter((r) => r?.type === 'run').map((r) => r.id));
    let names = [];
    try { names = await fs.readdir(jobsDir); } catch { names = []; }
    const manifests = new Map();
    const manifestOf = async (id) => {
      if (!manifests.has(id)) manifests.set(id, isUuid(id) && this.assetsDir ? await readJson(path.join(this.assetsDir, id.toLowerCase(), 'asset.json'), null).catch(() => null) : null);
      return manifests.get(id);
    };
    const add = [];
    let scanned = 0;
    for (const name of names) {
      if (!name.endsWith('.json') || !isUuid(name.slice(0, -5))) continue;
      const job = await readJson(path.join(jobsDir, name), null).catch(() => null);
      if (!job?.id || !isUuid(job.assetId) || !Array.isArray(job.steps)) continue;
      if (since && String(job.createdAt || '') < since) continue;
      scanned += 1;
      const fresh = job.steps.filter((s) => s && ['completed', 'failed'].includes(s.status) && !known.has(`${job.id}:${s.index}`));
      if (!fresh.length) continue;
      const m = await manifestOf(job.assetId);
      const cls = job.assetClass ? { id: job.assetClass, from: job.classFrom || null } : await this.classify(m || { kind: 'prop' });
      const ctx = { ...job, assetName: job.assetName || m?.name || null, assetKind: job.assetKind || m?.kind || null, assetClass: cls.id, classFrom: cls.from };
      for (const s of fresh) add.push(this.runRecord(ctx, s, { source: 'sync' }));
    }
    add.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    await this.journal.append(add);
    return { scanned, added: add.length, journal: this.journal.file };
  }

  // ---------------------------------------------------------------- feedback

  async feedbackList({ assetId, version } = {}) {
    let list = (await this.feedback.read()).filter((f) => f?.type === 'feedback');
    if (assetId) list = list.filter((f) => f.assetId === assetId);
    if (version) list = list.filter((f) => f.version === version);
    return list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  /**
   * Validate a verdict and store it. `targets` [{assetId, version}] gives one verdict to several
   * versions at once (a whole batch); otherwise assetId (+ version, default: the latest version that
   * has runs, else the latest version of the passport).
   * @param {object} input {assetId, version?, step?, verdict, rating?, tags?, comment?, by?, source?, targets?}
   * @param {{manifestOf?: (id:string) => Promise<object|null>}} [ctx]
   * @returns {Promise<object[]>} stored records
   */
  async addFeedback(input = {}, ctx = {}) {
    if (!input || typeof input !== 'object') throw learnError('A verdict needs assetId and verdict.', 400, 'bad_request');
    const verdict = normalizeVerdict(input.verdict);
    if (!verdict) throw learnError('verdict: accepted, rework, rejected or cleared («принято», «доработка», «брак», «снять»).', 400, 'validation');
    let rating = null;
    if (input.rating !== undefined && input.rating !== null && input.rating !== '') {
      rating = Number(input.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw learnError('rating is an integer from 1 to 5.', 400, 'validation');
    }
    const comment = String(input.comment ?? '').trim();
    if (comment.length > 2000) throw learnError('A comment is up to 2000 characters.', 400, 'validation');
    const tags = normalizeTags(input.tags);
    // a defect named in the comment of a rejection becomes a tag (praise names no defect)
    if (verdict === 'rejected' || verdict === 'rework') for (const t of tagsFromText(comment)) if (!tags.includes(t)) tags.push(t);
    const step = input.step === undefined || input.step === null || input.step === '' ? null : String(input.step);
    if (step && !getStep(step)) throw learnError(`Unknown step "${step}".`, 400, 'unknown_step');
    const by = String(input.by || 'owner').trim().slice(0, 60) || 'owner';
    const source = String(input.source || 'api').trim().slice(0, 20) || 'api';
    const targets = Array.isArray(input.targets) && input.targets.length ? input.targets : [{ assetId: input.assetId, version: input.version }];
    if (targets.length > 500) throw learnError('No more than 500 versions in one verdict.', 400, 'validation');
    const manifestOf = ctx.manifestOf || ((id) => (this.assetsDir ? readJson(path.join(this.assetsDir, id.toLowerCase(), 'asset.json'), null) : null));
    const group = targets.length > 1 ? randomUUID() : null;
    const at = now();
    const records = [];
    for (const t of targets) {
      if (!isUuid(t?.assetId)) throw learnError('assetId is a forge asset UUID.', 400, 'bad_id');
      const m = await manifestOf(t.assetId).catch(() => null);
      if (!m) throw learnError(`Asset ${t.assetId} not found.`, 404, 'not_found');
      let version = t.version ? String(t.version) : null;
      if (version && !/^v\d{3,}$/.test(version)) throw learnError('version looks like v003.', 400, 'validation');
      if (!version) {
        const runs = await this.runs({ assetId: m.id, limit: 1 });
        version = runs[0]?.version || (m.versions || []).map((v) => v?.version).filter(Boolean).pop() || null;
      }
      if (!version) throw learnError(`Asset "${m.name}" has no versions yet: there is nothing to attach a verdict to.`, 409, 'no_version');
      const cls = await this.classify(m);
      records.push({
        v: 1, type: 'feedback', id: randomUUID(), at, group,
        assetId: m.id, assetName: m.name || null, kind: m.kind || null, class: cls.id,
        version, step, verdict, rating, tags, comment, by, source,
      });
    }
    await this.feedback.append(records);
    return records;
  }

  // ---------------------------------------------------------------- recipes

  /**
   * Group the journal by class and step (with variant), score each set of params by the verdicts of
   * its runs, and pick the best set (the recipe) and the rejected ones (the pitfalls).
   */
  async analysis() {
    const runs = await this.runs();
    const feedback = (await this.feedbackList()).slice().reverse(); // oldest first: the last one wins
    const titles = await this.classTitles();
    const knowledge = await this.knowledge();
    return analyzeRecords({ runs, feedback, titles, knowledge });
  }

  /** Recipes, pitfalls, pins and notes of one class (or all classes). */
  async recipes({ cls = null } = {}) {
    const a = await this.analysis();
    const keep = (c) => !cls || c === cls || c === '*';
    return {
      class: cls,
      files: this.files,
      runs: a.runs,
      feedback: a.feedback,
      groups: a.groups.filter((g) => keep(g.class)),
      pinned: a.pinned.filter((p) => keep(p.class)),
      notes: a.notes.filter((n) => keep(n.class)),
      titles: a.titles,
    };
  }

  /**
   * Layers of known params for one step of an asset of class `cls` (kind `kind`), most general
   * first: '*', then the asset kind, then the class; at each level the journal recipe first and the
   * pinned recipe after it (a later layer wins its keys). The shared community layer of the shipped
   * Windows studio is excluded on this branch (EXCLUDED.md): this studio's own experience is the
   * floor here.
   */
  _layers(analysis, cls, kind, stepKey) {
    const chain = ['*', ...(kind && kind !== cls ? [kind] : []), cls];
    const layers = [];
    for (const level of chain) {
      const journal = analysis.groups.find((g) => g.class === level && g.stepKey === stepKey)?.best;
      if (journal) {
        layers.push({
          class: level, from: 'journal', params: journal.params,
          evidence: { accepted: journal.accepted, rework: journal.rework, rejected: journal.rejected, runs: journal.runs, score: journal.score, lastAt: journal.lastAt },
        });
      }
      const pin = analysis.pinned.find((p) => p && p.class === level && stepKeyOf(p.step, p.variant || '') === stepKey);
      if (pin && pin.params && typeof pin.params === 'object') {
        layers.push({ class: level, from: 'pinned', params: pin.params, note: pin.note || null, by: pin.by || null, at: pin.at || null });
      }
    }
    return layers;
  }

  /**
   * Fill the params the caller did not give from the class recipe. Mutates `steps` ([{step, params}]
   * after normalizeSteps: params are the explicit ones) and marks each touched step with `recipe`.
   * @returns {Promise<{class:{id,title,from}, applied:object[], notes:string[]}>}
   */
  async applyRecipes(steps, manifest, { assetClass = null, enabled = true } = {}) {
    const cls = await this.classify(manifest, assetClass);
    const notes = [];
    const applied = [];
    if (!enabled) return { class: cls, applied, notes: ['Class recipes are turned off for this run (recipes: false).'] };
    const analysis = await this.analysis();
    for (const [i, s] of steps.entries()) {
      const def = getStep(s.step);
      if (!def || def.scope === 'library') continue;
      const variant = variantOf(s.step, s.params);
      const key = stepKeyOf(s.step, variant);
      const layers = this._layers(analysis, cls.id, manifest?.kind, key);
      if (!layers.length) continue;
      const merged = {};
      const from = {};
      for (const layer of layers) {
        for (const [k, v] of Object.entries(recipeParams(s.step, layer.params))) {
          merged[k] = v;
          from[k] = `${layer.class}:${layer.from}`;
        }
      }
      const add = {};
      for (const [k, v] of Object.entries(merged)) {
        if (k === 'profile') continue; // the variant is the caller's choice, never switched by a recipe
        if (Object.prototype.hasOwnProperty.call(s.params || {}, k)) continue; // explicit and preset params win
        add[k] = v;
      }
      if (!Object.keys(add).length) continue;
      let next;
      try {
        next = normalizeParams(s.step, { ...(s.params || {}), ...add }).explicit;
      } catch (err) {
        notes.push(`The recipe of class "${cls.title}" for step "${s.step}" did not fit the step registry and was skipped: ${err.message}`);
        continue;
      }
      s.params = next;
      const info = {
        index: i + 1, step: s.step, variant, stepKey: key, class: cls.id,
        params: add, from: Object.fromEntries(Object.keys(add).map((k) => [k, from[k]])),
        layers: layers.map(({ params, ...rest }) => rest), // eslint-disable-line no-unused-vars
      };
      s.recipe = info;
      applied.push(info);
      const pairs = Object.entries(add).map(([k, v]) => `${k}=${fmtValue(v)}`).join(', ');
      notes.push(`Class recipe "${cls.title}" for "${stepTitle(s.step)}"${variant ? ` (${variant})` : ''}: ${pairs}.`);
    }
    return { class: cls, applied, notes };
  }

  // ---------------------------------------------------------------- hand-kept knowledge

  /** Pin a recipe (the owner's settled params) for a class and step; null params remove the pin. */
  async pin({ cls, step, variant = '', params, note = '', by = 'owner' } = {}) {
    const id = String(cls ?? '').trim().toLowerCase();
    if (id !== '*' && !CLASS_ID.test(id)) throw learnError('class is a class id (zombie, weapon...) or "*" for every class.', 400, 'bad_class');
    if (!getStep(step)) throw learnError(`Unknown step "${step}".`, 400, 'unknown_step');
    const v = String(variant || '');
    let clean = null;
    if (params !== null && params !== undefined) {
      if (typeof params !== 'object' || Array.isArray(params)) throw learnError('params must be an object.', 400, 'bad_params');
      clean = recipeParams(step, params);
      if (!Object.keys(clean).length) throw learnError('params hold no recipe parameters (paths, clips and sizes do not belong to a recipe).', 400, 'bad_params');
      normalizeParams(step, clean); // throws a bad_params error on a wrong value
    }
    return this._editKnowledge((k) => {
      k.pinned = k.pinned.filter((p) => !(p.class === id && p.step === step && String(p.variant || '') === v));
      if (clean) k.pinned.push({ class: id, step, variant: v, params: clean, note: String(note || '').slice(0, 2000), by: String(by || 'owner').slice(0, 60), at: now() });
    });
  }

  /** A note for a class: the production route that works or a known pitfall, in plain words. */
  async addNote({ cls, text, kind = 'pitfall', by = 'owner', steps = [] } = {}) {
    const id = String(cls ?? '').trim().toLowerCase();
    if (id !== '*' && !CLASS_ID.test(id)) throw learnError('class is a class id or "*".', 400, 'bad_class');
    const body = String(text ?? '').trim();
    if (!body || body.length > 3000) throw learnError('A note is from 1 to 3000 characters.', 400, 'validation');
    if (!['pitfall', 'route', 'tip'].includes(kind)) throw learnError('kind: pitfall, route or tip.', 400, 'validation');
    const list = (Array.isArray(steps) ? steps : []).map(String).filter((s) => getStep(s));
    const note = { id: randomUUID(), class: id, kind, text: body, steps: list, by: String(by || 'owner').slice(0, 60), at: now() };
    await this._editKnowledge((k) => { k.notes.push(note); });
    return note;
  }

  async removeNote(noteId) {
    let removed = false;
    await this._editKnowledge((k) => {
      const before = k.notes.length;
      k.notes = k.notes.filter((n) => n.id !== noteId);
      removed = k.notes.length !== before;
    });
    if (!removed) throw learnError('Note not found.', 404, 'not_found');
    return { ok: true };
  }

  /** Add or replace a class rule (knowledge.json classes). */
  async setClassRule({ id, title, match, kinds = [] } = {}) {
    const cid = String(id ?? '').trim().toLowerCase();
    if (!CLASS_ID.test(cid)) throw learnError('A class id uses latin letters, digits, "_" and "-".', 400, 'bad_class');
    try { new RegExp(String(match), 'i'); } catch { throw learnError('match is a regular expression over the asset name.', 400, 'validation'); }
    const rule = { id: cid, title: String(title || cid).slice(0, 80), match: String(match), kinds: (kinds || []).filter((k) => KINDS.includes(k)) };
    await this._editKnowledge((k) => { k.classes = [...k.classes.filter((c) => c.id !== cid), rule]; });
    return rule;
  }

  // ---------------------------------------------------------------- views

  /**
   * Asset versions for the review journal: runs grouped by asset version with previews, checks and
   * the latest verdict, newest first.
   */
  async versions({ cls, step, assetId, limit = 60, pending = false } = {}) {
    const runs = await this.runs({ cls, step, assetId });
    const feedback = await this.feedbackList({ assetId });
    const byVersion = new Map();
    for (const r of runs) {
      const k = `${r.assetId}|${r.version}`;
      if (!byVersion.has(k)) {
        byVersion.set(k, {
          assetId: r.assetId, assetName: r.assetName, kind: r.kind, class: r.class, version: r.version, at: r.at,
          steps: [], previews: [], recipe: false, feedback: [],
        });
      }
      const v = byVersion.get(k);
      v.steps.push({
        index: r.index, step: r.step, title: stepTitle(r.step), variant: r.variant, status: r.status,
        checks: r.checks.length, failed: r.failed, seconds: r.seconds, recipe: r.recipe ? { params: r.recipe.params, from: r.recipe.from } : null,
      });
      if (r.recipe) v.recipe = true;
      for (const p of r.previews || []) if (p.url && v.previews.length < 4 && !v.previews.includes(p.url)) v.previews.push(p.url);
      if (String(r.at) > String(v.at)) v.at = String(r.at);
    }
    for (const f of feedback) {
      const v = byVersion.get(`${f.assetId}|${f.version}`);
      if (v) v.feedback.push(f);
    }
    let list = [...byVersion.values()].map((v) => {
      v.steps.sort((a, b) => a.index - b.index);
      const last = v.feedback[0] && v.feedback[0].verdict !== 'cleared' ? v.feedback[0] : null;
      return { ...v, verdict: last ? { verdict: last.verdict, rating: last.rating, tags: last.tags, comment: last.comment, by: last.by, at: last.at, step: last.step } : null, feedback: v.feedback.slice(0, 5) };
    });
    if (pending) list = list.filter((v) => !v.verdict);
    list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { total: list.length, items: list.slice(0, Math.max(1, Math.min(500, limit))) };
  }

  /** Classes seen in the journal with counts, the tag catalogue and the files. */
  async overview() {
    const a = await this.analysis();
    const runs = await this.runs();
    const classes = new Map();
    for (const r of runs) {
      if (!classes.has(r.class)) classes.set(r.class, { id: r.class, title: a.titles[r.class] || r.class, runs: 0, steps: new Set() });
      const c = classes.get(r.class);
      c.runs += 1;
      c.steps.add(r.stepKey);
    }
    return {
      files: this.files,
      journaling: (await this.knowledge()).journaling,
      runs: a.runs,
      feedback: a.feedback,
      classes: [...classes.values()].map((c) => ({
        ...c, steps: [...c.steps].sort(),
        recipes: a.groups.filter((g) => g.class === c.id && g.best).length + a.pinned.filter((p) => p.class === c.id).length,
        pitfalls: a.groups.filter((g) => g.class === c.id).reduce((n, g) => n + g.pitfalls.length, 0) + a.notes.filter((n) => n.class === c.id && n.kind === 'pitfall').length,
      })).sort((x, y) => y.runs - x.runs),
      tags: DEFECT_TAGS.map(({ id, title, steps }) => ({ id, title, steps })),
      verdicts: VERDICTS.map((id) => ({ id, title: VERDICT_TITLES[id] })),
      rules: await this.classRules(),
    };
  }

  /** Markdown digest of recipes, pitfalls and notes for references/recipes.md. */
  async digest({ cls = null } = {}) {
    const r = await this.recipes({ cls });
    const lines = [];
    const title = (id) => r.titles[id] || id;
    lines.push('# Рецепты Кузницы по классам ассетов', '');
    lines.push(`Сводка журнала производства \`${r.files.dir}\`: запусков шагов — ${r.runs}, отзывов — ${r.feedback}. ` +
      `Собрано \`node scripts/forge.mjs learn digest\` ${fmtDate(now())}. Рецепт заполняет только те параметры, которых нет в запуске; ` +
      'явные параметры и параметры пресета главнее. Подробно — `docs/forge/LEARN.md`.', '');
    const said = (g) => g.best || g.pitfalls.length; // a group with a recipe or something rejected
    const classes = [...new Set([...r.pinned.map((p) => p.class), ...r.groups.filter(said).map((g) => g.class), ...r.notes.map((n) => n.class)])]
      .sort((a, b) => (a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b)));
    if (!classes.length) lines.push('Журнал пока пуст: рецептов нет.', '');
    for (const c of classes) {
      lines.push(`## ${c === '*' ? 'Все классы' : title(c)} (\`${c}\`)`, '');
      for (const n of r.notes.filter((x) => x.class === c && x.kind === 'route')) lines.push(`- **Путь:** ${n.text}`);
      for (const n of r.notes.filter((x) => x.class === c && x.kind === 'tip')) lines.push(`- **Совет:** ${n.text}`);
      for (const n of r.notes.filter((x) => x.class === c && x.kind === 'pitfall')) lines.push(`- **Грабли:** ${n.text}`);
      if (r.notes.some((x) => x.class === c)) lines.push('');
      for (const p of r.pinned.filter((x) => x.class === c)) {
        lines.push(`### ${stepTitle(p.step)}${p.variant ? ` · ${p.variant}` : ''} (\`${stepKeyOf(p.step, p.variant)}\`) — закреплён`, '');
        lines.push(`\`${JSON.stringify(p.params)}\`${p.note ? ` — ${p.note}` : ''} (${p.by || 'owner'}, ${fmtDate(p.at)})`, '');
      }
      const unjudged = [];
      for (const g of r.groups.filter((x) => x.class === c)) {
        if (!g.best && !g.pitfalls.length) continue;
        if (!g.verdicts.accepted && !g.verdicts.rework && !g.verdicts.rejected) {
          // no verdicts yet: only runs stopped by their own red checks — one line, not a recipe section
          unjudged.push(`\`${g.stepKey}\` ×${g.pitfalls.reduce((n, p) => n + p.checksFailed, 0)}`);
          continue;
        }
        lines.push(`### ${g.stepTitle}${g.variant ? ` · ${g.variant}` : ''} (\`${g.stepKey}\`)`, '');
        lines.push(`Запусков ${g.runs}; принято ${g.verdicts.accepted}, на доработку ${g.verdicts.rework}, брак ${g.verdicts.rejected}.`, '');
        if (g.best) {
          lines.push(`**Рецепт** (принято ${g.best.accepted}, брак ${g.best.rejected}, балл ${g.best.score}, последний ${fmtDate(g.best.lastAt)}; ` +
            `примеры: ${g.best.examples.map((e) => `${e.assetName} ${e.version}`).join(', ') || '—'}):`, '');
          lines.push('```json', JSON.stringify(g.best.params), '```', '');
        } else {
          lines.push('Принятого рецепта пока нет — только брак.', '');
        }
        if (g.pitfalls.length) {
          lines.push('**Грабли** (так делать не надо):');
          for (const p of g.pitfalls.slice(0, 6)) {
            const what = p.diff.length
              ? p.diff.map((d) => `\`${d.key}\` ${d.unset ? 'не задан (умолчание шага)' : fmtValue(d.value)}${d.recipeUnset ? '' : ` вместо ${fmtValue(d.recipe)}`}`).join(', ')
              : `\`${JSON.stringify(p.params)}\``;
            const verdicts = [p.rejected ? `брак ×${p.rejected}` : '', p.rework ? `доработка ×${p.rework}` : '', p.checksFailed ? `красные проверки ×${p.checksFailed}` : ''].filter(Boolean).join(', ');
            const blind = p.blind && p.blind >= p.rejected + p.rework ? ' (вердикт без шага и причины — виноват ли этот шаг, неизвестно)' : '';
            const why = (p.tags.length ? `: ${p.tags.map((t) => t.title).join(', ')}` : '') + blind;
            const saidHere = p.comments.length ? ` — «${p.comments[0].length > 220 ? `${p.comments[0].slice(0, 220)}…` : p.comments[0]}»` : '';
            lines.push(`- ${what} — ${verdicts}${why}${saidHere}`);
          }
          lines.push('');
        }
      }
      if (unjudged.length) {
        lines.push(`Вердиктов ещё нет; запуски останавливались красными проверками: ${unjudged.join(', ')} ` +
          `(подробно — \`learn recipes --class ${c}\`).`, '');
      }
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }
}

/** Step titles for UI selects (steps that work on an asset). */
export function learnStepList() {
  return listSteps().filter((s) => s.scope !== 'library').map((s) => ({ step: s.step, title: s.title, variants: s.params.profile?.enum || null }));
}

export { learnError };
