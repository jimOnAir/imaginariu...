// The Sculpt tab: pure functions without three and without the DOM (checked in tests/sculpt-core.test.mjs).
// The idea: SculptGL works with a welded mesh (coincident vertices merged), while the studio model has vertices
// split along UV and normal seams. So a welded mesh (positions only) goes to the sculpt, and the returned shape is
// spread back over ALL original vertices: UVs, materials, bone weights and vertex order stay as they were.
// This holds while the sculpt did not change the topology (the vertex count).

/** Weld tolerance: 1e-6 of the bounding-box diagonal (exact duplicates coincide, so the tolerance can be tiny). */
export function weldTolerance(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { const v = positions[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return Number.isFinite(diag) && diag > 0 ? diag * 1e-6 : 1e-9;
}

/**
 * Weld vertices by position. positions is a flat xyz array, index is triangle indices or null (vertices in triples).
 * -> {map: Int32Array (source vertex -> welded vertex; -1 when it belongs to no non-degenerate triangle),
 *     welded: Float32Array xyz, faces: Uint32Array (triples of welded indices), count, dropped (degenerate triangles removed)}
 */
export function weldMesh(positions, index = null, tolerance = weldTolerance(positions)) {
  const n = Math.floor(positions.length / 3), inv = 1 / tolerance;
  const keys = new Map(), rep = new Int32Array(n), first = [];
  for (let i = 0; i < n; i++) {
    const key = Math.round(positions[i * 3] * inv) + ',' + Math.round(positions[i * 3 + 1] * inv) + ',' + Math.round(positions[i * 3 + 2] * inv);
    let id = keys.get(key);
    if (id === undefined) { id = first.length; first.push(i); keys.set(key, id); }
    rep[i] = id;
  }
  const triangles = Math.floor((index ? index.length : n) / 3);
  const tri = new Uint32Array(triangles * 3), used = new Uint8Array(first.length);
  let kept = 0, dropped = 0;
  for (let t = 0; t < triangles; t++) {
    const a = index ? index[t * 3] : t * 3, b = index ? index[t * 3 + 1] : t * 3 + 1, c = index ? index[t * 3 + 2] : t * 3 + 2;
    if (a >= n || b >= n || c >= n) { dropped++; continue; }
    const x = rep[a], y = rep[b], z = rep[c];
    if (x === y || y === z || x === z) { dropped++; continue; }
    tri[kept * 3] = x; tri[kept * 3 + 1] = y; tri[kept * 3 + 2] = z; kept++;
    used[x] = used[y] = used[z] = 1;
  }
  const remap = new Int32Array(first.length).fill(-1);
  let count = 0;
  for (let w = 0; w < first.length; w++) if (used[w]) remap[w] = count++;
  const welded = new Float32Array(count * 3);
  for (let w = 0; w < first.length; w++) if (remap[w] >= 0) { const o = remap[w] * 3, s = first[w] * 3; welded[o] = positions[s]; welded[o + 1] = positions[s + 1]; welded[o + 2] = positions[s + 2]; }
  const faces = new Uint32Array(kept * 3);
  for (let i = 0; i < kept * 3; i++) faces[i] = remap[tri[i]];
  const map = new Int32Array(n);
  for (let i = 0; i < n; i++) map[i] = remap[rep[i]];
  return { map, welded, faces, count, dropped };
}

const num = (v) => String(+v.toPrecision(8));

/** The OBJ for SculptGL: one `o` group per part, positions and triangles only. parts: [{name, welded, faces}] */
export function objFromParts(parts) {
  const lines = ['# Imaginarium -> SculptGL: welded mesh, positions only'];
  let offset = 1;
  for (const p of parts) {
    lines.push('o ' + String(p.name || 'part').replace(/\s+/g, '_'));
    for (let i = 0; i < p.welded.length; i += 3) lines.push('v ' + num(p.welded[i]) + ' ' + num(p.welded[i + 1]) + ' ' + num(p.welded[i + 2]));
    for (let i = 0; i < p.faces.length; i += 3) lines.push('f ' + (offset + p.faces[i]) + ' ' + (offset + p.faces[i + 1]) + ' ' + (offset + p.faces[i + 2]));
    offset += p.welded.length / 3;
  }
  return lines.join('\n') + '\n';
}

/** OBJ vertex groups -> [{name, positions: Float32Array, faces: number}]. A vertex belongs to the `o` group it stands in. */
export function parseObj(text) {
  const groups = [];
  let cur = null;
  const open = (name) => { cur = { name, v: [], faces: 0 }; groups.push(cur); };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      if (!cur) open('part');
      const s = line.split(/\s+/);
      cur.v.push(parseFloat(s[1]), parseFloat(s[2]), parseFloat(s[3]));
    } else if (line.startsWith('f ')) { if (!cur) open('part'); cur.faces++; }
    else if (line.startsWith('o ') || line.startsWith('g ')) {
      // a `g` right after an `o` with no vertices yet is a rename, not a new part
      if (cur && !cur.v.length && !cur.faces) cur.name = line.slice(2).trim() || cur.name; else open(line.slice(2).trim() || 'part');
    }
  }
  return groups.filter((g) => g.v.length).map((g) => ({ name: g.name, positions: Float32Array.from(g.v), faces: g.faces }));
}

