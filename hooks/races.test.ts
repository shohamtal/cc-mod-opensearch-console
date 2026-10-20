import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__opensearch-console__console'
const HOME = '/home/tester'
const BASE = `${HOME}/.claude/mods/opensearch`
const S1 = `${BASE}/sessions/s1.json`
const PANE = { plugin: 'opensearch-console', surface: 'terminal', component: 'Pane', requestId: 'opensearch', props: { title: 'OpenSearch', isFocused: true, bodyColumns: 110, placement: 'dock' }, viewport: { columns: 110, rows: 44 } } as any

function world(on: On, servers: unknown[], curlDelay = 0, onCurl?: () => void | Promise<void>) {
  const files = new Map<string, string>([[`${BASE}/servers.json`, JSON.stringify({ servers })]])
  let tick = 1
  const mtimes = new Map<string, number>()
  mock.env(on, { HOME })
  mock.store(on)
  const clock = mock.clock(on)
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => { if (!files.has(e.path)) throw new Error(`ENOENT ${e.path}`); return { value: files.get(e.path)! } })
  on('fs.write', ($, e) => { files.set(e.path, e.text); mtimes.set(e.path, tick++); return { value: undefined } })
  on('fs.stat', ($, e) => {
    if (!files.has(e.path) && e.path !== BASE) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: files.has(e.path) ? 'file' : 'dir', size: 1, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false, realPath: e.path } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.panes', () => ({ value: [] }) as any)
  const curls: string[] = []
  on('process.run', async ($, e) => {
    curls.push(e.init?.stdin ?? '')
    if (onCurl) await onCurl()
    if (curlDelay) await clock.sleep(curlDelay)
    return { value: { exitCode: 0, stdout: '{"ok":true}\n__OSCONSOLE__200 0.01', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as any
  })
  const touch = (path: string, text: string) => { files.set(path, text); mtimes.set(path, 1_000_000 + tick++) }
  return { files, clock, touch, curls }
}

const sess = (w: any, f = S1) => JSON.parse(w.files.get(f))

describe('session file races', () => {
  test('a finished request keeps a query the agent wrote while it ran', async ($, on) => {
    let w: any
    w = world(on, [{ id: 'local', name: 'Local', host: '127.0.0.1' }], 0, () => {
      // The agent writes a new query while curl runs (before the next sync tick).
      w.touch(S1, JSON.stringify({ server: 'local', cursorRow: 0, query: 'GET agent-query' }))
    })
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 's1.json' } as any)
    const ui: any = await $.ui.mount(PANE)
    await ui.post({ type: 'run', text: 'GET _cluster/health', row: 0 }, { in: 'editor' })
    await $.tool.call({ tool: TOOL, action: 'status' } as any) // a sync
    console.log('R1 file query =', sess(w).query)
    expect(sess(w).query).toBe('GET agent-query')
  })

  test('a cursor move right after the agent writes keeps the agent\'s query', async ($, on) => {
    const w = world(on, [{ id: 'local', name: 'Local', host: '127.0.0.1' }])
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 's1.json' } as any)
    const ui: any = await $.ui.mount(PANE)
    w.touch(S1, JSON.stringify({ server: 'local', cursorRow: 0, query: 'GET agent-query' }))
    await ui.post({ type: 'cursor', text: 'GET _cluster/health', row: 0 }, { in: 'editor' })
    await w.clock.advance(300)
    await $.tool.call({ tool: TOOL, action: 'status' } as any)
    console.log('R1b file query =', sess(w).query)
    expect(sess(w).query).toBe('GET agent-query')
  })

  test('a request that finishes after a switch to another session file writes to its own console', async ($, on) => {
    const w = world(on, [{ id: 'local', name: 'Local', host: '127.0.0.1' }], 1000)
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 's1.json' } as any)
    const ui: any = await $.ui.mount(PANE)
    const p = ui.post({ type: 'run', text: 'GET from-console-A', row: 0 }, { in: 'editor' })
    await w.clock.settle()
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 'other.json' } as any)
    await w.clock.advance(1100)
    await p
    console.log('R2 other.response =', w.files.get(`${BASE}/sessions/other.response.json`), 's1.response =', w.files.get(`${BASE}/sessions/s1.response.json`))
    console.log('R2 other lastRun =', JSON.stringify(sess(w, `${BASE}/sessions/other.json`).lastRun))
    expect(w.files.has(`${BASE}/sessions/other.response.json`)).toBe(false)
  })

  test('a server named before the config has it is used once it appears, never servers[0]', async ($, on) => {
    const w = world(on, [{ id: 'prod', name: 'Prod', host: '10.0.0.1', tag: 'production' }, { id: 'dev', name: 'Dev', host: '10.0.0.2' }])
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 's1.json' } as any)
    const ui: any = await $.ui.mount(PANE)
    // Agent: session file first, then adds the server to the config.
    w.touch(S1, JSON.stringify({ server: 'new', cursorRow: 0, query: 'GET _cat/indices' }))
    await $.tool.call({ tool: TOOL, action: 'status' } as any)
    w.touch(`${BASE}/servers.json`, JSON.stringify({ servers: [{ id: 'prod', name: 'Prod', host: '10.0.0.1', tag: 'production' }, { id: 'dev', name: 'Dev', host: '10.0.0.2' }, { id: 'new', name: 'New', host: '10.0.0.3' }] }))
    await $.tool.call({ tool: TOOL, action: 'status' } as any)
    await ui.post({ type: 'run', text: 'GET _cat/indices', row: 0 }, { in: 'editor' })
    const url = /url = "([^"]+)"/.exec(w.curls[w.curls.length - 1]!)?.[1]
    console.log('R3 sent to', url, 'file server =', sess(w).server)
    expect(url).toContain('10.0.0.3')
  })

  test('a timed save and a finished request together keep lastRun', async ($, on) => {
    const w = world(on, [{ id: 'local', name: 'Local', host: '127.0.0.1' }], 250)
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 's1.json' } as any)
    const ui: any = await $.ui.mount(PANE)
    const p = ui.post({ type: 'run', text: 'GET x', row: 0 }, { in: 'editor' })
    await w.clock.advance(400)
    await p
    console.log('R4 lastRun =', JSON.stringify(sess(w).lastRun))
    expect(sess(w).lastRun?.path).toBe('x')
  })
})
