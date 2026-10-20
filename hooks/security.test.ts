import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { credentialFingerprint, normalizeServer, uniqueServers } from './lib'

const TOOL = 'mcp__opensearch-console__console'
const HOME = '/home/tester'
const BASE = `${HOME}/.claude/mods/opensearch`
const PANE = { plugin: 'opensearch-console', surface: 'terminal', component: 'Pane', requestId: 'opensearch', props: { title: 'OpenSearch', isFocused: true, bodyColumns: 110, placement: 'dock' }, viewport: { columns: 110, rows: 44 } } as any

// Files, HOME, panes and processes beneath the plugin; every process run is recorded.
function world(on: On, servers: unknown[], opts: { windows?: boolean } = {}) {
  const files = new Map<string, string>([[`${BASE}/servers.json`, JSON.stringify({ servers })]])
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  let tick = 1
  const mtimes = new Map<string, number>()
  mock.env(on, opts.windows ? { HOME, OS: 'Windows_NT', SystemRoot: 'C:\\Windows' } : { HOME })
  mock.store(on)
  const clock = mock.clock(on)
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    if (!files.has(e.path)) throw new Error(`ENOENT ${e.path}`)
    return { value: files.get(e.path)! }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    mtimes.set(e.path, tick++)
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
    // On Windows without Git Bash there is no printenv; cmd's `set` lists matching variables.
    if (opts.windows && e.argv[0] === 'printenv') throw new Error('ENOENT printenv')
    const other = opts.windows && e.argv[0] === 'C:/Windows/System32/cmd.exe' ? 'OS_PW_OLD=old\r\nOS_PW=pw\r\n' : 'secret-from-command\n'
    return { value: { exitCode: 0, stdout: isCurl ? '{"ok":true}\n__OSCONSOLE__200 0.01' : other, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as any
  })
  const curls = () => runs.filter(r => r.argv[0] === 'curl')
  // Writes a file as an outside writer (an agent) would: new content, newer mtime.
  const touch = (path: string, text: string) => {
    files.set(path, text)
    mtimes.set(path, 1_000_000 + clock.now())
  }
  return { files, runs, curls, clock, touch }
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
    expect(w.curls()[0]!.argv.slice(0, 3)).toEqual(['curl', '-q', '-K'])
    expect(w.curls()[0]!.stdin).toContain('url = "http://127.0.0.1:9200/idx/_doc/1"')
    expect(w.curls()[0]!.stdin).toContain('request = "PUT"')
    expect(w.curls()[0]!.stdin).toContain('data-raw = "{\\"a\\":1}"')
  })

  test('an outside change to the session file cancels an open prompt, so a swapped request is never sent', async ($, on) => {
    const w = world(on, [{ id: 'local', name: 'Local', host: '127.0.0.1' }])
    const ui = await openConsole($)
    await ui.post({ type: 'run', text: 'PUT idx/_doc/1\n{}', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'confirm-once' })).toBeDefined()
    // While the prompt is open the editor is hidden; an agent rewrites the session file instead.
    expect(await ui.find({ key: 'editor' })).toBeUndefined()
    w.touch(`${BASE}/sessions/s1.json`, JSON.stringify({ server: 'local', cursorRow: 0, query: 'DELETE prod-logs-*' }))
    // The pane re-reads its files on a timer; any read of them (here the agent's own status call) syncs.
    await $.tool.call({ tool: TOOL, action: 'status' } as any)
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

describe('session unlocks', () => {
  test('an unlock does not follow a server whose entry changed (host or credentials)', async ($, on) => {
    const w = world(on, [{ id: 'stg', name: 'Staging', host: '10.0.0.2' }])
    const ui = await openConsole($)
    await ui.post({ type: 'run', text: 'DELETE idx', row: 0 }, { in: 'editor' })
    await ui.press({ key: 'confirm-session' })
    expect(w.curls().length).toBe(1)
    // The agent repoints the unlocked entry at another cluster.
    w.files.set(`${BASE}/servers.json`, JSON.stringify({ servers: [{ id: 'stg', name: 'Staging', host: '10.9.9.9' }] }))
    await ui.post({ type: 'run', text: 'DELETE idx', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'confirm-once' })).toBeDefined()
    expect(w.curls().length).toBe(1)
  })

  test('a server seen as production stays production after its tag is removed', async ($, on) => {
    const w = world(on, [{ id: 'prd', name: 'Prod', host: '10.0.0.1', tag: 'production' }])
    const ui = await openConsole($)
    await ui.post({ type: 'run', text: 'DELETE idx', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'confirm-session' })).toBeUndefined()
    await ui.press({ key: 'confirm-no' })
    w.files.set(`${BASE}/servers.json`, JSON.stringify({ servers: [{ id: 'prd', name: 'Prod', host: '10.0.0.1' }] }))
    await ui.post({ type: 'run', text: 'DELETE idx', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'confirm-session' })).toBeUndefined()
    expect(w.curls()).toEqual([])
  })

  test('a body with a repeated key is not sent and opens no prompt', async ($, on) => {
    const w = world(on, [{ id: 'dev', name: 'Dev', host: '10.0.0.2' }])
    const ui = await openConsole($)
    await ui.post({ type: 'run', text: 'POST idx/_search\n{"query":{"term":{"a":1}},"query":{"match_all":{}}}', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'confirm-once' })).toBeUndefined()
    expect(w.curls()).toEqual([])
  })
})

