//! The studio sound bank (`ima_sounds.json`): one folder per sent asset, `assets/imaginarium/
//! sounds/<slug>/`, with a manifest naming every clip the asset uses (the export line of ticket
//! 31 writes it; this reads it). Parsing is pure and unit-tested; playing is thin Bevy glue.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

pub const BANK_FORMAT_PREFIX: &str = "imaginarium-soundbank/";

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BankManifest {
    pub format: String,
    pub slug: String,
    #[serde(default)]
    pub sounds: Vec<BankSound>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BankSound {
    pub name: String,
    /// file inside the bank folder (ogg preferred - the studio transcodes what it ships)
    pub file: String,
    #[serde(default)]
    pub r#loop: bool,
    /// linear gain; absent means 1.0
    #[serde(default = "full")]
    pub gain: f32,
}

fn full() -> f32 {
    1.0
}

/// The bank in the app: what the manifest says, indexed for lookup, duplicated names keep the
/// first entry (the manifest is written by the studio, a duplicate is a packaging bug worth
/// knowing about, not silently dropping).
#[derive(Debug, Clone, Default)]
pub struct SoundBank {
    pub slug: String,
    entries: BTreeMap<String, BankSound>,
}

impl BankManifest {
    pub fn parse(text: &str) -> Result<Self, String> {
        let m: BankManifest = serde_json::from_str(text).map_err(|e| format!("ima_sounds.json: {e}"))?;
        if !m.format.starts_with(BANK_FORMAT_PREFIX) {
            return Err(format!("ima_sounds.json: format {:?}, expected {BANK_FORMAT_PREFIX}N", m.format));
        }
        if m.slug.is_empty() {
            return Err("ima_sounds.json: slug is empty".into());
        }
        Ok(m)
    }

    pub fn to_bank(&self) -> SoundBank {
        let mut entries = BTreeMap::new();
        for s in &self.sounds {
            entries.entry(s.name.clone()).or_insert_with(|| s.clone());
        }
        SoundBank { slug: self.slug.clone(), entries }
    }
}

impl SoundBank {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        BankManifest::parse(&text).map(|m| m.to_bank())
    }

    pub fn get(&self, name: &str) -> Option<&BankSound> {
        self.entries.get(name)
    }

    pub fn names(&self) -> impl Iterator<Item = &String> {
        self.entries.keys()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bank_folder_becomes_a_bevy_asset_path() {
        assert_eq!(bank_asset_dir("assets/imaginarium/sounds/brass_lantern/ima_sounds.json").as_deref(),
                   Some("imaginarium/sounds/brass_lantern"));
        assert_eq!(bank_asset_dir("imaginarium/sounds/x/ima_sounds.json").as_deref(),
                   Some("imaginarium/sounds/x"));
        assert_eq!(bank_asset_dir("assets/imaginarium/sounds/ima_sounds.json").as_deref(),
                   Some("imaginarium/sounds"));
        assert!(bank_asset_dir("assets/imaginarium/sounds/x/other.json").is_none());
    }
}

// ---------------------------------------------------------------- the running app's half

use bevy::audio::{PlaybackMode, Volume};
use bevy::prelude::*;

/// Bank folder in Bevy asset space: the parent of ima_sounds.json without the "assets/" prefix
/// (pure so it is unit-testable; the audio server loads "<dir>/<file>" from there).
pub fn bank_asset_dir(passport_path: &str) -> Option<String> {
    let normalized = passport_path.replace('\\', "/");
    let trimmed = normalized.strip_prefix("assets/").unwrap_or(&normalized);
    if Path::new(trimmed).file_name()?.to_str()? != "ima_sounds.json" {
        return None;
    }
    let dir = Path::new(trimmed).parent()?.to_string_lossy().replace('\\', "/");
    Some(dir)
}

/// A loaded bank plus where its files live in asset space.
pub struct LoadedBank {
    pub bank: SoundBank,
    pub asset_dir: String,
}

/// The loaded sound banks of the app, by slug.
#[derive(Resource, Default)]
pub struct ImaginariumSoundBanks {
    banks: std::collections::BTreeMap<String, LoadedBank>,
}

impl ImaginariumSoundBanks {
    /// Read an ima_sounds.json from disk (at startup, like the passports).
    pub fn load(&mut self, fs_path: &str) -> Result<(), String> {
        let bank = SoundBank::load(std::path::Path::new(fs_path))?;
        let asset_dir = bank_asset_dir(fs_path).ok_or_else(|| format!("{fs_path}: not an ima_sounds.json"))?;
        self.banks.insert(bank.slug.clone(), LoadedBank { bank, asset_dir });
        Ok(())
    }

    pub fn get(&self, slug: &str) -> Option<&LoadedBank> {
        self.banks.get(slug)
    }
}

/// Studio sound bank playback: spawn an entity with AudioPlayer + PlaybackSettings; the bank
/// manifest decides loop vs one-shot (one-shots despawn themselves when done).
pub struct ImaginariumSoundPlugin;

impl Plugin for ImaginariumSoundPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ImaginariumSoundBanks>();
    }
}

