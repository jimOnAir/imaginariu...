// Builds the static SculptGL for the Sculpt tab: node scripts/sculpt/assemble.mjs <SculptGL sources> <destination>
// Takes <src>/app (after `webpack --env release`), copies it to <destination>, strips external calls (Google Fonts,
// the Sketchfab auth page), wires scripts/sculpt/bridge.js in and copies the MIT license.
// Run by scripts/vfx/install-vfx.sh; can also be run by hand.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARK = '<!-- astraforge-bridge -->';
const here = path.dirname(fileURLToPath(import.meta.url));

/** The SculptGL index.html -> the studio index.html: no Google Fonts, the app exposed as window.sculptApp, the bridge wired in. */
export function patchIndex(html) {
  if (html.includes(MARK)) return html;
  let out = html
    .replace(/[ \t]*<link[^>]*fonts\.googleapis\.com[^>]*>\r?\n?/i, '')
    .replace(/<title>[^<]*<\/title>/i, '<title>SculptGL · AstraForge</title>');
  const start = 'app.start();';
  if (!out.includes(start)) throw new Error('SculptGL index.html has no app.start(): a build of another version, the bridge is not wired in.');
  out = out.replace(start, 'app.start();\n    window.sculptApp = app;');
  const script = "<script src='sculptgl.js'></script>";
  if (!out.includes(script)) throw new Error('SculptGL index.html has no <script src=sculptgl.js>.');
  return out.replace(script, script + '\n  ' + MARK + "\n  <script src='sculptgl-bridge.js'></script>");
}

export async function assemble(src, out) {
  const app = path.join(src, 'app');
  const index = path.join(app, 'index.html');
  await fs.access(index).catch(() => { throw new Error(`No ${index}: build SculptGL first (webpack --env release).`); });
  await fs.rm(out, { recursive: true, force: true });
  await fs.cp(app, out, { recursive: true, filter: (p) => path.basename(p) !== 'authSuccess.html' });
  await fs.writeFile(path.join(out, 'index.html'), patchIndex(await fs.readFile(index, 'utf8')));
  await fs.copyFile(path.join(here, 'bridge.js'), path.join(out, 'sculptgl-bridge.js'));
  await fs.copyFile(path.join(src, 'LICENSE'), path.join(out, 'LICENSE.txt')).catch(() => {});
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) { console.error('Usage: node assemble.mjs <SculptGL sources> <destination>'); process.exit(2); }
  assemble(path.resolve(src), path.resolve(out)).then((o) => console.log('SculptGL assembled: ' + o), (e) => { console.error(e.message); process.exit(1); });
}
