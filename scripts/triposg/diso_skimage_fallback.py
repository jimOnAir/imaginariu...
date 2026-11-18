"""diso_skimage_fallback - Imaginarium's license-clean stand-in for the CUDA `diso` extension
(docs/product/triposg.md, ADR-0004 ticket 01).

Why this exists: TripoSG (MIT) extracts the iso-surface through `diso` (SarahWeiii/diso), which
is licensed CC BY-NC 4.0 - non-commercial. Imaginarium is commercial software, so `diso` is never
installed here. Instead the worker (scripts/triposg/triposg_run.py) registers this module as
`sys.modules['diso']` before importing the upstream code; the one call site that exists
(triposg/inference_utils.py, the octree geometry extractor) then resolves to this class.

Interface mirrored from the upstream call:

    dmc = DiffDMC(dtype=torch.float32).to(device)
    verts, faces = dmc(sdf, deform=None, return_quads=False, normalize=False)

  - `sdf`: dense (N,N,N) [or (1,N,N,N)] iso-surface grid from the octree - the solid is where
    the scalar is HIGH (the inverse of a textbook SDF) - with NaN in cells the
    sparse octree never queried.
  - returns torch tensors: `verts` float (M,3) in [0, dim-1] index space when normalize=False
    (mapped to [-1,1] when True), `faces` int64 (K,3) triangles.

Method: scikit-image's (BSD-2) classic marching cubes on a NaN-filled copy of the grid. Unknown
octree cells are far from the surface - the fill takes each one's nearest known value, so no
false iso-crossings appear. Sub-voxel vertex placement differs slightly from Dual Marching
Cubes; the output winding is matched so the exported GLB is outward-oriented (mechanically
checked in tests/triposg.test.mjs, which runs this file's own sphere self-test).
"""


class DiffDMC:
    """Drop-in replacement for diso.DiffDMC backed by scikit-image marching cubes."""

    def __init__(self, dtype=None):
        self._dtype = dtype  # torch dtype, resolved lazily by .to()/__call__ via torch

    def to(self, device_or_tensor):
        self._device = getattr(device_or_tensor, "device", device_or_tensor)
        return self

    def __call__(self, sdf, deform=None, return_quads=False, normalize=True):
        import numpy as np
        import torch
        from scipy.ndimage import distance_transform_edt
        from skimage.measure import marching_cubes

        if deform is not None:
            raise ValueError("the scikit-image fallback does not support grid deformation")
        if return_quads:
            raise ValueError("the scikit-image fallback returns triangles only")

        grid = sdf.detach()
        if grid.ndim == 4:  # batch of one, the way upstream builds it
            if grid.shape[0] != 1:
                raise ValueError("the scikit-image fallback handles one grid at a time")
            grid = grid[0]
        device, dtype = grid.device, grid.dtype
        arr = grid.float().cpu().numpy()

        bad = ~np.isfinite(arr)
        if bad.all():
            empty = torch.zeros((0, 3), dtype=dtype, device=device)
            return empty, torch.zeros((0, 3), dtype=torch.long, device=device)
        if bad.any():
            # nearest known neighbour; the unknown region is one uniform block, so this cannot
            # invent an iso-crossing - only extend a flat interior/exterior by a constant.
            idx = distance_transform_edt(bad, return_indices=True, return_distances=False)
            arr = arr[tuple(idx)]

        verts, faces, _normals, _values = marching_cubes(arr, level=0.0)
        # Orientation convention, taken from the real TripoSG grid: the solid region is where the
        # scalar INCREASES (the inverse of the textbook SDF), and scikit-image winds faces with
        # normals along the gradient - i.e. INTO the solid. The upstream call site reverses the
        # faces after us, so returning them unmodified leaves the exported GLB outward-oriented.
        # Both the sphere self-test below (solid = high values) and the live 5070 run assert a
        # positive final mesh volume.
        if normalize:
            dim = np.array(arr.shape, dtype=np.float32) - 1.0
            verts = verts / dim * 2.0 - 1.0

        return (torch.from_numpy(np.ascontiguousarray(verts, dtype=np.float32)).to(device=device, dtype=dtype),
                torch.from_numpy(np.ascontiguousarray(faces, dtype=np.int64)).to(device=device))


def register():
    """Make `import diso` (and `from diso import DiffDMC`) resolve to this module."""
    import sys
    sys.modules["diso"] = sys.modules[__name__]
    return DiffDMC


# ---- self-test: `python scripts/triposg/diso_skimage_fallback.py` (CPU, no GPU needed) ----

def _self_test():
    import numpy as np

    n = 128
    x = np.linspace(-1, 1, n)
    zz, yy, xx = np.meshgrid(x, x, x, indexing="ij")
    r = np.sqrt(xx * xx + yy * yy + zz * zz)
    grid = 1.0 - r  # the real TripoSG convention: positive (high) inside the unit sphere
    grid[np.abs(grid) > 0.4] = np.nan  # the sparse octree only resolved a band around the surface

    import torch
    t = torch.from_numpy(grid.astype("float32"))
    dmc = DiffDMC(dtype=torch.float32).to(t)
    verts, faces = dmc(t, deform=None, return_quads=False, normalize=False)
    verts = verts.cpu().numpy()
    faces = faces.cpu().numpy()

    world = verts / (n - 1) * 2.0 - 1.0  # index space -> [-1,1]
    import trimesh
    mesh = trimesh.Trimesh(world, faces[:, ::-1], process=False)  # the same winding step TripoSG applies
    r = np.linalg.norm(world, axis=1)
    assert abs(r.max() - 1.0) < 0.05 and abs(r.min() - 1.0) < 0.05, "vertices lie on the unit sphere"
    assert mesh.is_watertight, "closed surface"
    assert mesh.volume > 0, "outward orientation (positive signed volume)"
    print("OK: %d verts, %d faces, watertight, volume=%.4f (sphere 4/3*pi=%.4f)"
          % (len(world), len(faces), mesh.volume, 4.18879))


if __name__ == "__main__":
    _self_test()
