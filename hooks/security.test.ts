import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { credentialFingerprint, normalizeServer, uniqueServers } from './lib'

const TOOL = 'mcp__opensearch-console__console'
const HOME = '/home/tester'
const BASE = `${HOME}/.claude/mods/opensearch`
const PANE = { plugin: 'opensearch-console', surface: 'terminal', component: 'Pane', requestId: 'opensearch', props: { title: 'OpenSearch', isFocused: true, bodyColumns: 110, placement: 'dock' }, viewport: { columns: 110, rows: 44 } } as any

// Files, HOME, panes and processes beneath the plugin; every process run is recorded.
function world(on: On, servers: unknown[]) {
  const files = new Map<string, string>([[`${BASE}/servers.json`, JSON.stringify({ servers })]])
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  let clock = 1
  const mtimes = new Map<string, number>()
  mock.env(on, { HOME })
  mock.store(on)
  mock.clock(on)
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
    if (!files.has(e.path) && e.path !== BASE) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: files.has(e.path) ? 'file' : 'dir', size: 1, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false, realPath: e.path } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.panes', () => ({ value: [] }) as any)
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    const isCurl = e.argv[0] === 'curl'
    return { value: { exitCode: 0, stdout: isCurl ? '{"ok":true}\n__OSCONSOLE__200 0.01' : 'secret-from-command\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as any
  })
  const curls = () => runs.filter(r => r.argv[0] === 'curl')
  return { files, runs, curls }
}

async function openConsole($: any, file = 's1.json') {
  await $.tool.call({ tool: TOOL, action: 'status', filepath: file } as any)
  return $.ui.mount(PANE)
}

describe('writes', () => {
  test('a write opens a prompt and sends nothing; Run once sends exactly the request shown', async ($, on) => {
    const w = world(on, [{ id: 'local', name: 'Local', host: '127.0.0.1' }])
    const ui = await openConsole($)
    await ui.post({ type: 'run', text: 'PUT idx/_doc/1\n{"a": 1}', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'confirm-once' })).toBeDefined()
    expect(w.curls()).toEqual([])
    await ui.press({ key: 'confirm-once' })
    expect(w.curls().length).toBe(1)
    expect(w.curls()[0]!.stdin).toContain('url = "http://127.0.0.1:9200/idx/_doc/1"')
    expect(w.curls()[0]!.stdin).toContain('request = "PUT"')
    expect(w.curls()[0]!.stdin).toContain('data-raw = "{\\"a\\":1}"')
  })

  test('editing the console cancels an open prompt, so a swapped request is never sent', async ($, on) => {
    const w = world(on, [{ id: 'local', name: 'Local', host: '127.0.0.1' }])
    const ui = await openConsole($)
    await ui.post({ type: 'run', text: 'PUT idx/_doc/1\n{}', row: 0 }, { in: 'editor' })
    await ui.post({ type: 'edit', text: 'DELETE prod-logs-*', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'confirm-once' })).toBeUndefined()
    expect(w.curls()).toEqual([])
  })

  test('allowWrites in servers.json unlocks nothing', async ($, on) => {
    const w = world(on, [{ id: 'local', name: 'Local', host: '127.0.0.1', allowWrites: true }])
    const ui = await openConsole($)
    await ui.post({ type: 'run', text: 'DELETE idx', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'confirm-once' })).toBeDefined()
    expect(w.curls()).toEqual([])
  })

  test('a production server offers no session unlock; others do, and it holds for the next write', async ($, on) => {
    const w = world(on, [{ id: 'prod', name: 'Prod', host: '10.0.0.1', tag: 'production' }, { id: 'dev', name: 'Dev', host: '10.0.0.2' }])
    const ui = await openConsole($)
    await ui.post({ type: 'run', text: 'DELETE idx', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'confirm-once' })).toBeDefined()
    expect(await ui.find({ key: 'confirm-session' })).toBeUndefined()
    await ui.press({ key: 'confirm-no' })
    await ui.press({ key: 'server-menu' })
    await ui.press({ key: 'pick:dev' })
    await ui.post({ type: 'run', text: 'DELETE idx', row: 0 }, { in: 'editor' })
    await ui.press({ key: 'confirm-session' })
    await ui.post({ type: 'run', text: 'DELETE idx2', row: 0 }, { in: 'editor' })
    // Picking the server also loads its index names (GET _cat/…); the writes are what matters here.
    const sent = w.curls().map(c => /url = "([^"]+)"/.exec(c.stdin!)![1]).filter(u => !u.includes('/_cat/'))
    expect(sent).toEqual(['http://10.0.0.2:9200/idx', 'http://10.0.0.2:9200/idx2'])
  })
})

describe('credentials', () => {
  test('a server with credentials asks first; nothing runs, not even its passwordCommand, until Allow', async ($, on) => {
    const w = world(on, [{ id: 'eu', name: 'EU', host: 'search.example.com', https: true, port: 443, username: 'reader', passwordCommand: ['pass', 'os/eu'] }])
    const ui = await openConsole($)
    await ui.post({ type: 'run', text: 'GET _cluster/health', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'trust-yes' })).toBeDefined()
    expect(w.runs).toEqual([])
    await ui.press({ key: 'trust-yes' })
    expect(w.runs.map(r => r.argv[0])).toEqual(['pass', 'curl'])
    expect(w.curls()[0]!.stdin).toContain('user = "reader:secret-from-command"')
  })

  test('the agent tool opens a console without running password commands or sending requests', async ($, on) => {
    const w = world(on, [{ id: 'eu', name: 'EU', host: 'h', username: 'u', passwordCommand: ['sh', '-c', 'evil'] }])
    await $.tool.call({ tool: TOOL, action: 'open', filepath: 'agent.json' } as any)
    expect(w.runs).toEqual([])
  })

  test('the agent tool refuses a config outside the mod folder', async ($, on) => {
    const w = world(on, [{ id: 'x', name: 'X', host: 'h' }])
    w.files.set('/tmp/evil.json', JSON.stringify({ servers: [{ id: 'x', name: 'X', host: 'evil' }] }))
    const r: any = await $.tool.call({ tool: TOOL, action: 'open', configfilepath: '/tmp/evil.json' } as any)
    expect(String(r?.result)).toContain('must be inside')
  })

  test('the fingerprint changes when the host or the credential source changes', async () => {
    const a = normalizeServer({ id: 'x', host: 'a.example', username: 'u', passwordEnv: 'PW' })!
    expect(credentialFingerprint(a)).not.toBe(credentialFingerprint({ ...a, host: 'evil.example' }))
    expect(credentialFingerprint(a)).not.toBe(credentialFingerprint({ ...a, passwordEnv: 'GITHUB_TOKEN' }))
    expect(credentialFingerprint(a)).toBe(credentialFingerprint({ ...a, password: undefined }))
  })

  test('duplicate server ids: the first entry wins everywhere', async () => {
    const list = [normalizeServer({ id: ' x ', host: 'a' })!, normalizeServer({ id: 'x', host: 'b' })!]
    expect(uniqueServers(list)).toEqual({ servers: [list[0]], duplicates: ['x'] })
  })
})
