//! Putting a packaged AstraForge asset into a running app: read the passport, load the GLB,
//! spawn its scene, autostart the default clip, blend between clips, mount effects at sockets
//! and watch the model file for hot reload. The pure decisions (asset paths, clip lookup) are
//! unit-tested here; the Bevy plumbing runs from the plugin's systems.
//!
//! The shapes follow bevy 0.20's world-instance pipeline: a GLB scene is a `WorldAsset` spawned
//! through `WorldInstanceSpawner` (which also rebuilds instances when the asset reloads - that
//! is the second half of hot reload), and animations play through `AnimationGraph` node indices
//! switched with `AnimationTransitions` (which is the blending).

use crate::passport::{Passport, Socket};
use bevy::ecs::hierarchy::ChildOf;
use bevy::prelude::*;
use bevy::world_serialization::{InstanceId, WorldAsset, WorldInstanceSpawner};
use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, SystemTime};

/// One AstraForge asset instance in the world (spawned by [`AstraForgeAppExt::add_astraforge_asset`]).
#[derive(Component)]
pub struct AstraForgeAsset {
    pub passport: Passport,
    /// the package folder, relative to the Bevy assets root ("astraforge/<asset_id>")
    pub asset_dir: String,
    /// the model path as the asset server knows it
    pub glb_path: String,
    pub hot_reload: bool,
    pub mtime: Option<SystemTime>,
    /// the model handle, requested from the asset server by the first system (App setup keeps
    /// read-only access to the world in 0.20, so loading happens on the first frame)
    pub glb: Option<Handle<Gltf>>,
    /// the queued instance of the GLB's default scene, once the GLB is ready
    pub instance: Option<InstanceId>,
    /// set when the model has no default scene at all (say it once, stay quiet afterwards)
    pub dead_instance: bool,
    /// the instance's root entity (the mounted scene's top), once it appears
    pub scene_root: Option<Entity>,
    /// the entity inside the instance that carries bevy_gltf's AnimationPlayer - it is NOT
    /// the scene root in practice (the exporter anchors it at the animation's target subtree)
    pub anim_player: Option<Entity>,
    /// clip name -> node in this asset's animation graph, once wired
    pub clip_nodes: HashMap<String, AnimationNodeIndex>,
    /// loop flags per clip name (for .repeat() at play time)
    pub clip_loops: HashMap<String, bool>,
    /// requested plays waiting for the wiring to happen
    pub pending_plays: Vec<(String, f32)>,
    /// (preset, socket) pairs already mounted (cleared on hot reload, mounted on sockets)
    pub mounted_fx: Vec<(String, String)>,
    /// effect instances whose scale (from the fx params) still needs applying
    pub fx_pending_scale: Vec<(InstanceId, f32)>,
}

/// A clip switch request: the game pushes a name, the plugin crossfades to it.
#[derive(Component, Default)]
pub struct AstraPlay {
    requests: Vec<(String, f32)>,
}

impl AstraPlay {
    /// Queue a switch. `fade` is the crossfade in seconds (0 = instant).
    pub fn play(&mut self, name: impl Into<String>, fade: f32) {
        self.requests.push((name.into(), fade.max(0.0)));
    }
}

/// Effect presets this app knows how to spawn: register the scene under the studio's preset
/// name (the names come from the shipped fx_presets.json), and every passport fx entry whose
/// preset is registered mounts itself at its socket.
#[derive(Resource, Default)]
pub struct AstraForgeEffects {
    scenes: HashMap<String, Handle<WorldAsset>>,
}

impl AstraForgeEffects {
    /// `scene` is usually the `default_scene` of an effect GLB loaded from wherever the game keeps them.
    pub fn register(&mut self, preset: impl Into<String>, scene: Handle<WorldAsset>) {
        self.scenes.insert(preset.into(), scene);
    }

    pub fn get(&self, preset: &str) -> Option<&Handle<WorldAsset>> {
        self.scenes.get(preset)
    }
}

/// The plugin: every system the asset line needs. Add it before calling add_astraforge_asset.
pub struct AstraForgeBevyPlugin;

impl Plugin for AstraForgeBevyPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<AstraForgeEffects>()
            .insert_resource(HotReloadClock(Timer::from_seconds(1.0, TimerMode::Repeating)))
            .add_systems(Update, (
                mount_scenes,
                resolve_scene_roots,
                wire_animations,
                mount_effects,
                scale_fx_instances,
                play_requests,
                watch_hot_reload,
            ).chain());
    }
}

