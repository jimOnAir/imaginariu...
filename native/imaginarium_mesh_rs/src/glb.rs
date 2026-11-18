//! The GLB carrier: read a binary glTF, collapse every triangle primitive with the vendored
//! simplifier, write the file back with the carry-contract intact (wave ticket 46).
//!
//! Shape of the rewrite (deliberately conservative, so untouched data stays literally
//! untouched):
//!
//! - the JSON chunk is loaded into `gltf::json::Root` and patched in place; materials, nodes,
//!   skins, animations, cameras, images and every unpatched accessor keep their bytes and
//!   `extensions`/`extras` exactly as loaded (the `gltf` crate is built with the `names` +
//!   `extras` features so those fields survive the serde round trip);
//! - new geometry bytes are APPENDED after the original GLB buffer contents — every accessor
//!   that was not patched (another mesh, an animation input, a skin matrix) keeps pointing at
//!   valid data, because the original bytes never move;
//! - survivors are compacted into fresh accessors: every vertex attribute (rig joints and
//!   weights, colours, UVs, custom EXTRAS_*, morph target deltas) is gathered as raw byte rows
//!   — component-type agnostic, bit-exact. Accessor min/max are recomputed exactly (typed over
//!   the survivor rows) wherever the input carried them;
//! - anything the carrier cannot read is refused with a reason the user can act on: sparse
//!   accessors, primitive `extensions` (compressed meshes), external/base64 buffers,
//!   non-triangle modes, counts that disagree. A refusal is a non-zero exit with NO output
//!   file: the caller restores from its own copy and keeps its fallback.
//!
//! glTF has no face-level attributes, so `carried.dropped` in the summary is the honest note
//! list (kept primitives with reasons); every real vertex attribute lands in `carried`.

use std::collections::{BTreeMap, BTreeSet};

use gltf::json;
use gltf::json::accessor::{ComponentType, GenericComponentType, Type as AType};
use gltf::json::mesh::Semantic;
use gltf::json::validation::{Checked, USize64};

use crate::simplify;

/// What happened to one primitive during the run.
#[derive(Debug)]
pub struct PrimReport {
    pub mesh: usize,
    pub primitive: usize,
    pub triangles_before: usize,
    pub triangles_after: usize,
    pub vertices_before: usize,
    pub vertices_after: usize,
    /// "collapsed" or "kept: <reason>".
    pub action: String,
    /// The meshoptimizer relative error of the collapse (0 when the primitive was kept).
    pub error: f32,
}

/// The `--json` payload of a successful run.
#[derive(Debug)]
pub struct Summary {
    pub primitives: Vec<PrimReport>,
    /// Every vertex attribute semantic the carrier copied through (sorted, deduplicated).
    pub carried: Vec<String>,
    /// Honest notes: kept primitives and their reasons (glTF carries nothing per-face).
    pub dropped: Vec<String>,
    /// Worst reported collapse error across the collapsed primitives.
    pub max_error: f32,
}

/// Load a GLB into its JSON root and BIN bytes; anything but one internal buffer over
/// glTF 2.0 is refused with a reason.
pub fn load(bytes: &[u8]) -> Result<(json::Root, Vec<u8>), String> {
    if !bytes.starts_with(b"glTF") {
        return Err(
            "not a GLB file (no 'glTF' magic) — af-mesh takes the studio's .glb files".into(),
        );
    }
    let glb = gltf::binary::Glb::from_slice(bytes).map_err(|e| format!("broken GLB: {e}"))?;
    let root: json::Root = json::deserialize::from_slice(glb.json.as_ref())
        .map_err(|e| format!("broken GLB JSON chunk: {e}"))?;
    if root.asset.version != "2.0" {
        return Err(format!(
            "glTF asset.version '{}' is not 2.0",
            root.asset.version
        ));
    }
    let bin = glb.bin.map(|b| b.into_owned()).unwrap_or_default();
    single_internal_buffer(&root)?;
    Ok((root, bin))
}

fn single_internal_buffer(root: &json::Root) -> Result<(), String> {
    if root.buffers.is_empty() {
        return Err("the file declares no buffer".into());
    }
    if root.buffers.len() > 1 || root.buffers[0].uri.is_some() {
        return Err(
            "the file references external or base64 buffers; af-mesh carries the single \
                    internal GLB buffer only"
                .into(),
        );
    }
    Ok(())
}

/// Collapse the file's triangle primitives towards `target_total_tris` triangles (the whole
/// file, distributed over primitives proportionally to their triangle counts).
/// Returns the complete new GLB bytes — the caller writes them only after this succeeded, so a
/// refusal never leaves a half-written output behind.
pub fn simplify_glb(
    root: &mut json::Root,
    bin: &[u8],
    target_total_tris: usize,
) -> Result<(Vec<u8>, Summary), String> {
    single_internal_buffer(root)?;
    let total = count_triangles(root);
    let mut summary = Summary {
        primitives: Vec::new(),
        carried: Vec::new(),
        dropped: Vec::new(),
        max_error: 0.0,
    };
    let mut rw = Rewriter {
        bin,
        base: (bin.len() + 3) & !3,
        appended: Vec::new(),
        carried: BTreeSet::new(),
    };

    for mi in 0..root.meshes.len() {
        let prims = root.meshes[mi].primitives.len();
        for pi in 0..prims {
            let outcome = rw.primitive(root, mi, pi, target_total_tris, total)?;
            if outcome.note.contains("kept") {
                summary
                    .dropped
                    .push(format!("mesh {mi} primitive {pi}: {}", outcome.note));
            }
            if outcome.error > summary.max_error {
                summary.max_error = outcome.error;
            }
            summary.primitives.push(PrimReport {
                mesh: mi,
                primitive: pi,
                triangles_before: outcome.triangles_before,
                triangles_after: outcome.triangles_after,
                vertices_before: outcome.vertices_before,
                vertices_after: outcome.vertices_after,
                action: outcome.action,
                error: outcome.error,
            });
        }
    }
    if summary.primitives.is_empty() {
        return Err("the file contains no mesh primitives".into());
    }
    summary.carried = rw.carried.into_iter().collect();

    // Rebuild the BIN chunk: original bytes verbatim (the new appends start at the 4-aligned
    // offset the GLB chunk already enforces), then everything the collapse wrote.
    let mut new_bin = Vec::with_capacity(rw.base + rw.appended.len());
    new_bin.extend_from_slice(bin);
    new_bin.resize(rw.base, 0);
    new_bin.extend_from_slice(&rw.appended);
    root.buffers[0].byte_length = USize64::from(new_bin.len());

    let json_bytes =
        json::serialize::to_string(root).map_err(|e| format!("serializing the JSON chunk: {e}"))?;
    let out = gltf::binary::Glb {
        header: gltf::binary::Header {
            magic: *b"glTF",
            version: 2,
            length: 0,
        }, // to_vec computes it
        json: std::borrow::Cow::Owned(json_bytes.into_bytes()),
        bin: Some(std::borrow::Cow::Owned(new_bin)),
    }
    .to_vec()
    .map_err(|e| format!("writing the GLB: {e}"))?;
    Ok((out, summary))
}

