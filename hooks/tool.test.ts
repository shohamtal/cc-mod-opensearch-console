import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__opensearch-console__console'
const HOME = '/home/tester'
const BASE = `${HOME}/.claude/mods/opensearch`

// A small in-memory world beneath the plugin: files, HOME and panes.
function world(on: On) {
  const files = new Map<string, string>([[`${BASE}/servers.json`, JSON.stringify({ servers: [{ name: 'stg', url: 'http://127.0.0.1:9200' }] })]])
  const panes = new Set<string>()
  const opened: string[] = []
  let clock = 1
  const mtimes = new Map<string, number>()
  mock.env(on, { HOME })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    if (!files.has(e.path)) throw new Error(`ENOENT ${e.path}`)
    return { value: files.get(e.path)! }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    mtimes.set(e.path, clock++)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    if (!files.has(e.path)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: files.get(e.path)!.length, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false } }
  })
  on('ui.open', ($, e) => {
    panes.add(e.id)
    opened.push(e.id)
    return { value: { isPlaced: true } } as any
  })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }) as any)
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  return { files, panes, opened }
}

const text = (r: any) => String(r?.result ?? r?.text ?? r?.deny ?? '')

describe('the console tool reads its arguments from the call', () => {
  test('status with a non-default filepath attaches that file and opens nothing', async ($, on) => {
    const w = world(on)
    const r = await $.tool.call({ tool: TOOL, action: 'status', filepath: 'isolated.json' } as any)
    expect(text(r)).toContain(`${BASE}/sessions/isolated.json`)
    expect(text(r)).not.toContain('default.json')
    expect(w.files.has(`${BASE}/sessions/isolated.json`)).toBe(true)
    expect(w.opened).toEqual([])
  })

  test('open with a filepath and configfilepath opens the pane on those files', async ($, on) => {
    const w = world(on)
    w.files.set(`${BASE}/other-servers.json`, JSON.stringify({ servers: [{ name: 'local', url: 'http://127.0.0.1:9201' }] }))
    const r = await $.tool.call({ tool: TOOL, action: 'open', filepath: 'agent-7', configfilepath: 'other-servers.json' } as any)
    expect(text(r)).toContain(`${BASE}/sessions/agent-7.json`)
    expect(text(r)).toContain(`${BASE}/other-servers.json`)
    expect(w.opened).toEqual(['opensearch'])
  })

  test('close closes the pane', async ($, on) => {
    const w = world(on)
    await $.tool.call({ tool: TOOL, action: 'open', filepath: 'x.json' } as any)
    expect(w.panes.has('opensearch')).toBe(true)
    const r = await $.tool.call({ tool: TOOL, action: 'close' } as any)
    expect(text(r)).toContain('closed')
    expect(w.panes.has('opensearch')).toBe(false)
  })

  test('a missing config file is reported, not silently replaced', async ($, on) => {
    world(on)
    const r = await $.tool.call({ tool: TOOL, action: 'status', configfilepath: 'nope.json' } as any)
    expect(text(r)).toContain('Config file not found')
  })
})

describe('backslashes off Windows', () => {
  test('a sibling folder named opensearch\\x is not inside the mod folder', async ($, on) => {
    const w = world(on)
    w.files.set(`${HOME}/.claude/mods/opensearch\\x/c.json`, JSON.stringify({ servers: [] }))
    const r = await $.tool.call({ tool: TOOL, action: 'status', configfilepath: '~/.claude/mods/opensearch\\x/c.json' } as any)
    expect((r as any).isError).toBe(true)
  })
})

describe('Windows', () => {
  // No HOME, a USERPROFILE with backslashes, real paths reported with backslashes, and no printenv.
  function windows(on: On) {
    const WBASE = 'C:/Users/dev/.claude/mods/opensearch'
    const files = new Map<string, string>([[`${WBASE}/servers.json`, JSON.stringify({ servers: [{ id: 'w', host: '127.0.0.1', username: 'u', passwordEnv: 'OS_PW' }] })]])
    const runs: string[][] = []
    // This test runs on macOS / Linux, where the engine resolves `C:/…` against the working folder.
    const win = (p: string) => p.replace(/^.*?(?=[A-Za-z]:\/)/, '')
    mock.env(on, { USERPROFILE: 'C:\\Users\\dev', OS: 'Windows_NT' })
    on('fs.exists', ($, e) => ({ value: files.has(win(e.path)) }))
    on('fs.read', ($, e) => {
      if (!files.has(win(e.path))) throw new Error(`ENOENT ${e.path}`)
      return { value: files.get(win(e.path))! }
    })
    on('fs.write', ($, e) => {
      files.set(win(e.path), e.text)
      return { value: undefined }
    })
    on('fs.stat', ($, e) => {
      if (!files.has(win(e.path)) && win(e.path) !== WBASE) throw new Error(`ENOENT ${e.path}`)
      return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: win(e.path).replace(/\//g, '\\') } }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }) as any)
    on('ui.panes', () => ({ value: [] }) as any)
    on('process.run', ($, e) => {
      runs.push([...e.argv])
      if (e.argv[0] === 'printenv') throw new Error('ENOENT printenv')
      return { value: { exitCode: 0, stdout: 'OS_PW_OLD=x\r\nOS_PW=pw\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as any
    })
    return { WBASE, files, runs }
  }

  test('the mod folder is under USERPROFILE, and a config inside it passes the tool check', async ($, on) => {
    const w = windows(on)
    w.files.set(`${w.WBASE}/other.json`, JSON.stringify({ servers: [] }))
    const r = await $.tool.call({ tool: TOOL, action: 'status', filepath: 'win', configfilepath: 'other.json' } as any)
    expect(text(r)).toContain(`${w.WBASE}/sessions/win.json`)
    expect(text(r)).toContain(`${w.WBASE}/other.json`)
    const abs = await $.tool.call({ tool: TOOL, action: 'status', configfilepath: 'C:\\Users\\dev\\.claude\\mods\\opensearch\\other.json' } as any)
    expect(text(abs)).toContain(`${w.WBASE}/other.json`)
    const out = await $.tool.call({ tool: TOOL, action: 'status', configfilepath: 'D:\\x\\servers.json' } as any)
    expect((out as any).isError).toBe(true)
  })
})
