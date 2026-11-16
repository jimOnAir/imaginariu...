#!/usr/bin/env node
// Where the studio actually listens right now (0.7.9 fold wave ticket 60 item 2). Since the
// launcher may take a port after 3210 (a foreign program held it and said its name), every
// consumer resolves the same way, in this one order: ASTRA_PORT env > the port the server itself
// recorded in data/runtime/port.json > the usual 3210. stop.sh, scripts/forge.mjs and ai/mcp all
// read this file so a moved port can never split the tools into two opinions.
// ASTRA_ROOT overrides the app root (the tests use a scratch tree; the server never sets it).
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.env.ASTRA_ROOT || path.resolve(import.meta.dirname, '..');
let port = Number(process.env.ASTRA_PORT) || 0;
if (!port) {
  try { port = Number(JSON.parse(readFileSync(path.join(root, 'data', 'runtime', 'port.json'), 'utf8')).port) || 0; } catch { /* the studio never started */ }
}
process.stdout.write(`${port || 3210}\n`);
