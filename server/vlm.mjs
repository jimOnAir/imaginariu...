// The review model - the local vision model that looks at a texture pass or an animation frame
// (docs/product/ollama.md, 0.6.x wave ticket 14; the loop that consumes it is ticket 08, and the
// paint step already reads ASTRA_QA_VLM in scripts/blender/steps/_paint_qa.py).
//
// The rule is "use what is installed": the tier comes from the card, an older generation of a
// vision model is still a vision model, and nothing here ever downloads - weights are the
// installer's job (installer/install.sh -Only vlm) or the user's (`ollama pull`).
export const REVIEW_TIER_MIB = 11264;                       // 11 GiB: the line between the two Qwen3.5 tiers
export const REVIEW_MODELS = [
  { model: 'qwen3.5:9b', minVramMiB: REVIEW_TIER_MIB },     // Apache-2.0
  { model: 'qwen3.5:4b', minVramMiB: 0 },                   // Apache-2.0
];
export const FALLBACK_REVIEW_MODEL = 'qwen3-vl:8b';         // the row installer/install.sh -Only vlm pulls

/** Model names that carry vision - by family, older versions and forks included. */
export const isVisionModelName = (name) => /(qwen\d(\.\d)?[-_:]?vl|qwen3\.5|llava|vision|minicpm-v|moondream|gemma3|internvl)/i.test(String(name));

/**
 * {model, wanted, installed, reason} - what to review with on this card.
 * `chosen` is the user's pick from Connections → Local LLM (config.reviewModel, '' = auto);
 * ASTRA_REVIEW_VLM overrides everything. When nothing from the tier list is installed, any
 * installed vision model is used (an older qwen3-vl after an upgrade is still a working model),
 * and only then comes the honest "not installed" reason naming the installer row.
 */
export function pickReviewModel(vramMiB, installed = [], env = process.env, chosen = '') {
  const names = installed.map(String);
  const resolve = (m) => names.find((n) => n === m || n === m + ':latest') || null;
  if (env.ASTRA_REVIEW_VLM) {
    const m = String(env.ASTRA_REVIEW_VLM);
    return { model: resolve(m) || m, wanted: m, installed: !!resolve(m), reason: 'ASTRA_REVIEW_VLM' };
  }
  const pick = String(chosen || '').trim();
  if (pick) {
    const hit = resolve(pick);
    if (hit) return { model: hit, wanted: pick, installed: true, reason: 'chosen in Connections' };
  }
  const wanted = (REVIEW_MODELS.find((m) => (vramMiB || 0) >= m.minVramMiB) || REVIEW_MODELS.at(-1)).model;
  const alt = resolve(wanted);
  if (alt) return { model: alt, wanted, installed: true, reason: vramMiB ? `video memory ${Math.round(vramMiB / 1024)} GB` : 'the card is not read' };
  for (const m of [...REVIEW_MODELS.map((x) => x.model), FALLBACK_REVIEW_MODEL]) {
    const hit = resolve(m);
    if (hit) return { model: hit, wanted, installed: true, reason: `${wanted} is not installed - taking ${hit}` };
  }
  const other = names.find(isVisionModelName);
  if (other) return { model: other, wanted, installed: true, reason: `${wanted} is not installed - taking the installed ${other}` };
  return { model: wanted, wanted, installed: false, reason: `${wanted} is not installed: installer/install.sh -Only vlm (or ollama pull ${wanted})` };
}

/**
 * Publish the pick where the Blender steps read it. A variable that was already in the studio
 * process at startup is the user's own choice (shell profile, .env, wrapper) and is never
 * overwritten; with no usable model the variable we published is cleared, so the step says so
 * instead of guessing a model name.
 */
const HAND_SET = String(process.env.ASTRA_QA_VLM || '').trim();
export function publishQaModel(pick, env = process.env, handSet = HAND_SET) {
  if (handSet) return { published: false, model: String(env.ASTRA_QA_VLM || handSet).trim(), reason: 'ASTRA_QA_VLM is set by hand' };
  if (pick?.installed) { env.ASTRA_QA_VLM = pick.model; return { published: true, model: pick.model, reason: '' }; }
  if (env.ASTRA_QA_VLM) delete env.ASTRA_QA_VLM;
  return { published: false, model: null, reason: pick?.reason || 'no vision model installed' };
}
