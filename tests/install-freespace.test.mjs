// The installer's free-space honesty (Windows 0.6.11 behavior, ported as wave ticket 33):
// an unreadable reading is UNKNOWN, never 0. The helper block and SumFooter are extracted from
// installer/install.sh verbatim and driven in a bash with stub say/Gb and a df that fails;
// the two call sites inside the long plan functions are pinned at source level (they live in
// flows that need the whole installer to run) - FreeUnder/FreeText at the decisions, the old
// zero-default gone, and the honest "skipped, not failed" line present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const INSTALL = readFileSync(path.join(REPO, 'installer', 'install.sh'), 'utf8');

// the helper block (FreeOn/FreeText/FreeUnder), verbatim from the script
const HELPERS = INSTALL.split('\n')
  .slice(INSTALL.split('\n').findIndex((l) => l.startsWith('# The free bytes of a filesystem')) >= 0
    ? INSTALL.split('\n').findIndex((l) => l.startsWith('# The free bytes of a filesystem'))
    : (() => { throw new Error('helper block marker moved'); })(),
    INSTALL.split('\n').findIndex((l) => l.startsWith('FreeUnder')) + 2).join('\n');
const SUMFOOTER = (() => {
  const lines = INSTALL.split('\n');
  const a = lines.findIndex((l) => l.startsWith('SumFooter()'));
  if (a < 0) throw new Error('SumFooter moved');
  let b = a; while (lines[b] !== '}') b++;
  return lines.slice(a, b + 1).join('\n');
})();

const SCRIPT = `
set -u
ROOT="/root"
say() { echo "SAY: $1"; }
Gb() { awk -v b="$1" 'BEGIN{printf "%.1f GB", b/1e9}'; }
${HELPERS}
${SUMFOOTER}
case "$CASE" in
  unknown) FreeOn() { return 1; }; SumFooter 3 5000000000; SumFooter 0 0 ;;
  known)   FreeOn() { echo 1500000000; }; SumFooter 3 5000000000 ;;
  sf)      FreeOn() { return 1; }; S_FREE=2500000000; SumFooter 2 100 ;;
  gates)
    FreeUnder ""            100 && echo BAD1
    FreeUnder 50            100 && echo SHORT
    FreeUnder 200           100 && echo BAD2
    FreeUnder 1500000000    100 && echo BAD3
    echo "text=[$(FreeText '')] [$(FreeText 1500000000)]" ;;
esac
`;

const run = (env = {}) => {
  const work = mkdtempSync(path.join(tmpdir(), 'af-t33-'));
  const file = path.join(work, 'harness.sh');
  writeFileSync(file, SCRIPT);
  const r = spawnSync('bash', [file], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
  rmSync(work, { recursive: true, force: true });
  return r;
};

test('helpers: an unknown reading is never "under" a need, and prints as unknown', () => {
  const r = run({ CASE: 'gates' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SHORT/);
  assert.doesNotMatch(r.stdout, /BAD/);
  assert.match(r.stdout, /text=\[unknown\] \[1\.5 GB\]/);
});

test('the checklist footer shows unknown honestly when df cannot read the volume', () => {
  const r = run({ CASE: 'unknown' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Free on \/root: unknown\./);
  assert.doesNotMatch(r.stdout, /0\.0 GB/, 'the false "0.0 GB free" line is gone');
});

test('a readable volume still prints its size; S_FREE still overrides the probe', () => {
  const a = run({ CASE: 'known' });
  assert.match(a.stdout, /Free on \/root: 1\.5 GB\./);
  const b = run({ CASE: 'sf' });
  assert.match(b.stdout, /Free on \/root: 2\.5 GB\./);
});

test('the two in-plan gates use the honest helpers, and no zero-default survives', () => {
  assert.match(INSTALL, /if \[ "\$n" != 0 \] && FreeUnder "\$free" "\$needx"; then/);
  assert.match(INSTALL, /the disk check is skipped, not failed/);
  assert.match(INSTALL, /if \[ "\$SCAN_OK" != 1 \] && FreeUnder "\$free" "\$dl"; then/);
  assert.doesNotMatch(INSTALL, /free:-0/, 'no `${free:-0}` remains anywhere in the installer');
});
