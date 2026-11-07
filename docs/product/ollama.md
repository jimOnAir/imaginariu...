# Ollama that runs itself — and models this machine actually has

Branch: `linux-support`, 0.6.x reintroduction wave, tickets 14 (0.6.5 + 0.6.6 facts). The assistant
and the texture/animation review step stop assuming: after an install or a reboot the studio starts
Ollama itself, and every model it talks to is one that is actually on this disk — never a download,
never a name nobody pulled.

## The problem this solves

A fresh install or a reboot leaves Ollama configured but silent, and the studio used to answer
"Ollama not connected" and wait for the user to fix it. Worse, the assistant asked Ollama for one
hard-coded model name; on a machine that had some other model installed the reply was an error, and
the old shipped default was a model most users do not have at all.

## What the studio does now

**Boot.** `server/index.mjs` calls `ensureOllama()` (in `server/ollama-run.mjs`) for the configured
address. If the local server is installed but silent, the studio spawns `ollama serve` (detached,
one attempt per address at a time — concurrent callers wait for the same start) and waits up to 20 s
for `/api/tags` to answer. Auto-start is only ever for `http://127.0.0.1:11434` (or `localhost`):
an Ollama at another address belongs to somebody else's setup, so the studio probes it and says so
instead of starting a process. The background path never blocks a request, and `ASTRA_ENGINE_AUTOSTART=0`
or a test context turns the whole mechanism off.

**Where the program is** (`ollamaExecutable`): `ASTRA_OLLAMA_EXE`, else `config/paths.json` (key
`ollama`, written by `installer/install.sh`), else the usual locations (`/usr/local/bin`,
`/usr/bin`, `~/.ollama/bin`), else `PATH`. First hit wins; no candidate is a guess — a dead path
from an older install is skipped.

**Which model answers the assistant** (`pickChatModel`): the configured model when it is installed
(a `name:latest` tag counts as the same model), otherwise the biggest model of the installer's own
recommendation table (`installer/manifest.json`, `llm.byVram`: qwen3:4b/8b/14b with the memory each
wants) that is installed and this card can hold, otherwise any installed text model. One table
decides both what the installer offers to pull and what the assistant asks for, so the assistant
never reaches for a model the same install could not have provided. The configured name being gone
never breaks a request. If the machine has only vision models (or none), the reply is a sentence
that points at Components → Assistant (LLM) and `installer/install.sh -Only llm` — never a crash,
never a silent fallback to a model that isn't there. The same rule applies inside every chat request
(`server/llm.mjs`): ensure → list → pick → talk.

**What is installed** (`ollamaCatalog`): every model from `/api/tags` with
`{name, size, family, params, vision}`. `vision` is Ollama's own answer — `POST /api/show` →
`capabilities` includes `"vision"` — cached per `name@digest`, asked in parallel with a 4 s budget
each; an Ollama that reports no capabilities falls back to a name pattern (`qwen*-vl`, `qwen3.5`,
`llava`, `vision`, `minicpm-v`, `moondream`, `gemma3`, `internvl`). Offline answers `null`, which is
not the same as an empty list.

## Choosing models in the UI

Connections → Local LLM has two lists instead of the old free-text field:

- **Assistant model** — the whole catalog;
- **Texture and animation review model** — the catalog filtered by `vision`.

Both start with **«Auto»**, which names the model Auto resolved (`Auto — qwen3:8b`), a configured
model that is missing from Ollama stays visible, marked *(not installed)*, and any installed version
can be made active — older generations included; saving re-resolves the picks immediately, no
restart. Under the lists one line says what Ollama has, with a `(vision)` mark, or points at the
Components row when there is nothing. Options read `name · params · size`. Config keys:
`ollamaModel` and `reviewModel`, both `''` = Auto (ticket 17's tolerant boot loader carries old
values across untouched).

## The review model (`server/vlm.mjs`)

The pick precedence, `pickReviewModel(vramMiB, installed, env, chosen)`:

1. `ASTRA_REVIEW_VLM` — a hand-set override, wins over everything;
2. the configured `reviewModel` when it is installed (any generation — this is the 0.6.6 rule: after
   an upgrade the previous vision model is still on disk and still useful);
3. the tier for this card: `qwen3.5:9b` at ≥ 11 GiB, `qwen3.5:4b` below;
4. the other tier entry and the fallback `qwen3-vl:8b` (what `installer/install.sh -Only vlm` pulls);
5. **any other installed vision model** — the reason says what was wanted and what it took instead;
6. nothing installed: the model is reported with `installed: false` and the reason names the
   installer row. No download, ever.

The resolved pick is published into `ASTRA_QA_VLM`, the variable the Blender paint-QA step
(`scripts/blender/steps/_paint_qa.py`) reads — a variable that was already in the studio's
environment at startup is the user's own and is never overwritten; when no vision model is usable
the published value is cleared so the step reports it instead of guessing.

`GET /api/status` carries it all under `ollama`: `{online, models, model, catalog, review,
starting}` — `model` is the resolved assistant, `review` is the full pick `{model, wanted,
installed, reason}`, `catalog` is `[]` when Ollama is offline, and `starting` tells the UI a local
server is coming up right now.

## What never happens here

- the studio does not download models — weights are the installer's (`-Only llm`, `-Only vlm`) or
  the user's (`ollama pull`);
- it does not kill or restart an Ollama it did not start;
- it does not spawn processes for non-loopback addresses;
- the tolerant boot loader never rewrites `data/config.json` — the file is cleaned by the next save.