/// Load a studio package by passport path (relative to the project root, the same path the
/// integrator skill copies assets to): "assets/astraforge/<asset_id>/af_bevy.json".
/// The model autostarts its default clip; `hot_reload` re-reads the .glb whenever its mtime
/// changes while the app runs.
pub trait AstraForgeAppExt {
    fn add_astraforge_asset(&mut self, passport_path: impl AsRef<Path>) -> &mut Self;
    fn add_astraforge_asset_hot(&mut self, passport_path: impl AsRef<Path>, hot_reload: bool) -> &mut Self;
}

impl AstraForgeAppExt for App {
    fn add_astraforge_asset(&mut self, passport_path: impl AsRef<Path>) -> &mut Self {
        self.add_astraforge_asset_hot(passport_path, true)
    }

    fn add_astraforge_asset_hot(&mut self, passport_path: impl AsRef<Path>, hot_reload: bool) -> &mut Self {
        let path = passport_path.as_ref();
        match (|| -> Result<AstraForgeAsset, String> {
            let passport = load_passport_file(path)?;
            let (dir, _) = bevy_paths(&path.to_string_lossy())?;
            let glb_path = glb_asset_path(&dir, &passport);
            let fs_glb = path.parent().unwrap_or(Path::new(".")).join(&passport.glb);
            let mtime = std::fs::metadata(&fs_glb).and_then(|m| m.modified()).ok();
            Ok(AstraForgeAsset {
                passport, asset_dir: dir, glb_path, glb: None, hot_reload, mtime,
                instance: None, dead_instance: false, scene_root: None, anim_player: None, clip_nodes: HashMap::new(), clip_loops: HashMap::new(),
                pending_plays: Vec::new(), mounted_fx: Vec::new(), fx_pending_scale: Vec::new(),
            })
        })() {
            Ok(asset) => {
                self.world_mut().spawn((asset, AstraPlay::default()));
            }
            Err(e) => warn!("astraforge: {e}"),
        }
        self
    }
}

/// Where the passport and the model live in Bevy asset-space, from the path the user passed:
/// "assets/astraforge/brass_lantern/af_bevy.json" -> dir "astraforge/brass_lantern" (+ model).
pub fn bevy_paths(passport_path: &str) -> Result<(String, String), String> {
    let normalized = passport_path.replace('\\', "/");
    let trimmed = normalized.strip_prefix("assets/").unwrap_or(&normalized);
    let file = Path::new(trimmed).file_name().and_then(|f| f.to_str()).unwrap_or_default();
    if file != "af_bevy.json" {
        return Err(format!("add_astraforge_asset expects a passport path ending in af_bevy.json, got {passport_path:?}"));
    }
    let dir = match Path::new(trimmed).parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_string_lossy().replace('\\', "/"),
        _ => return Err(format!("add_astraforge_asset: no package folder in {passport_path:?}")),
    };
    Ok((dir.clone(), format!("{dir}/model.glb"))) // the real file name comes from the passport
}

/// The model path as Bevy must load it - the passport names the file, the folder is the asset dir.
pub fn glb_asset_path(asset_dir: &str, passport: &Passport) -> String {
    format!("{asset_dir}/{}", passport.glb)
}

/// Read and parse the passport file from disk (at startup, before the asset server owns anything).
pub fn load_passport_file(fs_path: &Path) -> Result<Passport, String> {
    let text = std::fs::read_to_string(fs_path).map_err(|e| format!("{}: {e}", fs_path.display()))?;
    Passport::parse(&text)
}

/// Find a passport clip name among the animation names the loaded GLB actually carries.
/// Exact name, then the stem before '-' / after a ".001"-style suffix (a re-import that renamed
/// 'idle-loop' still autostarts). None means no match: the caller decides (warn, stay stopped).
pub fn resolve_clip_index(available: &[String], wanted: &str) -> Option<usize> {
    if wanted.is_empty() {
        return None;
    }
    available.iter().position(|a| a == wanted)
        .or_else(|| available.iter().position(|a| a.trim_end_matches(".001") == wanted || wanted.trim_end_matches(".001") == a.as_str()))
        .or_else(|| {
            let stem = wanted.split('-').next().unwrap_or(wanted);
            available.iter().position(|a| a.split('-').next() == Some(stem))
        })
}

