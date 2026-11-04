#!/usr/bin/env node
// Palette tokenizer (behavior per ADR-0004, ticket 04): rewrites every #hex color literal in
// src/**/*.css into var(--c-<hex>) and generates src/palette.css with the dark map (:root) and a
// derived light map (html[data-theme='light']) + src/palette-map.json for the palette test.
//
// Dark theme is byte-equivalent by construction: each token's :root value IS the original hex.
// Light values are derived by an HSL rule (deep surfaces -> paper, near-white text -> ink, mid
// tones flipped, accents deepened) with a curated override table for the brand anchors.
// Near-black colors and translucent scrims are treated as shadows/overlays and stay dark.
//
// Run: node scripts/ui/palette-tokens.mjs [--check]
//   --check  verifies the tree against the map without writing (used by tests/shell-palette.test.mjs)
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const PALETTE = 'palette.css';
const MAP = 'palette-map.json';
const HEX = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;

// anchors of the dark design kept in style.css :root + the accent family (light values authored)
const OVERRIDES = {
  '#111516': '#edefe7', '#202628': '#f7f8f2', '#343d3f': '#c6cdc3', '#849291': '#59665f', '#a0adaa': '#515e57',
  '#d5df9b': '#5c6c2e', '#e2ebb1': '#51601f', '#e2e5dc': '#252c27', '#ced4d1': '#303a34', '#afbdb4': '#455249',
  '#eceee3': '#1f2621', '#cbd5cb': '#37413a', '#e7e9da': '#242a1e', '#b5c1bb': '#47534c', '#95a6a0': '#5b6862',
  '#252e25': '#eef2df', '#232922': '#f2f5e4', '#1a2021': '#e9ebe2', '#1a2022': '#e7e9e0', '#1c2325': '#e3e6dc',
  '#171c1e': '#e6e8e0', '#20292a': '#eef0e8', '#18221c': '#dfe5d6', '#191f21': '#fdfdf8',
};

const cssFiles = (dir) => readdirSync(dir).flatMap((f) => {
  const p = path.join(dir, f);
  if (statSync(p).isDirectory()) return cssFiles(p);
  return p.endsWith('.css') && path.basename(p) !== PALETTE ? [p] : [];
});

const norm = (hex) => {
  let h = hex.slice(1).toLowerCase();
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('') + h[3] + h[3];
  return '#' + h;
};
const parse = (h) => {
  const b = h.slice(1);
  return { r: parseInt(b.slice(0, 2), 16), g: parseInt(b.slice(2, 4), 16), bl: parseInt(b.slice(4, 6), 16), a: b.length === 8 ? parseInt(b.slice(6, 8), 16) / 255 : 1 };
};
const toHex = (r, g, b, a) => '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('') + (a < 1 ? Math.round(a * 255).toString(16).padStart(2, '0') : '');
const hsl = ({ r, g, bl }) => {
  const R = r / 255, G = g / 255, B = bl / 255, mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
  let H = 0;
  if (d) H = mx === R ? 60 * (((G - B) / d) % 6) : mx === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4);
  const L = (mx + mn) / 2, S = d === 0 ? 0 : d / (1 - Math.abs(2 * L - 1));
  return { H: (H + 360) % 360, S, L };
};
const hslToHex = (H, S, L, a) => {
  const C = (1 - Math.abs(2 * L - 1)) * S, X = C * (1 - Math.abs(((H / 60) % 2) - 1)), m = L - C / 2;
  const seg = [[C, X, 0], [X, C, 0], [0, C, X], [0, X, C], [X, 0, C], [C, 0, X]][Math.floor(H / 60) % 6];
  return toHex((seg[0] + m) * 255, (seg[1] + m) * 255, (seg[2] + m) * 255, a);
};

function lightOf(hex) {
  if (OVERRIDES[hex]) return OVERRIDES[hex];
  const { r, g, bl, a } = parse(hex), { H, S, L } = hsl({ r, g, bl });
  if (L < 0.10 || a <= 0.35) return hex;                      // shadow, scrim, black veil: stays
  let NL;
  if (L <= 0.30) NL = 0.965 - L * 0.30;                       // dark surface -> paper
  else if (L >= 0.84) NL = 0.20 - (1 - L) * 0.5;              // near-white ink -> deep ink
  else NL = Math.min(0.93, Math.max(0.30, 1.04 - L));         // mid tone: flip about the middle
  const NS = L <= 0.30 ? Math.min(S, 0.22) : L >= 0.84 ? S : (S > 0.30 ? S : Math.min(S * 1.1, 0.45));
  return hslToHex(H, NS, Math.min(0.99, Math.max(0.10, NL)), a);
}

