# Vendored: meshoptimizer v1.3

- Source: official repo <https://github.com/zeux/meshoptimizer> (single author: Arseny
  Kapoulkine), tag **v1.3**, tag commit `9e1f07b159d3cb777f1c67ed31fc11fd117986f4`
  (`git ls-remote refs/tags/v1.3`, verified 2026-11-16).
- Archive: `https://github.com/zeux/meshoptimizer/archive/refs/tags/v1.3.tar.gz`
  sha256 `ca4f47d451201593904b9e3067fa54b65db94bc34ab5173864950862b748a145`
- License: MIT (see `LICENSE.md` copied verbatim from the archive).

Files vendored (exactly what the simplifier translation unit needs; no network at build):

| file | sha256 |
|---|---|
| `src/meshoptimizer.h` | `e3688ef553f603391747895a5c221ef1528574cc7f8173782417a96cb531f61b` |
| `src/simplifier.cpp` | `719303b6970398631e30724e8eebc6cd2e7e08b67fe8ab7cbf7eecafdaa08616` |
| `LICENSE.md` | `f03037ca7bad1e3eb7f4a63fa6084a8baabd5ba30d3c239a9a7f35705d873e26` |

These files are UNMODIFIED upstream sources. They are third-party code under their own MIT
license and are listed in `THIRD_PARTY_NOTICES.md`; for the ADR-0004 similarity audits they are
**excluded-by-notice** (like `node_modules`): third-party files legitimately match any build
that vendors the same project, and the audit gates ORIGINAL AstraForge code, which lives in
`src/` and `build.rs`.

Built from source with the `cc` crate — never downloaded as a binary.