/// The socket a mounted effect should follow: parent bone first (it tracks the animation),
/// then the plain node name.
pub fn socket_track_target(socket: &Socket) -> &str {
    if socket.parent_bone.is_empty() { &socket.node } else { &socket.parent_bone }
}

/// The asset entity an instance root hangs under (spawn_as_child parents it); also used to
/// find effect instances' roots for scaling.
#[derive(Component)]
struct AstraWired;

#[derive(Resource)]
struct HotReloadClock(Timer);

/// Queue the instance of the default scene once the GLB has loaded.
fn mount_scenes(
    server: Res<AssetServer>,
    gltfs: Res<Assets<Gltf>>,
    mut spawner: ResMut<WorldInstanceSpawner>,
    mut assets: Query<(Entity, &mut AstraForgeAsset)>,
) {
    for (entity, mut a) in assets.iter_mut() {
        if a.instance.is_some() {
            continue;
        }
        if a.glb.is_none() {
            a.glb = Some(server.load(a.glb_path.clone())); // the first frame asks; then we wait
            continue;
        }
        let Some(gltf) = a.glb.as_ref().and_then(|h| gltfs.get(h)) else { continue };
        let Some(scene) = gltf.default_scene.clone() else {
            warn!("astraforge {}: the GLB has no default scene - nothing to mount", a.passport.asset_id);
            a.dead_instance = true;
            continue;
        };
        a.instance = Some(spawner.spawn_as_child(scene, entity));
    }
}

/// The instance's root entity: the queued spawn lands as a child of some entity once the world
/// instance is ready - the root is the instance member whose Parent is not itself part of the
/// instance (spawn_as_child parented it to the outside entity).
fn instance_root(spawner: &WorldInstanceSpawner, parents: &Query<&ChildOf>, instance: InstanceId) -> Option<Entity> {
    let members: Vec<Entity> = spawner.iter_instance_entities(instance).collect();
    members.iter().copied().find(|e| match parents.get(*e) {
        Ok(p) => !members.contains(&p.parent()),
        Err(_) => true,
    })
}

fn resolve_scene_roots(
    spawner: Res<WorldInstanceSpawner>,
    parents: Query<&ChildOf>,
    players: Query<(), With<AnimationPlayer>>,
    mut assets: Query<&mut AstraForgeAsset>,
) {
    for mut a in assets.iter_mut() {
        if a.dead_instance || a.instance.is_none() {
            continue;
        }
        if a.scene_root.is_some() && (a.anim_player.is_some() || a.passport.clips.is_empty()) {
            continue;   // a clip-less package has no player to wait for
        }
        let instance = a.instance.unwrap();
        if !spawner.instance_is_ready(instance) {
            continue;
        }
        if a.scene_root.is_none() {
            a.scene_root = instance_root(&spawner, &parents, instance);
        }
        if a.anim_player.is_none() {
            // the live run proved it: bevy_gltf anchors the AnimationPlayer on the animation's
            // target node, somewhere inside the instance - find it there, not at the root
            a.anim_player = spawner.iter_instance_entities(instance)
                .find(|e| players.get(*e).is_ok());
        }
    }
}

