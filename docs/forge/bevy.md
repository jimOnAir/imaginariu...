# Bevy 0.20 — the fourth export target

Imaginarium packages assets for Bevy the way it does for Godot, Unity and Unreal: a folder with
the model and a machine-readable passport. Bevy reads glTF natively, so the model ships as the
same **GLB** the Godot profile produces (same mesh, same rig, same clips — nothing converted),
and the difference lives in the passport and the crate that reads it.

This line arrived with the 0.6.10 patch wave (Linux branch): export profile + passport (ticket
28), the crate (ticket 29), the headless check (ticket 30), MCP/sound parity (ticket 31).

## The package

    assets/imaginarium/<asset_id>/
        model.glb          the asset: meshes, materials, rig, animation clips
        ima_bevy.json       the passport (below)
        fx_presets.json    only when the asset has effects
        README.md          install snippet in human words

## The passport (ima_bevy.json)

| Key | What it says |
| --- | --- |
| `asset_id` | snake_case name, also the folder |
| `glb` / `gltf` | file names inside the package (`gltf` is reserved, null today) |
| `clips` | `[{name, loop, seconds}]` — `name` is the GLB animation name, read from the shipped bytes, never renamed |
| `default_clip` | what autostarts (idle > first loop > first) |
| `sockets` | `[{name, node, kind, parent, parent_bone}]` — effect mount points per the model contract |
| `collider` | `{kind}`: `hulls` (the model carries COL_*/-colonly meshes), else `capsule` (rigged) or `box` |
| `collision_meshes` | those hull names |
| `fx` / `fx_presets` | effect rows `{preset, socket, params}` (socket masks already fanned out) + the presets file |
| `rig` / `scene` | `skinned|static`, bones; sizes in glTF axes, triangle count |
| `checks` | which build checks the package passed |

## In the game

One line puts the asset in with everything the passport promises:

```rust
app.add_plugins((ImaginariumBevyPlugin, ImaginariumSoundPlugin))
   .add_imaginarium_asset("assets/imaginarium/brass_lantern/ima_bevy.json");
```

- the default clip autostarts the moment the model appears;
- `AstraPlay.play("attack", 0.2)` blends through `AnimationTransitions` — every switch fades;
- looping clips repeat automatically (from the passport);
- effects: `ImaginariumEffects::register("fire", scene)` mounts every passport `fx` row whose
  preset is registered at its socket, scaled by the row's `params.scale` if it has one;
- sounds: `play_sound(&mut commands, &banks, &assets, "brass_lantern", "lantern_swing", None)` —
  one-shots despawn when done, loops loop, gains come from `ima_sounds.json`;
- hot model reload is on: re-export the same asset in the studio, the running window picks it
  up (mtime watch + the asset server's reload; `add_imaginarium_asset_hot(path, false)` turns it
  off per asset).

The crate (`bevy/imaginarium_bevy`, MIT, on this branch) is written against bevy **0.20.1** with
`default-features = false, features = ["3d", "audio"]` so it joins any app's feature set.

## Headless check and preview frames

When `cargo` is on PATH, the studio additionally validates the package in a throwaway Bevy
project (`scripts/engines/bevy.mjs`, ids `imaginarium_bevy_check` / `imaginarium_bevy_send_<slug>`): the crate's
own `imaginarium_bevy_check` binary (behind the crate's `check` feature) mounts the package through the
same loader a game uses, proves the passport against the live world (`scene_mounted`,
`clips_in_graph`, `default_clip_autostarts`, `sockets_named`, `sockets_found`), switches a
clip, and captures preview frames through bevy's screenshot pass. The step carries the answers
as the tokens `bevy_check` (report json), `bevy_shots` (frames), `bevy_log` (cargo output),
`bevy_forward` (the orientation record the frames prove). Cargo runs with an idle-kill and a
hard ceiling (`IMAGINARIUM_CARGO_IDLE_MIN` 4, `IMAGINARIUM_CARGO_TIMEOUT_MIN` 25 minutes — a stuck
toolchain never hangs a forge job), and the build cache (`IMAGINARIUM_CARGO_TARGET_DIR`, default
`data/engines/bevy/target`) is shared: the first check pays the Bevy compile, later ones
seconds. Without Rust the export is byte-identical minus the check — one honest warning row,
the package never depends on the machine having a toolchain. See `docs/linux.md` (0.6.10) for
the run book.

## MCP parity, sound banks, the bridge

`bevy` is an engine everywhere the other engines are: the MCP engine verbs
(`engine_project_create` / `engine_project_link` / `engine_send` / `engine_scaffold` /
`engine_test`, enum `unity|godot|bevy`), the `forge_export` profile list, and `sound_export
{engine:"bevy"}` — the last lays down the studio sound bank exactly as the crate reads it:
`assets/imaginarium/sounds/<slug>/` with the bound sounds inside (ogg when the library has one,
wav otherwise) and an `ima_sounds.json` manifest, format `imaginarium-soundbank/1`, one
`{name, file, loop, gain}` entry per event sorted by name (the crate's `play_sound("attack")`
looks them up by those names). A re-export replaces the bank folder wholesale, so a manifest
can never outlive one of its files.

The optional editor bridge is `bevy_brp_mcp 0.23.0` — installed only by `installBrpMcp`
(`bevy.mjs brp-install`, or `engine_mcp_register {installBevyBrp:true}`): the .crate is
downloaded, its sha256 compared to the crates.io record pinned in the driver, and only the
verified file is unpacked and handed to `cargo install --path`. A mismatch refuses and the
toolchain never runs — the branch's supply-chain rule, never a bare index install.

The running game opens itself to the bridge with bevy's own remote feature
(`Cargo.toml`: `bevy = { version = "0.20.1", features = ["bevy_remote"] }`):
`RemotePlugin::default()` registers the verbs and `http::RemoteHttpPlugin::default()` binds
the socket (15702) — on this bevy the first one alone registers methods but never listens,
verified in the ticket-47 live session against the real 0.20.1. Component types are named by
their full path (`bevy_transform::components::transform::Transform`), newtypes take the bare
value (`bevy_ecs::name::Name: "hero"`). Everything the crate keeps as plain Rust (the
`AstraPlay` clip queue is not reflected) rides to the agent as one app-defined BRP verb —
`RemotePlugin::with_method("imaginarium/play_clip", …)` that forwards `{"clip": "<name>"}` to
the queue — the same pattern any game command would use.

## Deviations recorded (Protocol v2)

- the studio's English wording is this branch's; upstream's runtime phrase-map is not ported;
- Linux repair/concurrency semantics differ by design (see the acceptance report);
- the passport is this branch's schema (`{name, loop, seconds}` clips, `{kind}` collider,
  `checks` as names) — the crate reads exactly what the step writes, both live on this branch.