fn count_triangles(root: &json::Root) -> usize {
    root.meshes
        .iter()
        .flat_map(|m| m.primitives.iter())
        .map(|prim| match prim.indices {
            Some(idx) => root.accessors[idx.value()].count.0 as usize / 3,
            None => prim
                .attributes
                .iter()
                .find(|(s, _)| checked_semantic(s).as_deref() == Some("POSITION"))
                .map_or(0, |(_, acc)| {
                    root.accessors[acc.value()].count.0 as usize / 3
                }),
        })
        .sum()
}

struct Outcome {
    triangles_before: usize,
    triangles_after: usize,
    vertices_before: usize,
    vertices_after: usize,
    action: String,
    note: String,
    error: f32,
}

struct Rewriter<'a> {
    bin: &'a [u8],
    /// Offset inside the NEW buffer where `appended` lands (4-aligned after the original).
    base: usize,
    appended: Vec<u8>,
    carried: BTreeSet<String>,
}

impl<'a> Rewriter<'a> {
    fn primitive(
        &mut self,
        root: &mut json::Root,
        mi: usize,
        pi: usize,
        target_total: usize,
        total: usize,
    ) -> Result<Outcome, String> {
        let here = format!("mesh {mi} primitive {pi}");
        let prim = &root.meshes[mi].primitives[pi];
        if !matches!(prim.mode, Checked::Valid(json::mesh::Mode::Triangles)) {
            return Err(format!(
                "{here}: the primitive mode is not TRIANGLES; af-mesh collapses triangles only"
            ));
        }
        if prim.extensions.is_some() {
            return Err(format!(
                "{here}: the primitive carries extensions (mesh compression); af-mesh \
                               cannot read them — unpack the file first or keep the fallback"
            ));
        }

        // --- attribute inventory (everything is verified before anything is mutated) ------
        let mut attributes: BTreeMap<String, usize> = BTreeMap::new();
        for (sem, acc) in &prim.attributes {
            let name = checked_semantic(sem)
                .ok_or_else(|| format!("{here}: attribute semantic '{sem:?}' is not readable"))?;
            if attributes.insert(name, acc.value()).is_some() {
                return Err(format!("{here}: duplicate attribute"));
            }
        }
        let position = *attributes
            .get("POSITION")
            .ok_or_else(|| format!("{here}: no POSITION attribute"))?;
        let (positions, vertex_count) = self.read_f32(root, position, &here)?;
        let acc = &root.accessors[position];
        if !matches!(acc.type_, Checked::Valid(AType::Vec3))
            || !matches!(
                acc.component_type,
                Checked::Valid(GenericComponentType(ComponentType::F32))
            )
        {
            return Err(format!(
                "{here}: POSITION must be VEC3 of FLOAT32 (the glTF spec rule)"
            ));
        }
        let names: Vec<String> = attributes.keys().cloned().collect();
        for name in &names {
            let acc = &root.accessors[attributes[name]];
            if acc.count.0 as usize != vertex_count {
                return Err(format!(
                    "{here}: {name} covers {} vertices, POSITION covers {vertex_count}",
                    acc.count.0
                ));
            }
        }

        let morphs = prim.targets.clone().unwrap_or_default();
        let mut morph_accessors: Vec<usize> = Vec::new();
        for t in &morphs {
            for (label, idx) in [
                ("POSITION", t.positions),
                ("NORMAL", t.normals),
                ("TANGENT", t.tangents),
            ] {
                let Some(idx) = idx else { continue };
                let acc = &root.accessors[idx.value()];
                if acc.count.0 as usize != vertex_count {
                    return Err(format!(
                        "{here}: morph {label} covers {} vertices, POSITION covers {vertex_count}",
                        acc.count.0
                    ));
                }
                morph_accessors.push(idx.value());
            }
        }

        let indices = match prim.indices {
            Some(idx) => self.read_u32s(root, idx.value(), &here)?,
            None => {
                if vertex_count % 3 != 0 {
                    return Err(format!("{here}: a non-indexed primitive covers {vertex_count} vertices, not a multiple of 3"));
                }
                (0..vertex_count as u32).collect()
            }
        };
        if indices.len() % 3 != 0 {
            return Err(format!(
                "{here}: {} indices do not form a triangle list",
                indices.len()
            ));
        }
        let triangles_before = indices.len() / 3;
        let base = Outcome {
            triangles_before,
            triangles_after: triangles_before,
            vertices_before: vertex_count,
            vertices_after: vertex_count,
            action: String::new(),
            note: String::new(),
            error: 0.0,
        };
        if triangles_before == 0 {
            return Ok(Outcome {
                action: "kept: empty primitive".into(),
                note: "kept: empty primitive".into(),
                ..base
            });
        }
        let target = target_total.min(total) * triangles_before / total.max(1);
        if target == 0 {
            return Ok(Outcome {
                action: format!(
                    "kept: its share of the {target_total}-triangle budget rounds to nil"
                ),
                note: format!(
                    "kept: its share of the {target_total}-triangle budget rounds to nil"
                ),
                ..base
            });
        }
        if target >= triangles_before {
            return Ok(Outcome {
                action: "kept: already under the target".into(),
                note: "kept: already under the target".into(),
                ..base
            });
        }

        // --- metric streams (which collapses hurt least) ---------------------------------
        // Float attributes only; the pinned header caps attribute_count at 32 floats per
        // vertex, so streams join in this priority order until the cap is full. Weights keep
        // each stream in the position error's units: normals and morph deltas are unit vectors
        // / position offsets (weight 1.0), colours and UVs are dimensionless 0..1 gradients
        // whose every step would otherwise block a geometrically free collapse (weight 0.01 —
        // one step of a texture ramp then reads as one percent of the position budget, while
        // a real discontinuity, delta ~1, still costs more than the whole error budget).
        // Skin weights in-between: rig boundaries matter, their interpolation noise less so.
        let mut streams: Vec<(Vec<f32>, f32)> = Vec::new();
        let mut used_floats = 0usize;
        for (name, weight) in [
            ("NORMAL", 1.0f32),
            ("COLOR_0", 0.01),
            ("WEIGHTS_0", 0.1),
            ("TEXCOORD_0", 0.01),
        ] {
            let Some(&ai) = attributes.get(name) else {
                continue;
            };
            if let Ok((values, _)) = self.read_f32(root, ai, &here) {
                let per = values.len() / vertex_count;
                if used_floats + per <= simplify::MAX_ATTR_FLOATS {
                    streams.push((values, weight));
                    used_floats += per;
                }
            }
        }
        for t in &morphs {
            if let Some(idx) = t.positions {
                // position deltas carry the shape-key geometry
                if let Ok((values, _)) = self.read_f32(root, idx.value(), &here) {
                    let per = values.len() / vertex_count;
                    if used_floats + per <= simplify::MAX_ATTR_FLOATS {
                        streams.push((values, 1.0));
                        used_floats += per;
                    }
                }
            }
        }
        // The FFI wants attribute_count floats FOR EACH VERTEX — interleave the streams.
        let mut metric = vec![0.0f32; vertex_count * used_floats];
        let mut metric_weights = Vec::with_capacity(used_floats);
        {
            let mut column = 0usize;
            for (values, weight) in &streams {
                let per = values.len() / vertex_count;
                for v in 0..vertex_count {
                    metric[v * used_floats + column..v * used_floats + column + per]
                        .copy_from_slice(&values[v * per..(v + 1) * per]);
                }
                metric_weights.extend(std::iter::repeat_n(*weight, per));
                column += per;
            }
        }

        let collapsed = match simplify::simplify(
            &positions,
            used_floats,
            &metric,
            &metric_weights,
            &indices,
            target,
        ) {
            Some(c) if c.indices.len() < indices.len() => c,
            _ => {
                let why = "kept: the simplifier declined this shape".to_string();
                return Ok(Outcome {
                    note: why.clone(),
                    action: why,
                    ..base
                });
            }
        };

        // --- survivor rows into fresh accessors --------------------------------------------
        let survivors = collapsed.source_vertex.clone();
        let mut new_attrs: Vec<(String, json::Index<json::Accessor>)> = Vec::new();
        for name in &names {
            let ai = attributes[name];
            let (ct, type_, normalized, src_name, src_extras, had_bounds) = {
                let src = &root.accessors[ai];
                let ct = checked(src.component_type.map_gtc())
                    .ok_or_else(|| format!("{here}: {name} has an unreadable component type"))?;
                let type_ = match src.type_ {
                    Checked::Valid(t) => t,
                    Checked::Invalid => {
                        return Err(format!("{here}: {name} has an unreadable accessor type"))
                    }
                };
                (
                    ct,
                    type_,
                    src.normalized,
                    src.name.clone(),
                    src.extras.clone(),
                    src.min.is_some() && src.max.is_some(),
                )
            };
            let rows = self.gather_rows(root, ai, &survivors, &here)?;
            let minmax = if had_bounds {
                Some(
                    typed_minmax(ct, type_comps(type_), &rows)
                        .ok_or_else(|| format!("{here}: {name} survivor bounds"))?,
                )
            } else {
                None
            };
            let view = self.push_view(root, &rows, json::buffer::Target::ArrayBuffer);
            new_attrs.push((
                name.clone(),
                push_accessor(
                    root,
                    view,
                    survivors.len(),
                    ct,
                    type_,
                    normalized,
                    src_name,
                    minmax,
                    &src_extras,
                ),
            ));
            self.carried.insert(name.clone());
        }

        let mut new_morphs = Vec::new();
        for t in &morphs {
            let mut target = json::mesh::MorphTarget {
                positions: None,
                normals: None,
                tangents: None,
            };
            for (slot, out, label) in [
                (&t.positions, &mut target.positions, "POSITION"),
                (&t.normals, &mut target.normals, "NORMAL"),
                (&t.tangents, &mut target.tangents, "TANGENT"),
            ] {
                let Some(src_idx) = slot else { continue };
                let (ct, normalized, src_name, src_extras, had_bounds, src_idx) = {
                    let src = &root.accessors[src_idx.value()];
                    (
                        checked(src.component_type.map_gtc())
                            .ok_or_else(|| format!("{here}: morph {label} component type"))?,
                        src.normalized,
                        src.name.clone(),
                        src.extras.clone(),
                        src.min.is_some() && src.max.is_some(),
                        src_idx.value(),
                    )
                };
                let rows = self.gather_rows(root, src_idx, &survivors, &here)?;
                let minmax = if had_bounds {
                    typed_minmax(ct, 3, &rows)
                } else {
                    None
                };
                let view = self.push_view(root, &rows, json::buffer::Target::ArrayBuffer);
                *out = Some(push_accessor(
                    root,
                    view,
                    survivors.len(),
                    ct,
                    AType::Vec3,
                    normalized,
                    src_name,
                    minmax,
                    &src_extras,
                ));
            }
            new_morphs.push(target);
        }

        // --- the new index accessor ----------------------------------------------------------
        let mut index_bytes = Vec::with_capacity(collapsed.indices.len() * 4);
        for &i in &collapsed.indices {
            index_bytes.extend_from_slice(&i.to_le_bytes());
        }
        let index_view =
            self.push_view(root, &index_bytes, json::buffer::Target::ElementArrayBuffer);
        let index_accessor = root.push(json::Accessor {
            buffer_view: Some(index_view),
            byte_offset: Some(USize64(0)),
            count: USize64::from(collapsed.indices.len()),
            component_type: Checked::Valid(GenericComponentType(ComponentType::U32)),
            extensions: Default::default(),
            extras: Default::default(),
            type_: Checked::Valid(AType::Scalar),
            min: None,
            max: None,
            name: None,
            normalized: false,
            sparse: None,
        });

        // --- patch the primitive (mutation happens only after every fallible step) -----------
        let prim = &mut root.meshes[mi].primitives[pi];
        let mut attrs_map = BTreeMap::new();
        for (name, index) in new_attrs {
            let sem = semantic_of(&name)
                .ok_or_else(|| format!("{here}: cannot rebuild the {name} semantic"))?;
            attrs_map.insert(Checked::Valid(sem), index);
        }
        prim.attributes = attrs_map;
        prim.indices = Some(index_accessor);
        if !new_morphs.is_empty() {
            prim.targets = Some(new_morphs);
        }

        Ok(Outcome {
            triangles_after: collapsed.indices.len() / 3,
            vertices_after: survivors.len(),
            action: "collapsed".into(),
            note: String::new(),
            error: collapsed.error,
            ..base
        })
    }

