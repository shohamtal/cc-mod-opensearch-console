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

export type OsServer = { id: string; name: string; host: string; url: string; tag?: 'production' | 'staging' | 'development' | 'local'; indices?: string[]; allowWrites?: boolean }

export type OsConfirm = { serverId: string; serverName: string; method: string; path: string }

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
      editorCmd: { id: number; cmd: 'undo' | 'redo' } | null
    }
  }
}
