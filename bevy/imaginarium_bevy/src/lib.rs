//! Play Imaginarium game assets in [Bevy](https://bevy.org): one `add_imaginarium_asset` line
//! reads a studio package (GLB + `ima_bevy.json` passport) and gets you the model in-game with
//! its default clip autostarting, blended clip switching, socket-mounted effects, studio sound
//! banks and hot model reload while the editor stays open.
//!
//! ```no_run
//! use imaginarium_bevy::prelude::*;
//! use bevy::prelude::*;
//!
//! fn main() {
//!     App::new()
//!         .add_plugins(DefaultPlugins)
//!         .add_plugins(ImaginariumBevyPlugin)
//!         .add_imaginarium_asset("assets/imaginarium/brass_lantern/ima_bevy.json")
//!         .run();
//! }
//! ```

pub mod passport;
pub mod sound;
pub mod spawn;

pub use passport::Passport;
pub use sound::{ImaginariumSoundBanks, ImaginariumSoundPlugin, BankManifest, BankSound, SoundBank, play_sound};
pub use spawn::{ImaginariumAppExt, ImaginariumAsset, ImaginariumBevyPlugin, ImaginariumEffects, AstraPlay};

pub mod prelude {
    //! `use imaginarium_bevy::prelude::*;`
    pub use crate::passport::{Clip, Passport, Socket};
    pub use crate::sound::{ImaginariumSoundBanks, ImaginariumSoundPlugin, SoundBank, play_sound};
    pub use crate::spawn::{
        ImaginariumAppExt, ImaginariumAsset, ImaginariumBevyPlugin, ImaginariumEffects, AstraPlay,
    };
}
