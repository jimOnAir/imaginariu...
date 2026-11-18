#!/usr/bin/env node
// CLI of the 2D module (docs/art2d.md). Talks to ComfyUI directly - the studio server does not have to run,
// but its ComfyUI (:8190, started by the studio) or another one with ComfyUI-GGUF must.
//
//   node scripts/art2d/art2d.mjs status [--comfy URL]
//   node scripts/art2d/art2d.mjs list | styles | recipes
//   node scripts/art2d/art2d.mjs make --recipe turnaround --character hero.png [--style painted] [--engine flux2]
//        [--prompt "..."] [--action walk] [--direction right] [--frames 6] [--views front,side,back] [--parts head,torso]
//        [--scenes scenes.txt] [--style-image look.png] [--poses dir|a.png,b.png] [--inputs dir|a.png,...]
//        [--chain] [--sheet default|heroes_gates|hd] [--seed N] [--steps N] [--name "..."] [--godot] [--dry]
//   node scripts/art2d/art2d.mjs redo <setId> <shotKey,...> [--new-seed]
//   node scripts/art2d/art2d.mjs resume <setId>
//   node scripts/art2d/art2d.mjs godot <setId>
import path from 'node:path';
import { promises as fs, existsSync, statSync } from 'node:fs';
import { DEFAULT_COMFY_URL } from '../views/comfy_client.mjs';
import { STYLES } from './art2d_styles.mjs';
import { RECIPES, ACTIONS } from './art2d_recipes.mjs';
import { ART2D_ROOT, art2dStatus, createSet, runSet, exportGodot, listSets, loadSet, SHEET_PRESETS } from './art2d_run.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = [];
const opt = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[k] = argv[++i]; else opt[k] = true;
  } else pos.push(a);
}
const comfyUrl = opt.comfy || process.env.IMAGINARIUM_COMFY_URL || DEFAULT_COMFY_URL;
const root = opt.root || process.env.IMAGINARIUM_ART2D_ROOT || ART2D_ROOT;
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const IMG = /\.(png|jpe?g|webp)$/i;

async function files(v) {
  if (!v) return [];
  if (existsSync(v) && statSync(v).isDirectory()) return (await fs.readdir(v)).filter((f) => IMG.test(f)).sort().map((f) => path.join(v, f));
  return list(v).map((f) => path.resolve(f));
}
const progress = (t) => process.stdout.write(`  ${new Date().toLocaleTimeString()}  ${t}\n`);

async function run(dir, o = {}) {
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  const set = await runSet(dir, { comfyUrl, signal: controller.signal, onProgress: progress, ...o });
  console.log(`Done in ${set.run.seconds} s: ${set.shots.filter((s) => s.status === 'done').length}/${set.shots.length} frames`);
  for (const [k, v] of Object.entries(set.outputs)) if (v.file) console.log(`  ${k}: ${path.join(dir, v.file)}`);
  if (opt.godot) console.log('  godot: ' + await exportGodot(dir));
}

async function main() {
  if (cmd === 'status') {
    const s = await art2dStatus(comfyUrl);
    console.log(`ComfyUI ${comfyUrl}: ${s.online ? 'answering' : 'not answering'}`);
    for (const [id, e] of Object.entries(s.engines)) console.log(`  [${e.ready ? 'ready' : 'no  '}] ${id.padEnd(6)} ${e.label} - ${e.license}${e.reasons.length ? '\n        ' + e.reasons.join('\n        ') : ''}`);
    return;
  }
  if (cmd === 'styles') { for (const [id, s] of Object.entries(STYLES)) console.log(`${id.padEnd(9)} ${s.label} - ${s.note}`); return; }
  if (cmd === 'recipes') {
    for (const [id, r] of Object.entries(RECIPES)) console.log(`${id.padEnd(11)} ${r.label} - ${r.note}`);
    console.log('\nActions for --action: ' + Object.entries(ACTIONS).map(([k, a]) => `${k} (${a.label}, ${a.poses.length})`).join(', '));
    console.log('Sheets for --sheet: ' + Object.entries(SHEET_PRESETS).map(([k, p]) => `${k} (${p.label})`).join(', '));
    return;
  }
  if (cmd === 'list') {
    for (const s of await listSets(root)) console.log(`${s.id}  ${s.recipe.padEnd(11)} ${s.style.padEnd(9)} ${s.shots.filter((x) => x.status === 'done').length}/${s.shots.length}  ${s.run?.status || 'new'}  ${s.name}`);
    return;
  }
  if (cmd === 'make') {
    const scenes = opt.scenes ? (existsSync(opt.scenes) ? (await fs.readFile(opt.scenes, 'utf8')).split(/\r?\n/) : String(opt.scenes).split('|')) : undefined;
    const input = {
      recipe: opt.recipe, style: opt.style || 'painted', engine: opt.engine || 'flux2', prompt: opt.prompt, action: opt.action, direction: opt.direction,
      frames: opt.frames ? Number(opt.frames) : undefined, chain: !!opt.chain, views: list(opt.views), parts: list(opt.parts), scenes,
      character: opt.character ? path.resolve(opt.character) : undefined, styleImage: opt['style-image'] ? path.resolve(opt['style-image']) : undefined,
      poses: await files(opt.poses), inputs: await files(opt.inputs), sheet: opt.sheet, seed: opt.seed !== undefined ? Number(opt.seed) : undefined,
      steps: opt.steps ? Number(opt.steps) : undefined, name: opt.name,
    };
    const { dir, set } = await createSet(input, { root });
    console.log(`Set ${set.id}: ${set.name} - ${set.shots.length} frame(s), ${set.engine}, style ${set.style}\n  ${dir}`);
    if (opt.dry) { for (const s of set.shots) console.log(`  - ${s.key}: ${s.prompt.slice(0, 160)}`); return; }
    await run(dir);
    return;
  }
  if (cmd === 'resume' || cmd === 'redo') {
    const dir = path.join(root, pos[0] || '');
    if (!(await loadSet(dir))) throw new Error('No set ' + pos[0]);
    await run(dir, cmd === 'redo' ? { only: list(pos[1]), newSeed: !!opt['new-seed'] } : {});
    return;
  }
  if (cmd === 'godot') { console.log(await exportGodot(path.join(root, pos[0] || ''))); return; }
  console.log('Commands: status | styles | recipes | list | make | resume | redo | godot  (details at the top of this file and docs/art2d.md)');
}

main().catch((e) => { console.error('Error: ' + (e.message || e)); process.exit(1); });
