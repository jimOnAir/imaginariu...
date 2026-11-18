# Sound — effects and music loops, generated on this machine

Branch: `linux-support`, 0.6.x reintroduction wave, ticket 04. One new studio tab («Sound» / «Звук»)
that makes two kinds of audio locally: a **sound effect** from a sentence describing it, and a
**seamless music loop** of an exact number of bars for a game.

## What runs

| | effect | music loop |
|---|---|---|
| engine | MOSS-SoundEffect v2.0 (DiT 1.3B + Qwen3 text encoder + DAC VAE) | ACE-Step 1.5 (turbo DiT + 5 Hz LM + Qwen3 embedding + VAE) |
| vendor | OpenMOSS | ACE-Step |
| license | Apache-2.0 | MIT |
| code | pinned clone in `runtime/sound/src/MOSS-TTS` | pinned clone in `runtime/sound/src/ACE-Step-1.5` |
| weights | HF `OpenMOSS-Team/MOSS-SoundEffect-v2.0` @ `e35df4d8` | HF `ACE-Step/Ace-Step1.5` @ `19671f40` |
| output | 48 kHz mono WAV, 1–30 s | 48 kHz stereo WAV, 1–8 bars at 40–240 BPM |

Both live in one dedicated venv, `runtime/sound/.venv`, because each engine needs its own line of
`transformers`/`diffusers` and neither may reach into the ComfyUI or TripoSG environment. A task
spawns a worker subprocess (`scripts/sound/sound_run.py`) that prints `SOUND_PROGRESS`/
`SOUND_RESULT`/`SOUND_ERROR` lines, exactly like the TripoSG worker; the studio follows them and
lands the file in the library. `server/sound.mjs` is the whole server side. NVIDIA only: the card
has to be 8 GB or bigger (MOSS keeps the prompt encoder, the DiT and the DAC VAE one at a time in
memory, which is what makes a 12 GB card work at all).

`descript-audiotools` — the one dependency of the MOSS DAC VAE that pulls in a large tree — is not
installed. Its inference path uses two names from it (`AudioSignal` in annotations, and
`BaseModel` as the checkpoint loader), so the worker prepends a two-file local shim
(`scripts/sound/shim/audiotools`) that implements the weights loader and refuses to pretend that
it can read audio.

## Seamless loops

ACE-Step generates the loop length plus a short overhang; the overhang is then crossfaded into the
head of the file, so the sample at the end of the loop leads into the sample at the beginning.
The exported length is `bars × 4 × 60 / bpm` to the sample. The parameter is the bar count, not a
duration — a loop that does not land on the bar cannot be repeated by the game engine.

## The library and the trash

`data/sound/library` holds one record per sound: `<uuid>.wav` (the file the user made), `<uuid>.ogg`
(the playback companion, from libsndfile in the worker; `ffmpeg` fills it in later when it was not
there), and `<uuid>.json` (prompt, kind, seconds or bars/BPM, seed, engine, date). `index.json`
keeps the order.

**Removing a sound is a move, never a delete**: the three files go to `data/sound/trash`. The
studio has no code path that unlinks a generated sound. Bindings that point at a trashed sound stay
visible and say so; the sound is one move back.

## Event bindings

`data/sound/bindings.json` maps `{ assetId: { event: soundId } }`. Events are the branch's own set
(rendered through i18n): `footstep`, `run`, `jump`, `attack`, `hit`, `death`, `impact`, `spell`,
`ui_click`, `ambient`. The Sound tab binds a library sound to an event of the selected scene
object; ticket 05 exposes the same library to the AI tools.

## Exports carry no marks

A released WAV contains the `fmt ` and `data` RIFF chunks and nothing else. An OGG carries the
encoder's own banner (Xiph's vendor string, `ENCODER=libsndfile`) and no field naming this product
or the `afmk` chunk of the provenance machinery. Neither file names the product anywhere. That is
the branch policy for audio (Q5/Q11): the files are plain audio. `findAudioMarks()` in
`server/sound.mjs` is the check; `tests/sound.test.mjs` pins it against marked fixtures, and the
live demo files of ticket 04 pass it (`npm run`-free: `node --input-type=module -e ...`).

## Endpoints

`GET /api/sound/status` (install verdict + presets + events), `GET /api/sound/library`,
`GET /api/sound/library/:id/:wav|ogg`, `POST /api/sound/library/:id/ogg`,
`POST /api/sound/library/:id/trash`, `GET|PUT /api/sound/bindings`,
`POST /api/sound/tasks`, `GET /api/sound/tasks`, `GET /api/sound/tasks/:id`,
`POST /api/sound/tasks/:id/cancel`. The Sound row of `GET /api/status` says the same verdict for
the whole studio.

## Installing it

`installer/install.sh -Only sound` (then `-Only soundmoss` and `-Only soundace` for the two weight
sets — the checklist row ticks all three). Pins live in `installer/sound/manifest.json`: the two
commit-pinned code archives and every weight file with its size and sha256, downloaded by the same
`DownloadChecked` as everything else. The component is **new and never preselected**: no installer
preset contains the id (ticket 12 makes the rule visible in the checklist).

## Out of the branch, on purpose

Provenance/licensing machinery (the `afmk` chunk, OGG comment marks, `MODEL_LICENSES` rows, the
core manifest), the AMD/ROCm shim for the sound library, and the Windows frontends stay on the
Windows side — see `.scratch/imaginarium-060-reintroduction/spec.md`.
