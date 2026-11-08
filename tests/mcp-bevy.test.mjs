// A live MCP session against this branch's own server (0.6.10 wave ticket 31, T2-4): spawned over
// stdio exactly like Claude Code spawns it, then tools/list. The point is the CONTRACT the agent
// sees: bevy must be an engine in the engine verbs, unreal + bevy profiles in forge_export, bevy
// a sound_export format, and the checksum-gated bridge install an opt-in flag. No studio HTTP
// needed - listing tools never touches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');

async function listTools() {
  const child = spawn(process.execPath, [path.join(REPO, 'ai', 'mcp', 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (b) => { err += b; });
  const byId = new Map();
  let carry = '';   // a tools/list answer is tens of KB and arrives split across chunks - buffer to newlines
  child.stdout.on('data', (b) => {
    carry += b.toString();
    const lines = carry.split('\n');
    carry = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (m && m.id !== undefined) byId.set(m.id, m); } catch { /* not ours */ }
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (id, method) => {
    const t0 = Date.now();
    while (!byId.has(id)) {
      if (Date.now() - t0 > 25000) throw new Error(`mcp: no response to ${method} in 25 s; stderr: ${err.slice(0, 400)}`);
      await sleep(50);
    }
    return byId.get(id);
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'af-ticket31', version: '1' } } });
    const init = await waitFor(1, 'initialize');
    assert.ok(init.result?.serverInfo, 'the server introduced itself');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await waitFor(2, 'tools/list');
    return Object.fromEntries(list.result.tools.map((t) => [t.name, t]));
  } finally {
    child.kill();
  }
}

const enumOf = (tools, tool, key) => {
  const node = JSON.stringify(tools[tool]?.inputSchema?.properties?.[key] ?? null);
  assert.notEqual(node, 'null', `${tool} must expose ${key}`);
  return node;
};

test('an MCP session sees bevy as an engine wherever unity/godot are (T2-4)', async () => {
  const tools = await listTools();
  for (const verb of ['engine_project_create', 'engine_send', 'engine_scaffold', 'engine_test']) {
    const schema = enumOf(tools, verb, 'engine');
    assert.match(schema, /"bevy"/, `${verb}: engine enum must accept bevy`);
    assert.match(schema, /"unity"|"godot"/, `${verb}: and keep the old engines`);
  }
});

test('an MCP session sees the unreal + bevy export profiles and the bevy sound bank', async () => {
  const tools = await listTools();
  const profiles = enumOf(tools, 'forge_export', 'profile');
  for (const p of ['godot', 'space_quest', 'heroes_gates', 'iso8', 'unity', 'unreal', 'bevy']) {
    assert.match(profiles, new RegExp(`"${p}"`), `forge_export profile ${p}`);
  }
  assert.match(enumOf(tools, 'sound_export', 'engine'), /"bevy"/, 'sound_export gains the bank format');
  assert.match(enumOf(tools, 'sound_export', 'engine'), /"files"/, '...beside the plain-files default');
});

test('the checksum-pinned bridge install is an opt-in flag on engine_mcp_register', async () => {
  const tools = await listTools();
  const params = tools['engine_mcp_register']?.inputSchema?.properties ?? {};
  assert.ok(params.installBevyBrp, 'engine_mcp_register {installBevyBrp}');
  assert.match(JSON.stringify(params.installBevyBrp), /false/, 'defaulting to false: nothing compiles until asked');
});
