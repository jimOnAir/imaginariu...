#!/usr/bin/env node
// NATTEN kernel probe for the Pixal3D environments (0.6.x wave ticket 11; the Linux twin of the
// 0.6.4 Windows fix, the slimmed fact ticket 02 left here). Upstream's bug: a stale NATTEN wheel
// without kernels for the actual GPU -> ComfyUI dies on `no kernel image available to execute`
// mid-generation. Selection is keyed by (torch version, CUDA, compute capability) per the spec.
// On Linux this branch verified live that natten-0.21.5+torch290cu128 carries sm_120 kernels
// (RTX 5070: na2d forward, finite output) - so today's pin is the Blackwell-correct row; what the
// installer still lacked was the PROBE: confirm the installed wheel can run this card, and pick
// the right row when it cannot. Cards below sm_75 have no NATTEN kernels at all: the honest
// lighter recommendation (Windows side forces TripoSG into the low-VRAM quick set; this branch
// only recommends, ticket 12's opt-in rule stays unconditional).
//
//   node af_natten_probe.mjs <python of the env>    # probe one environment (##NATTEN json line)
//   node af_natten_probe.mjs --plan <cc> [torch cuda]  # machine-readable plan line, no env needed
//
// Test seams (ASTRA_VRAM_MIB style): ASTRA_GPU_CC overrides the compute capability, ASTRA_NATTEN_PROBE=0
// skips the live forward pass (unit-testable logic, no hardware). Failure to probe degrades to
// today's behavior (the pinned wheel) with a clear reason, never to a fake green.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// natten-0.21.5+torch290cu128-cp312-cp312-linux_x86_64.whl -> {version, torch, cuda, py, arch}
// release encodings: torch 290 = 2.9, 2100 = 2.10 (major = first digit, minor without the pad zero);
// CUDA 128 = 12.8, 130 = 13.0 (major = all but the last digit, minor = the last one).
export function parseWheel(name) {
  const m = /^natten-(\d+\.\d+\.\d+)\+torch(\d{3,4})cu(\d{2,3})-(cp\d{2,3}[dt]?)-[a-z0-9]+-(linux_x86_64|linux_aarch64)\.whl$/.exec(String(name).replace(/%2B/g, '+'));
  if (!m) return null;
  const torch = m[2][0] + '.' + (String(parseInt(m[2].slice(1), 10)).replace(/0$/, '') || '0');
  return { version: m[1], torch, cuda: (+m[3].slice(0, -1)) + (+m[3].slice(-1)) / 10, py: m[4], arch: m[5] };
}

// The matrix is this branch's verified wheel table; rows reference the pinned download entry in
// installer/pixal3d/manifest.json by id (one pin today, the shape is what grows when a second
// torch/CUDA pair is supported). `needs` is the MINIMUM environment the row's kernels run in.
export function pickNatten({ cc, torch, cuda, matrix, py = 'cp312' }) {
  if (cc === null || cc === undefined) return { verdict: 'unknown-gpu', reason: 'the GPU did not report a compute capability - keeping the pinned wheel', wheel: matrix[0] || null };
  if (cc < 7.5) return { verdict: 'lite-recommendation', reason: `this card (compute capability ${cc}) has no NATTEN kernels at all (sm_75+) - Pixal3D will not run here; the studio recommends the lighter set for it`, wheel: null };
  if (!torch) return { verdict: 'unknown-torch', reason: 'could not read the environment\'s torch version - keeping the pinned wheel', wheel: matrix[0] || null };
  const row = matrix.find((r) => r.py.includes(py) && torchMajor(torch) === r.torch && cuda >= r.cuda);
  if (!row) {
    const want = matrix.find((r) => r.torch === torchMajor(torch));
    return { verdict: 'no-row', reason: want ? `torch ${torch} needs a NATTEN build for CUDA ${want.cuda} or newer (this environment has ${cuda}) - keeping the pinned wheel` : `no NATTEN wheel row for torch ${torch} on linux x86_64 - keeping the pinned wheel`, wheel: matrix[0] || null };
  }
  if (cc >= 12 && row.cuda < 12.8) return { verdict: 'no-row', reason: `Blackwell (compute capability ${cc}) needs a CUDA 12.8+ NATTEN build (the ${row.id} row is CUDA ${row.cuda}) - keeping the pinned wheel`, wheel: matrix[0] || null };
  return { verdict: 'row', reason: `torch ${torch} + CUDA ${cuda} + cc ${cc} matches the ${row.id} row`, wheel: row };
}
const torchMajor = (t) => String(t).split('.').slice(0, 2).join('.');

// One python script for both readings: the environment's torch pair and (unless skipped) a real
// na2d forward - the only proof that the installed kernels can run this card.
const ENV_PY = `
import json, sys
out = {}
try:
    import torch
    out['torch'] = torch.__version__.split('+')[0]
    out['cuda'] = float(torch.version.cuda) if torch.version.cuda else None
    try: out['cc'] = '.'.join(str(x) for x in torch.cuda.get_device_capability())
    except Exception: out['cc'] = None
except Exception as e:
    out['torchError'] = type(e).__name__ + ': ' + str(e)[:160]
if len(sys.argv) > 1 and sys.argv[1] == 'forward':
    try:
        from natten.functional import na2d
        q = torch.randn(1, 16 * 16, 8, 64, device='cuda', dtype=torch.float16)
        y = na2d(q, q.clone(), q.clone(), 7)
        torch.cuda.synchronize()
        out['forward'] = bool(torch.isfinite(y).all()) and list(y.shape) == [1, 256, 8, 64]
    except Exception as e:
        out['forward'] = False
        out['forwardError'] = type(e).__name__ + ': ' + str(e)[:200]
print(json.dumps(out))
`;

