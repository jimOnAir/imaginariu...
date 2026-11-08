//! Play AstraForge game assets in [Bevy](https://bevy.org): one `add_astraforge_asset` line
//! reads a studio package (GLB + `af_bevy.json` passport) and gets you the model in-game with
//! its default clip autostarting, blended clip switching, socket-mounted effects, studio sound
//! banks and hot model reload while the editor stays open.
//!
//! ```no_run
//! use astraforge_bevy::prelude::*;
//! use bevy::prelude::*;
//!
//! fn main() {
//!     App::new()
//!         .add_plugins(DefaultPlugins)
//!         .add_plugins(AstraForgeBevyPlugin)
//!         .add_astraforge_asset("assets/astraforge/brass_lantern/af_bevy.json")
//!         .run();
//! }
//! ```

pub mod passport;
pub mod sound;
pub mod spawn;

pub use passport::Passport;
pub use sound::{AstraForgeSoundBanks, AstraForgeSoundPlugin, BankManifest, BankSound, SoundBank, play_sound};
pub use spawn::{AstraForgeAppExt, AstraForgeAsset, AstraForgeBevyPlugin, AstraForgeEffects, AstraPlay};

pub mod prelude {
    //! `use astraforge_bevy::prelude::*;`
    pub use crate::passport::{Clip, Passport, Socket};
    pub use crate::sound::{AstraForgeSoundBanks, AstraForgeSoundPlugin, SoundBank, play_sound};
    pub use crate::spawn::{
        AstraForgeAppExt, AstraForgeAsset, AstraForgeBevyPlugin, AstraForgeEffects, AstraPlay,
    };
}
