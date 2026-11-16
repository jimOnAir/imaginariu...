//! The FFI seam to the vendored meshoptimizer simplifier (pinned, see `VENDORING.md`).
//!
//! The only unsafe surface of the crate. The pinned v1.3 header is explicit about what the
//! attributes do here: `meshopt_simplifyWithAttributes` feeds them into the collapse ERROR
//! METRIC only — it never rewrites vertex data. The output indices reference the ORIGINAL
//! vertex buffer, so carrying attributes through a collapse is exact: the caller copies the
//! survivor rows verbatim (`glb.rs` does). A metric that knows about colours, skin weights and
//! morph deltas is what keeps the collapse from eating colour seams and rig boundaries.

/// What a successful collapse hands back.
pub struct Collapsed {
    /// Triangles over survivor numbering (0..`source_vertex`.len()), every index in range.
    pub indices: Vec<u32>,
    /// Surviving vertices by their ORIGINAL index, ascending — the copy order for the caller.
    pub source_vertex: Vec<u32>,
    /// The relative error to the extents that meshoptimizer reported for this result.
    pub error: f32,
}

/// The tolerated collapse error relative to mesh extents (1 %). The salvage caller is a fast
/// pre-pass in front of Blender's own decimator; a knob here would only ever be twiddled in
/// the dark, so the value is fixed and this comment is the documentation.
pub const TARGET_ERROR: f32 = 1e-2;

/// `attribute_count` cap from the pinned header ("must be <= 32").
pub const MAX_ATTR_FLOATS: usize = 32;

unsafe extern "C" {
    #[allow(non_snake_case)]
    fn meshopt_simplifyWithAttributes(
        destination: *mut u32,
        indices: *const u32,
        index_count: usize,
        vertex_positions: *const f32,
        vertex_count: usize,
        vertex_positions_stride: usize,
        vertex_attributes: *const f32,
        vertex_attributes_stride: usize,
        attribute_weights: *const f32,
        attribute_count: usize,
        vertex_lock: *const u8,
        target_index_count: usize,
        target_error: f32,
        options: u32,
        result_error: *mut f32,
    ) -> usize;
}

