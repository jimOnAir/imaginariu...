# Imaginarium Bevy project (template)

A starter for using Imaginarium assets in Bevy 0.20 with the `imaginarium_bevy` crate.

Layout after `ima_bevy.json` assets are sent here (the studio's "send" verb puts each package
under `assets/imaginarium/<asset_id>/`, sound banks under `assets/imaginarium/sounds/<slug>/`):

```
Cargo.toml
src/main.rs        plugin wiring + one add_imaginarium_asset line per package
src/player.rs      starter controller: WASD moves, Space switches clips, E plays a sound
assets/imaginarium/ the studio drops packages here
```

Build: `cargo run` (the crate pins bevy 0.20.1 with default-features=false, features 3d+audio -
add the "bevy/render"/"x" features your game needs to your own bevy dependency; imaginarium_bevy
stays compatible).

Hot model reload is on by default: save the same asset again from the studio and the running
window updates - no restart. Turn it off per asset with `add_imaginarium_asset_hot(path, false)`.
