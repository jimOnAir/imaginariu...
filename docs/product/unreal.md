# Unreal Engine 5 (the export line)

Imaginarium turns an asset into an **Unreal-ready package on this Linux studio**, and an
**Imaginarium importer plugin** turns that package into engine assets in any UE 5.x project.
The line is the sibling of the Unity and Godot exports: same passport, same socket contract
(`socket_*`), same clips (`-loop`), same collision naming (`-colonly`, `-convcolonly`, `COL_*`).

## The flow

1. **Forge → Export step** (`unreal_package`, module `export`) builds a package folder:
   - `SM_<asset>.fbx` / `SK_<asset>.fbx` - render meshes renamed to the UE conventions, plus
     UCX collision hulls and `_LOD1/_LOD2` meshes (static assets from `lod_min_tris` triangles);
   - `Textures/T_<asset>_<slot>_BaseColor.png`, `..._Normal.png` (green flipped to DirectX),
     `..._ORM.png` (R occlusion, G roughness, B metallic);
   - `ima_unreal.json` - the passport of the package: units (centimetres), axes (Z up, nose +X,
     left-handed; the FBX is written `axis_forward -Y / axis_up Z`), the material instances
     (`MI_*` of the master `M_Imaginarium`), collision, sockets, animations (A_*), fps and the
     studio passport carried through untouched;
   - `README.md` for the person dropping the folder into a project.
2. **The project** (`scripts/engines/imaginarium_engine.mjs`):
   - `create --engine unreal --name <Game>` writes a minimal `.uproject` with the Imaginarium
     plugin (`unreal/Imaginarium/`, Python-only, no binaries) and `PythonScriptPlugin` enabled -
     no editor needed to create it;
   - `send --project <Game> <package|zip>` copies the packages into
     `<Game>/ImaginariumPackages/<asset_id>/`;
   - `test --project <Game>` runs `UnrealEditor-Cmd <Game>.uproject -run=pythonscript
     -script=<import script> -nullrhi -unattended -nosplash` per package: the plugin imports
     the FBX and textures, builds `M_Imaginarium` and its `MI_*` instances, the physics asset
     from UCX, skeleton sockets, animations and the `A_<asset>` blueprint, then `check` writes
     `unreal_check.json`. A per-project lock (`.ima_unreal.lock`) keeps a second background run
     out while one is going.
3. **The agent path**: `mcp-register` registers `unreal-mcp` for Claude Code when
   `IMAGINARIUM_UNREAL_MCP` points at the server (create/send/test work without it).

## Where an Unreal Editor is absent (this machine)

The plugin, the manifest and the bridge contract are code-reviewed and data-tested
(`tests/unreal.test.mjs`, `scripts/blender/tests/test_unreal.py`); **the in-editor import has
never been executed here** - there is no Unreal Editor on Linux-studio machines in this setup.
`test` says so plainly and points at `IMAGINARIUM_UNREAL`; `create`/`send` do their whole job without
an editor. Every plugin step is guarded: the engine's own answer (imported / skipped with a
reason) lands in `import_report.json`, so the first run on a real editor produces the checklist
that fixes whatever the API changed. Treat the line as **unverified-by-design until someone runs
it against Unreal 5.8+ with Python enabled** (the same status the Unity C# line carries).

## Conventions the package obeys

| | |
|---|---|
| units | centimetres (the FBX carries the metres->cm conversion) |
| axes | Z up, nose **+X**, left-handed; a `+Z` GLB nose is turned -90° on the root |
| names | `SM_` static mesh, `SK_` skeletal, `A_` blueprint, `T_` texture, `MI_` material instance, `UCX_<mesh>_##` collision, `<mesh>_LOD1/_LOD2` |
| materials | instances of one master `M_Imaginarium` (BaseColor / Normal DirectX / ORM) |
| collision | `*-colonly`, `*-convcolonly`, `COL_*` hull the render mesh and never render |
| sockets | `socket_*` empties; bone-parented ones become Skeleton sockets |
