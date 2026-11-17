# VRM 1.0 — the character as one `.vrm` file

The VRM line arrived with the 0.7.10 fold wave (Linux branch): the component installer
(ticket 61), the `vrm_package` step (ticket 62), and the Forge surfaces — `.vrm` upload, the
"VRM 1.0 (anime)" export profile, the `humanoid_vrm` pack (ticket 63).

VRM 1.0 is an open standard for humanoid avatars: a **glTF 2.0 binary container** that declares
a `VRMC_vrm` extension carrying the humanoid bone assignment, the meta block, expression
presets, materials (MToon) and spring bones. The step drives the
[VRM Add-on for Blender](https://github.com/saturday06/VRM-Addon-for-Blender) — installed as
the `vrmaddon` studio component, enabled inside the step's own background Blender. The bone
table, the Mixamo correspondence and the ARKit expression blends were re-derived from the
published VRM 1.0 specification and the add-on's published mapping tables (see
`scripts/blender/steps/_vrm_lib.py`); the step code is branch-original.

## Verification status — read this before quoting the doc

Honest split, as of the wave (the runtime half waits for the pinned add-on archive to clear
the 7-day supply-chain gate, 2026-11-18):

| Claim | Status |
| --- | --- |
| `.vrm` uploads pass the gate only if the container declares a VRM extension (`bad_vrm` otherwise) | tested (`tests/forge-pipeline.test.mjs`) |
| an uploaded `.vrm` runs the humanoid chain (source → cleanup → rig) | tested (chain test, same file) |
| the step maps the rig to the spec's Required-15 bones; a shoulder-less rig is not blocked | lane-tested (`scripts/blender/tests/test_vrm_package.py`) |
| ARKit expression matching: direct keys and the published blends, unsupported presets named as gaps | lane-tested |
| the remedy errors (no skeleton / missing Required bones / component not installed) name the next action | lane-tested |
| producing a real `.vrm` end to end (export, re-import round trip) | **not yet verified** — the test exists (`test_vrm_export_round_trip`) and skips until the component installs |
| expressions actually bound in the exported file; MToon; `VRMC_springBone` | **not attempted yet** — the run report says so (`expressions_bound: false`, `gaps.springs`) |
| Unity/UniVRM, UE5/VRM4U, Godot/godot-vrm opening our files | **not verified by us** — that is the standard's promise, not our test result |

## Running it

The step lives in the registry like every other step (`GET /api/forge/steps`):
`vrm_package`, kinds `humanoid`, inputs `glb` (+ `manifest`), outputs `vrm` + `report`,
profile `vrm1`. In the UI it is the **"VRM 1.0 (anime)"** export profile, or the whole route as
the preset **"Humanoid from a model -> VRM 1.0 (anime)"**
(`cleanup 40k/1.8m → rig_humanoid → retarget → vrm_package`).

CLI (the lane's runner, as for every step):

```
runtime/blender/blender-5.2.4-linux-x64/blender -b --factory-startup \
    --python scripts/blender/af_run.py -- vrm_package request.json
runtime/blender/blender-5.2.4-linux-x64/blender -b --factory-startup \
    --python scripts/blender/tests/run_tests.py -- vrm_package
```

```json
{"step": "vrm_package", "params": {"profile": "vrm1", "meta_name": "Char One",
  "meta_version": "0.1.0", "meta_author": "AstraForge studio",
  "expressions": "auto", "validate": true},
 "inputs": {"glb": "abs/character.glb", "manifest": "abs/asset.json"},
 "out_dir": "abs/out"}
```

## What the run report says

`vrm_package.json` (the `report` output) carries the stats, and the honesty rule is the
contract: **a run never claims more than it did**. `stats.expressions_matched` lists what the
face supports (a preset name → the direct shape key, or `arkit-blend` with the published
weights); `stats.expressions_bound` is `false` while the binding half has not landed;
`stats.gaps.expressions` names every preset the character cannot support — nothing is silently
dropped. `stats.extensions_used` and `stats.vrm_meta_name` are read back from the produced
file's own JSON chunk (a reader with the same contract as the upload gate — parallel JS and
Python implementations of the chunk format), and `stats.reimport`
proves the rig survives a stock glTF re-import of those bytes.

## Parameters

| Param | Default | Meaning |
| --- | --- | --- |
| `profile` | `vrm1` | the only value; reserved by the profile machinery |
| `meta_name` | asset name | the VRM meta name |
| `meta_version` | `0.1.0` | the VRM meta version |
| `meta_author` | `AstraForge studio` | the VRM meta author |
| `expressions` | `auto` | `auto` wires what the face supports; `off` ships rig and materials only |
| `validate` | true | re-read the produced `.vrm` as a container and re-import it in Blender |

The component: **VRM Add-on for Blender 4.10.5** — the studio installer puts it in
`runtime/vrm-addon` (`installer -Only vrmaddon`, config key `vrm_addon`, env override
`ASTRA_VRM_ADDON`). Without it the step fails with the named remedy, not a crash, and the
preset help says it is needed.
