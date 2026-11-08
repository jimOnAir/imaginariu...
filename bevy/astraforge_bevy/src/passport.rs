//! Reading the `af_bevy.json` passport an AstraForge package ships with (the asset contract of
//! the Bevy export line). The shapes mirror the Python writer (`steps/_bevy_lib.py`) exactly:
//! clip names are the GLB animation names as shipped, `seconds` come from the sampler spans,
//! `gltf` is reserved (null for the binary packages the studio produces today).

use serde::Deserialize;

pub const FORMAT_PREFIX: &str = "astraforge-bevy-package/";

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Passport {
    pub format: String,
    pub asset_id: String,
    #[serde(default)]
    pub kind: String,
    /// file name of the model inside the package folder, e.g. "model.glb"
    pub glb: String,
    /// reserved for future multi-file glTF packages; binary packages carry null
    #[serde(default)]
    pub gltf: Option<String>,
    #[serde(default)]
    pub clips: Vec<Clip>,
    #[serde(default)]
    pub default_clip: String,
    #[serde(default)]
    pub sockets: Vec<Socket>,
    #[serde(default)]
    pub collider: Collider,
    #[serde(default)]
    pub collision_meshes: Vec<String>,
    #[serde(default)]
    pub fx: Vec<Fx>,
    /// file name of the presets table inside the package folder, when the asset has effects
    #[serde(default)]
    pub fx_presets: Option<String>,
    #[serde(default)]
    pub rig: Rig,
    #[serde(default)]
    pub scene: SceneInfo,
    /// names of the build checks the package passed (informational)
    #[serde(default)]
    pub checks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Clip {
    pub name: String,
    /// `loop` is a Rust keyword: field is_loop, contract key is loop
    #[serde(rename = "loop")]
    pub is_loop: bool,
    #[serde(default)]
    pub seconds: f32,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Socket {
    pub name: String,
    /// the node in the GLB scene the socket hangs off (children lookup starts from here)
    #[serde(default)]
    pub node: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub parent: String,
    #[serde(default)]
    pub parent_bone: String,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct Collider {
    /// none | box | capsule | mesh | hulls
    #[serde(default)]
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Fx {
    pub preset: String,
    /// already faned out over real socket names by the packer (never contains '*')
    #[serde(default)]
    pub socket: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Rig {
    /// skinned | static
    #[serde(rename = "type", default)]
    pub rig_type: String,
    #[serde(default)]
    pub armatures: usize,
    #[serde(default)]
    pub bones: usize,
}

impl Default for Rig {
    fn default() -> Self {
        Rig { rig_type: "static".into(), armatures: 0, bones: 0 }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct SceneInfo {
    /// size in the glTF coordinate space (x, y, z), meters
    #[serde(default)]
    pub size_gltf_m: [f32; 3],
    #[serde(default)]
    pub longest_m: f32,
    #[serde(default)]
    pub tris: usize,
    #[serde(default)]
    pub meshes: usize,
}

impl Passport {
    /// Parse and sanity-check: right format family, and the glb file name must exist to load.
    pub fn parse(text: &str) -> Result<Self, String> {
        let p: Passport = serde_json::from_str(text).map_err(|e| format!("af_bevy.json: {e}"))?;
        if !p.format.starts_with(FORMAT_PREFIX) {
            return Err(format!("af_bevy.json: format {:?}, expected {FORMAT_PREFIX}N", p.format));
        }
        if p.glb.is_empty() {
            return Err("af_bevy.json: glb is empty".into());
        }
        Ok(p)
    }

    /// The clip to autostart, or the first one, mirroring the studio ladder so the game and the
    /// preview frame agree: a requested name, else idle, else the first loop, else the first.
    pub fn default_clip_index(&self, requested: Option<&str>) -> Option<usize> {
        if self.clips.is_empty() {
            return None;
        }
        let find = |want: &dyn Fn(&Clip) -> bool| self.clips.iter().position(|c| want(c));
        if let Some(req) = requested.filter(|r| !r.is_empty()) {
            if let Some(i) = find(&|c| c.name == req) {
                return Some(i);
            }
            let stem = req.split('-').next().unwrap_or(req);
            if let Some(i) = find(&|c| c.name.split('-').next() == Some(stem)) {
                return Some(i);
            }
        }
        if !self.default_clip.is_empty()
            && let Some(i) = find(&|c| c.name == self.default_clip)
        {
            return Some(i);
        }
        find(&|c| c.name.split('-').next() == Some("idle")).or_else(|| find(&|c| c.is_loop)).or(Some(0))
    }

    /// Directory part of a socket node path: Bevy addresses spawned scene children by node name.
    pub fn socket_node(&self, name: &str) -> Option<&Socket> {
        self.sockets.iter().find(|s| s.name == name || s.node == name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &str = include_str!("../tests/fixtures/brass_lantern.af_bevy.json");
    const RIGGED: &str = include_str!("../tests/fixtures/rigged_actor.af_bevy.json");

    #[test]
    fn parses_a_passport_the_studio_actually_wrote() {
        let p = Passport::parse(REAL).expect("the static demo passport parses");
        assert_eq!(p.asset_id, "brass_lantern_demo");
        assert_eq!(p.glb, "model.glb");
        assert!(p.clips.is_empty());
        assert_eq!(p.collider.kind, "box");
        assert_eq!(p.rig.rig_type, "static");
        assert!(!p.checks.is_empty());
        // the gltf key exists and is null on binary packages
        assert_eq!(p.gltf, None);
    }

    #[test]
    fn parses_the_full_contract_and_the_loop_keyword_field() {
        let p = Passport::parse(RIGGED).expect("the rigged fixture parses");
        assert_eq!(p.clips.len(), 3);
        assert!(p.clips[0].is_loop && p.clips[0].name == "idle-loop");
        assert!(!p.clips[2].is_loop && p.clips[2].name == "death");
        assert_eq!(p.sockets[0].parent_bone, "mixamorigSpine1");
        assert_eq!(p.collider.kind, "hulls");
        assert_eq!(p.collision_meshes, ["COL_Body", "hand-colonly"]);
        assert_eq!(p.fx.len(), 2);
        assert_eq!(p.fx[0].preset, "fire");
        assert_eq!(p.fx_presets.as_deref(), Some("fx_presets.json"));
        assert_eq!(p.rig.rig_type, "skinned");
        assert!(p.scene.longest_m > 1.0);
    }

    #[test]
    fn default_clip_ladder_never_invents_a_clip() {
        let p = Passport::parse(RIGGED).unwrap();
        assert_eq!(p.default_clip_index(None), Some(0)); // passport says idle-loop
        assert_eq!(p.default_clip_index(Some("attack")), Some(1)); // an explicit request wins
        assert_eq!(p.default_clip_index(Some("attack-2")), Some(1), "stem fallback");
        assert_eq!(p.default_clip_index(Some("nope")), Some(0), "unknown request falls back to the passport default");
        let s = Passport::parse(REAL).unwrap();
        assert_eq!(s.default_clip_index(None), None, "no clips, no index");
    }

    #[test]
    fn bad_documents_answer_with_what_is_wrong() {
        assert!(Passport::parse("{}").is_err(), "missing required keys must fail");
        let e = Passport::parse(r#"{"format":"other/1","asset_id":"a","glb":"m.glb"}"#).unwrap_err();
        assert!(e.contains("format"), "{e}");
        let e = Passport::parse(r#"{"format":"astraforge-bevy-package/1","asset_id":"a","glb":""}"#).unwrap_err();
        assert!(e.contains("glb"), "{e}");
    }

    #[test]
    fn socket_lookup_answers_by_contract_name_or_node() {
        let p = Passport::parse(RIGGED).unwrap();
        assert_eq!(p.socket_node("socket_fx_gun").unwrap().name, "socket_fx_gun");
        assert!(p.socket_node("socket_fx_laser").is_some(), "the masked fx row landed on a real socket");
        assert!(p.socket_node("ghost").is_none());
    }
}