export function readEnv(pyPath, { forward = false, spawnFn = spawnSync } = {}) {
  let r;
  try { r = spawnFn(pyPath, ['-c', ENV_PY].concat(forward ? ['forward'] : []), { encoding: 'utf8', timeout: 180000 }); } catch { return null; }
  // the script's json is the last stdout line (torch import chatter above it)
  const last = String(r.stdout || '').trim().split('\n').filter(Boolean).pop();
  try { return JSON.parse(last); } catch {
    // ticket 23 (0.6.8 line): a silent subprocess death used to answer nothing at all - now the
    // exit code and the kill signal are part of the diagnosis (OOM-kill and a driver-level crash
    // look different in the log, and the 570+ driver floor gets named when it is an RTX 50 class box)
    return { probeFailed: true, exitCode: Number.isInteger(r?.status) ? r.status : null, signal: r?.signal || null, stderr: String(r?.stderr || '').slice(-200) };
  }
}

export async function probe(dir, { manifest, env = process.env, spawnFn = spawnSync } = {}) {
  const man = manifest || JSON.parse(readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
  const matrix = (man.linux.nattenMatrix || []).map((r) => ({ ...r, ...pinOf(man, r.id) }));
  const py = path.join(dir, '.venv', 'bin', 'python');
  const info = readEnv(py, { forward: env.ASTRA_NATTEN_PROBE !== '0', spawnFn });
  if (!info || info.torchError || info.probeFailed) {
    const why = (info && (info.torchError || (info.probeFailed
      ? `the environment's python probe died without answering (exit ${info.exitCode ?? '?'}${info.signal ? ', signal ' + info.signal : ''}) - keeping the pinned wheel; on an RTX 50 a probe like this often means an NVIDIA driver below 570 (the studio gates Pixal3D on that floor) - see the scan's driver line`
      : null))) || 'the environment answered nothing - keeping the pinned wheel';
    return { dir, verdict: 'probe-failed', reason: why, matrix };
  }
  const ccRaw = env.ASTRA_GPU_CC || info.cc;
  const cc = ccRaw === null || ccRaw === undefined ? null : Number(ccRaw);
  const installed = (() => {
    const r = spawnFn(py, ['-c', "import importlib.metadata as m;print(m.version('natten'))"], { encoding: 'utf8', timeout: 30000 });
    const v = String(r.stdout || '').trim();
    return v && r.status === 0 ? v : null;
  })();
  const pick = pickNatten({ cc, torch: info.torch, cuda: info.cuda, matrix });
  const forwardOk = info.forward;
  return { ...pick, cc, torch: info.torch, cuda: info.cuda, installed, forwardOk, dir, needsReinstall: !!(pick.wheel && installed && !samePin(installed, pick.wheel.version, pick.wheel.torch, pick.wheel.cuda)) };
}
const torchTag = (t) => { const [M, m] = String(t).split('.'); return M + (Number(m) < 10 ? m + '0' : m); };  // release zero-pads a one-digit minor: 2.9 -> 290, 2.10 -> 2100
const samePin = (installed, ver, torch, cuda) => String(installed).replace(/%2B/g, '+') === `${ver}+torch${torchTag(torch)}cu${String(cuda).replace('.', '')}`;
const pinOf = (man, id) => { const key = ({ torch290cu128: 'natten' })[id]; return key ? { file: man.linux[key].file, url: man.linux[key].url, size: man.linux[key].size, sha256: man.linux[key].sha256 } : {}; };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmdOrDir, a2, a3, a4] = process.argv.slice(2);
  if (cmdOrDir === '--plan') { // machine-readable plan for shell callers: --plan <cc> [torch cuda]
    const man = JSON.parse(readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
    const matrix = (man.linux.nattenMatrix || []).map((r) => ({ ...r, ...pinOf(man, r.id) }));
    const p = pickNatten({ cc: Number(a2), torch: a3 || null, cuda: a4 ? Number(a4) : null, matrix });
    console.log(`##NATTEN ${JSON.stringify({ ...p, wheel: p.wheel ? p.wheel.file : null, url: p.wheel ? p.wheel.url : null, size: p.wheel ? p.wheel.size : null, sha256: p.wheel ? p.wheel.sha256 : null })}`);
  } else if (cmdOrDir) {
    const r = await probe(cmdOrDir, {});
    const { file, url, size, sha256 } = r.wheel || {};
    console.log(`##NATTEN ${JSON.stringify({ ...r, wheel: file || null, url: url || null, size: size || null, sha256: sha256 || null })}`);
  } else {
    console.error('usage: af_natten_probe.mjs <env dir with .venv> | --plan <cc> [torch cuda]');
    process.exit(2);
  }
}