/// Build the animation graph (every named GLB animation - the passport order first), hand it to
/// the instance root, and queue the default clip's autostart.
fn wire_animations(
    mut commands: Commands,
    gltfs: Res<Assets<Gltf>>,
    mut graphs: ResMut<Assets<AnimationGraph>>,
    mut assets: Query<&mut AstraForgeAsset>,
    players: Query<(), With<AnimationPlayer>>,
) {
    for mut a in assets.iter_mut() {
        let Some(player) = a.anim_player else { continue };
        if !a.clip_nodes.is_empty() {
            continue;
        }
        if players.get(player).is_err() {
            continue;   // the entity has not materialised in the world this frame
        }
        let Some(gltf) = a.glb.as_ref().and_then(|h| gltfs.get(h)) else { continue };
        let mut ordered: Vec<(String, Handle<AnimationClip>)> = Vec::new();
        for c in &a.passport.clips {
            if let Some(h) = gltf.named_animations.get(c.name.as_str()) {
                ordered.push((c.name.clone(), h.clone()));
            }
        }
        for (name, h) in &gltf.named_animations {
            if !ordered.iter().any(|(n, _)| n.as_str() == name.as_ref()) {
                ordered.push((name.to_string(), h.clone()));
            }
        }
        if ordered.is_empty() {
            continue; // static model: no graph, nothing to autostart
        }
        let (graph, nodes) = AnimationGraph::from_clips(ordered.iter().map(|(_, h)| h.clone()));
        let handle = graphs.add(graph);
        for (name, node) in ordered.iter().map(|(n, _)| n.clone()).zip(nodes.iter().copied()) {
            a.clip_nodes.insert(name, node);
        }
        a.clip_loops = a.passport.clips.iter().map(|c| (c.name.clone(), c.is_loop)).collect();
        commands.entity(player).insert((AnimationGraphHandle(handle), AnimationTransitions::new(), AstraWired));
        let wanted = a.passport.default_clip_index(None)
            .and_then(|i| a.passport.clips.get(i))
            .map(|c| c.name.clone());
        if let Some(name) = wanted.filter(|n| a.clip_nodes.contains_key(n)) {
            a.pending_plays.push((name, 0.0)); // autostart: the moment the model appears
        }
    }
}

/// Mount every registered-preset fx at its socket entity (the socket node's Name inside the
/// instance; effects are WorldAssets too, so they get their own hot-reloaded instances).
fn mount_effects(
    effects: Res<AstraForgeEffects>,
    mut spawner: ResMut<WorldInstanceSpawner>,
    names: Query<(Entity, &Name)>,
    mut assets: Query<&mut AstraForgeAsset>,
) {
    for mut a in assets.iter_mut() {
        if a.scene_root.is_none() || a.passport.fx.is_empty() {
            continue;
        }
        let mut to_mount = Vec::new();
        for f in &a.passport.fx {
            if a.mounted_fx.iter().any(|(p, s)| p == &f.preset && s == &f.socket) {
                continue;
            }
            let Some(scene) = effects.get(&f.preset).cloned() else { continue };
            let Some((entity, _)) = names.iter().find(|(_, n)| n.as_str() == f.socket.as_str()) else {
                continue; // socket not in this app's world (masked fan-out or a renamed import): skip honestly
            };
            let scale = f.params.get("scale").and_then(|v| v.as_f64()).map(|v| v as f32).unwrap_or(1.0);
            to_mount.push((f.preset.clone(), f.socket.clone(), scene, entity, scale));
        }
        for (preset, socket, scene, entity, scale) in to_mount {
            let instance = spawner.spawn_as_child(scene, entity);
            if scale != 1.0 {
                a.fx_pending_scale.push((instance, scale));
            }
            a.mounted_fx.push((preset.clone(), socket.clone()));
            info!("astraforge {}: mounted {preset} at {socket}", a.passport.asset_id);
        }
    }
}

/// Apply the fx params' scale to freshly mounted effect instances (their root entity appears a
/// frame later than the queue).
fn scale_fx_instances(
    spawner: Res<WorldInstanceSpawner>,
    parents: Query<&ChildOf>,
    mut transforms: Query<&mut Transform>,
    mut assets: Query<&mut AstraForgeAsset>,
) {
    for mut a in assets.iter_mut() {
        a.fx_pending_scale.retain_mut(|(instance, scale)| {
            if !spawner.instance_is_ready(*instance) {
                return true;
            }
            match instance_root(&spawner, &parents, *instance) {
                Some(root) => {
                    if let Ok(mut t) = transforms.get_mut(root) {
                        t.scale *= *scale;
                    }
                    false
                }
                None => true,
            }
        });
    }
}

/// Drain the play queues through the blending system.
fn play_requests(
    mut assets: Query<(&mut AstraForgeAsset, &mut AstraPlay)>,
    mut players: Query<(&mut AnimationPlayer, &mut AnimationTransitions)>,
) {
    for (mut a, mut queue) in assets.iter_mut() {
        let Some(player_e) = a.anim_player else { continue };
        if queue.requests.is_empty() && a.pending_plays.is_empty() {
            continue;
        }
        let Ok((mut player, mut transitions)) = players.get_mut(player_e) else { continue };
        let mut plays = std::mem::take(&mut queue.requests);
        plays.append(&mut std::mem::take(&mut a.pending_plays));
        for (name, fade) in plays {
            let Some(&node) = a.clip_nodes.get(&name) else {
                warn!("astraforge {}: no clip {name:?} in the model", a.passport.asset_id);
                continue;
            };
            let looping = a.clip_loops.get(&name).copied().unwrap_or(false);
            let anim = transitions.play(&mut player, node, Duration::from_secs_f32(fade));
            if looping {
                anim.repeat();
            }
        }
    }
}