/// Play a bank sound; `at` turns on spatial audio at that transform. None answers loudly:
/// unknown bank or unknown sound name (a game typo should not be silent).
pub fn play_sound(
    commands: &mut Commands,
    banks: &ImaginariumSoundBanks,
    assets: &AssetServer,
    slug: &str,
    sound: &str,
    at: Option<Transform>,
) -> Option<Entity> {
    let loaded = banks.get(slug)?;
    let entry = loaded.bank.get(sound)?;
    let handle: Handle<AudioSource> = assets.load(format!("{}/{}", loaded.asset_dir, entry.file));
    let settings = PlaybackSettings {
        mode: if entry.r#loop { PlaybackMode::Loop } else { PlaybackMode::Despawn },
        volume: Volume::Linear(entry.gain.max(0.0)),
        spatial: at.is_some(),
        ..default()
    };
    let mut spawned = commands.spawn((AudioPlayer::new(handle), settings));
    if let Some(transform) = at {
        spawned.insert(transform);
    }
    Some(spawned.id().into())
}

#[cfg(test)]
mod bank_tests {
    use super::*;

    const BANK: &str = r#"{
      "format": "imaginarium-soundbank/1",
      "slug": "brass_lantern",
      "sounds": [
        {"name": "lantern_idle", "file": "lantern_idle.ogg", "loop": true, "gain": 0.7},
        {"name": "lantern_swing", "file": "lantern_swing.ogg", "gain": 1.0},
        {"name": "lantern_idle", "file": "duplicate.ogg"}
      ]
    }"#;

    #[test]
    fn a_bank_the_studio_wrote_indexes_by_name_first_wins() {
        let bank = BankManifest::parse(BANK).unwrap().to_bank();
        assert_eq!(bank.slug, "brass_lantern");
        assert_eq!(bank.len(), 2, "the duplicate keeps the first entry");
        let idle = bank.get("lantern_idle").unwrap();
        assert!(idle.r#loop);
        assert!((idle.gain - 0.7).abs() < f32::EPSILON);
        assert_eq!(idle.file, "lantern_idle.ogg");
        assert!(!bank.get("lantern_swing").unwrap().r#loop);
        assert_eq!(bank.names().map(|s| s.as_str()).collect::<Vec<_>>(), ["lantern_idle", "lantern_swing"]);
    }

    #[test]
    fn gain_defaults_to_full_and_bad_banks_answer_why() {
        let m = BankManifest::parse(r#"{"format":"imaginarium-soundbank/1","slug":"s","sounds":[{"name":"a","file":"a.ogg"}]}"#).unwrap();
        assert!((m.sounds[0].gain - 1.0).abs() < f32::EPSILON);
        assert!(BankManifest::parse(r#"{"format":"other/1","slug":"s"}"#).unwrap_err().contains("format"));
        assert!(BankManifest::parse(r#"{"format":"imaginarium-soundbank/1","slug":""}"#).unwrap_err().contains("slug"));
        assert!(BankManifest::parse("nope").is_err());
    }
}
