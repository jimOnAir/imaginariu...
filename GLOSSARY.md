# Imaginarium

A local 3D asset studio: one application folder that turns a picture or a prompt into a game-ready
3D asset. This glossary is the binding vocabulary for new prose and names in this repository.

## Language

**Studio**:
The Imaginarium application the user runs: the Node server plus the browser UI on port 3210.
_Avoid_: app, site, frontend

**Engine**:
A ComfyUI instance the studio starts and stops for GPU generation: the Hunyuan engine on port
8190 and the Pixal3D engine on port 8191.
_Avoid_: backend, worker, server (the server is the Studio)

**Component**:
One named installable unit of the runtime, addressed by its id (`comfy`, `hy2`, `sdxl`, `godot`,
`pixal3d`, …) by the installer and the `-Only` list.
_Avoid_: package, module, feature

**App-local runtime**:
The rule that everything the installer downloads lives inside the application folder
(`runtime/`, `data/models/`, `tools/`) instead of system locations, so the studio needs no
administrator rights and can be moved or deleted as one directory.
_Avoid_: portable mode, green install

**Scan**:
The pre-install report of the machine (`-ScanOnly`): GPU and VRAM, free disk, what is already
installed. It downloads nothing.
_Avoid_: doctor, preflight

**GPU lock**:
The system-wide turnstile that lets exactly one GPU job run at a time across processes (named
mutex on Windows, lock file on Linux). A ComfyUI started by hand does not take the lock; the
studio's engines do.
_Avoid_: GPU mutex (only as the Windows mechanism), semaphore

**Linux parity**:
The agreed scope of the Linux port: every studio feature works, except tools whose vendors ship
no Linux binary — those are marked unavailable, never emulated.
_Avoid_: full support, Wine compatibility

**Connections**:
The tab where the user enters cloud API keys; on Windows keys are stored encrypted, elsewhere
they are read from environment variables only.
_Avoid_: settings, credentials tab
