// AstraForge pane inside the Claude Code window: studio state, the job queue, engine start buttons.
// The live 3D view opens in the built-in browser (/astraforge open); this pane shows what is happening
// next to it and gives manual controls. Behavior derived from the shipped 0.4.16 panel (ADR-0003).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Studio, StudioJob, StudioStatus } from '../types'

const PANE = 'astraforge'
const URL = process.env.ASTRA_URL ?? 'http://127.0.0.1:3210'
// app folder: ASTRA_APP wins (the Linux checkout); the shipped Windows install is the fallback
const APP = process.env.ASTRA_APP ?? 'C:\\Users\\doron\\Documents\\Codex\\2026-10-09\\3\\outputs\\AstraForge'
const HEADERS = { 'x-astra-client': 'studio', 'content-type': 'application/json' }

const empty: Studio = {
  status: { online: false, comfy: { online: false, ready: false }, pixal3d: { installed: false, running: false }, ollama: { online: false, models: 0 } },
  jobs: [],
  checkedAt: 0,
}
const studio = atom({ plugin: 'astraforge', key: 'studio' } as const, empty)

type Engine = EngineInterface

let busy = false

async function poll($: Engine, note?: string) {
  if (busy) return
  busy = true
  try {
    const health = await $.http.fetch(URL + '/api/health').catch(() => null)
    if (!health?.ok) {
      await update($, studio, s => ({ ...s, status: { ...empty.status, online: false }, checkedAt: Date.now(), note: note ?? 'Студия выключена' }))
      return
    }
    const [st, jb] = await Promise.all([$.http.fetch(URL + '/api/status'), $.http.fetch(URL + '/api/jobs')])
    const s = st.ok ? JSON.parse(st.text) : {}
    const jobs: StudioJob[] = jb.ok ? JSON.parse(jb.text) : []
    const status: StudioStatus = {
      online: true,
      version: JSON.parse(health.text).version,
      comfy: { online: !!s.comfy?.online, ready: !!s.comfy?.ready },
      pixal3d: { installed: !!s.pixal3d?.installed, running: !!s.pixal3d?.running },
      ollama: { online: !!s.ollama?.online, models: s.ollama?.models?.length ?? 0 },
      gpu: s.gpu?.name?.replace('cuda:0 ', '').replace(' : cudaMallocAsync', ''),
    }
    const brief = jobs.slice(0, 12).map(j => ({ id: j.id, status: j.status, message: j.message ?? '', progress: j.progress ?? 0, engine: j.engine, prompt: j.prompt, createdAt: j.createdAt }))
    await update($, studio, () => ({ status, jobs: brief, checkedAt: Date.now(), note }))
  } catch (e) {
    await update($, studio, s => ({ ...s, checkedAt: Date.now(), note: 'Ошибка опроса: ' + String(e) }))
  } finally {
    busy = false
  }
}

async function post($: Engine, path: string, ok: string) {
  const r = await $.http.fetch(URL + path, { method: 'POST', headers: HEADERS, body: '{}' })
  $.ui.toast(r.ok ? ok : 'AstraForge: ' + (JSON.parse(r.text || '{}').error ?? 'ошибка ' + r.status))
  await poll($)
}

async function startStudio($: Engine) {
  $.ui.toast('AstraForge: запускаю студию…')
  // platform gate: Start.ps1 on Windows, start.sh elsewhere
  const cmd = process.platform === 'win32'
    ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', APP + '\\scripts\\Start.ps1', '-NoBrowser']
    : ['bash', APP + '/scripts/start.sh']
  const r = await $.process.run(cmd, { cwd: APP, timeoutMs: 120000 })
  $.ui.toast(r.exitCode === 0 ? 'AstraForge: студия запущена' : 'AstraForge: не запустилась: ' + (r.stderr || r.stdout).slice(0, 200))
  await poll($)
}

