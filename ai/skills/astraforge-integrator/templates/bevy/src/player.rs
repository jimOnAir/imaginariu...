//! Starter player controller (the counterpart of the Godot/Unity templates): WASD walks the
//! entity that carries an AstraForgeAsset, Space plays the first non-looping clip ("attack"),
//! E plays the asset's first sound from its studio sound bank. It only speaks the crate's public
//! surface - AstraForgeAsset + AstraPlay + play_sound - so it survives crate updates.

use astraforge_bevy::prelude::*;
use bevy::prelude::*;

const SPEED: f32 = 3.0;

pub fn control(
    keyboard: Res<ButtonInput<KeyCode>>,
    time: Res<Time>,
    banks: Res<AstraForgeSoundBanks>,
    assets: Res<AssetServer>,
    mut q: Query<(&AstraForgeAsset, &mut Transform, &mut AstraPlay)>,
    mut commands: Commands,
) {
    for (asset, mut transform, mut play) in q.iter_mut() {
        let mut move_by = Vec3::ZERO;
        if keyboard.pressed(KeyCode::KeyW) { move_by.z -= 1.0; }
        if keyboard.pressed(KeyCode::KeyS) { move_by.z += 1.0; }
        if keyboard.pressed(KeyCode::KeyA) { move_by.x -= 1.0; }
        if keyboard.pressed(KeyCode::KeyD) { move_by.x += 1.0; }
        if move_by != Vec3::ZERO {
            transform.translation += move_by.normalize_or_zero() * SPEED * time.delta_secs();
        }
        if keyboard.just_pressed(KeyCode::Space) {
            // a one-shot clip (the passport's first non-loop, usually "attack") with a 0.2 s blend
            if let Some(clip) = asset.passport.clips.iter().find(|c| !c.is_loop) {
                play.play(clip.name.clone(), 0.2);
            }
        }
        if keyboard.just_pressed(KeyCode::KeyE) {
            if let Some(first) = banks.get(&asset.passport.asset_id).map(|b| b.bank.names().next().cloned()).flatten() {
                play_sound(&mut commands, &banks, &assets, &asset.passport.asset_id, &first, None);
            }
        }
    }
}
