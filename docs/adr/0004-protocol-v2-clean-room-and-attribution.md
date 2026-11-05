# Protocol v2: strict clean-room re-derivations and honest attribution

ADR-0003 rebuilt the `linux-support` branch toward parity with shipped Windows 0.4.16 by
*reading the extracted payload as a behavioral reference* and restoring non-code artifacts
(docs, notes, data JSON) verbatim. At the time the branch was treated as an author-side effort.
It is not: the upstream product — including everything shipped in Windows releases 0.4.2 through
0.5.3 — is © Artem Doronin (Dops Media) and is distributed under the
**PolyForm Noncommercial License 1.0.0 plus a commercial-subscription license** (the
`LICENSE` embedded in the shipped payloads; byte-identical across 0.4.16→0.5.3). The branch
maintainer is neither the author nor a licensee of that code. Two strings inside the shipped
builds — the exe `LegalCopyright` version resource ("… MIT License") and an outdated paragraph
in the shipped `THIRD_PARTY_NOTICES.md` (Russian: «бесплатная программа по лицензии MIT… можно
использовать в том числе в коммерческих целях» — free under MIT, commercial use OK) — contradict
the authoritative in-payload `LICENSE`; they are treated as upstream bugs (reported, see
`.scratch/astraforge-051-reintroduction/issues/10-*`), never as a grant.

Under those facts, "read as spec, write fresh" is a defensible but *middle* position, and
"restore artifacts verbatim" is untenable: only the licensor can re-license to MIT, and the
public MIT grant must cover nothing that a court could deem a derivative of PolyForm-licensed
expression. This ADR raises the bar for all work from 0.5.1 onward and fixes attribution.

## Decision

1. **Attribution rewrite.** `LICENSE` becomes MIT © 2026 Dmitry Belozerov (jimOnAir) covering
   *this re-implementation*, with a provenance/attribution block: AstraForge is the work of
   Artem Doronin (Dops Media); this branch re-derives documented behavior clean-room under this
   protocol; it is not affiliated, distributes no PolyForm-licensed source, and the Windows
   releases remain under their own licenses. Mirrored in `README.md` / `README.ru.md`.

2. **Spec-input tiers.** Every change is specified from three tiers only:
   - **T1 — intent.** The author's public release notes and product prose as a statement of
     *what* the feature does, paraphrased into functional bullets. Never verbatim.
   - **T2 — behavior.** Observed operation: UI flows, HTTP responses, exported files, installer
     output, logs.
   - **T3 — interface facts.** Names, keys, thresholds, formats, attribute and storage keys,
     URLs — data that is inseparable from interoperability — recorded as `[fact]` lines.
   No verbatim restoration of upstream documentation, notes or data files: ADR-0003's
   artifact-verbatim clause is **retired** for all new work. Third-party license texts may ship
   only where those third-party licenses themselves require their inclusion.

3. **Quarantine.** The extracted payload trees and change reports
   (`~/github/AstraForge-0.4.16-ref/`) are quarantined work papers: readable by the
   *spec-drafter* (who distills T1/T2/T3 into ticket files) and by the independent
   *similarity auditor*, and by **no implementing context**. Implementation runs from the ticket
   file and this repository only.

4. **Per-ticket similarity audit.** Before its commit lands, every change is reviewed by a
   fresh context (which may read the quarantined payload) comparing the new diff against the
   reference corpus for textual and structural similarity; a PASS is recorded on the ticket.
   The audit checks both source and prose.

5. **Commit hygiene** (carried from ADR-0003): per-cluster commits, `npm test` green at every
   commit, each carrying the provenance note "behavior derived per ADR-0004, no source
   consulted". Windows frontends (`Setup.cs`, `Install.ps1`) stay frozen (ADR-0001); installer
   features land as the platform-neutral `install.sh` core.

6. **Excluded and deferred lines** for the 0.5.x wave (recorded per release in the acceptance
   reports): the AstraForge Engine and its self-learning LoRA line — deferred as a
   Windows-specific architecture; the FLUX.2-klein non-commercial restriction survives here as
   notice prose only. The asset-provenance and licensing machinery (invisible watermarks,
   `AFC1` certificates, signed core-manifest, owner mode, license build checks) — excluded:
   exports carry no marks and checks run license-blind. The updater, telemetry, support
   endpoints and keys-server — excluded, with only their *message patterns* mirrored into
   `install.sh`. AMD/ROCm support — deferred until there is AMD hardware to verify against.

## Consequences

- The branch's MIT claim becomes honest: the copyright line names the actual author of the
  code, attribution names the actual author of the product, and the derivation method is
  documented and enforced per change.
- A residual, disclosed risk stays: re-implementation from published behavior is lawful, but
  "clean room" is a defense posture, not a guarantee. It is mitigated to the practical floor by
  tiers (2), quarantine (3) and audits (4), and the open lever to remove it entirely is an
  explicit blessing from the rights holder (ticket 10).
- Historical scope is disclosed, not hidden: `v0.5.0` was produced under the weaker ADR-0003
  bar and is subject to a retroactive similarity audit whose results and follow-up rewrites are
  tracked publicly (ticket 09).

## Rejected

- Relying on the stale "MIT" strings in the shipped builds as a license grant (the authoritative
  `LICENSE` says otherwise; a contradiction in the licensor's own artifacts is not a grant).
- Keeping ADR-0003's read-as-spec method while asserting MIT authorship we cannot confer.
- Staying private "until blessed" — with tiers/quarantine/audits, public development at the
  defensible floor is possible now, and the blessing lever remains open in parallel.

## Amendment at the 0.5.1 release (deviations actually taken while implementing)

Recorded here because they refine how the protocol was applied; the per-cluster evidence and the
full deviations table live in `docs/product/acceptance-0.5.1.md`.

- **Engine-management scope.** The Windows `generator_*` family drives the proprietary AstraForge
  Engine; this branch maps the family onto the ComfyUI backend and exposes only
  status/nodes/graphs/run/restart. The other verbs are documented absent by name (MCP README,
  integrator skill) — absence as a contract, per decision 6.
- **Unity hull handling mechanism.** The accepted behavior is "hull names never render, hulls are
  the collider source"; the implementation re-derives it through Unity's public UCX FBX convention
  (synthesize convex hulls ≤64 tris, drop the sources) rather than any upstream mechanism — an
  independently chosen shape, audited as such.
- **Isolated check mode.** Windows silences telemetry and the journal in check mode; this branch
  has neither by design, so isolation means model-library and process containment only.
- **Unverified-by-design lines.** The Unreal in-editor pass and the Unity C# importer cannot run on
  the verification machine; they ship flagged, with data-level tests as the tested scope and
  guarded engine-side reports where the contract allows (plugin step reports, batch checks).
- **Graph catalog.** `GET /api/runtime/graphs` derives its rows by invoking this branch's own
  workflow builders, so the agent-facing catalog cannot drift from the code.
- **Audit outcome discipline.** Three of seven feature tickets were rejected by the audit gate at
  first pass (a release-note sentence, one transcribed hex constant, one copied helper) and
  re-landed only after original rework; the FAIL→fix→PASS trail is part of the release record.
  Pre-existing ADR-0.3-era strings flagged by the auditors were carried to the retroactive audit
  (ticket 09) rather than silently kept.