describe('long bodies', () => {
  test('the send buttons appear only on the last body page, after every page', async ($, on) => {
    const w = world(on, [{ id: 'dev', name: 'Dev', host: '10.0.0.2' }])
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 's1.json' } as any)
    const ui: any = await $.ui.mount({ ...PANE, viewport: { columns: 110, rows: 40 } })
    const lines = Array.from({ length: 30 }, (_, i) => `{"delete":{"_index":"products","_id":"${i}"}}`).join('\n')
    await ui.post({ type: 'run', text: `POST _bulk\n{"index":{"_index":"a"}}\n{"x":1}\n${lines}`, row: 0 }, { in: 'editor' })
    let presses = 0
    while (await ui.find({ key: 'body-next' })) {
      expect(await ui.find({ key: 'confirm-once' })).toBeUndefined()
      await ui.press({ key: 'body-next' })
      presses++
    }
    expect(presses).toBeGreaterThan(0)
    expect(await ui.find({ key: 'confirm-once' })).toBeDefined()
    expect(w.curls()).toEqual([])
  })

  test('a body too long to show can never be sent from the prompt', async ($, on) => {
    const w = world(on, [{ id: 'dev', name: 'Dev', host: '10.0.0.2' }])
    const ui = await openConsole($)
    const body = JSON.stringify({ query: { ids: { values: Array.from({ length: 3000 }, (_, i) => `doc-${i}`) } } })
    await ui.post({ type: 'run', text: `POST idx/_delete_by_query\n${body}`, row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'confirm-once' })).toBeUndefined()
    expect(await ui.find({ key: 'body-next' })).toBeUndefined()
    expect(w.curls()).toEqual([])
  })
})

