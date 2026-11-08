//! af_bevy_check — the headless package validator (0.6.10 wave ticket 30).
//!
//! Run by the studio's engine driver (`scripts/engines/bevy.mjs`) with cwd = a scaffold folder
//! whose `assets/astraforge/<slug>/` is the package being exported:
//!
//!     cargo run --quiet --features check --bin af_bevy_check -- --slug <slug> --out <dir>
//!
//! It boots the same plugin stack a user app would (minus the audio device, which a headless
//! box may not own), loads the passport through the crate's own loader, waits for the scene to
//! mount and its animations to wire, verifies the passport's promises against the live world,
//! captures preview frames through bevy's screenshot pass (a front frame, then a frame after a
//! clip switch), and prints one final `AFBEVY {json}` line. Exit code: 0 verified, 2 something
//! the passport promised is not true, 3 timed out. A machine without Rust or a GPU simply does
//! not run this: the package build never asked for either, and the studio says so (T2-3).

use astraforge_bevy::prelude::*;
use bevy::audio::AudioPlugin;
use bevy::prelude::*;
use bevy::render::view::screenshot::{save_to_disk, Capturing, Screenshot};
use bevy::window::{WindowPosition, WindowResolution};
use std::num::NonZero;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn main() {
    let mut slug = String::new();
    let mut out = PathBuf::from(".");
    let mut timeout = 150.0f32;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = || args.next().unwrap_or_default();
        match a.as_str() {
            "--slug" => slug = val(),
            "--out" => out = PathBuf::from(val()),
            "--timeout" => timeout = val().parse().unwrap_or(150.0),
            other => eprintln!("af_bevy_check: unknown argument {other:?}"),
        }
    }
    if slug.is_empty() {
        eprintln!("usage: af_bevy_check --slug <name> [--out <dir>] [--timeout <secs>]");
        std::process::exit(2);
    }
    let _ = std::fs::create_dir_all(out.join("shots"));

    let mut app = App::new();
    app.add_plugins(
        DefaultPlugins
            .build()
            .disable::<AudioPlugin>() // sounds check as files; a missing sound device is nobody's fault
            // The scaffold folder is cwd; bevy's default asset root would instead resolve
            // "assets" next to the crate that compiled this binary (here: the studio's own
            // folder), missing the package. Pin the root to where we are standing.
            .set(AssetPlugin {
                file_path: std::env::current_dir()
                    .map(|d| d.join("assets").display().to_string())
                    .unwrap_or_else(|_| "assets".into()),
                ..default()
            })
            .set(WindowPlugin {
                primary_window: Some(Window {
                    title: format!("af_bevy_check {slug}"),
                    // off-screen, like the Godot line's preview window: it renders, never flashes
                    position: WindowPosition::At(IVec2::new(-32000, -32000)),
                    resolution: WindowResolution::new(800, 600),
                    ..default()
                }),
                ..default()
            }),
    )
    .add_plugins(AstraForgeBevyPlugin)
    .add_astraforge_asset(format!("assets/astraforge/{slug}/af_bevy.json"))
    .insert_resource(CheckState {
        slug,
        out,
        deadline: Instant::now() + Duration::from_secs_f32(timeout),
        phase: Phase::Mount,
        shot: None,
        oneshot: None,
        next_at: None,
        checks: Vec::new(),
        shots: Vec::new(),
        forward: None,
        retries: 0,
    })
    .add_systems(Startup, check_scene)
    .add_systems(Update, check_machine);

    let code = match app.run() {
        AppExit::Success => 0,
        AppExit::Error(code) => code.get(),
    };
    std::process::exit(code as i32);
}

