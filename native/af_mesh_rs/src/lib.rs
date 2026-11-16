//! af-mesh-rs — AstraForge's own GLB decimator on vendored meshoptimizer (wave ticket 46).
//!
//! Branch-original code (MIT, AstraForge contributors) over unmodified third-party sources
//! pinned in `vendor/` (`VENDORING.md`, `THIRD_PARTY_NOTICES.md`). The CLI in `src/main.rs` is
//! the only contract the studio relies on:
//!
//! ```text
//! af-mesh-rs simplify --in a.glb --tris N --out b.glb [--json]
//! af-mesh-rs compare  --a a.glb --b b.glb [--json]
//! af-mesh-rs --version
//! ```
//!
//! The carry-contract: rig weights, vertex colours, custom normals, UVs and shape-key deltas
//! survive for the survivor vertices verbatim (`glb`); attributes glTF does not carry are the
//! honest note list; a refusal NEVER writes the output — the caller restores from its own copy
//! and keeps its fallback (the Blender path always stays).

pub mod glb;
pub mod simplify;

/// The handshake the studio checks before spawning (`--version`).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
