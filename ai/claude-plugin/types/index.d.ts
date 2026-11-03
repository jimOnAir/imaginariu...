// Shapes the AstraForge pane reads from the studio HTTP API (/api/health, /api/status, /api/jobs).

export type StudioJob = {
  id: string
  status: string
  message: string
  progress: number
  engine?: string
  prompt?: string
  createdAt: string
}

export type StudioStatus = {
  online: boolean
  version?: string
  comfy: { online: boolean; ready: boolean }
  pixal3d: { installed: boolean; running: boolean }
  ollama: { online: boolean; models: number }
  gpu?: string
  error?: string
}

export type Studio = {
  status: StudioStatus
  jobs: StudioJob[]
  checkedAt: number
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    astraforge: { studio: Studio }
  }
}