/** Which welded points moved farther than eps from what was sent to the sculpt (without base: all). */
export function changedPoints(welded, base = null, eps = 0) {
  const moved = new Uint8Array(welded.length / 3);
  for (let w = 0; w < moved.length; w++) moved[w] = !base || Math.hypot(welded[w * 3] - base[w * 3], welded[w * 3 + 1] - base[w * 3 + 1], welded[w * 3 + 2] - base[w * 3 + 2]) > eps ? 1 : 0;
  return moved;
}

/** Source vertices whose normal may have changed: any face of their welded point contains a moved point. */
export function dirtyVertices(map, index, moved) {
  const F = Math.floor((index ? index.length : map.length) / 3), hot = new Uint8Array(moved.length), at = (f, k) => map[index ? index[f * 3 + k] : f * 3 + k];
  for (let f = 0; f < F; f++) {
    const a = at(f, 0), b = at(f, 1), c = at(f, 2);
    if ((a >= 0 && moved[a]) || (b >= 0 && moved[b]) || (c >= 0 && moved[c])) { if (a >= 0) hot[a] = 1; if (b >= 0) hot[b] = 1; if (c >= 0) hot[c] = 1; }
  }
  const out = new Uint8Array(map.length);
  for (let v = 0; v < map.length; v++) out[v] = map[v] >= 0 && hot[map[v]] ? 1 : 0;
  return out;
}

/**
 * Positions of all source vertices after the sculpt: a welded position is spread through map; vertices outside the
 * mesh stay as they were. base is the welded set sent to the sculpt: points that moved less than eps (OBJ/float32
 * rounding noise) are not touched, so untouched vertices stay bit-for-bit identical.
 */
export function applyWelded(original, map, welded, base = null, eps = 0) {
  const out = Float32Array.from(original), moved = changedPoints(welded, base, eps);
  for (let i = 0; i < map.length; i++) {
    const w = map[i];
    if (w < 0 || !moved[w]) continue;
    out[i * 3] = welded[w * 3]; out[i * 3 + 1] = welded[w * 3 + 1]; out[i * 3 + 2] = welded[w * 3 + 2];
  }
  return out;
}

/** The largest per-vertex shift between two position sets (0 - the sculpt changed nothing). */
export function maxDisplacement(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i += 3) { const d = Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]); if (d > m) m = d; }
  return m;
}

/**
 * Normals after the sculpt. Faces meeting at one point (UV and normal seams) are averaged together, but only when
 * the angle between them is at most creaseDeg: smooth seams stay smooth, hard edges stay hard.
 */
export function creaseNormals(positions, index, map, creaseDeg = 60) {
  const n = Math.floor(positions.length / 3), F = Math.floor((index ? index.length : n) / 3), cos = Math.cos((creaseDeg * Math.PI) / 180);
  const fn = new Float32Array(F * 3), fu = new Float32Array(F * 3);
  const corner = (f, k) => (index ? index[f * 3 + k] : f * 3 + k);
  for (let f = 0; f < F; f++) {
    const a = corner(f, 0) * 3, b = corner(f, 1) * 3, c = corner(f, 2) * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, len = Math.hypot(x, y, z);
    fn[f * 3] = x; fn[f * 3 + 1] = y; fn[f * 3 + 2] = z;
    if (len > 0) { fu[f * 3] = x / len; fu[f * 3 + 1] = y / len; fu[f * 3 + 2] = z / len; }
  }
  // faces of every source vertex and faces of every welded point (CSR)
  const own = csr(n, F, (f, k) => corner(f, k)), maxW = map.reduce((m, w) => Math.max(m, w), -1) + 1;
  const bucket = csr(maxW, F, (f, k) => map[corner(f, k)]);
  const out = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const w = map[v];
    let rx = 0, ry = 0, rz = 0;
    for (let i = own.start[v]; i < own.start[v + 1]; i++) { const f = own.items[i]; rx += fn[f * 3]; ry += fn[f * 3 + 1]; rz += fn[f * 3 + 2]; }
    const rl = Math.hypot(rx, ry, rz);
    if (w < 0 || !rl) { out[v * 3 + 2] = 1; continue; }
    rx /= rl; ry /= rl; rz /= rl;
    let x = 0, y = 0, z = 0;
    for (let i = bucket.start[w]; i < bucket.start[w + 1]; i++) {
      const f = bucket.items[i];
      if (fu[f * 3] * rx + fu[f * 3 + 1] * ry + fu[f * 3 + 2] * rz >= cos) { x += fn[f * 3]; y += fn[f * 3 + 1]; z += fn[f * 3 + 2]; }
    }
    const l = Math.hypot(x, y, z) || 1;
    out[v * 3] = x / l; out[v * 3 + 1] = y / l; out[v * 3 + 2] = z / l;
  }
  return out;
}

function csr(slots, F, pick) {
  const start = new Uint32Array(slots + 1);
  for (let f = 0; f < F; f++) for (let k = 0; k < 3; k++) { const s = pick(f, k); if (s >= 0) start[s + 1]++; }
  for (let i = 0; i < slots; i++) start[i + 1] += start[i];
  const fill = start.slice(0, slots), items = new Uint32Array(start[slots]);
  for (let f = 0; f < F; f++) for (let k = 0; k < 3; k++) { const s = pick(f, k); if (s >= 0) items[fill[s]++] = f; }
  return { start, items };
}
