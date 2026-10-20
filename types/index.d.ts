export type OsResult = {
  id: number
  server: string
  method: string
  path: string
  status: number
  ms: number
  text: string
  error?: string
  at: string
}

export type OsView = {
  collapsed: string[]
  top: number
  cursor: number
  search: string
  match: number
}

export type OsServer = { id: string; name: string; host: string; url: string; tag?: 'production' | 'staging' | 'development' | 'local'; indices?: string[] }

// The exact request a prompt shows; Yes sends this, never what the editor holds by then.
export type OsPending = { serverId: string; serverName: string; url: string; method: string; path: string; body: string; production: boolean }

export type OsConfirm =
  | { kind: 'write'; req: OsPending }
  | { kind: 'trust'; req: OsPending | null; serverId: string; serverName: string; url: string; source: string; fingerprint: string; then: 'run' | 'indices' }

declare module 'claude-code' {
  interface PluginState {
    'opensearch-console': {
      query: string
      rev: number
      cursorRow: number
      result: OsResult | null
      view: OsView
      running: boolean
      server: string
      servers: OsServer[]
      showHelp: boolean
      paste: { id: number; text: string } | null
      indices: Record<string, string[]>
      indicesLoading: string
      paths: { file: string; config: string } | null
      editorScroll: { id: number; by: number } | null
      menuOpen: boolean
      confirm: OsConfirm | null
      unlocked: string[]
      editorCmd: { id: number; cmd: 'undo' | 'redo' } | null
    }
  }
}
