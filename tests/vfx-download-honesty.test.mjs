// Ticket 38 (0.6.18 wave): VFX download honesty. The page-instead-of-file verdict comes from
// installer/imaginarium_download.sh (sourced in a bash with a stub say and a stub Download); the npm
// retry loop from scripts/vfx/install-vfx.sh (function extracted verbatim, driven with a
// counting chain). Nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const CORE = readFileSync(path.join(REPO, 'installer', 'imaginarium_download.sh'), 'utf8');
const VFX = readFileSync(path.join(REPO, 'scripts', 'vfx', 'install-vfx.sh'), 'utf8');

function bash(script, env = {}) {
  const r = spawnSync('bash', ['-c', `set -u\n${script}`], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
  return { out: r.stdout + r.stderr, code: r.status };
}

test('LooksLikePage knows markup openers and nothing else', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 't38-'));
  const w = (n, b) => { const p = path.join(dir, n); writeFileSync(p, b); return p; };
  const S = `say(){ echo "SAY: $1"; }\n. ${path.join(REPO, 'installer', 'imaginarium_download.sh')}\n`;
  const cases = [
    ['<!DOCTYPE html><html><body>rate limit</body></html>', true],
    ['\n\n   <HTML lang="en">', true],
    ['<?xml version="1.0"?><Error><Code>NotFound</Code></Error>', true],
    ['<svg xmlns="http://www.w3.org/2000/svg"/>', true],
    ['{"asset_id":"x"}', false],
    ['glTF', false],
    ['PK\x03\x04 binary zip bytes', false],
    ['', false],
  ];
  let body = S;
  cases.forEach(([content, want], i) => {
    const f = w('f' + i, content);
    body += `if LooksLikePage ${JSON.stringify(f)}; then echo "P${i}"; else echo "N${i}"; fi\n`;
    assert.ok(true, want ? 'page' : 'file');
    void want;
  });
  const r = bash(body);
  cases.forEach(([, want], i) => assert.equal(r.out.includes(`P${i}`), want, `case ${i}: ${r.out}`));
  // missing file: not a page
  assert.match(bash(S + `LooksLikePage ${dir}/nope || echo absent-ok`).out, /absent-ok/);
  rmSync(dir, { recursive: true, force: true });
});

function checkedDownload(served, { size = 0, sha = 'deadbeef'.repeat(8) } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 't38-'));
  const dst = path.join(dir, 'tool.zip');
  const cnt = path.join(dir, 'cnt');
  writeFileSync(cnt, '0');
  const r = bash(`
say(){ echo "SAY: $1"; }
. ${path.join(REPO, 'installer', 'imaginarium_download.sh')}
Download(){ c=$(($(cat ${cnt})+1)); echo $c > ${cnt}; printf '%s' ${JSON.stringify(served)} > "$2"; return 0; }
DownloadChecked "https://author.example/tool.zip" "${dst}" ${size} "${sha}"; echo "rc=$?"
`);
  const calls = Number(readFileSync(cnt, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  return { ...r, calls };
}

test('a checksum miss whose bytes are an HTML page is named exactly - not tamper, not damaged, no pointless re-fetch', () => {
  const r = checkedDownload('<!DOCTYPE html><html><head>PixaFlux</head><body>download moved</body></html>');
  assert.match(r.out, /The site served a web page instead of the file \(tool\.zip is HTML\)/);
  assert.match(r.out, /was NOT tampered with/);
  assert.match(r.out, /rc=1/);
  assert.ok(!/downloaded damaged/.test(r.out), 'no scary damage wording for a page');
  assert.equal(r.calls, 1, 'one fetch: a second download would serve the same page');
});

test('a genuinely damaged binary keeps the existing damaged/re-download story', () => {
  const r = checkedDownload('PK\u0003\u0004garbagebytes'.repeat(50));
  assert.match(r.out, /downloaded damaged \(size or sha256 mismatch\) - downloading it once more from the start/);
  assert.match(r.out, /rc=1/);
  assert.equal(r.calls, 2, 'the damaged path still re-downloads once');
  assert.ok(!/web page/.test(r.out));
});

// ---------- NpmBuildTry ----------
function fn(name) {
  const lines = VFX.split('\n');
  const a = lines.findIndex((l) => l.startsWith(name + '()'));
  if (a < 0) throw new Error(name + ' moved');
  let b = a; while (lines[b] !== '}') b++;
  return lines.slice(a, b + 1).join('\n');
}
const NPM_SCRIPT = `
say(){ echo "SAY: $1"; }
export NPM_BIN=/bin/true
${fn('NpmBuildTry')}
case "$CASE" in
  ok3)  NpmBuildTry Test /tmp 'c=$(cat "$CNT"); c=$((c+1)); echo $c > "$CNT"; [ "$c" -ge 3 ]'; echo "rc=$?" ;;
  fail) NpmBuildTry Test /tmp 'c=$(cat "$CNT"); c=$((c+1)); echo $c > "$CNT"; false'; echo "rc=$?" ;;
  ok1)  NpmBuildTry Test /tmp 'true'; echo "rc=$?" ;;
esac
`;
function npmCase(name) {
  const dir = mkdtempSync(path.join(tmpdir(), 't38-'));
  const cnt = path.join(dir, 'cnt');
  writeFileSync(cnt, '0');
  const r = spawnSync('bash', ['-c', `set -u\n${NPM_SCRIPT}`], { encoding: 'utf8', timeout: 30000, env: { ...process.env, CNT: cnt, CASE: name } });
  const calls = Number(readFileSync(cnt, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  return { out: r.stdout + r.stderr, code: r.status, calls };
}

test('npm build chains retry up to 3 attempts with honest lines', () => {
  const r = npmCase('ok3');
  assert.equal(r.calls, 3);
  assert.match(r.out, /npm hiccup on attempt 1 of 3 .* retrying the npm steps/);
  assert.match(r.out, /npm hiccup on attempt 2 of 3/);
  assert.match(r.out, /rc=0/);
  assert.ok(!/failed after 3 attempts/.test(r.out), 'success on attempt 3 pays no failure line');
});

test('after 3 attempts the failure names the resume behavior', () => {
  const r = npmCase('fail');
  assert.equal(r.calls, 3);
  assert.equal((r.out.match(/attempt . of 3/g) || []).length, 2, 'no retry line after the last attempt');
  assert.match(r.out, /failed after 3 attempts .* finished steps are skipped/);
  assert.match(r.out, /rc=1/);
});

test('a healthy network pays zero retry noise', () => {
  const r = npmCase('ok1');
  assert.equal(r.out.trim(), 'rc=0');
});

test('both VFX builds route through NpmBuildTry; the unguarded chains are gone', () => {
  assert.match(VFX, /NpmBuildTry 'DisplacementX' "\$src" '"\$NPM_BIN" ci --no-audit --no-fund && "\$NPM_BIN" exec -- astro build'/);
  assert.match(VFX, /NpmBuildTry 'SculptGL' "\$src"/);
  assert.ok(!/\(cd "\$src" && "\$NPM_BIN"/.test(VFX));
});
