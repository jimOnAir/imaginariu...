//! Imaginarium starter: the plugin reads each package's passport and puts the model in the world
//! with its default clip already playing. This main sets up camera, light and ground, loads one
//! asset (change the path or call add_imaginarium_asset once per package the studio sent) and
//! installs the starter player controller from player.rs.

use imaginarium_bevy::prelude::*;
use bevy::prelude::*;
mod player;

fn main() {
    App::new()
        .add_plugins(DefaultPlugins)
        .add_plugins((ImaginariumBevyPlugin, ImaginariumSoundPlugin))
        // the studio's "send" verb put the package here; hot reload is on by default
        .add_imaginarium_asset("assets/imaginarium/brass_lantern/ima_bevy.json")
        // sound banks load at startup like passports (ima_sounds.json, per sent asset)
        // .world_mut().resource_mut::<ImaginariumSoundBanks>().load("assets/imaginarium/sounds/brass_lantern/ima_sounds.json");
        .add_systems(Startup, setup)
        .add_systems(Update, player::control)
        .run();
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    commands.spawn((Camera3d::default(), Transform::from_xyz(0.0, 1.6, 4.0).looking_to(Vec3::new(0.0, 0.8, -1.0), Vec3::Y)));
    commands.spawn((
        DirectionalLight::default(),
        Transform::from_rotation(Quat::from_euler(EulerRot::XYZ, -0.8, -0.4, 0.0)),
    ));
    commands.spawn((
        Mesh3d(meshes.add(Plane3d::default().mesh().size(20.0, 20.0))),
        MeshMaterial3d(materials.add(StandardMaterial::from_color(Color::srgb(0.2, 0.2, 0.24)))),
        Transform::default(),
    ));
    // the studio positions assets at the world origin; move the entity add_imaginarium_asset
    // spawned (it carries ImaginariumAsset) wherever your game wants it.
}