/// Collapse a triangle list towards `target_triangles`.
///
/// - `positions` — 3 floats per vertex, `indices` reference them (out of range = `None`).
/// - `attributes` — `attr_floats` floats per vertex feeding the metric; empty for position-only.
/// - `weights` — one per attribute float (empty = uniform 1.0); they rank attributes against
///   each other and against the position, per the pinned header.
///
/// `None` means the caller keeps its fallback: degenerate or inconsistent input, a target that
/// is not below the input, or a simplifier that removed nothing.
pub fn simplify(
    positions: &[f32],
    attr_floats: usize,
    attributes: &[f32],
    weights: &[f32],
    indices: &[u32],
    target_triangles: usize,
) -> Option<Collapsed> {
    let vertex_count = positions.len().checked_div(3)?;
    if positions.len() != vertex_count * 3 || vertex_count == 0 {
        return None;
    }
    if indices.is_empty() || !indices.len().is_multiple_of(3) {
        return None;
    }
    if indices.iter().any(|&i| i as usize >= vertex_count) {
        return None;
    }
    if attributes.len() != attr_floats * vertex_count || attr_floats > MAX_ATTR_FLOATS {
        return None;
    }
    let default_weights;
    let weights = if attr_floats == 0 {
        &[][..]
    } else if weights.is_empty() {
        default_weights = vec![1.0f32; attr_floats];
        &default_weights
    } else {
        if weights.len() != attr_floats {
            return None;
        }
        weights
    };
    let target_index_count = target_triangles.max(1) * 3;
    if target_index_count >= indices.len() {
        return None; // nothing to do is not a partial success
    }

    let mut out = vec![0u32; indices.len()];
    let mut error = 0f32;
    let f32_size = std::mem::size_of::<f32>();
    let keep = unsafe {
        meshopt_simplifyWithAttributes(
            out.as_mut_ptr(),
            indices.as_ptr(),
            indices.len(),
            positions.as_ptr(),
            vertex_count,
            3 * f32_size,
            if attr_floats == 0 {
                std::ptr::null()
            } else {
                attributes.as_ptr()
            },
            if attr_floats == 0 {
                0
            } else {
                attr_floats * f32_size
            },
            if attr_floats == 0 {
                std::ptr::null()
            } else {
                weights.as_ptr()
            },
            attr_floats,
            std::ptr::null(), // no vertex locks in v1
            target_index_count,
            TARGET_ERROR,
            0, // no options: the salvage pass wants plain collapse, nothing exotic
            &mut error,
        )
    };
    if keep == 0 || keep % 3 != 0 || keep > indices.len() || keep == indices.len() {
        // 0 / corrupt output, or the simplifier stood its ground and removed nothing:
        // "nothing happened" is the caller's fallback signal, not a collapsed mesh.
        return None;
    }
    out.truncate(keep);

    // The output references ORIGINAL vertex numbers; compact them into the survivor numbering.
    // The pinned header promises no new vertices, but the scan treats anything else as
    // corrupt input from upstream and refuses — a broken mesh is never handed to the caller.
    let mut remap = vec![u32::MAX; vertex_count];
    let mut source_vertex = Vec::new();
    for &i in &out {
        let i = i as usize;
        if i >= vertex_count {
            return None;
        }
        if remap[i] == u32::MAX {
            remap[i] = source_vertex.len() as u32;
            source_vertex.push(i as u32);
        }
    }
    // source_vertex was filled in index-stream order; sort for the deterministic copy order
    // the caller relies on, then derive the remap from the sorted list.
    source_vertex.sort_unstable();
    for (slot, &src) in source_vertex.iter().enumerate() {
        remap[src as usize] = slot as u32;
    }
    let indices: Vec<u32> = out.iter().map(|&i| remap[i as usize]).collect();
    Some(Collapsed {
        indices,
        source_vertex,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A flat NxN quad grid: two triangles per cell, z=0 everywhere.
    fn plane(
        n: usize,
        mut colour: impl FnMut(usize, usize) -> [f32; 4],
    ) -> (Vec<f32>, Vec<f32>, Vec<u32>) {
        let mut positions = Vec::new();
        let mut attributes = Vec::new();
        for y in 0..n {
            for x in 0..n {
                positions.extend_from_slice(&[
                    x as f32 / (n - 1) as f32,
                    y as f32 / (n - 1) as f32,
                    0.0,
                ]);
                attributes.extend_from_slice(&colour(x, y));
            }
        }
        let mut indices = Vec::new();
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
        (positions, attributes, indices)
    }

    #[test]
    fn collapses_a_plane_and_renumbers_survivors() {
        let (p, a, i) = plane(16, |_, _| [1.0, 1.0, 1.0, 1.0]);
        let tris = i.len() / 3;
        let out = simplify(&p, 4, &a, &[], &i, tris / 4).expect("a grid plane collapses");
        assert!(out.indices.len() < i.len(), "fewer indices");
        assert_eq!(out.indices.len() % 3, 0);
        assert!(
            out.source_vertex.len() > 3
                && out
                    .source_vertex
                    .last()
                    .is_some_and(|&v| (v as usize) < p.len() / 3)
        );
        assert!(
            out.source_vertex.windows(2).all(|w| w[0] < w[1]),
            "ascending, unique"
        );
        assert!(out
            .indices
            .iter()
            .all(|&s| (s as usize) < out.source_vertex.len()));
    }

    #[test]
    fn collapses_a_position_only_mesh() {
        // The plainest path the studio hits: exports from tools that never write attributes.
        // No attribute stream at all (attr_floats 0, null pointers on the FFI) still collapses.
        let (p, _unused, i) = plane(8, |_, _| [0.0, 0.0, 0.0, 0.0]);
        let tris = i.len() / 3;
        let out = simplify(&p, 0, &[], &[], &i, tris / 3).expect("position-only collapses");
        assert!(out.indices.len() < i.len(), "fewer indices");
        assert!(out
            .indices
            .iter()
            .all(|&s| (s as usize) < out.source_vertex.len()));
    }

    #[test]
    fn the_metric_stream_cannot_break_the_collapse() {
        // What a metric guarantees is correctness, not an outcome ranking (the quality effect
        // of attributes is a deviation question, proven separately by `compare`): the collapse
        // with a four-float attribute stream must still deliver a valid renumbered mesh.
        let seam = |x: usize, _: usize| {
            if x < 8 {
                [1.0, 0.0, 0.0, 1.0]
            } else {
                [0.0, 0.0, 1.0, 1.0]
            }
        };
        let (p, a, i) = plane(16, seam);
        let tris = i.len() / 3;
        let metric =
            simplify(&p, 4, &a, &[0.01, 0.01, 0.01, 0.01], &i, tris / 8).expect("metric collapses");
        assert!(metric.indices.len() / 3 <= tris);
        assert_eq!(metric.indices.len() % 3, 0);
        assert!(metric
            .indices
            .iter()
            .all(|&s| (s as usize) < metric.source_vertex.len()));
        assert_eq!(
            metric.source_vertex.len(),
            metric
                .source_vertex
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
        );
    }

    #[test]
    fn identical_inputs_collapse_identically() {
        let (p, a, i) = plane(12, |x, y| [x as f32, y as f32, 0.5, 1.0]);
        let tris = i.len() / 3;
        let a1 = simplify(&p, 4, &a, &[0.01, 0.01, 0.01, 0.01], &i, tris / 3).expect("first run");
        let a2 = simplify(&p, 4, &a, &[0.01, 0.01, 0.01, 0.01], &i, tris / 3).expect("second run");
        assert_eq!(a1.indices, a2.indices);
        assert_eq!(a1.source_vertex, a2.source_vertex);
    }

    #[test]
    fn refuses_instead_of_half_working() {
        let (p, a, i) = plane(8, |_, _| [0.0, 0.0, 0.0, 1.0]);
        let tris = i.len() / 3;
        assert!(
            simplify(&p, 0, &[], &[], &i, tris).is_none(),
            "target is not below the input"
        );
        assert!(
            simplify(&[], 0, &[], &[], &[0, 1, 2], 1).is_none(),
            "no vertices"
        );
        assert!(
            simplify(&p, 3, &a, &[], &i, 2).is_none(),
            "attribute count inconsistent"
        );
        assert!(
            simplify(&p, 4, &a, &[1.0, 1.0], &i, 2).is_none(),
            "weights inconsistent"
        );
        let mut bad = i.clone();
        bad[0] = 1_000_000;
        assert!(
            simplify(&p, 0, &[], &[], &bad, 2).is_none(),
            "index out of range"
        );
        assert!(
            simplify(&p, 33, &vec![0.0; 33 * p.len() / 3], &[], &i, 2).is_none(),
            "attr cap"
        );
    }
}