export const register: Register = on => {
  let stop: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'astraforge', description: 'Панель AstraForge: open — открыть студию во встроенном браузере, start — запустить, status — состояние', argumentHint: '[open|start|status]' })
    void $.ui.open({ id: PANE, title: 'AstraForge' })
    void poll($)
    stop?.cancel()
    stop = $.clock.every(5000, () => void poll($))
    return next(e)
  })

  on('command.run', { command: 'astraforge' }, async ($, e) => {
    const arg = (e.args || '').trim()
    await $.ui.open({ id: PANE, title: 'AstraForge' })
    if (arg === 'start') { await startStudio($); return { text: 'Студия AstraForge запускается.' } }
    if (arg === 'open') {
      return { text: 'Открываю студию AstraForge во встроенном браузере.', context: [`Открой ${URL} во встроенном браузере Claude (preview_start с url).`, `Если /api/health не отвечает, сначала запусти студию (${process.platform === 'win32' ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${APP}\\scripts\\Start.ps1" -NoBrowser` : `${APP}/scripts/start.sh`}).`] }
    }
    await poll($)
    const s = await read($, studio)
    return { text: s.status.online ? `AstraForge ${s.status.version}: движок ${s.status.comfy.ready ? 'готов' : 'выключен'}, Pixal3D ${s.status.pixal3d.running ? 'работает' : 'выключен'}, заданий ${s.jobs.length}.` : 'Студия AstraForge выключена. /astraforge start — запустить.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, studio)
    const st = s.status
    const dot = (v: boolean) => (v ? '●' : '○')
    const active = s.jobs.filter(j => j.status === 'running' || j.status === 'queued')
    const finished = s.jobs.filter(j => j.status !== 'running' && j.status !== 'queued').slice(0, 5)

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>AstraForge </Text>
          <Text color={st.online ? 'green' : 'red'}>{st.online ? `работает ${st.version ?? ''}` : 'выключена'}</Text>
          {st.gpu && <Text dimColor>  {st.gpu}</Text>}
        </Box>
        {st.online && (
          <Box flexDirection="column">
            <Text>{dot(st.comfy.ready)} Движок формы (Hunyuan) {st.comfy.ready ? 'готов' : st.comfy.online ? 'без модели' : 'выключен'}</Text>
            <Text>{dot(st.pixal3d.running)} Pixal3D {st.pixal3d.running ? 'работает' : st.pixal3d.installed ? 'выключен' : 'не установлен'}</Text>
            <Text>{dot(st.ollama.online)} Помощник Ollama {st.ollama.online ? `${st.ollama.models} мод.` : 'выключен'}</Text>
          </Box>
        )}
        {s.note && <Text dimColor>{s.note}</Text>}
        <Box marginTop={1}>
          {!st.online && <Button key="start" variant="primary" hotkey="s" onPress={() => startStudio($)}>Запустить студию</Button>}
          {st.online && !st.comfy.online && <Button key="engine" hotkey="e" onPress={() => post($, '/api/runtime/start', 'Движок формы запускается')}>Движок</Button>}
          {st.online && st.pixal3d.installed && !st.pixal3d.running && <Button key="pixal" hotkey="p" onPress={() => post($, '/api/runtime/pixal3d/start', 'Pixal3D запускается')}>Pixal3D</Button>}
          <Button key="refresh" hotkey="r" onPress={() => poll($, 'обновлено')}>Обновить</Button>
        </Box>
        <Text dimColor>Живой 3D-вид: /astraforge open — студия откроется во встроенном браузере.</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Задания {active.length ? `· идёт ${active.length}` : ''}</Text>
          {s.jobs.length === 0 && <Text dimColor>пока нет</Text>}
          {active.map(j => (
            <Box key={j.id}>
              <Text color="yellow">▶ {Math.round(j.progress)}% </Text>
              <Text>{(j.engine === 'pixal3d' ? 'Pixal3D · ' : '') + (j.prompt?.slice(0, 40) || 'модель по изображению')}</Text>
              <Text dimColor> {j.message.slice(0, 50)} </Text>
              <Button key={'cancel-' + j.id} plain onPress={() => post($, '/api/jobs/' + j.id + '/cancel', 'Задание отменено')}>✕</Button>
            </Box>
          ))}
          {finished.map(j => (
            <Text key={j.id} dimColor>
              {j.status === 'completed' ? '✓' : j.status === 'failed' ? '✗' : '–'} {(j.prompt?.slice(0, 40) || 'модель по изображению')} · {j.message.slice(0, 40)}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
