# A custom OpenAI-compatible endpoint replaces the OpenAI and Anthropic connections

The studio shipped two hardcoded cloud adapters - OpenAI Chat Completions and Anthropic
Messages - each with its own key, model field and UI tab. Neither ever saw a live user key
(VALIDATION.md), while the requests users actually want to send go to a growing zoo of
OpenAI-compatible servers: OpenRouter, vLLM, LM Studio, Ollama's own OpenAI endpoint,
corporate proxies. One adapter plus a base URL covers all of them, and the studio stops
carrying protocol code for providers it does not test.

`provider: 'custom'` carries `customUrl` (a base URL up to the API root, any http(s) host,
`''` = not configured) and `customModel`; the key (vault provider `custom`, environment
`CUSTOM_LLM_API_KEY`) is optional because local servers routinely run without auth - the
request then simply carries no `Authorization` header. Calls go to
`{customUrl minus trailing slash}/chat/completions` with `response_format: json_object`,
retried once without it: a server that does not know the field fails that request, not the
chat, and the existing reply parser already tolerates plain text (no actions proposed).
Plain `http://` addresses are accepted on purpose - this is a local desktop app and the
user owns both the key and the endpoint - but the field note says plainly that such an
address carries the key unencrypted.

Retirement follows the existing rules, not new ones: `openaiModel`/`anthropicModel` get
sentences in the `RETIRED` map (ADR-0004) pointing at the Custom API tab, a saved
`provider: 'openai'` falls back to `ollama` by the per-field boot rule, and PUT /api/config
refuses the old values strictly. Vault entries the old providers left behind and
`OPENAI_API_KEY`/`ANTHROPIC_API_KEY` in an environment are left untouched but unread -
nothing is deleted, and a user who restores an older studio build finds their data as it
was.