    fn push_view(
        &mut self,
        root: &mut json::Root,
        bytes: &[u8],
        target: json::buffer::Target,
    ) -> json::Index<json::buffer::View> {
        let offset = self.base + self.appended.len();
        self.appended.extend_from_slice(bytes);
        while !self.appended.len().is_multiple_of(4) {
            self.appended.push(0);
        }
        root.push(json::buffer::View {
            buffer: json::Index::new(0), // single_internal_buffer() guarantees buffer 0 is THE buffer
            byte_length: USize64::from(bytes.len()),
            byte_offset: Some(USize64::from(offset)),
            byte_stride: None,
            extensions: Default::default(),
            extras: Default::default(),
            name: None,
            target: Some(Checked::Valid(target)),
        })
    }

    /// Dense f32 vector accessor → values; Err for anything that is not dense f32.
    fn read_f32(
        &self,
        root: &json::Root,
        ai: usize,
        here: &str,
    ) -> Result<(Vec<f32>, usize), String> {
        let acc = &root.accessors[ai];
        let type_ = match acc.type_ {
            Checked::Valid(t) => t,
            Checked::Invalid => fail(here, "unreadable accessor type")?,
        };
        match acc.component_type {
            Checked::Valid(GenericComponentType(ComponentType::F32)) => {}
            _ => fail(here, "not an f32 accessor")?,
        }
        if !matches!(
            type_,
            AType::Scalar | AType::Vec2 | AType::Vec3 | AType::Vec4
        ) {
            return Err(format!(
                "{here}: f32 metric needs a scalar or vector accessor"
            ));
        }
        let (base, stride, elem) = self.locate(root, ai, here)?;
        let comps = type_comps(type_);
        let count = acc.count.0 as usize;
        let mut values = Vec::with_capacity(count * comps);
        for v in 0..count {
            let row = &base[v * stride..v * stride + elem];
            for c in 0..comps {
                values.push(f32::from_le_bytes(
                    row[c * 4..c * 4 + 4]
                        .try_into()
                        .expect("4 bytes checked by locate"),
                ));
            }
        }
        Ok((values, count))
    }

