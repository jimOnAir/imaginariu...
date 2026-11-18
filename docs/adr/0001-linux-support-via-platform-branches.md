# Linux support via platform branches, Windows behavior frozen

Imaginarium shipped as a Windows-only app (PowerShell installer, DPAPI vault, named-mutex GPU
lock, `.cmd` launchers). To run on Linux we add `process.platform` branches and POSIX
counterparts (bash installer, `start.sh`/`stop.sh`, `flock` GPU lock, PATH-based Blender/Godot
discovery) instead of a Linux-only fork, a shim layer over the Windows assumptions, or
containers. Every existing Windows code path is kept byte-for-byte so the port stays
mergeable upstream and Windows users cannot regress; new behavior activates only off Windows.
The shims would calcify into undocumented landmines, a divergent fork would freeze out upstream
fixes, and containers add GPU-pass-through friction for a personal-workstation app.