describe('wide text and resizing', () => {
  test('wide characters are shown escaped, so the hidden tail of a line is never counted as seen', async ($, on) => {
    const w = world(on, [{ id: 'dev', name: 'Dev', host: '10.0.0.2' }])
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 's1.json' } as any)
    const ui: any = await $.ui.mount({ ...PANE, viewport: { columns: 110, rows: 40 }, props: { ...PANE.props, bodyColumns: 110, scroll: { offset: 0, bodyRows: 40 } } })
    const body = `{"query":{"bool":{"should":[{"term":{"n":"${'漢'.repeat(400)}"}}],"must":{"match_all":{}}}}}`
    await ui.post({ type: 'run', text: `POST idx/_delete_by_query\n${body}`, row: 0 }, { in: 'editor' })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('\\\\u6f22')
    expect(drawn).not.toContain('漢')
    expect(w.curls()).toEqual([])
  })

  test('enlarging the pane continues from the furthest point shown; nothing is skipped', async ($, on) => {
    const w = world(on, [{ id: 'dev', name: 'Dev', host: '10.0.0.2' }])
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 's1.json' } as any)
    const small: any = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 20 } } })
    const lines = Array.from({ length: 60 }, (_, i) => `{"delete":{"_index":"p","_id":"d${i}"}}`).join('\n')
    await small.post({ type: 'run', text: `POST _bulk\n${lines}`, row: 0 }, { in: 'editor' })
    const first = JSON.stringify(await small.drawn())
    expect(first).toContain('d0\\"')
    expect(first).not.toContain('d20\\"')
    await small.press({ key: 'body-next' })
    await small.unmount()
    const big: any = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 200 } } })
    const next = JSON.stringify(await big.drawn())
    // The big pane shows the rest from where the small one stopped, so it reaches the end honestly.
    expect(next).not.toContain('d0\\"')
    expect(next).toContain('d59\\"')
    expect(await big.find({ key: 'confirm-once' })).toBeDefined()
    expect(w.curls()).toEqual([])
  })

  test('a too-small pane shows no send button at all', async ($, on) => {
    const w = world(on, [{ id: 'dev', name: 'Dev', host: '10.0.0.2' }])
    await $.tool.call({ tool: TOOL, action: 'status', filepath: 's1.json' } as any)
    const ui: any = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 10 } } })
    await ui.post({ type: 'run', text: 'PUT idx/_doc/1\n{"a":1}', row: 0 }, { in: 'editor' })
    expect(await ui.find({ key: 'confirm-once' })).toBeUndefined()
    expect(await ui.find({ key: 'body-next' })).toBeUndefined()
    expect(w.curls()).toEqual([])
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

  for (const [label, entry] of [
    ['passwordCommand', { passwordCommand: ['sh', '-c', 'evil'] }],
    ['passwordEnv', { passwordEnv: 'GITHUB_TOKEN' }],
    ['password', { password: 'x' }],
    ['headers', { headers: { Authorization: 'ApiKey x' } }],
  ] as const) {
    test(`an entry without a username but with ${label} still asks before the first request`, async ($, on) => {
      const w = world(on, [{ id: 'eu', name: 'EU', host: 'h.example', ...entry }])
      const ui = await openConsole($)
      await ui.post({ type: 'run', text: 'GET _cluster/health', row: 0 }, { in: 'editor' })
      expect(await ui.find({ key: 'trust-yes' })).toBeDefined()
      expect(w.runs).toEqual([])
    })
  }

  test('the agent tool refuses a config inside sessions/', async ($, on) => {
    const w = world(on, [{ id: 'x', name: 'X', host: 'h' }])
    w.files.set(`${BASE}/sessions/evil-servers.json`, JSON.stringify({ servers: [{ id: 'x', name: 'X', host: 'evil' }] }))
    const r: any = await $.tool.call({ tool: TOOL, action: 'open', configfilepath: 'sessions/evil-servers.json' } as any)
    expect(String(r?.result)).toContain('not sessions/')
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

describe('Windows password variables', () => {
  test('on Windows, passwordEnv is read with System32 cmd set, never printenv, exactly that variable', async ($, on) => {
    const w = world(on, [{ id: 'w', name: 'W', host: '127.0.0.1', username: 'u', passwordEnv: 'OS_PW' }], { windows: true })
    const ui = await openConsole($)
    await ui.post({ type: 'run', text: 'GET _cluster/health', row: 0 }, { in: 'editor' })
    const trust = await ui.find({ key: 'trust-yes' })
    expect(trust).toBeDefined()
    await ui.press({ key: 'trust-yes' })
    expect(w.runs.map(r => r.argv[0])).toEqual(['C:/Windows/System32/cmd.exe', 'curl'])
    expect(w.runs[0]!.argv).toEqual(['C:/Windows/System32/cmd.exe', '/d', '/c', 'set', 'OS_PW'])
    expect(w.curls()[0]!.stdin).toContain('pw')
    expect(w.curls()[0]!.stdin).not.toContain('old')
  })
})

describe('clipboard', () => {
  test('a copy, and a cut riding on its edit post, go to the system clipboard with the text on stdin', async ($, on) => {
    const w = world(on, [{ id: 'local', name: 'Local', host: '127.0.0.1' }])
    const ui = await openConsole($)
    await ui.post({ type: 'copy', copy: 'GET a', text: 'GET a', row: 0 }, { in: 'editor' })
    await ui.post({ type: 'edit', copy: 'GET b', text: '', row: 0 }, { in: 'editor' })
    expect(w.runs.map(r => r.argv)).toEqual([['pbcopy'], ['pbcopy']])
    expect(w.runs.map(r => r.stdin)).toEqual(['GET a', 'GET b'])
    expect(w.curls()).toEqual([])
  })
})