const check = process.argv.includes('--check');
const files = cssFiles(SRC);
const used = new Map();                                     // token hex -> first file seen
let changed = 0;
const rendered = files.map((f) => {
  const src = readFileSync(f, 'utf8');
  const out = src.replace(HEX, (m) => {
    const n = norm(m);
    used.set(n, used.get(n) || path.relative(ROOT, f));
    return 'var(--c' + n.slice(1) + ')';
  });
  if (out !== src) changed++;
  return [f, out];
});

const tokens = [...used.keys()].sort();
const mapJson = JSON.stringify(Object.fromEntries(tokens.map((t) => [t, t])), null, 1) + '\n';
const darkBlock = tokens.map((t) => '  --c' + t.slice(1) + ':' + t + ';').join('\n');
const lightBlock = tokens.map((t) => '  --c' + t.slice(1) + ':' + lightOf(t) + ';').join('\n');
const palette =
  '/* Generated by scripts/ui/palette-tokens.mjs - the studio palette as tokens.\n' +
  '   :root carries the dark theme (every value is the original literal of the stylesheets),\n' +
  '   html[data-theme=light] the derived light theme. Do not edit by hand: rerun the tool.\n' +
  '   Curated anchors live in the tool override table. */\n' +
  ':root{\n' + darkBlock + '\n}\n' +
  'html[data-theme=light]{\n' + lightBlock + '\n}\n';

if (!check && used.size === 0 && files.length > 5) {
  console.error('nothing to tokenize - the stylesheets are already tokenized; rerun only after reverting, or use --check');
  process.exit(1);
}
if (check) {
  const errors = [];
  let curPalette = '';
  try { curPalette = readFileSync(path.join(SRC, PALETTE), 'utf8'); } catch { errors.push('src/' + PALETTE + ' is missing'); }
  let curMap = {};
  try { curMap = JSON.parse(readFileSync(path.join(SRC, MAP), 'utf8')); } catch { errors.push('src/' + MAP + ' is missing or unreadable'); }
  const lightBlock = curPalette.slice(curPalette.lastIndexOf('html[data-theme=light]{'));
  const varUses = new Set();
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    for (const m of txt.matchAll(/var\(--c([0-9a-f]{6,8})\)/g)) varUses.add('#' + m[1]);
    if (/#([0-9a-fA-F]{3,8})\b/.test(txt)) errors.push(path.relative(ROOT, f) + ' still has a bare #hex literal');
  }
  for (const hex of varUses) {
    const name = '--c' + hex.slice(1);
    if (!new RegExp(name + ':' + hex + ';').test(curPalette)) errors.push('no :root dark value equal to the original literal for ' + name);
    if (!lightBlock.includes(name + ':')) errors.push('no light value defined for ' + name);
    if (!(hex in curMap)) errors.push('map entry missing for ' + hex);
  }
  const stale = Object.keys(curMap).filter((k) => !varUses.has(k));
  if (stale.length) errors.push('map has unused tokens: ' + stale.slice(0, 5).join(', ') + (stale.length > 5 ? ' …' : ''));
  const undef = [...varUses].filter((h) => !curPalette.includes('--c' + h.slice(1) + ':'));
  if (undef.length) errors.push('tokens used in css but absent from palette.css: ' + undef.slice(0, 5).join(', '));
  if (errors.length) { console.error('palette check FAILED:\n' + errors.join('\n')); process.exit(1); }
  console.log('palette check ok: ' + varUses.size + ' tokens, ' + files.length + ' css files, dark==original, both themes defined');
  process.exit(0);
}

for (const [f, out] of rendered) writeFileSync(f, out);
writeFileSync(path.join(SRC, PALETTE), palette);
writeFileSync(path.join(SRC, MAP), mapJson);
console.log('tokenized ' + used.size + ' colors across ' + files.length + ' css files (' + changed + ' rewritten); wrote src/' + PALETTE + ' and src/' + MAP);