    fn read_u32s(&self, root: &json::Root, ai: usize, here: &str) -> Result<Vec<u32>, String> {
        let acc = &root.accessors[ai];
        let ct = match acc.component_type {
            Checked::Valid(GenericComponentType(c)) => c,
            Checked::Invalid => fail(here, "unreadable index component type")?,
        };
        if !matches!(acc.type_, Checked::Valid(AType::Scalar)) {
            return Err(format!("{here}: the index accessor is not SCALAR"));
        }
        let (base, stride, elem) = self.locate(root, ai, here)?;
        let count = acc.count.0 as usize;
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let row = &base[i * stride..i * stride + elem];
            out.push(match ct {
                ComponentType::U8 => row[0] as u32,
                ComponentType::U16 => {
                    u16::from_le_bytes(row[..2].try_into().expect("2 bytes checked by locate"))
                        as u32
                }
                ComponentType::U32 => {
                    u32::from_le_bytes(row[..4].try_into().expect("4 bytes checked by locate"))
                }
                _ => {
                    return Err(format!(
                        "{here}: the index accessor must be UNSIGNED_BYTE, _SHORT or _INT"
                    ))
                }
            });
        }
        Ok(out)
    }

    /// The survivor rows of an accessor, copied verbatim (any component type), tightly packed.
    fn gather_rows(
        &self,
        root: &json::Root,
        ai: usize,
        survivors: &[u32],
        here: &str,
    ) -> Result<Vec<u8>, String> {
        let (base, stride, elem) = self.locate(root, ai, here)?;
        let mut rows = Vec::with_capacity(survivors.len() * elem);
        for &s in survivors {
            let off = s as usize * stride;
            if off + elem > base.len() {
                return Err(format!("{here}: a survivor reads past the accessor"));
            }
            rows.extend_from_slice(&base[off..off + elem]);
        }
        Ok(rows)
    }

    /// Resolve an accessor to (data slice inside the GLB buffer, byte stride, element size).
    fn locate(
        &self,
        root: &json::Root,
        ai: usize,
        here: &str,
    ) -> Result<(&[u8], usize, usize), String> {
        let acc = &root.accessors[ai];
        if acc.sparse.is_some() {
            return Err(format!("{here}: sparse accessors are outside the carrier"));
        }
        let Some(view_idx) = acc.buffer_view else {
            return Err(format!("{here}: an accessor has no buffer view"));
        };
        let view = &root.buffer_views[view_idx.value()];
        if view.buffer.value() != 0 {
            return Err(format!(
                "{here}: an accessor reads a buffer outside the GLB chunk"
            ));
        }
        let ct = match acc.component_type {
            Checked::Valid(GenericComponentType(c)) => c,
            Checked::Invalid => fail(here, "unreadable component type")?,
        };
        let type_ = match acc.type_ {
            Checked::Valid(t) => t,
            Checked::Invalid => fail(here, "unreadable accessor type")?,
        };
        let elem = component_size(ct)
            .ok_or_else(|| format!("{here}: unsupported component type"))?
            * type_comps(type_);
        let stride = match view.byte_stride {
            Some(json::buffer::Stride(s)) if s >= elem => s,
            _ => elem,
        };
        let count = acc.count.0 as usize;
        let view_start = view.byte_offset.map_or(0, |o| o.0 as usize);
        let data_start = view_start + acc.byte_offset.map_or(0, |o| o.0 as usize);
        if count == 0 {
            return Err(format!("{here}: an accessor covers no vertices"));
        }
        let last_end_rel = (count - 1) * stride + elem;
        if last_end_rel > view.byte_length.0 as usize {
            return Err(format!("{here}: an accessor reads past its buffer view"));
        }
        if data_start + last_end_rel > self.bin.len() {
            return Err(format!("{here}: an accessor reads past the GLB buffer"));
        }
        Ok((&self.bin[data_start..], stride, elem))
    }
}

fn fail<T>(here: &str, reason: &str) -> Result<T, String> {
    Err(format!("{here}: {reason}"))
}

/// `Checked<GenericComponentType>` is not Copy-friendly through the matchers above; small helper.
trait Gtc {
    fn map_gtc(self) -> Checked<ComponentType>;
}
impl Gtc for Checked<GenericComponentType> {
    fn map_gtc(self) -> Checked<ComponentType> {
        match self {
            Checked::Valid(GenericComponentType(c)) => Checked::Valid(c),
            Checked::Invalid => Checked::Invalid,
        }
    }
}

fn checked(c: Checked<ComponentType>) -> Option<ComponentType> {
    match c {
        Checked::Valid(c) => Some(c),
        Checked::Invalid => None,
    }
}

