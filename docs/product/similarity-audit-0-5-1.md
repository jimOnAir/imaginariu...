# Retroactive similarity audit — the pre-existing tree vs the shipped payloads (ticket 09)

Authority: [ADR-0004](../adr/0004-protocol-v2-clean-room-and-attribution.md) — the branch commits
to a public, re-runnable audit of the history it shipped under the weaker ADR-0003 bar, and to
rewriting what the audit flags. This is that audit. It is evidence, not vibes: a deterministic
tool, frozen thresholds, a machine-readable evidence file beside this report.

**What was compared.** Every git-tracked text file of this repository (504 files after excluding
binaries, fonts, the lockfile and local scratch) against every text file of the quarantined
extracted payloads `0.4.16/`, `0.5.0/`, `0.5.1/`, `0.5.3/` (9 970 reference files) — the same
corpus the per-ticket audits of the 0.5.1 wave used. The work papers were excluded by default
(they are derivative change-reports and would inflate every legitimate overlap; `--papers` exists).
Direction of copying is not what this measures — identity is. Under the branch's own legal posture
(ADR-0004 preamble) any verbatim upstream expression inside a tree that claims MIT authorship must
either be rewritten or removed, whatever its provenance story.

**Method** (`scripts/audit/similarity-audit.mjs`, deterministic, zero LLM):
tokenize (lowercase words incl. Cyrillic; punctuation as tokens) → k=8 token shingles → public
shingle index (a shingle at >64 public positions counts as boilerplate and is not extended) →
stream every reference file, verify and extend every candidate match token-by-token → per public
file: longest verified contiguous shared run + 8-gram containment against its best-matching
reference. Bands, frozen here for all future runs of this tool:

| Band | Raw rule | Meaning |
|---|---|---|
| clean | shared run < 8 tokens | nothing to say |
| review | 8–39 tokens | classify: idiom / interface fact / HEAD-inheritance / expression |
| rewrite | ≥ 40 tokens, or containment ≥ 0.60, and not in an allowed class | disallowed shared expression — rewrite or remove |

Reproduce: `node scripts/audit/similarity-audit.mjs --out evidence.json` (heap flag recommended);
the committed evidence file is `similarity-audit-0-5-1.evidence.json` next to this report
(494 files with ≥8-token runs, each row: maxRun, containment, matching reference file, excerpt).

## Headline finding — the pre-existing tree is the 0.4.16 payload, not a re-derivation

`module` buckets at the v0.5.1 commit (files scanned / files with ≥8-token runs / worst run /
rewrite-band / review-band):

