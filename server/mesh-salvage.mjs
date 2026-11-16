// Ticket 34 (0.6.18 wave, Windows 0.6.13 intent): a generated mesh over the triangle cap is
// simplified to the limit instead of the generation being thrown away — the GPU minutes are
// already paid for. Only a STRUCTURALLY valid GLB that is merely dense gets this path; the old
// honest error returns unchanged when simplification cannot reach the cap. Windows 0.6.15's
// parameter honesty rides here too: with "Surface level" at the edge (±1) an empty or
// irreducible mesh message suggests setting it back to 0.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateGeneratedMesh, maxMeshTriangles } from './mesh-validation.mjs';
import { runBlenderStep } from './blender.mjs';
import { afMeshConfig, runAfMesh } from './af-mesh.mjs';
import { data } from './storage.mjs';

export const SALVAGE_ROOT = path.join(data, 'runtime', 'salvage');

/** The ±1→0 suggestion (0.6.15); '' when the level is in the middle of the range. */
export function surfaceLevelHint(meshLevel) {
  return Number(meshLevel) === 1 || Number(meshLevel) === -1
    ? ' Surface level is at the edge (+1 or -1); try setting it back to 0.' : '';
}

/**
 * Validate a generated GLB, salvaging an over-cap mesh through `simplify`.
 * @param {Buffer} buffer
 * @param {{meshLevel?:number, simplify?:(buffer:Buffer)=>Promise<Buffer>}} o
 * @returns {Promise<{validation:object, simplifiedBuffer:Buffer|null}>} validation carries
 *          `simplifiedFrom` (the original triangle count) when the mesh was reduced.
 * @throws the original validation error (plus the ±1 hint where it applies) when not salvageable.
 */
export async function acceptOrSimplify(buffer, { meshLevel = 0, simplify } = {}) {
  try {
    return { validation: validateGeneratedMesh(buffer), simplifiedBuffer: null };
  } catch (e) {
    if (e.code !== 'oversize' && e.code !== 'oversize-bytes') {
      if (e.code === 'empty-mesh') e.message += surfaceLevelHint(meshLevel);
      throw e;
    }
    let simplified = null;
    if (simplify) {
      try { simplified = await simplify(buffer); } catch { simplified = null; }
    }
    if (simplified) {
      try {
        return { validation: { ...validateGeneratedMesh(simplified), simplifiedFrom: e.triangles }, simplifiedBuffer: simplified };
      } catch { /* the reduced mesh is still no good — fall back to the original honest error */ }
    }
    e.message += surfaceLevelHint(meshLevel);
    throw e;
  }
}

/**
 * The Blender decimate path: the branch's own `cleanup` step with every other operation turned
 * off — the mesh comes back identical except for the triangle budget (0.6.13: "simplified to
 * the limit"). The limit is BOTH caps: a reduced mesh can still miss the byte gate through
 * normal/UV attribute splitting, so a failed re-validation keeps halving the budget (up to 3
 * passes). Injectable `runStep` keeps the unit lane Blender-free.
 */
export function makeBlenderSimplify({ runStep = runBlenderStep, root = SALVAGE_ROOT, passes = 3 } = {}) {
  return async (buffer) => {
    const dir = path.join(root, randomUUID());
    try {
      await fs.mkdir(dir, { recursive: true });
      const src = path.join(dir, 'oversize.glb');
      await fs.writeFile(src, buffer);
      let target = maxMeshTriangles;
      let out = null;
      for (let pass = 0; pass < passes; pass++) {
        await runStep({
          step: 'cleanup',
          jobId: 'salvage',
          request: {
            inputs: { mesh: pass ? path.join(dir, 'pass' + pass + '.glb') : src },
            params: { join: true, ground: false, center: false, merge_distance: 0, remove_islands_below: 0,
              recalc_normals: false, shade_auto_smooth_deg: null, preview: false, target_tris: target },
            out_dir: path.join(dir, 'p' + pass),
          },
        });
        out = await fs.readFile(path.join(dir, 'p' + pass, 'clean.glb'));
        try { validateGeneratedMesh(out); return out; }
        catch (e) {
          if (e.code !== 'oversize' && e.code !== 'oversize-bytes') throw e;
          target = Math.floor(target / 2);
          if (pass < passes - 1) await fs.writeFile(path.join(dir, 'pass' + (pass + 1) + '.glb'), out);
        }
      }
      return out; // last pass stands; acceptOrSimplify will fail it with the original honest error
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

/**
 * The af-mesh-rs fast path (ticket 46, 0.7.9 performance wave): the studio's own decimator —
 * the same budget-and-halve rhythm as the Blender path, seconds instead of minutes, and the
 * carry-contract (rig weights, colors, normals, shape keys) proven by the crate's own tests.
 * Every failure shape answers `null` — binary absent (the ticket-30 posture: an installed
 * studio without cargo), a CLI refusal, a wedged run, a summary that cannot be read — so the
 * caller's fallback decides instead of failing the job. Injectable `run`/`cfg` keep the unit
 * lane af-mesh-free.
 */
export function makeAfMeshSimplify({ root = SALVAGE_ROOT, passes = 3, cfg = afMeshConfig(), run = runAfMesh } = {}) {
  return async (buffer) => {
    if (!cfg.found) return null;
    const dir = path.join(root, randomUUID());
    try {
      await fs.mkdir(dir, { recursive: true });
      const src = path.join(dir, 'in.glb');
      await fs.writeFile(src, buffer);
      let target = maxMeshTriangles;
      let out = null;
      for (let pass = 0; pass < passes; pass++) {
        const dst = path.join(dir, 'out' + pass + '.glb');
        const r = await run({ exe: cfg.exe, args: ['simplify', '--in', src, '--tris', String(target), '--out', dst, '--json'] });
        if (r.code !== 0) return null; // refusal or wedged run: the fallback decides
        let summary = null;
        try { summary = JSON.parse(r.stdout); } catch { return null; }
        if (!(summary.trianglesAfter > 0) || summary.trianglesAfter >= summary.trianglesBefore) return null; // declined: nothing was removed
        try { out = await fs.readFile(dst); } catch { return null; }
        try { validateGeneratedMesh(out); return out; }
        catch (e) {
          if (e.code !== 'oversize' && e.code !== 'oversize-bytes') return null;
          target = Math.floor(target / 2); // the byte gate can still miss through attribute data (0.6.13 rule)
        }
      }
      return out; // last pass stands; the salvage chain judges it, then the Blender path gets its turn
    } catch {
      return null;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

/**
 * The salvage chain as the jobs use it (ticket 46): af-mesh-rs first, the Blender path stays the
 * fallback for anything the fast path declines or cannot finish — and `ASTRA_SALVAGE=blender`
 * forces it as the whole route, byte-identical behavior to the wave before af-mesh existed.
 */
export function makeSalvageSimplify({ env = process.env, makeAfMesh = makeAfMeshSimplify, makeBlender = makeBlenderSimplify } = {}) {
  if (String(env.ASTRA_SALVAGE || '').toLowerCase() === 'blender') return makeBlender();
  const af = makeAfMesh();
  const blender = makeBlender();
  return async (buffer) => {
    const out = await Promise.resolve(af(buffer)).catch(() => null);
    if (out) {
      try { validateGeneratedMesh(out); return out; } catch { /* still over a cap — the Blender path gets its turn */ }
    }
    return blender(buffer);
  };
}
