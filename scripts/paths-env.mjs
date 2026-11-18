#!/usr/bin/env node
// Maps config/paths.json (written by the installer) to `export IMAGINARIUM_*=...` lines for scripts/start.sh.
// The file is read BOM-safe: before 0.4.11 a UTF-8 BOM (as written by Windows PowerShell 5.1) made the
// studio lose installer-written paths such as pixal3dDir silently. Variables already set by the user win.
import { readFileSync } from 'node:fs';

const MAP = {
  comfyDir: 'IMAGINARIUM_COMFY_DIR',
  blender: 'IMAGINARIUM_BLENDER',
  godot: 'IMAGINARIUM_GODOT',
  library: 'IMAGINARIUM_LIBRARY',
  forgeRuntime: 'IMAGINARIUM_RUNTIME',
  pixal3dDir: 'IMAGINARIUM_PIXAL3D_DIR',
  vfxTools: 'IMAGINARIUM_VFX_TOOLS',
};

const config = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
for (const [key, name] of Object.entries(MAP)) {
  if (config[key] && !process.env[name]) console.log(`export ${name}=${JSON.stringify(String(config[key]))};`);
}
if (config.node && !process.env.IMAGINARIUM_NODE) console.log(`export IMAGINARIUM_NODE_PATH=${JSON.stringify(String(config.node))};`);
