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