fn checked_semantic(sem: &Checked<Semantic>) -> Option<String> {
    match sem {
        Checked::Valid(s) => Some(semantic(s)),
        // With the gltf `extras` feature a non-standard name deserializes as Extras(name);
        // Invalid means the JSON attribute key was not usable at all.
        Checked::Invalid => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn push_accessor(
    root: &mut json::Root,
    view: json::Index<json::buffer::View>,
    count: usize,
    ct: ComponentType,
    type_: AType,
    normalized: bool,
    name: Option<String>,
    minmax: Option<(Vec<f64>, Vec<f64>)>,
    extras: &json::Extras,
) -> json::Index<json::Accessor> {
    let (min, max) = match minmax {
        Some((min, max)) => (Some(json::Value::from(min)), Some(json::Value::from(max))),
        None => (None, None),
    };
    root.push(json::Accessor {
        buffer_view: Some(view),
        byte_offset: Some(USize64(0)),
        count: USize64::from(count),
        component_type: Checked::Valid(GenericComponentType(ct)),
        extensions: Default::default(),
        extras: extras.clone(),
        type_: Checked::Valid(type_),
        min,
        max,
        name,
        normalized,
        sparse: None,
    })
}

/// Exact per-component raw min/max over tightly packed rows. The Khronos validator compares
/// raw values, so normalization (a consumer-side view of the data) stays out of the numbers.
fn typed_minmax(ct: ComponentType, comps: usize, rows: &[u8]) -> Option<(Vec<f64>, Vec<f64>)> {
    let size = component_size(ct)?;
    let elem = size * comps;
    if elem == 0 || rows.is_empty() || !rows.len().is_multiple_of(elem) {
        return None;
    }
    let decode = |i: usize, c: usize| -> f64 {
        let r = &rows[i * elem..i * elem + elem];
        match ct {
            ComponentType::I8 => r[c] as i8 as f64,
            ComponentType::U8 => r[c] as f64,
            ComponentType::I16 => {
                i16::from_le_bytes(r[c * 2..c * 2 + 2].try_into().unwrap()) as f64
            }
            ComponentType::U16 => {
                u16::from_le_bytes(r[c * 2..c * 2 + 2].try_into().unwrap()) as f64
            }
            ComponentType::U32 => {
                u32::from_le_bytes(r[c * 4..c * 4 + 4].try_into().unwrap()) as f64
            }
            ComponentType::F32 => {
                f32::from_le_bytes(r[c * 4..c * 4 + 4].try_into().unwrap()) as f64
            }
        }
    };
    let mut min = vec![f64::MAX; comps];
    let mut max = vec![f64::MIN; comps];
    for i in 0..rows.len() / elem {
        for c in 0..comps {
            let v = decode(i, c);
            if v < min[c] {
                min[c] = v;
            }
            if v > max[c] {
                max[c] = v;
            }
        }
    }
    Some((min, max))
}

fn component_size(ct: ComponentType) -> Option<usize> {
    Some(match ct {
        ComponentType::I8 | ComponentType::U8 => 1,
        ComponentType::I16 | ComponentType::U16 => 2,
        ComponentType::U32 | ComponentType::F32 => 4,
    })
}

fn type_comps(t: AType) -> usize {
    match t {
        AType::Scalar => 1,
        AType::Vec2 => 2,
        AType::Vec3 => 3,
        AType::Vec4 => 4,
        AType::Mat2 => 4,
        AType::Mat3 => 9,
        AType::Mat4 => 16,
    }
}

fn semantic(s: &Semantic) -> String {
    match s {
        Semantic::Positions => "POSITION".into(),
        Semantic::Normals => "NORMAL".into(),
        Semantic::Tangents => "TANGENT".into(),
        Semantic::Colors(i) => format!("COLOR_{i}"),
        Semantic::TexCoords(i) => format!("TEXCOORD_{i}"),
        Semantic::Joints(i) => format!("JOINTS_{i}"),
        Semantic::Weights(i) => format!("WEIGHTS_{i}"),
        Semantic::Extras(name) => format!("EXTRAS_{name}"),
    }
}

fn semantic_of(name: &str) -> Option<Semantic> {
    Some(match name {
        "POSITION" => Semantic::Positions,
        "NORMAL" => Semantic::Normals,
        "TANGENT" => Semantic::Tangents,
        other => {
            let (kind, tail) = other.split_once('_')?;
            match kind {
                "COLOR" => Semantic::Colors(tail.parse().ok()?),
                "TEXCOORD" => Semantic::TexCoords(tail.parse().ok()?),
                "JOINTS" => Semantic::Joints(tail.parse().ok()?),
                "WEIGHTS" => Semantic::Weights(tail.parse().ok()?),
                "EXTRAS" => Semantic::Extras(tail.to_string()),
                _ => return None,
            }
        }
    })
}

// --- compare: the deviation metric the tests and callers use ------------------------------

/// Mesh-level facts of a file, and every triangle vertex position of it.
pub struct Stats {
    pub triangles: usize,
    pub vertices: usize,
    /// Sum of triangle areas (a coarse mass of surface: a collapse that guts the geometry
    /// shows up here long before any rendering problem).
    pub area: f64,
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub points: Vec<[f32; 3]>,
}

/// Per-file stats used by `compare`. Only TRIANGLES primitives count.
pub fn file_stats(bytes: &[u8]) -> Result<Stats, String> {
    let (root, bin) = load(bytes)?;
    let rw = Rewriter {
        bin: &bin,
        base: 0,
        appended: Vec::new(),
        carried: BTreeSet::new(),
    };
    let mut stats = Stats {
        triangles: 0,
        vertices: 0,
        area: 0.0,
        min: [f32::MAX; 3],
        max: [f32::MIN; 3],
        points: Vec::new(),
    };
    let mut vertex_count_total = 0;
    for mesh in &root.meshes {
        for prim in &mesh.primitives {
            if !matches!(prim.mode, Checked::Valid(json::mesh::Mode::Triangles)) {
                continue;
            }
            let position = prim
                .attributes
                .iter()
                .find(|(s, _)| checked_semantic(s).as_deref() == Some("POSITION"))
                .map(|(_, i)| i.value())
                .ok_or("a triangle primitive without POSITION")?;
            vertex_count_total += root.accessors[position].count.0 as usize;
            let (verts, count) = rw.read_f32(&root, position, "stats")?;
            for v in 0..count {
                let p = [verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]];
                for (c, &x) in p.iter().enumerate() {
                    if x < stats.min[c] {
                        stats.min[c] = x;
                    }
                    if x > stats.max[c] {
                        stats.max[c] = x;
                    }
                }
                stats.points.push(p);
            }
            let indices = match prim.indices {
                Some(idx) => rw.read_u32s(&root, idx.value(), "stats")?,
                None => (0..count as u32).collect(),
            };
            stats.triangles += indices.len() / 3;
            for t in 0..indices.len() / 3 {
                let a = &verts[indices[t * 3] as usize * 3..];
                let b = &verts[indices[t * 3 + 1] as usize * 3..];
                let c = &verts[indices[t * 3 + 2] as usize * 3..];
                let ux = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                let vx = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                let cx = ux[1] * vx[2] - ux[2] * vx[1];
                let cy = ux[2] * vx[0] - ux[0] * vx[2];
                let cz = ux[0] * vx[1] - ux[1] * vx[0];
                stats.area += ((cx * cx + cy * cy + cz * cz).sqrt() * 0.5) as f64;
            }
        }
    }
    stats.vertices = vertex_count_total;
    if stats.points.is_empty() {
        stats.min = [0.0; 3];
        stats.max = [0.0; 3];
    }
    Ok(stats)
}

/// Deviation between two files: the surface-mass ratio plus the distance of the first file's
/// triangle vertices to the nearest second-file vertex (the collapse removes vertices; how far
/// the removed ones sat from the kept ones is what quality looks like from the outside).
pub fn compare_bytes(a: &[u8], b: &[u8]) -> Result<serde_json::Value, String> {
    let sa = file_stats(a)?;
    let sb = file_stats(b)?;
    if sb.points.is_empty() {
        return Err("the second file has no triangle vertices".into());
    }

    // Uniform grid over the second file's points.
    let mut diag = 0.0f32;
    for c in 0..3 {
        diag += (sb.max[c] - sb.min[c]).powi(2);
    }
    let cell = (diag.sqrt() / 64.0).max(f32::EPSILON);
    let cell_of = |p: &[f32; 3]| -> [i64; 3] {
        [
            ((p[0] - sb.min[0]) / cell).floor() as i64,
            ((p[1] - sb.min[1]) / cell).floor() as i64,
            ((p[2] - sb.min[2]) / cell).floor() as i64,
        ]
    };
    let mut grid: std::collections::HashMap<[i64; 3], Vec<[f32; 3]>> =
        std::collections::HashMap::new();
    for p in &sb.points {
        grid.entry(cell_of(p)).or_default().push(*p);
    }
    let nearest = |p: &[f32; 3]| -> f64 {
        let c = cell_of(p);
        let mut best = f64::INFINITY;
        for r in 0i64.. {
            if (r as f64 - 1.0) * cell as f64 > best.sqrt() && best.is_finite() {
                break;
            }
            if r > 130 {
                break; // 2 grid diagonals without a hit: report the infinity honestly
            }
            for dx in -r..=r {
                for dy in -r..=r {
                    for dz in -r..=r {
                        if r.max(dx.abs()).max(dy.abs()).max(dz.abs()) != r {
                            continue; // only the shell of the cube
                        }
                        let Some(pts) = grid.get(&[c[0] + dx, c[1] + dy, c[2] + dz]) else {
                            continue;
                        };
                        for q in pts {
                            let d = (p[0] - q[0]).powi(2)
                                + (p[1] - q[1]).powi(2)
                                + (p[2] - q[2]).powi(2);
                            if (d as f64) < best {
                                best = (d as f64).sqrt();
                            }
                        }
                    }
                }
            }
        }
        best
    };

    let stride = (sa.points.len() / 20_000).max(1);
    let mut distances: Vec<f64> = sa.points.iter().step_by(stride).map(nearest).collect();
    distances.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    let pct = |q: f64| {
        distances
            .get(((distances.len() as f64) * q) as usize)
            .copied()
    };

    Ok(serde_json::json!({
        "a": { "triangles": sa.triangles, "vertices": sa.vertices, "area": sa.area,
               "bbox": [sa.min, sa.max] },
        "b": { "triangles": sb.triangles, "vertices": sb.vertices, "area": sb.area,
               "bbox": [sb.min, sb.max] },
        "deviation": {
            "samples": distances.len(),
            "areaRatio": if sa.area > 0.0 { Some(sb.area / sa.area) } else { None },
            "vertexDistance": {
                "p50": pct(0.50),
                "p95": pct(0.95),
                "max": distances.last().copied(),
            },
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap as Map;

    // --- a minimal hand-built GLB: the carrier's fixture factory -------------------------
    //
    // One 8x8 quad plane (98 triangles) carrying POSITION, NORMAL, COLOR_0, a u8 rig pair
    // (JOINTS_0/WEIGHTS_0), one morph POSITION target — everything the carry-contract must
    // survive, assembled without any external file so the tests run offline.

    struct Builder {
        root: json::Root,
        bin: Vec<u8>,
    }

    impl Builder {
        fn new() -> Self {
            Builder {
                root: json::Root::default(),
                bin: Vec::new(),
            }
        }

        fn push_attr(
            &mut self,
            count: usize,
            ct: ComponentType,
            type_: AType,
            bytes: Vec<u8>,
            minmax: bool,
        ) -> json::Index<json::Accessor> {
            let offset = self.bin.len();
            self.bin.extend_from_slice(&bytes);
            while !self.bin.len().is_multiple_of(4) {
                self.bin.push(0);
            }
            let buffer = json::Index::new(0);
            if self.root.buffers.is_empty() {
                self.root.buffers.push(json::Buffer {
                    byte_length: USize64(0),
                    extensions: Default::default(),
                    extras: Default::default(),
                    name: None,
                    uri: None,
                });
            }
            let view = self.root.push(json::buffer::View {
                buffer,
                byte_length: USize64::from(bytes.len()),
                byte_offset: Some(USize64::from(offset)),
                byte_stride: None,
                extensions: Default::default(),
                extras: Default::default(),
                name: None,
                target: None,
            });
            let (min, max) = if minmax {
                let comps = type_comps(type_);
                let mut mn = vec![f32::INFINITY; comps];
                let mut mx = vec![f32::NEG_INFINITY; comps];
                for v in 0..count {
                    for c in 0..comps {
                        let x = f32::from_le_bytes(
                            bytes[(v * comps + c) * 4..(v * comps + c) * 4 + 4]
                                .try_into()
                                .unwrap(),
                        );
                        if x < mn[c] {
                            mn[c] = x;
                        }
                        if x > mx[c] {
                            mx[c] = x;
                        }
                    }
                }
                (
                    Some(json::Value::from(
                        mn.iter().map(|&x| x as f64).collect::<Vec<f64>>(),
                    )),
                    Some(json::Value::from(
                        mx.iter().map(|&x| x as f64).collect::<Vec<f64>>(),
                    )),
                )
            } else {
                (None, None)
            };
            self.root.push(json::Accessor {
                buffer_view: Some(view),
                byte_offset: Some(USize64(0)),
                count: USize64::from(count),
                component_type: Checked::Valid(GenericComponentType(ct)),
                extensions: Default::default(),
                extras: Default::default(),
                type_: Checked::Valid(type_),
                min,
                max,
                name: None,
                normalized: false,
                sparse: None,
            })
        }

        fn push_f32(
            &mut self,
            values: &[f32],
            type_: AType,
            minmax: bool,
        ) -> json::Index<json::Accessor> {
            let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
            self.push_attr(
                values.len() / type_comps(type_),
                ComponentType::F32,
                type_,
                bytes,
                minmax,
            )
        }

        fn push_u8x4(&mut self, rows: &[u8]) -> json::Index<json::Accessor> {
            self.push_attr(
                rows.len() / 4,
                ComponentType::U8,
                AType::Vec4,
                rows.to_vec(),
                false,
            )
        }

        fn push_u32(&mut self, values: &[u32]) -> json::Index<json::Accessor> {
            let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
            self.push_attr(
                values.len(),
                ComponentType::U32,
                AType::Scalar,
                bytes,
                false,
            )
        }

        fn finish(mut self) -> Vec<u8> {
            while !self.bin.len().is_multiple_of(4) {
                self.bin.push(0);
            }
            self.root.buffers[0].byte_length = USize64::from(self.bin.len());
            self.root.asset.version = "2.0".into();
            let node = json::scene::Node {
                camera: None,
                children: None,
                extensions: Default::default(),
                extras: Default::default(),
                matrix: None,
                mesh: Some(json::Index::new(0)),
                name: Some("plane-node".into()),
                rotation: None,
                scale: None,
                skin: None,
                translation: None,
                weights: None,
            };
            let node_index = self.root.nodes.len();
            self.root.nodes.push(node);
            let scene = json::Scene {
                name: None,
                nodes: vec![json::Index::new(node_index as u32)],
                extensions: Default::default(),
                extras: Default::default(),
            };
            let scene_index = self.root.scenes.len();
            self.root.scenes.push(scene);
            self.root.scene = Some(json::Index::new(scene_index as u32));
            let glb = gltf::binary::Glb {
                header: gltf::binary::Header {
                    magic: *b"glTF",
                    version: 2,
                    length: 0,
                },
                json: std::borrow::Cow::Owned(
                    json::serialize::to_string(&self.root).unwrap().into_bytes(),
                ),
                bin: Some(std::borrow::Cow::Owned(self.bin)),
            };
            glb.to_vec().unwrap()
        }
    }

    /// Grid plane of n x n vertices: z=0, normals +z, colour ramp, one constant morph z-delta,
    /// rigid skin (joint 0, weight 255 on the first channel).
    fn plane_file(n: usize) -> Vec<u8> {
        let mut b = Builder::new();
        let (mut positions, mut normals, mut colors, mut deltas, mut joints, mut weights) = (
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        );
        for y in 0..n {
            for x in 0..n {
                let fx = x as f32 / (n - 1) as f32;
                let fy = y as f32 / (n - 1) as f32;
                positions.extend_from_slice(&[fx, fy, 0.0]);
                normals.extend_from_slice(&[0.0, 0.0, 1.0]);
                colors.extend_from_slice(&[fx, fy, 0.25, 1.0]);
                deltas.extend_from_slice(&[0.0, 0.0, 0.5]); // a constant delta stays metric-free
                joints.extend_from_slice(&[0u8, 0, 0, 0]);
                weights.extend_from_slice(&[255u8, 0, 0, 0]);
            }
        }
        let mut indices: Vec<u32> = Vec::new();
        for y in 0..n - 1 {
            for x in 0..n - 1 {
                let a = (y * n + x) as u32;
                indices.extend_from_slice(&[
                    a,
                    a + 1,
                    a + n as u32,
                    a + 1,
                    a + n as u32 + 1,
                    a + n as u32,
                ]);
            }
        }
        let pos = b.push_f32(&positions, AType::Vec3, true);
        let nor = b.push_f32(&normals, AType::Vec3, false);
        let col = b.push_f32(&colors, AType::Vec4, false);
        let dlt = b.push_f32(&deltas, AType::Vec3, false);
        let jnt = b.push_u8x4(&joints);
        let wgt = b.push_u8x4(&weights);
        let idx = b.push_u32(&indices);

        let mut attributes = Map::new();
        attributes.insert(Checked::Valid(Semantic::Positions), pos);
        attributes.insert(Checked::Valid(Semantic::Normals), nor);
        attributes.insert(Checked::Valid(Semantic::Colors(0)), col);
        attributes.insert(Checked::Valid(Semantic::Joints(0)), jnt);
        attributes.insert(Checked::Valid(Semantic::Weights(0)), wgt);
        b.root.meshes.push(json::mesh::Mesh {
            name: Some("plane".into()),
            primitives: vec![json::mesh::Primitive {
                attributes,
                extensions: Default::default(),
                extras: Default::default(),
                indices: Some(idx),
                material: None,
                mode: Checked::Valid(json::mesh::Mode::Triangles),
                targets: Some(vec![json::mesh::MorphTarget {
                    positions: Some(dlt),
                    normals: None,
                    tangents: None,
                }]),
            }],
            weights: Some(vec![0.5]),
            extensions: Default::default(),
            extras: Default::default(),
        });
        b.finish()
    }

    /// Read one attribute of primitive (0,0) of the reloaded output back to typed rows using
    /// the crate's own readers (self-consistency of the carrier).
    struct Out {
        root: json::Root,
        bin: Vec<u8>,
    }

    impl Out {
        fn open(bytes: &[u8]) -> Out {
            let (root, bin) = load(bytes).expect("the written GLB reloads");
            Out { root, bin }
        }

        fn rw(&self) -> Rewriter<'_> {
            Rewriter {
                bin: &self.bin,
                base: 0,
                appended: Vec::new(),
                carried: BTreeSet::new(),
            }
        }

        fn attr(&self, name: &str) -> usize {
            self.root.meshes[0].primitives[0]
                .attributes
                .iter()
                .find(|(s, _)| checked_semantic(s).as_deref() == Some(name))
                .unwrap_or_else(|| panic!("{name} is not carried"))
                .1
                .value()
        }

        fn f32_rows(&self, name: &str) -> Vec<Vec<f32>> {
            let ai = self.attr(name);
            let count = self.root.accessors[ai].count.0 as usize;
            let (values, _) = self
                .rw()
                .read_f32(&self.root, ai, "test")
                .expect("f32 attribute");
            let comps = values.len() / count;
            (0..count)
                .map(|v| values[v * comps..(v + 1) * comps].to_vec())
                .collect()
        }

        fn u_rows(&self, name: &str) -> Vec<Vec<u8>> {
            let ai = self.attr(name);
            let acc = &self.root.accessors[ai];
            let comps = type_comps(match acc.type_ {
                Checked::Valid(t) => t,
                _ => unreachable!(),
            });
            let rw = self.rw();
            let (base, stride, elem) = rw.locate(&self.root, ai, "test").expect("locate");
            let n = acc.count.0 as usize;
            (0..n)
                .map(|v| {
                    base[v * stride..v * stride + elem]
                        .iter()
                        .take(comps)
                        .cloned()
                        .collect()
                })
                .collect()
        }

        fn morph_z(&self) -> Vec<f32> {
            let ai = self.root.meshes[0].primitives[0].targets.as_ref().unwrap()[0]
                .positions
                .unwrap()
                .value();
            let (values, _) = self
                .rw()
                .read_f32(&self.root, ai, "test")
                .expect("morph deltas");
            (0..values.len() / 3).map(|v| values[v * 3 + 2]).collect()
        }
    }

    #[test]
    fn the_written_file_parses_and_the_loader_validates_it() {
        let bytes = plane_file(8);
        let (mut root, bin) = load(&bytes).expect("fixture loads");
        let (out, _) = simplify_glb(&mut root, &bin, 40).expect("collapse ran");
        gltf::Gltf::from_slice(&out).expect("the output validates against the gltf loader");
    }

    #[test]
    fn collapse_meets_the_target_and_carries_every_attribute_verbatim() {
        let bytes = plane_file(8);
        let (mut root, bin) = load(&bytes).expect("fixture loads");
        let (out, summary) = simplify_glb(&mut root, &bin, 40).expect("collapse ran");
        let p = &summary.primitives[0];
        assert_eq!(p.action, "collapsed");
        assert!(
            p.triangles_after <= 40,
            "target met, got {}",
            p.triangles_after
        );
        assert!(p.triangles_after > 0);
        assert!(p.vertices_after < p.vertices_before);
        assert!(p.error < 0.2, "sane collapse error {}", p.error);
        assert_eq!(
            summary.carried,
            vec!["COLOR_0", "JOINTS_0", "NORMAL", "POSITION", "WEIGHTS_0"]
        );
        assert!(summary.dropped.is_empty(), "{:?}", summary.dropped);

        let o = Out::open(&out);
        let n_after = o.root.accessors[o.attr("POSITION")].count.0 as usize;
        assert_eq!(n_after, p.vertices_after);

        // Survivors are verbatim copies: the fixture's attributes are distinctive enough that
        // "every row identical to an input row" is provable row by row.
        for r in o.f32_rows("NORMAL") {
            assert_eq!(r, vec![0.0, 0.0, 1.0], "custom normals verbatim");
        }
        for r in o.f32_rows("COLOR_0") {
            assert_eq!(r[2], 0.25, "vertex colour verbatim");
            for x in [r[0], r[1]] {
                let t = x * 7.0; // the fixture ramp has 8 steps: values stay on i/7
                assert!(
                    (t - t.round()).abs() < 1e-4,
                    "colour stayed on the 7-step ramp"
                );
            }
        }
        for r in o.u_rows("JOINTS_0") {
            assert_eq!(r, vec![0, 0, 0, 0], "rig joints verbatim");
        }
        for r in o.u_rows("WEIGHTS_0") {
            assert_eq!(r, vec![255, 0, 0, 0], "rig weights verbatim");
        }
        assert!(
            o.f32_rows("POSITION").iter().all(|r| r[2] == 0.0),
            "the plane stays flat"
        );
        assert_eq!(o.u_rows("POSITION").len(), n_after, "row counts line up");

        // morph target: kept, survivor count, deltas verbatim inside the input band
        assert_eq!(
            o.root.meshes[0].weights,
            Some(vec![0.5]),
            "mesh morph weights untouched"
        );
        let dz = o.morph_z();
        assert_eq!(dz.len(), n_after);
        assert!(dz.iter().all(|&z| z == 0.5), "deltas verbatim");

        // POSITION bounds are exact for the survivors (input had them)
        let acc = &o.root.accessors[o.attr("POSITION")];
        let mn: Vec<f64> = acc
            .min
            .as_ref()
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        let mx: Vec<f64> = acc
            .max
            .as_ref()
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        let verts = o.f32_rows("POSITION");
        for c in 0..3 {
            let lo = verts
                .iter()
                .map(|v| v[c] as f64)
                .fold(f64::INFINITY, f64::min);
            let hi = verts
                .iter()
                .map(|v| v[c] as f64)
                .fold(f64::NEG_INFINITY, f64::max);
            assert!(
                (mn[c] - lo).abs() < 1e-6,
                "min[{c}] {} vs actual {lo}",
                mn[c]
            );
            assert!(
                (mx[c] - hi).abs() < 1e-6,
                "max[{c}] {} vs actual {hi}",
                mx[c]
            );
        }
    }

    #[test]
    fn untouched_sections_survive_byte_for_byte() {
        // the fixture carries a scene; the patched output keeps it and adds no meshes
        let bytes = plane_file(8);
        let (mut root, bin) = load(&bytes).unwrap();
        let (out, _) = simplify_glb(&mut root, &bin, 30).unwrap();
        let o = Out::open(&out);
        assert_eq!(o.root.meshes.len(), 1);
        assert_eq!(o.root.scenes.len(), 1);
        assert!(o.root.scene.is_some());
        assert_eq!(
            o.root.nodes[0].mesh.map(|i| i.value()),
            Some(0),
            "the node still points at its mesh"
        );
        assert_eq!(
            o.root.nodes[0].name.as_deref(),
            Some("plane-node"),
            "names survive the round trip"
        );
        // the ORIGINAL bin bytes still sit at the start of the chunk untouched
        let (_, orig_bin) = load(&bytes).unwrap();
        assert_eq!(
            &o.bin[..orig_bin.len()],
            &orig_bin[..],
            "original buffer bytes are never moved"
        );
    }

    #[test]
    fn target_at_or_above_the_input_changes_nothing_but_is_still_a_valid_file() {
        let bytes = plane_file(8);
        let (mut root, bin) = load(&bytes).unwrap();
        let (out, summary) = simplify_glb(&mut root, &bin, 10_000).unwrap();
        assert_eq!(
            summary.primitives[0].action,
            "kept: already under the target"
        );
        assert_eq!(summary.primitives[0].triangles_after, 98); // the 8x8 fixture grid is 7x7 cells
        gltf::Gltf::from_slice(&out).expect("the copy validates");
        let o = Out::open(&out);
        assert_eq!(o.root.accessors[o.attr("POSITION")].count.0, 64);
    }

    #[test]
    fn refuses_what_the_carrier_cannot_read() {
        assert!(
            load(b"{'asset':{'version':'2.0'}}").is_err(),
            "plain JSON / non-GLB is refused"
        );
        assert!(
            load(b"glTF-not-a-glb-at-all").is_err(),
            "a broken GLB is refused"
        );

        let bytes = plane_file(8);
        // primitive extensions (compressed meshes) are refused
        let (mut root, bin) = load(&bytes).unwrap();
        root.meshes[0].primitives[0].extensions = Some(Default::default());
        let err = simplify_glb(&mut root, &bin, 40).unwrap_err();
        assert!(err.contains("extensions"), "{err}");

        // external buffers are refused by load itself: rebuild the fixture with a uri
        let (mut root, bin) = load(&bytes).unwrap();
        root.buffers[0].uri = Some("external.bin".into());
        let err = simplify_glb(&mut root, &bin, 40).unwrap_err();
        assert!(err.contains("external"), "{err}");

        // an attribute count that disagrees with POSITION is refused
        let (mut root, bin) = load(&bytes).unwrap();
        root.accessors[root.meshes[0].primitives[0]
            .attributes
            .values()
            .last()
            .unwrap()
            .value()]
        .count = USize64(3);
        let err = simplify_glb(&mut root, &bin, 40).unwrap_err();
        assert!(err.contains("vertices"), "{err}");
    }

    #[test]
    fn a_refusal_never_produces_output_bytes() {
        let bytes = plane_file(8);
        let (mut root, bin) = load(&bytes).unwrap();
        root.meshes[0].primitives[0].extensions = Some(Default::default());
        assert!(simplify_glb(&mut root, &bin, 40).is_err());
        // the root was NOT mutated before the refusal — the caller's own file stays intact
        assert!(root.meshes[0].primitives[0].extensions.is_some());
        let pristine = json::serialize::to_string(&root).unwrap();
        assert!(pristine.contains("plane"));
    }
}