/// Hot model reload, first half: when the .glb changed on disk, tell the asset server - the
/// spawner unloads/reloads the instances with the new asset; clearing the wiring state makes the
/// systems above remount and rewire everything that survived, same frame cadence, no restart.
fn watch_hot_reload(
    time: Res<Time>,
    mut clock: ResMut<HotReloadClock>,
    assets: Res<AssetServer>,
    mut q: Query<&mut AstraForgeAsset>,
) {
    if !clock.0.tick(time.delta()).just_finished() {
        return;
    }
    for mut a in q.iter_mut() {
        if !a.hot_reload {
            continue;
        }
        let fs_glb = Path::new("assets").join(&a.glb_path);
        let Ok(meta) = std::fs::metadata(&fs_glb) else { continue };
        let Ok(now) = meta.modified() else { continue };
        if a.mtime.is_some_and(|m| m != now) {
            a.mtime = Some(now);
            a.clip_nodes.clear();
            a.scene_root = None;    // the reload respawns the instance; resolve_scene_roots re-finds both
            a.anim_player = None;
            a.mounted_fx.clear();
            a.fx_pending_scale.clear();
            assets.reload(a.glb_path.clone());
            info!("astraforge {}: model changed on disk - reloading", a.passport.asset_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::passport::Passport;

    const RIGGED: &str = include_str!("../tests/fixtures/rigged_actor.af_bevy.json");

    #[test]
    fn passport_paths_become_bevy_asset_paths() {
        let (dir, placeholder) = bevy_paths("assets/astraforge/brass_lantern/af_bevy.json").unwrap();
        assert_eq!(dir, "astraforge/brass_lantern");
        assert!(placeholder.ends_with("model.glb"));
        let (dir2, _) = bevy_paths("assets\\astraforge\\lantern\\af_bevy.json").unwrap();
        assert_eq!(dir2, "astraforge/lantern", "Windows separators normalize");
        assert!(bevy_paths("assets/astraforge/x/x.json").is_err());
        assert!(bevy_paths("assets/astraforge/af_bevy.json").is_ok(), "a folderless layout still has a parent");
        let p = Passport::parse(RIGGED).unwrap();
        assert_eq!(glb_asset_path("astraforge/actor", &p), "astraforge/actor/model.glb");
    }

    #[test]
    fn clip_resolution_survives_renamed_imports_and_never_guesses() {
        let glb = ["idle-loop".to_string(), "attack".to_string(), "idle-extra.001".to_string()];
        assert_eq!(resolve_clip_index(&glb, "attack"), Some(1));
        assert_eq!(resolve_clip_index(&glb, "idle-loop"), Some(0));
        assert_eq!(resolve_clip_index(&glb, "idle"), Some(0), "stem fallback");
        assert_eq!(resolve_clip_index(&glb, "idle-extra"), Some(2), "stem fallback past a renamed twin");
        assert_eq!(resolve_clip_index(&glb, "attack.001"), Some(1), "exact-after-suffix fallback");
        assert_eq!(resolve_clip_index(&glb, "death"), None, "absent is absent");
        assert_eq!(resolve_clip_index(&glb, ""), None);
    }

    #[test]
    fn effects_track_bones_when_the_socket_has_one() {
        let p = Passport::parse(RIGGED).unwrap();
        let s = p.socket_node("socket_fx_gun").unwrap();
        assert_eq!(socket_track_target(s), "mixamorigSpine1");
        let mut bare = s.clone();
        bare.parent_bone.clear();
        assert_eq!(socket_track_target(&bare), "socket_fx_gun", "static socket: the node itself");
    }

    #[test]
    fn a_missing_passport_file_says_so() {
        let e = load_passport_file(Path::new("/nonexistent/af_bevy.json")).unwrap_err();
        assert!(e.contains("/nonexistent/af_bevy.json"), "{e}");
    }
}
