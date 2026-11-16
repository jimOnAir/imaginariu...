// concept-llm.mjs - the one LLM step of the text-to-3D concept path (server/jobs.mjs).
// 0.7.9 fold wave ticket 60 item 6 (the 0.7.9 note): a Russian (any non-ASCII) description used to
// stop the job when no assistant is installed - "Ollama has no models" as if the studio could not
// draw at all, while SDXL reads the text as written just fine. The rule now: a missing or silent
// assistant never stops the job - the concept is drawn from the original text and the job records
// an honest note that English would be more accurate (the Assistant component adds translation).
// A live assistant that answers without a concept action is still the old honest error: that is a
// translation failure, not a missing feature. Aborts re-throw: cancellation is never a fallback.
// The module exists as its own file so the behavior is testable without the job engine (llm seam).

import { llmChat } from './llm.mjs';

/** {english, untranslated?} for a concept description; `note` receives the honest sentence when
 *  the assistant could not translate (it is the caller's job to record it on the job). */
export async function conceptEnglishText(prompt, { llm = llmChat, config = {}, signal, note = () => {} } = {}) {
  if (!/[^\x00-\x7F]/.test(prompt)) return { english: prompt };
  let response;
  try {
    response = await llm({ ...config, provider: 'ollama' }, {
      message: 'Translate the concept description into English for SDXL, keeping the meaning. Return a concept action with the English prompt. Description: ' + prompt,
      context: '', history: [],
    });
  } catch (e) {
    signal?.throwIfAborted();
    note('No assistant to translate the description (' + (e && e.message || e) + ') - drawing the concept from the text as written; an English description is more accurate (the Assistant component adds translation).');
    return { english: prompt, untranslated: true };
  }
  const english = response?.actions?.find((a) => a.type === 'concept')?.prompt;
  if (!english) throw new Error('The local LLM did not return an English concept. Click "Refine with AI" or use an English description.');
  return { english };
}