#[derive(Resource)]
struct CheckState {
    slug: String,
    out: PathBuf,
    deadline: Instant,
    phase: Phase,
    /// the screenshot in flight: (file, when it was asked for)
    shot: Option<(String, Instant)>,
    /// the clip queued for the second frame, taken when the Beat phase starts
    oneshot: Option<String>,
    /// when the next beat/shot is due
    next_at: Option<Instant>,
    checks: Vec<(&'static str, bool, String)>,
    shots: Vec<String>,
    /// the orientation record written to bevy_forward.json at finish (built at mount)
    forward: Option<serde_json::Value>,
    /// how many times forward.png was re-shot for looking flat (see Shot1)
    retries: u32,
}

#[derive(PartialEq, Clone, Copy)]
enum Phase { Mount, Settle, Shot1, Beat, Shot2, Done }

#[derive(Component)]
struct CheckCamera;

fn check_scene(mut commands: Commands) {
    commands.spawn((Camera3d::default(), CheckCamera,
        Transform::from_xyz(3.0, 2.0, 4.0).looking_at(Vec3::ZERO, Vec3::Y)));
    commands.spawn((DirectionalLight::default(),
        Transform::from_rotation(Quat::from_euler(EulerRot::XYZ, -0.7, -0.5, 0.0))));
}

/// The state machine: wait for the crate to mount + wire, give the renderer a settle beat,
/// shoot the front frame (re-shooting while it looks flat), queue the one-shot clip through
/// the crate's own play queue, shoot again after the blend, verify, print AFBEVY, exit.
fn check_machine(
    mut commands: Commands,
    mut state: ResMut<CheckState>,
    mut assets: Query<(Entity, &AstraForgeAsset, &mut AstraPlay)>,
    anim: Query<&AnimationPlayer>,
    names: Query<&Name>,
    capturing: Query<(), With<Capturing>>,
    mut camera: Query<&mut Transform, With<CheckCamera>>,
) {
    if state.phase == Phase::Done {
        return;
    }
    if Instant::now() > state.deadline {
        let info = match assets.single_mut() {
            Ok((_e, a, _)) => format!("asset: root={:?} player={:?} clip_nodes={} dead={} players={}",
                a.scene_root, a.anim_player, a.clip_nodes.len(), a.dead_instance, anim.iter().count()),
            Err(_) => "no AstraForgeAsset spawned".to_string(),
        };
        finish(&mut commands, &mut state, 3, &format!("timed out waiting for the package to load ({info})"));
        return;
    }

    match state.phase {
        Phase::Mount => {
            let Ok((_e, a, _play)) = assets.single_mut() else { return };
            if a.dead_instance {
                finish(&mut commands, &mut state, 2, "the GLB has no default scene to mount");
                return;
            }
            let Some(root) = a.scene_root else { return };       // the GLB is still loading
            if !a.passport.clips.is_empty() && a.clip_nodes.is_empty() { return; } // still wiring
            // frame the model the way the passport describes it
            if let Ok(mut t) = camera.single_mut() {
                let size = a.passport.scene.longest_m.max(0.2);
                *t = Transform::from_xyz(size * 1.8, size * 1.2, size * 2.2)
                    .looking_at(Vec3::new(0.0, size * 0.45, 0.0), Vec3::Y);
            }
            let p = &a.passport;
            state.checks.push(("scene_mounted", true, format!("{root:?}")));
            let unresolved: Vec<&str> = p.clips.iter()
                .filter(|c| !a.clip_nodes.contains_key(&c.name)).map(|c| c.name.as_str()).collect();
            state.checks.push(("clips_in_graph", unresolved.is_empty(), unresolved.join(", ")));
            let autostart = p.default_clip_index(None)
                .and_then(|i| p.clips.get(i))
                .and_then(|c| a.clip_nodes.get(&c.name).copied())
                .and_then(|node| a.anim_player.or(Some(root))
                    .and_then(|pe| anim.get(pe).ok().map(|pl| pl.is_playing_animation(node))))
                .unwrap_or(p.clips.is_empty());   // a static model has nothing to autostart
            state.checks.push(("default_clip_autostarts", autostart, p.default_clip.clone()));
            let nameless: Vec<&str> = p.sockets.iter()
                .filter(|s| s.node.is_empty()).map(|s| s.name.as_str()).collect();
            state.checks.push(("sockets_named", nameless.is_empty(), nameless.join(", ")));
            // effect mounts look sockets up by name in the mounted scene - they must be there
            let missing: Vec<&str> = p.sockets.iter().map(|s| s.node.as_str())
                .filter(|n| !n.is_empty() && names.iter().all(|nm| nm.as_str() != *n)).collect();
            state.checks.push(("sockets_found", missing.is_empty(), missing.join(", ")));
            state.oneshot = p.clips.iter().find(|c| !c.is_loop).map(|c| c.name.clone());
            // the orientation contract this check just proved live: the GLB ships untouched,
            // the crate spawns it unrotated, +Y is up - and the camera framed it by the
            // passport's own numbers, so those numbers are what the preview shows
            let size = p.scene.longest_m.max(0.2);
            state.forward = Some(serde_json::json!({
                "glb": p.glb,
                "up": "+Y",
                "forward": "-Z (glTF authored; the studio ships the GLB untouched and the crate spawns it unrotated)",
                "size_gltf_m": p.scene.size_gltf_m,
                "framed_from": [size * 1.8, size * 1.2, size * 2.2],
                "look_at": [0.0, size * 0.45, 0.0],
                "shots": ["shots/forward.png", "shots/clip.png"],
            }));
            // a cold shader pipeline paints nothing but clear colour for a second after the
            // instance mounts (the live run proved it): give the renderer a beat to settle
            state.next_at = Some(Instant::now() + Duration::from_millis(1500));
            state.phase = Phase::Settle;
        }
        Phase::Settle => {
            if state.next_at.is_some_and(|t| Instant::now() >= t) {
                trigger_shot(&mut commands, &mut state, "forward.png");
                state.phase = Phase::Shot1;
            }
        }
        Phase::Shot1 => {
            if shot_done(&mut state, &capturing) {
                // a flat 800x600 clear-colour PNG compresses to a few KB, a rendered scene to
                // tens: the size is the honest content gate (the live run calibrated it).
                if state.retries < 3 && is_flat_shot(&state, "forward.png") {
                    state.retries += 1;
                    eprintln!("af_bevy_check: forward frame still flat, re-shooting ({}/3)", state.retries);
                    state.next_at = Some(Instant::now() + Duration::from_millis(1500));
                    state.phase = Phase::Settle;
                    return;
                }
                if let Some(name) = state.oneshot.take() {
                    if let Ok((_e, _a, mut play)) = assets.single_mut() {
                        play.play(name, 0.2);   // the crate's own crossfade queue
                    }
                }
                state.next_at = Some(Instant::now() + Duration::from_millis(600));
                state.phase = Phase::Beat;
            }
        }
        Phase::Beat => {
            if state.next_at.is_some_and(|t| Instant::now() >= t) {
                trigger_shot(&mut commands, &mut state, "clip.png");
                state.phase = Phase::Shot2;
            }
        }
        Phase::Shot2 => {
            if shot_done(&mut state, &capturing) {
                finish(&mut commands, &mut state, 0, "");
            }
        }
        Phase::Done => {}
    }
}

/// bevy's screenshot pass is async: trigger it, then the Capturing marker says when it is gone.
fn trigger_shot(commands: &mut Commands, state: &mut CheckState, file: &str) {
    let path = state.out.join("shots").join(file);
    commands.spawn(Screenshot::primary_window())
        .observe(save_to_disk(path.display().to_string()));
    state.shot = Some((file.to_string(), Instant::now()));
}

fn shot_done(state: &mut CheckState, capturing: &Query<(), With<Capturing>>) -> bool {
    let Some((file, started)) = state.shot.clone() else { return true };
    if !capturing.is_empty() { return false; }
    let path = state.out.join("shots").join(&file);
    if path.exists() {
        let rel = format!("shots/{file}");   // a re-shoot overwrites the file, never double-lists it
        if !state.shots.contains(&rel) { state.shots.push(rel); }
        state.shot = None;
        true
    } else if started.elapsed() > Duration::from_secs(30) {
        state.checks.push(("screenshot", false, file));
        state.shot = None;
        true
    } else { false }
}

fn is_flat_shot(state: &CheckState, file: &str) -> bool {
    std::fs::metadata(state.out.join("shots").join(file)).map(|m| m.len() < 15_000).unwrap_or(false)
}

fn finish(commands: &mut Commands, state: &mut CheckState, code: u8, why: &str) {
    state.phase = Phase::Done;
    let ok = code == 0 && state.checks.iter().all(|(_, passed, _)| *passed);
    let checks: Vec<serde_json::Value> = state.checks.iter()
        .map(|(name, passed, detail)| serde_json::json!({"name": name, "ok": passed, "detail": detail}))
        .collect();
    let report = serde_json::json!({
        "ok": ok, "slug": state.slug, "code": code, "why": why,
        "shots": state.shots, "checks": checks,
    });
    println!("AFBEVY {}", serde_json::to_string(&report).unwrap_or_default());
    let _ = std::fs::write(state.out.join("bevy_check.json"),
        serde_json::to_string_pretty(&report).unwrap_or_default());
    if let Some(f) = &state.forward {
        let _ = std::fs::write(state.out.join("bevy_forward.json"),
            serde_json::to_string_pretty(f).unwrap_or_default());
    }
    let exit = if ok { AppExit::Success }
        else { AppExit::Error(NonZero::new(if code == 0 { 2 } else { code }).unwrap()) };
    commands.write_message(exit);
}
