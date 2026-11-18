// The review model - the local vision model that looks at a texture pass or an animation frame
// (docs/product/ollama.md, 0.6.x wave ticket 14; the loop that consumes it is ticket 08, and the
// paint step already reads IMAGINARIUM_QA_VLM in scripts/blender/steps/_paint_qa.py).
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
 * IMAGINARIUM_REVIEW_VLM overrides everything. When nothing from the tier list is installed, any
 * installed vision model is used (an older qwen3-vl after an upgrade is still a working model),
 * and only then comes the honest "not installed" reason naming the installer row.
 */
export function pickReviewModel(vramMiB, installed = [], env = process.env, chosen = '') {
  const names = installed.map(String);
  const resolve = (m) => names.find((n) => n === m || n === m + ':latest') || null;
  if (env.IMAGINARIUM_REVIEW_VLM) {
    const m = String(env.IMAGINARIUM_REVIEW_VLM);
    return { model: resolve(m) || m, wanted: m, installed: !!resolve(m), reason: 'IMAGINARIUM_REVIEW_VLM' };
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
/**
 * Ask the installed vision model about pictures (the style describe, ticket 08 later too). This
 * function only talks: the model must already be on this machine (the caller picks it), `think` is
 * forced off because the drafts must arrive as plain answers, and a failure surfaces as a sentence.
 * Returns the answer text.
 */
export async function vlmAsk({ url, model, prompt, images = [], fetchFn = fetch, timeoutMs = 180000, numPredict = 700 } = {}) {
  if (!url || !model) throw new Error('vlmAsk needs a url and a model that is installed here.');
  const send = async (think) => {
    let answer;
    try {
      answer = await fetchFn(String(url).replace(/\/+$/, '') + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, stream: false, think, keep_alive: 0,
          messages: images.length ? [{ role: 'user', content: prompt, images }] : [{ role: 'user', content: prompt }],
          options: { num_ctx: 16384, num_predict: think ? Math.max(numPredict, 3000) : numPredict },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) { throw new Error(`The vision model did not answer (${e.name === 'TimeoutError' ? 'too slow' : e.code || e.message}) - the pictures may need a bigger model.`); }
    if (!answer.ok) throw new Error(`The vision model answered ${answer.status}: ${String(await answer.text().catch(() => '')).slice(0, 160)}`);
    return answer.json().catch(() => null);
  };
  // `think: false` is forced because drafts must arrive as plain answers - but some models reason
  // anyway (qwen3-vl under ollama 0.40 ignores the flag and fills message.thinking, leaving
  // content empty). When that happens, a second request with reasoning ON and a budget big enough
  // to finish it returns the real answer; a model that answered nothing twice is honestly no answer.
  let v = await send(false);
  let text = String(v?.message?.content || '').trim();
  const thought = String(v?.message?.thinking || '').trim();
  if (!text && thought) { v = await send(true); text = String(v?.message?.content || '').trim(); }
  if (!text) throw new Error('The vision model answered with an empty text - try once more or add clearer references.');
  return text;
}

const HAND_SET = String(process.env.IMAGINARIUM_QA_VLM || '').trim();
export function publishQaModel(pick, env = process.env, handSet = HAND_SET) {
  if (handSet) return { published: false, model: String(env.IMAGINARIUM_QA_VLM || handSet).trim(), reason: 'IMAGINARIUM_QA_VLM is set by hand' };
  if (pick?.installed) { env.IMAGINARIUM_QA_VLM = pick.model; return { published: true, model: pick.model, reason: '' }; }
  if (env.IMAGINARIUM_QA_VLM) delete env.IMAGINARIUM_QA_VLM;
  return { published: false, model: null, reason: pick?.reason || 'no vision model installed' };
}
