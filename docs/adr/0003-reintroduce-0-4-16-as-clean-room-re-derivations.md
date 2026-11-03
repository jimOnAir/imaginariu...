# Reintroduce 0.4.7–0.4.16 as clean-room re-derivations from the shipped payload

The source commits of releases 0.4.7→0.4.16 do not exist anywhere: git froze at the 0.4.6-era
README commit while the product line kept shipping Windows installers, so the only surviving copy
of that work is the `payload.zip` embedded in `AstraForge-Setup-0.4.16.exe` (together with a whole
body — 2D, Sculpt, Pixel, Unity export, MCP — that shipped since 0.4.6 but was never committed).
We rebuild the tree toward full parity with shipped 0.4.16 by re-deriving behavior from the
extracted payload as a reference: implementations are written fresh in this repo's current idioms
(i18n-wired UI, platform-gated launchers per ADR-0001), never copied — no source text or structure
is transplanted, so the public MIT tree stays license-clean. Non-code artifacts (docs, figures,
data JSON, per-release notes, third-party license notes) are restored verbatim, keeping their
license notes. The entire monetization and identity line — license validation, auto-update,
telemetry, support endpoints, shared community recipes — is excluded by decision: this tree is the
free Linux Studio, and shipping enforcement prose or endpoints it cannot exercise would be
misleading. Windows frontends (`Setup.cs`, `Install.ps1`) stay frozen at their repo state; the
installer features (Scan, per-Component selection, Lite setup, download robustness, integrity
gates) land as a platform-neutral core driven by `install.sh`, since verification is Linux-only.
Rejected: dropping the extracted files in (license contamination plus unverifiable Windows code),
file-by-file porting (monkey-patching the lost history), and re-implementing from release notes
alone (guaranteed behavioral drift where notes are silent). The reference base and bucket
classification live in `~/github/AstraForge-0.4.16-ref/` (work papers, not committed).

## Amendment (0.5.0 closeout)

Deviations that the re-introduction actually took, recorded at the version bump so a later reader
finds them here and not in archaeology (full evidence: `docs/product/acceptance-0.5.0.md`):

- **Curl code 35 has no Linux flip.** The shipped fix toggles Windows Schannel's revocation check
  (`--ssl-no-revoke`); Linux curl (OpenSSL) never performs that check, so the fix is not
  applicable. Code 35 joins the ordinary flaky-TLS resume class here, and the tested flag is
  never passed (a test asserts both).
- **Ollama gate: sha256 instead of Authenticode.** Authenticode has no Linux analogue and this
  tree never executes third-party installer binaries; the equivalent anchor is the vendor's own
  checksum channel — the official release `tar.zst` is installed into `runtime/ollama` only on a
  sha256 match against the same release's `sha256sum.txt` (fetched fresh; no version pin).
- **Linux sha/size pins live as `install.sh` constants** (`NodeTarSha`, `BlenderTarSha`, …); the
  shipped `manifest.json` stays verbatim and `ManifestMirrors` rewrites its Windows-archive URLs
  to the Linux archives at download time.
- **About → Learning toggles the journal itself** (`knowledge.json.journaling`): the consent it
  replaces gated journal *shipping* through telemetry, which does not exist on this branch, so
  the switch controls local recording.
- **Community recipe layer absent** (EXCLUDED.md): the lowest recipe tier is this studio's own
  journal; the precedence ladder (explicit/preset > class pin > class journal > kind > `*`) is
  the surviving half of the 0.4.16 rule.
- **Keys-server suite not applicable** — license validation and its server contract are excluded
  entirely.
- **String policy**: machine/agent-parsed contract strings (verdict aliases, defect-tag words,
  class patterns, the Markdown digest) stay Russian verbatim as shipped; new human-facing UI
  strings go through `src/i18n` (en/ru); server and CLI generated prose is English.
- **Unity C# unverified**: no Unity editor exists on the verification machine; the export line is
  proven at the data level only (flagged in the acceptance report and the unity package README).
- **Windows frontends stay frozen** — verification of every ticket is Linux-only: root `npm test`
  plus live demos on this machine.