| Module | files | ≥8 | worst | rewrite | review |
|---|---:|---:|---:|---:|---:|
| scripts/blender | 79 | 79 | 35 973 | 78 | 1 |
| src (UI) | 70 | 70 | 3 794 | 67 | 3 |
| scripts (other) | 57 | 57 | 5 297 | 53 | 4 |
| root (docs, license files, vendored data) | 68 | 62 | 6 204 | 47 | 15 |
| docs | 45 | 43 | 13 087 | 40 | 3 |
| installer | 42 | 42 | 4 000 | 40 | 2 |
| ai (mcp + skills) | 35 | 35 | 7 262 | 34 | 1 |
| tests | 36 | 36 | 2 221 | 33 | 3 |
| server | 31 | 31 | 1 587 | 31 | 0 |
| unity (C#) | 16 | 16 | 3 078 | 16 | 0 |

Typical rows carry containment **1.00** — the tracked file is *the same file* as in the payload
(`scripts/blender/steps/ship_gen.py` shares a 35 973-token contiguous run with the 0.4.16 tree).
In plain terms: the 0.4.7→0.4.16 "re-introduction" (ADR-0003 era) did not re-derive the code; the
branch carries the extracted payload — code, docs, tests, installer scripts, MCP server, skills,
the C# importer. The ADR-0003 claim ("read as spec, write fresh") held for its artifacts rule but
not for the code, and the branch shipped an MIT header over it. That is the historical fact this
audit exists to state, and it is why ADR-0004 was written: everything after base commit `a3c959d`
(v0.5.0) is produced under the strict protocol with per-ticket audits.

Consequences, in order of honesty:

1. **The MIT grant over the pre-existing body cannot be honored as written** — this branch cannot
   confer MIT on expression it did not author. Until the rewrite campaign below lands, the public
   README's disclosure ("`v0.5.0` line produced under the earlier ADR-0003 bar") understates the
   situation; the amended README bullet added with this report points here.
2. **A module-by-module rewrite campaign is tracked now** — follow-up tickets `09a`…`09j` under
   `.scratch/imaginarium-051-reintroduction/issues/`, each with concrete acceptance criteria, each
   gated by the same per-ticket similarity audit, re-running this tool for evidence.
3. The alternative levers stay open and are the owner's call, not the tool's: an explicit blessing
   / relicensing from the rights holder (ticket 10), or removing the flagged bodies wholesale.

## Allowed classes (measured, named, justified)

These raw hits are **not** rewrite work; the classification belongs to the audit role (ADR-0004
decision 4), and the rows are in the evidence file under the same numbers:

| Class | Files | Why allowed |
|---|---:|---|
| Vendored third-party code under its own OSS license (`data/runtime/custom_nodes/ComfyUI-MVAdapter/**` — Apache-2.0 HF/diffusers-derived, incl. its LICENSE) | 22 | The match is against the payload's copy of the *same third-party* code (`engine/plugins/mvadapter/vendor/…`); both trees are license-compliant carriers. Disposition note: this runtime folder should not live in git at all — ticket `09i` (remove-from-tracking is a deletion decision → owner confirmation). Files `nodes.py`, `imagi_views.py` may be upstream-authored rather than HF — flagged inside `09i`. |
| Grandfathered verbatim artifacts: `installer/notes-0.4.*.txt` (16) | 16 | ADR-0003's explicit historical-record exception; ADR-0004 forbids new additions of this class. Kept as records, never extended. |
| The product's own license/terms texts: `COMMERCIAL-LICENSE.md`, `LICENSE-0.4.2.md`, `LICENSE-0.4.2.ru.md`, `PRIVACY*`, `REFUND.md` | ~5 | Functional legal documents describing the licensor's Windows-side terms, referenced from README's license table; rewriting them would falsify them. Kept, disclosed, labeled as upstream terms (not this branch's grant). |
| Canonical license boilerplate: the MIT block in `LICENSE` (193-token run at 0.57 — vs vendor MIT texts), `LICENSE-NOTE.txt` stubs (56) | 5 | Boilerplate required by the licenses themselves. `LICENSE-NOTE` stubs reword as a trivial item in `09i`. |
| Public invocation contracts: the blender `-b --factory-startup --python` command lines in our own docs (13, 9) | 2 | CLI fact, unprotectable. |

## The 0.5.1 wave itself (files added after `a3c959d`) — zero new violations

23 raw ≥8-token rows, every one classified (full rows in the evidence JSON, `wave: true`):

| Class of raw hit | Example | Classification |
|---|---|---|
| HEAD-inherited prologue lines | `unreal_package.py` opening (68) ≡ our HEAD `godot_package.py` | allowed by the wave protocol (HEAD-inherited), **but** the pool it inherits from is now itself flagged — re-verification obligation after the rewrite lands, ticket `09j`. Known quoted lines: the `params.asset_id must be snake_case ASCII…` prologue, the restart message "The job was interrupted by a restart…" (ticket 02 audit note), the blender test-harness helpers (`_tmp`, `Imaginarium_KEEP_TEST_FILES`). |
| stdlib / test-harness import blocks | `import { test } from 'node:test' …` (12–43) | universal Node idiom + our suite's own convention; no expression at stake. |
| engine format keys | `Imaginarium.uplugin` fields (35 at 0.35), `data-theme=light` selector (9) | T3 interface facts of public engine formats. |
| name+idiom collisions in tiny pure modules | `src/shell/mode.js saveMode(…)` (22 vs upstream `mode.js`) | function-name facts + the universal localStorage-wrapper shape; decomposition already adjudicated different (ticket 04 audit). |

