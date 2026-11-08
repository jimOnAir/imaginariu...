# AstraForge Bevy project (template)

A starter for using AstraForge assets in Bevy 0.20 with the `astraforge_bevy` crate.

Layout after `af_bevy.json` assets are sent here (the studio's "send" verb puts each package
under `assets/astraforge/<asset_id>/`, sound banks under `assets/astraforge/sounds/<slug>/`):

```
Cargo.toml
src/main.rs        plugin wiring + one add_astraforge_asset line per package
src/player.rs      starter controller: WASD moves, Space switches clips, E plays a sound
assets/astraforge/ the studio drops packages here
```

Build: `cargo run` (the crate pins bevy 0.20.1 with default-features=false, features 3d+audio -
add the "bevy/render"/"x" features your game needs to your own bevy dependency; astraforge_bevy
stays compatible).

Hot model reload is on by default: save the same asset again from the studio and the running
window updates - no restart. Turn it off per asset with `add_astraforge_asset_hot(path, false)`.