The per-ticket audits of tickets 01–07 (trail in `docs/product/acceptance-0.5.1.md`) already
rejected and re-landed the three genuine first-pass violations; this whole-tree re-scan confirms
none survived, and adds the `09j` re-check duty the wave cannot discharge until HEAD is rewritten.

## Follow-up tickets filed (rewrite band, worst-first)

| Ticket | Module | Scope (files in rewrite band) |
|---|---|---|
| `09a` | scripts/blender steps + libs + their tests | 78 + overlapping test rows |
| `09b` | src (UI: jsx/css/i18n) | 67 |
| `09c` | server (api/job/forge modules) | 31 |
| `09d` | installer (install.sh-adjacent .ps1/.cs/.cmd frozen frontends: disposition — rewrite behind the same CLI contract or drop) | 40 |
| `09e` | docs/ + root prose (ARCHITECTURE, module docs, README overlaps) | 40 + root rows |
| `09f` | ai (mcp server, skills, references) | 34 |
| `09g` | tests/ node suites | 33 |
| `09h` | unity C# importer + checks | 16 |
| `09i` | scripts (other) + data/ tracking hygiene + LICENSE-NOTE stubs | 53 + 32 vendored rows |
| `09j` | wave re-verification after HEAD strings are rewritten | carry-over list above |

Every `09x` ticket: same Protocol v2 gates (T1/T2/T3 inputs, quarantine rule, fresh-context audit,
evidence line in the ticket), re-run this tool as its exit criterion (module rewrite-band → 0).

## Limitations (stated so the number is not over-trusted)

Token-run identity is a *copy* detector, not a plagiarism judge: semantically equivalent but
rewritten code can score clean, and short functional strings can score as runs without being
protectable expression — that is what the classification pass is for. k=8 with forward-verified
extension biases toward precision (few false positives) at the cost of missing scattered fragment
overlap; per-ticket audits covered that for the wave. The reference trees are snapshots of the
shipped installers; if the author ever publishes source, re-run with that as corpus. The evidence
file's `ref` paths are relative to the reference tree that matched; `containment` is measured
against the single best-matching reference file.

## Re-run at the 0.6.6 release (2026-11-08)

Re-ran the frozen tool over the same tree method at the 0.6.6 closeout commit, corpus widened to
**all eight payload trees** (`--trees 0.4.16,0.4.6,0.5.0,0.5.1,0.5.3,0.6.0,0.6.5,0.6.6`;
13 619 reference files, 541 tracked). Result: **the pre-existing buckets are unchanged** — same
per-module counts, same worst runs (`ship_gen.py` 35 973, containment 1.00) — the 0.6.x trees
bundle the same lineage files and widen the grandfathered corpus without changing its verdict.
Evidence: [`similarity-audit-0-6-6.evidence.json`](similarity-audit-0-6-6.evidence.json).

The 0.6.x reintroduction wave (tickets 01–17, `linux-support` base `ea96e11`) added 34 files:
each landed only after its own fresh-context added-line audit (per-ticket records under
`.scratch/imaginarium-060-reintroduction/issues/`, trail table in the
[0.6.6 acceptance report](acceptance-0.6.6.md)); the raw whole-file numbers for those 34 files
(6 rewrite-band by rule, all containment ≤ 0.148, every run classified junction/idiom/public-pin
by the ticket audits; 3 clean) are recorded there too. The campaign rows 09a…09j stand — `09j`
now also owes re-verification of the 0.6.x wave lines that anchor on HEAD idioms, discharged the
same way as its existing carry-over list.
