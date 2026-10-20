import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { OsResult, OsServer, OsView } from '../types'
import {
  ancestorsOpen,
  buildLines,
  curlConfig,
  END,
  findMatches,
  foldablePaths,
  formatAt,
  highlight,
  parseCurlOutput,
  parseJson,
  pretty,
  rawLines,
  requestAt,
  type Line,
  type ServerCreds,
  parseArgs,
  writeGuard,
  normalizeServer,
  baseUrl,
  tagColor,
  PASTE_COMMANDS,
  type Server,
} from './lib'

const PANE = 'opensearch'
const query = atom({ plugin: 'opensearch-console', key: 'query' } as const, '')
const rev = atom({ plugin: 'opensearch-console', key: 'rev' } as const, 0)
const cursorRow = atom({ plugin: 'opensearch-console', key: 'cursorRow' } as const, 0)
const result = atom({ plugin: 'opensearch-console', key: 'result' } as const, null)
const running = atom({ plugin: 'opensearch-console', key: 'running' } as const, false)
const server = atom({ plugin: 'opensearch-console', key: 'server' } as const, '')
const servers = atom({ plugin: 'opensearch-console', key: 'servers' } as const, [])
const EMPTY_VIEW: OsView = { collapsed: [], top: 0, cursor: 0, search: '', match: 0 }
const showHelp = atom({ plugin: 'opensearch-console', key: 'showHelp' } as const, false)
const paste = atom({ plugin: 'opensearch-console', key: 'paste' } as const, null)
const indices = atom({ plugin: 'opensearch-console', key: 'indices' } as const, {})
const indicesLoading = atom({ plugin: 'opensearch-console', key: 'indicesLoading' } as const, '')
const paths = atom({ plugin: 'opensearch-console', key: 'paths' } as const, null)
const editorScroll = atom({ plugin: 'opensearch-console', key: 'editorScroll' } as const, null)
const view = atom({ plugin: 'opensearch-console', key: 'view' } as const, EMPTY_VIEW)
const menuOpen = atom({ plugin: 'opensearch-console', key: 'menuOpen' } as const, false)
const confirm = atom({ plugin: 'opensearch-console', key: 'confirm' } as const, null)
const editorCmd = atom({ plugin: 'opensearch-console', key: 'editorCmd' } as const, null)

const HELP = `**Top bar**
- **▾ Server** — open the list of servers from \`servers.json\` and pick one (● is active; production is red)
- **🔒 / 🔓** — writes are locked per server (\`allowWrites\`); a write on a locked server asks first · **↶ ↷** undo / redo
- **Format** — pretty-print the body under the cursor · **↻ Indices** — reload the server's index/alias names · **Help** — this screen

**Editor** (click it to type)
- \`ctrl+r\` / \`ctrl+enter\` or click **▶** in the gutter — run that request
- Select: shift+arrows, mouse drag, shift+click · \`ctrl+a\` select all
- \`ctrl+c\` copy · \`ctrl+x\` cut · \`ctrl+v\` paste (or your terminal's paste) · Backspace/Delete/typing replace the selection
- \`alt+z\` undo · \`alt+y\` / \`alt+shift+z\` redo, or the ↶ ↷ buttons (\`ctrl+z\` suspends Claude Code)
- \`ctrl+l\` format · Home/End or \`ctrl+e\` line end · \`ctrl+k\` delete to line end · Tab = 2 spaces
- Autocomplete: methods, index names, endpoints (\`_search\`, \`_cat/…\`), query parameters after \`?\`, and query DSL keys inside \`"…"\` · ↑↓ pick, Tab/Enter accept (index names are cached in \`indices.json\`)
- Syntax: \`METHOD path\` line, then an optional JSON body; several requests per file

**Response** (click it first)
- Mouse wheel scrolls the editor or the response (whichever is under the pointer)
- \`↑↓\` / \`j k\` move · PgUp/PgDn · \`g\`/\`G\` top/bottom
- Enter / Space / click — fold or unfold · \`←\`/\`→\` collapse/expand · \`e\` expand all · \`c\` collapse all
- \`1\`–\`9\` fold below that depth · \`y\` copy the response
- \`/\` or \`ctrl+f\` — jump to **Find** · Enter in Find / \`n\` next match · \`N\` previous

**Writes are locked by default** — on a locked server only GET/HEAD and POST to search-type endpoints (_search, _count, _msearch, _mget, _explain, _validate, scroll, PIT…) are sent. Anything else asks: “Writes are locked for this server. Unlock?” Yes sets \`allowWrites\` in \`servers.json\`; 🔓 locks it again.

**Files** — one JSON session file per console (default \`~/.claude/mods/opensearch/sessions/default.json\`: server, cursorRow, query, lastRun) + \`<name>.response.json\`; servers in \`servers.json\`. Edits show here live.

**Own console per session/agent** — \`/opensearch --filepath <name>.json [--configfilepath <servers>.json]\` (relative names live under \`~/.claude/mods/opensearch/sessions/\`).

Esc returns the keyboard to the prompt · \`/opensearch\` toggles this pane.`

const GUIDE = `OpenSearch / Elasticsearch console (a Kibana Dev Tools-style pane the user sees; works with both). Each console is one JSON session file, so sessions and agents never overwrite each other: open your own with this tool (filepath) or the user types /opensearch --filepath <name>.json [--configfilepath <servers>.json]. The current session's files are kept across reloads.

Session file (default ~/.claude/mods/opensearch/sessions/default.json): {"server": "<name from config>", "cursorRow": <0-based line of the request the user's Run sends>, "query": "<editor text>", "lastRun": {server, method, path, status, ms, at, error?}}.
- query uses Dev Tools syntax: a "METHOD path" line (GET _cat/indices?v, POST my-index/_search), then an optional JSON body; several requests separated by blank lines.
- To inject a query, write the session file (keep the other keys); the pane updates within a second. Set cursorRow to the request's METHOD line so Run sends it. Read the file to see the user's edits.
Response file: the session file with .response.json in place of .json, the last response body (pretty JSON). Read it after the user runs.
Config file (default ~/.claude/mods/opensearch/servers.json): {"servers": [{"id","name","host","port","https","insecure","username","password" | "passwordEnv" | "passwordCommand","tag","allowWrites","headers"?,"indices"?}]}. The session file's "server" is a server id. Never print passwords, and never change allowWrites yourself: unlocking writes is the user's decision.
Writes: on a server without allowWrites only reads are sent (GET/HEAD and POST to _search/_count/_msearch/_mget/_explain/_validate/_field_caps/_analyze/_termvectors/templates/scroll/PIT); a write asks the user to unlock first.
The user runs requests (▶ in the editor gutter or ctrl+r); do not run them yourself unless asked.`

const DEFAULT_SERVERS = {
  _help:
    'One entry per cluster, listed in the pane\'s server menu by name. Fields: id, name, host, port (9200), https, insecure (skip the certificate check), username, password or passwordEnv (an environment variable) or passwordCommand (argv whose output is the password), tag (production | staging | development | local), allowWrites (false: writes ask first), path (URL prefix), headers, indices (extra autocomplete names).',
  servers: [{ id: 'local', name: 'Local', host: 'localhost', port: 9200, https: false, tag: 'local' }],
}

const DEFAULT_CONSOLE = `GET _cluster/health

GET _cat/indices?v&s=index

POST my-index/_search
{
  "query": {
    "match_all": {}
  },
  "size": 10
}
`

type Model = { id: number; isJson: boolean; value: unknown; text: string; all: Line[] }

// Where this session's console lives. Kept in $.state so a reload finds them again.
let base = ''
let sessionFile = ''
let configFile = ''
const seen: Record<string, number> = {}
let saveTimer: Timer | undefined
let viewerHeight = 20
let editorBottom = 14
let model: Model | undefined
let matchCache: { key: string; paths: string[] } | undefined

const responseFile = () => sessionFile.replace(/(\.json)?$/, '.response.json')
const indicesFile = () => `${base}/indices.json`

async function resolvePath($: EngineInterface, p: string, under: string): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  if (p.startsWith('~/')) return home + p.slice(1)
  if (p.startsWith('/')) return p
  return `${under}/${p}`
}

async function write($: EngineInterface, file: string, text: string) {
  await $.fs.write(file, text)
  seen[file] = (await $.fs.stat(file)).mtimeMs
}

async function readJson($: EngineInterface, file: string): Promise<any> {
  try {
    return JSON.parse(await $.fs.read(file))
  } catch {
    return undefined
  }
}

async function readServers($: EngineInterface): Promise<Server[]> {
  const data = await readJson($, configFile)
  const list: unknown[] = Array.isArray(data?.servers) ? data.servers : []
  return list.map(x => normalizeServer(x)).filter((s): s is Server => !!s)
}

// The password from the file, an environment variable or a command (keychain, 1Password, pass).
async function passwordOf($: EngineInterface, s: Server): Promise<string> {
  if (s.passwordCommand) {
    const out = await $.process.run(s.passwordCommand, { timeoutMs: 15_000 })
    if (out.exitCode !== 0) throw new Error(`passwordCommand for ${s.name} exited ${out.exitCode}`)
    return out.stdout.replace(/\r?\n$/, '')
  }
  if (s.passwordEnv) {
    // $.env.get takes only literal names, so a configured variable is read through printenv.
    const out = await $.process.run(['printenv', s.passwordEnv]).catch(() => undefined)
    return out && out.exitCode === 0 ? out.stdout.replace(/\r?\n$/, '') : ''
  }
  return s.password ?? ''
}

async function credsFor($: EngineInterface, s: Server): Promise<ServerCreds> {
  return { name: s.id, url: baseUrl(s), username: s.username, password: await passwordOf($, s), insecure: s.insecure, headers: s.headers }
}

async function findServer($: EngineInterface, id: string): Promise<Server | undefined> {
  return (await readServers($)).find(s => s.id === id)
}

// Sets allowWrites on one server in the config file, keeping everything else as written.
async function setAllowWrites($: EngineInterface, id: string, allow: boolean) {
  const data = (await readJson($, configFile)) ?? {}
  const list: any[] = Array.isArray(data.servers) ? data.servers : []
  const entry = list.find(x => x && (x.id === id || (!x.id && x.name === id)))
  if (!entry) return
  if (allow) entry.allowWrites = true
  else delete entry.allowWrites
  await $.fs.write(configFile, JSON.stringify(data, null, 2) + '\n')
}

function getModel(r: OsResult): Model {
  if (model?.id === r.id) return model
  const parsed = parseJson(r.text)
  const value = parsed.ok ? parsed.value : undefined
  model = {
    id: r.id,
    isJson: parsed.ok,
    value,
    text: r.text,
    all: parsed.ok ? buildLines(value, new Set(), true) : rawLines(r.text),
  }
  matchCache = undefined
  return model
}

function matchesOf(m: Model, term: string) {
  const key = JSON.stringify([m.id, term])
  if (matchCache?.key !== key) matchCache = { key, paths: findMatches(m.all, term) }
  return matchCache.paths
}

function linesOf(m: Model, v: OsView) {
  return (m.isJson ? buildLines(m.value, new Set(v.collapsed)) : m.all)
}

function keepVisible(v: OsView, count: number): OsView {
  const cursor = Math.max(0, Math.min(v.cursor, count - 1))
  let top = Math.max(0, Math.min(v.top, Math.max(0, count - viewerHeight)))
  if (cursor < top) top = cursor
  if (cursor >= top + viewerHeight) top = cursor - viewerHeight + 1
  return { ...v, cursor, top }
}

function jump(m: Model, v: OsView, idx: number): OsView {
  const paths = matchesOf(m, v.search)
  if (!paths.length) return { ...v, match: 0 }
  const match = ((idx % paths.length) + paths.length) % paths.length
  const collapsed = ancestorsOpen(v.collapsed, paths[match])
  const lines = linesOf(m, { ...v, collapsed })
  const cursor = Math.max(0, lines.findIndex(l => l.path === paths[match]))
  return { ...v, collapsed, match, cursor, top: Math.max(0, cursor - Math.floor(viewerHeight / 2)) }
}

async function editView($: EngineInterface, fn: (v: OsView, m: Model) => OsView) {
  const r = await read($, result)
  if (!r) return
  const m = getModel(r)
  await update($, view, v => {
    const next = fn(v ?? EMPTY_VIEW, m)
    return keepVisible(next, linesOf(m, next).length)
  })
}

// ---- files → state ----

async function changed($: EngineInterface, file: string): Promise<boolean> {
  let mtime: number
  try {
    mtime = (await $.fs.stat(file)).mtimeMs
  } catch {
    return false
  }
  if (seen[file] === mtime) return false
  seen[file] = mtime
  return true
}

// The session file may name a server by its display name (older files): match it to an id.
async function resolveServer($: EngineInterface) {
  const list = (await read($, servers)) ?? []
  const cur = await read($, server)
  if (!list.length || list.some(s => s.id === cur)) return
  const byName = list.find(s => s.name === cur)
  await update($, server, () => (byName ?? list[0]!).id)
}

async function sync($: EngineInterface) {
  if (!sessionFile) return
  if (await changed($, configFile)) {
    const list = await readServers($)
    await update($, servers, () =>
      list.map(s => ({
        id: s.id,
        name: s.name,
        host: s.host,
        url: baseUrl(s),
        ...(s.tag ? { tag: s.tag } : {}),
        ...(s.indices ? { indices: s.indices } : {}),
        ...(s.allowWrites ? { allowWrites: true } : {}),
      })),
    )
    const cur = await read($, server)
    if (list.length && !list.some(s => s.id === cur)) {
      const byName = list.find(s => s.name === cur)
      await update($, server, () => (byName ?? list[0]!).id)
    }
  }
  if (await changed($, sessionFile)) {
    const st = await readJson($, sessionFile)
    if (st) {
      if (typeof st.query === 'string' && st.query !== (await read($, query))) {
        await update($, query, () => st.query)
        await update($, rev, n => n + 1)
      }
      if (typeof st.server === 'string' && st.server && st.server !== (await read($, server))) await update($, server, () => st.server)
      if (typeof st.cursorRow === 'number' && st.cursorRow !== (await read($, cursorRow))) {
        await update($, cursorRow, () => st.cursorRow)
        await update($, rev, n => n + 1)
      }
    }
  }
  await resolveServer($)
  if (await changed($, indicesFile())) {
    const data = (await readJson($, indicesFile())) ?? {}
    const map: Record<string, string[]> = {}
    for (const [key, entry] of Object.entries(data as Record<string, any>)) {
      if (Array.isArray(entry?.names)) map[key] = entry.names.map(String)
    }
    await update($, indices, () => map)
  }
  if (await changed($, responseFile())) {
    const text = await $.fs.read(responseFile()).catch(() => undefined)
    const cur = await read($, result)
    if (text !== undefined && text !== cur?.text) {
      const meta = (await readJson($, sessionFile))?.lastRun ?? {}
      const next: OsResult = {
        id: Date.now(),
        server: String(meta.server ?? ''),
        method: String(meta.method ?? ''),
        path: String(meta.path ?? ''),
        status: Number(meta.status ?? 0),
        ms: Number(meta.ms ?? 0),
        text,
        at: String(meta.at ?? ''),
      }
      await update($, result, () => next)
      await update($, view, v => ({ ...EMPTY_VIEW, search: v?.search ?? '' }))
    }
  }
}

async function ensureBase($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  base = `${home}/.claude/mods/opensearch`
  if (!(await $.fs.exists(`${base}/servers.json`))) await $.fs.write(`${base}/servers.json`, JSON.stringify(DEFAULT_SERVERS, null, 2) + '\n')
}

// Points this session's console at a session file and a config file, creating the session file.
// Answers why it could not, or undefined.
async function attach($: EngineInterface, file?: string, config?: string): Promise<string | undefined> {
  await ensureBase($)
  const kept = await read($, paths)
  const nextConfig = config ? await resolvePath($, config, base) : kept?.config ?? `${base}/servers.json`
  const nextFile = file ? await resolvePath($, file.endsWith('.json') ? file : `${file}.json`, `${base}/sessions`) : kept?.file ?? `${base}/sessions/default.json`
  if (!(await $.fs.exists(nextConfig))) return `Config file not found: ${nextConfig}`
  if (!(await $.fs.exists(nextFile))) {
    // A new console starts from the old single-file console when there is one.
    const legacy = nextFile === `${base}/sessions/default.json` ? await $.fs.read(`${base}/console.http`).catch(() => undefined) : undefined
    const firstRaw = (await readJson($, nextConfig))?.servers?.[0]
    const first = firstRaw?.id ?? firstRaw?.name ?? ''
    await $.fs.write(nextFile, JSON.stringify({ server: first, cursorRow: 0, query: legacy ?? DEFAULT_CONSOLE }, null, 2) + '\n')
  }
  if (nextFile !== sessionFile || nextConfig !== configFile) {
    sessionFile = nextFile
    configFile = nextConfig
    for (const k of Object.keys(seen)) delete seen[k]
    await update($, paths, () => ({ file: nextFile, config: nextConfig }))
    await update($, result, () => null)
    await update($, view, () => EMPTY_VIEW)
  }
  await sync($)
  return undefined
}

async function saveSession($: EngineInterface, extra: Record<string, unknown> = {}) {
  if (!sessionFile) return
  const old = (await readJson($, sessionFile)) ?? {}
  const next = { ...old, server: await read($, server), cursorRow: await read($, cursorRow), query: await read($, query), ...extra }
  await write($, sessionFile, JSON.stringify(next, null, 2) + '\n')
}

function scheduleSave($: EngineInterface) {
  saveTimer?.cancel()
  saveTimer = $.clock.after(250, () => void saveSession($).catch(() => undefined))
}


// ---- running a request ----

async function catNames($: EngineInterface, creds: ServerCreds, path: string, field: string): Promise<string[]> {
  const out = await $.process.run(['curl', '-K', '-'], {
    stdin: curlConfig(creds, { start: 0, end: 0, method: 'GET', path, body: '' }),
    timeoutMs: 30_000,
  })
  const parsed = parseJson(parseCurlOutput(out.stdout).text)
  if (!parsed.ok || !Array.isArray(parsed.value)) throw new Error(out.stderr.trim() || 'unexpected answer')
  return (parsed.value as Record<string, unknown>[]).map(r => String(r[field] ?? '')).filter(Boolean)
}

// Reads the server's index and alias names into indices.json (GET only).
async function refreshIndices($: EngineInterface, name: string) {
  if ((await read($, indicesLoading)) === name) return
  const s = await findServer($, name)
  if (!s) return
  await update($, indicesLoading, () => name)
  try {
    const creds = await credsFor($, s)
    const [idx, aliases] = await Promise.all([
      catNames($, creds, '_cat/indices?h=index&format=json&expand_wildcards=open', 'index'),
      catNames($, creds, '_cat/aliases?h=alias&format=json', 'alias').catch(() => [] as string[]),
    ])
    const names = [...new Set([...aliases, ...idx])].sort((a, b) => Number(a.startsWith('.')) - Number(b.startsWith('.')) || a.localeCompare(b))
    const data = (await readJson($, indicesFile())) ?? {}
    data[creds.url] = { at: new Date().toISOString(), server: s.name, names }
    await write($, indicesFile(), JSON.stringify(data, null, 2) + '\n')
    await update($, indices, m => ({ ...(m ?? {}), [creds.url]: names }))
    $.ui.toast(`${s.name}: ${names.length} indices and aliases loaded`)
  } catch (err) {
    $.ui.toast(`${name}: could not list indices (${String(err).slice(0, 120)})`)
  } finally {
    await update($, indicesLoading, () => '')
  }
}

async function ensureIndices($: EngineInterface) {
  const name = await read($, server)
  const url = ((await read($, servers)) ?? []).find(s => s.id === name)?.url
  if (name && url && !(await read($, indices))?.[url]) await refreshIndices($, name)
}

async function run($: EngineInterface) {
  if (await read($, running)) return
  const text = await read($, query)
  const req = requestAt(text, await read($, cursorRow))
  if (!req) return $.ui.toast('No request in the console (a line like `GET index/_search`).')
  const name = await read($, server)
  const target = await findServer($, name)
  if (!target) return $.ui.toast(`No server "${name}" in ${configFile}`)
  // Writes are locked per server in the config. A locked server asks the person before anything is sent.
  const refused = target.allowWrites ? undefined : writeGuard(req)
  if (refused) {
    await update($, confirm, () => ({ serverId: target.id, serverName: target.name, method: req.method, path: req.path }))
    const next: OsResult = {
      id: Date.now(), server: await read($, server), method: req.method, path: req.path,
      status: 0, ms: 0, text: refused, error: refused, at: new Date().toISOString(),
    }
    await update($, result, () => next)
    await update($, view, v => ({ ...EMPTY_VIEW, search: v?.search ?? '' }))
    return
  }
  await update($, running, () => true)
  const started = Date.now()
  let next: OsResult
  try {
    const creds = await credsFor($, target)
    const out = await $.process.run(['curl', '-K', '-'], { stdin: curlConfig(creds, req), timeoutMs: 130_000 })
    const parsed = parseCurlOutput(out.stdout)
    next = {
      id: Date.now(),
      server: target.name,
      method: req.method,
      path: req.path,
      status: parsed.status,
      ms: parsed.ms || Date.now() - started,
      text: pretty(parsed.text || (out.exitCode !== 0 ? out.stderr : '')),
      error: out.exitCode !== 0 ? out.stderr.trim() || `curl exited ${out.exitCode}` : undefined,
      at: new Date().toISOString(),
    }
  } catch (err) {
    next = {
      id: Date.now(),
      server: target.name,
      method: req.method,
      path: req.path,
      status: 0,
      ms: Date.now() - started,
      text: String(err),
      error: String(err),
      at: new Date().toISOString(),
    }
  }
  await update($, result, () => next)
  await update($, view, v => ({ ...EMPTY_VIEW, search: v?.search ?? '' }))
  await update($, running, () => false)
  await write($, responseFile(), next.text)
  const { text: _t, id: _i, ...meta } = next
  await saveSession($, { lastRun: meta })
  if (next.error) $.ui.toast(`OpenSearch: ${next.error.slice(0, 200)}`)
}

async function viewerKey($: EngineInterface, key: string, ctrl: boolean, meta: boolean, shift: boolean) {
  if (key === '/' || ((ctrl || meta) && key === 'f')) {
    await $.ui.focus({ requestId: PANE, key: 'search' }).catch(() => undefined)
    return
  }
  if (key === 'y') {
    const r = await read($, result)
    if (r) await $.ui.copy({ text: r.text })
    $.ui.toast('Response copied')
    return
  }
  await editView($, (v, m) => {
    const lines = linesOf(m, v)
    const cur = lines[v.cursor]
    const toggleTo = (p: string, open: boolean | undefined) => {
      const isCol = v.collapsed.includes(p)
      const want = open === undefined ? !isCol : !open
      const collapsed = want ? (isCol ? v.collapsed : [...v.collapsed, p]) : v.collapsed.filter(c => c !== p)
      const after = linesOf(m, { ...v, collapsed })
      return { ...v, collapsed, cursor: Math.max(0, after.findIndex(l => l.path === p)) }
    }
    switch (key) {
      case 'up':
      case 'k':
        return { ...v, cursor: v.cursor - 1 }
      case 'down':
      case 'j':
        return { ...v, cursor: v.cursor + 1 }
      case 'pageup':
        return { ...v, cursor: v.cursor - viewerHeight, top: v.top - viewerHeight }
      case 'pagedown':
        return { ...v, cursor: v.cursor + viewerHeight, top: v.top + viewerHeight }
      case 'home':
      case 'g':
        return { ...v, cursor: 0, top: 0 }
      case 'end':
      case 'G':
        return { ...v, cursor: lines.length - 1 }
      case 'return':
      case 'enter':
      case 'space':
      case ' ': {
        if (!cur) return v
        const p = cur.path.endsWith(END) ? cur.path.slice(0, -END.length) : cur.path
        return cur.fold || cur.path.endsWith(END) ? toggleTo(p, undefined) : v
      }
      case 'left':
      case 'h': {
        if (!cur) return v
        if (cur.fold && !v.collapsed.includes(cur.path)) return toggleTo(cur.path, false)
        const parent = cur.path.replace(new RegExp(`(/[^/]*)?(${END})?$`), '')
        const idx = lines.findIndex(l => l.path === parent)
        return idx >= 0 ? { ...v, cursor: idx } : v
      }
      case 'right':
      case 'l':
        return cur?.fold ? toggleTo(cur.path, true) : v
      case 'e':
        return { ...v, collapsed: [] }
      case 'c':
        return m.isJson ? { ...v, collapsed: foldablePaths(m.value, 1), cursor: 0, top: 0 } : v
      case 'n':
        return jump(m, v, v.match + (shift ? -1 : 1))
      case 'N':
        return jump(m, v, v.match - 1)
    }
    if (/^[1-9]$/.test(key) && m.isJson) {
      return { ...v, collapsed: foldablePaths(m.value, Number(key)), cursor: 0, top: 0 }
    }
    return v
  })
}


export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'opensearch',
      description: 'Toggle the OpenSearch console pane (Dev Tools style)',
      argumentHint: '[--filepath <session>.json] [--configfilepath <servers>.json]',
    })
    await $.tool.register({
      name: 'console',
      description: GUIDE,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'close', 'status'], description: 'open (default) attaches and shows the pane; close hides it; status only reports the files' },
          filepath: { type: 'string', description: 'Session file for this console (own state per session/agent). Relative = under ~/.claude/mods/opensearch/sessions/; .json added if missing; created when new.' },
          configfilepath: { type: 'string', description: 'Servers config file (urls + creds). Relative = under ~/.claude/mods/opensearch/. Must exist.' },
        },
      },
    })
    const kept = await read($, paths)
    await attach($, kept?.file, kept?.config)
    $.clock.every(600, () => void sync($).catch(() => undefined))
    return next(e)
  })

  on('tool.call', { tool: 'mcp__opensearch-console__console' }, async ($, e) => {
    // A plugin tool's arguments arrive on the event itself, beside `tool` and `tool_use_id`.
    const input = e as unknown as { action?: string; filepath?: string; configfilepath?: string }
    const action = input.action ?? 'open'
    if (action === 'close') {
      if ((await $.ui.panes()).some(pane => pane.id === PANE)) await $.ui.close({ id: PANE })
      return { result: 'OpenSearch console closed.' }
    }
    const refused = await attach($, input.filepath, input.configfilepath)
    if (refused) return { result: refused, isError: true }
    let placed = ''
    if (action === 'open') {
      const opened = await $.ui.open({ id: PANE, title: `OpenSearch · ${sessionFile.split('/').pop()}` })
      placed = opened.isPlaced ? 'Pane is open. ' : `Pane not shown yet (${(opened as any).reason ?? 'terminal too narrow'}); the user can type /opensearch. `
      void ensureIndices($).catch(() => undefined)
    }
    return { result: `${placed}Session file: ${sessionFile}\nResponse file: ${responseFile()}\nConfig file: ${configFile}` }
  })

  on('command.run', { command: 'opensearch' }, async ($, e) => {
    const args = parseArgs(e.args ?? '')
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen && !args.file && !args.config) {
      await $.ui.close({ id: PANE })
      return { text: 'OpenSearch console closed.' }
    }
    const refused = await attach($, args.file, args.config)
    if (refused) return { text: refused }
    await $.ui.open({ id: PANE, title: `OpenSearch · ${sessionFile.split('/').pop()}`, focus: true, columns: 110 })
    void ensureIndices($).catch(() => undefined)
    return {
      text: `OpenSearch console opened: ${sessionFile}`,
      context: [`${GUIDE}\n\nThis session's console: session file ${sessionFile}, response file ${responseFile()}, config file ${configFile}.`],
    }
  })

  // The wheel scrolls whichever half the pointer is over; the pane itself never moves.
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    const row = e.pointer?.row
    if (row === undefined) return {}
    const by = Math.sign(e.by) * Math.max(1, Math.min(10, Math.abs(e.by) * 3))
    if (row < editorBottom) {
      await update($, editorScroll, () => ({ id: Date.now(), by }))
    } else {
      await editView($, v => {
        const top = Math.max(0, v.top + by)
        const cursor = Math.min(Math.max(v.cursor, top), top + viewerHeight - 1)
        return { ...v, top, cursor }
      })
    }
    return {}
  })

  on('ui.message', async ($, e) => {
    const data = (e.data ?? {}) as Record<string, any>
    if (e.element === 'editor') {
      if (typeof data.text === 'string') await update($, query, () => data.text)
      if (typeof data.row === 'number') await update($, cursorRow, () => data.row)
      if (data.type === 'copy') {
        const copied = await $.ui.copy({ text: String(data.copy ?? '') })
        $.ui.toast(copied.isCopied ? 'Copied' : `Copy failed: ${'reason' in copied ? copied.reason : ''}`)
      } else if (data.type === 'paste') {
        for (const argv of PASTE_COMMANDS) {
          const out = await $.process.run(argv).catch(() => undefined)
          if (out && out.exitCode === 0) {
            await update($, paste, () => ({ id: Date.now(), text: out.stdout.replace(/\r\n/g, '\n') }))
            break
          }
        }
      } else if (data.type === 'run') {
        scheduleSave($)
        await run($)
      } else if (data.type === 'format') {
        const text = formatAt(await read($, query), await read($, cursorRow))
        await update($, query, () => text)
        await update($, rev, n => n + 1)
        scheduleSave($)
      } else {
        scheduleSave($)
      }
    } else if (e.element === 'viewer') {
      if (data.type === 'click') {
        await editView($, (v, m) => {
          const lines = linesOf(m, v)
          const idx = v.top + Number(data.y)
          const l = lines[idx]
          if (!l) return v
          if (l.fold) {
            const collapsed = v.collapsed.includes(l.path) ? v.collapsed.filter(c => c !== l.path) : [...v.collapsed, l.path]
            return { ...v, collapsed, cursor: idx }
          }
          return { ...v, cursor: idx }
        })
      } else if (data.type === 'key') {
        await viewerKey($, String(data.key), !!data.ctrl, !!data.meta, !!data.shift)
      }
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select, Input, Client, Markdown } = $.ui.resolve(e) as any
    const rows = e.viewport?.rows ?? 36
    const text = await read($, query)
    const r = await read($, result)
    const v = (await read($, view)) ?? EMPTY_VIEW
    const isRunning = await read($, running)
    const current = await read($, server)
    const list: OsServer[] = (await read($, servers)) ?? []
    const row = await read($, cursorRow)
    const req = requestAt(text, row)
    const target = list.find(s => s.id === current)
    const isMenu = await read($, menuOpen)
    const ask = await read($, confirm)
    const cmd = await read($, editorCmd)
    const help = await read($, showHelp)
    const pasted = await read($, paste)
    const scrolled = await read($, editorScroll)
    const loadingIdx = (await read($, indicesLoading)) === current
    let budget = 60_000
    const known = [...new Set([...(target?.indices ?? []), ...(((await read($, indices)) ?? {})[target?.url ?? ''] ?? [])])].filter(n => (budget -= n.length + 3) > 0)

    const fixed = 11
    // An open menu or prompt sits under the toolbar; the editor gives up its rows.
    const extra = isMenu ? Math.max(1, list.length) + 2 : ask ? (ask.method ? 6 : 5) : 0
    const editorHeight = Math.max(3, Math.floor((rows - fixed) * 0.4) - extra)
    viewerHeight = Math.max(4, rows - fixed - editorHeight)
    editorBottom = 2 + editorHeight

    let viewerProps: { lines: [string, string][][]; cursor: number; height: number; status: string }
    if (!r) {
      viewerProps = {
        lines: [[['  ', 'f'], ['Click ▶ in the editor gutter (or ctrl+r) to send the request under the cursor.', 'm']]],
        cursor: -1,
        height: viewerHeight,
        status: '',
      }
    } else {
      const m = getModel(r)
      const lines = linesOf(m, v)
      const vv = keepVisible(v, lines.length)
      const paths = matchesOf(m, v.search)
      const currentMatch = paths.length ? paths[Math.min(v.match, paths.length - 1)] : undefined
      const window = lines
        .slice(vv.top, vv.top + viewerHeight)
        .map(l => highlight(l.segs, v.search, l.path === currentMatch ? 'C' : 'H') as [string, string][])
      const found = v.search ? (paths.length ? ` · match ${Math.min(v.match, paths.length - 1) + 1}/${paths.length}` : ' · no matches') : ''
      viewerProps = {
        lines: window,
        cursor: vv.cursor - vv.top,
        height: viewerHeight,
        status: `${vv.cursor + 1}/${lines.length}${found} · ↑↓ ⏎ fold · e/c all · 1-9 depth · / find · n/N · y copy`,
      }
    }

    const statusColor = !r ? undefined : r.error || r.status >= 400 || r.status === 0 ? 'error' : 'success'
    const statusText = isRunning
      ? 'running…'
      : r
        ? `${r.status || 'ERR'} · ${r.ms} ms · ${r.method} ${r.path} · ${r.server}`
        : 'no response yet'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} height={1}>
          <Button
            key="server-menu"
            label={`▾ ${target ? target.name : 'Choose server'}`}
            variant="primary"
            onPress={() => void update($, menuOpen, o => !o)}
          />
          <Button
            key="lock"
            label={target?.allowWrites ? '🔓 writes on' : '🔒 read-only'}
            onPress={() =>
              void (async () => {
                if (!target) return
                if (target.allowWrites) {
                  await setAllowWrites($, target.id, false)
                  $.ui.toast(`${target.name}: writes locked`)
                } else await update($, confirm, () => ({ serverId: target.id, serverName: target.name, method: '', path: '' }))
              })().catch(() => undefined)
            }
          />
          <Button key="undo" label="↶" onPress={() => void update($, editorCmd, () => ({ id: Date.now(), cmd: 'undo' }))} />
          <Button key="redo" label="↷" onPress={() => void update($, editorCmd, () => ({ id: Date.now(), cmd: 'redo' }))} />
          <Text dimColor>│</Text>
          <Button
            key="format"
            label="Format"
            onPress={() =>
              void (async () => {
                await update($, query, t => formatAt(t, row))
                await update($, rev, n => n + 1)
                scheduleSave($)
              })()
            }
          />
          <Button
            key="indices"
            label={loadingIdx ? '… Indices' : '↻ Indices'}
            onPress={() => void refreshIndices($, current)}
          />
          <Button key="help" label={help ? 'Close help' : 'Help'} onPress={() => void update($, showHelp, h => !h)} />
        </Box>
        <Text wrap="truncate-end">
          <Text dimColor>{req ? `${req.method} ${req.path}` : 'no request'} → </Text>
          <Text color={tagColor(target?.tag)} bold={target?.tag === 'production' ? true : undefined}>
            {target ? `${target.url}${target.tag ? ` · ${target.tag}` : ''}` : '(no server)'}
          </Text>
        </Text>
        {isMenu ? (
          <Box flexDirection="column" borderStyle="round" borderColor="#4ec9b0" backgroundColor="#1e1e1e" paddingX={1}>
            {list.length === 0 && <Text color="error">no servers in {configFile}</Text>}
            {list.map(sv => (
              <Box flexDirection="row" gap={1} height={1}>
                <Button
                  key={`pick:${sv.id}`}
                  plain
                  label={`${sv.id === current ? '●' : ' '} ${sv.name}`}
                  onPress={() =>
                    void (async () => {
                      await update($, server, () => sv.id)
                      await update($, menuOpen, () => false)
                      await saveSession($)
                      void ensureIndices($).catch(() => undefined)
                    })()
                  }
                />
                {sv.tag ? <Text color={tagColor(sv.tag)}>{sv.tag}</Text> : null}
                <Text dimColor>{sv.url}</Text>
                {sv.allowWrites ? <Text color="warning">writes on</Text> : null}
              </Box>
            ))}
          </Box>
        ) : null}
        {ask ? (
          <Box flexDirection="column" borderStyle="round" borderColor="#f14c4c" backgroundColor="#1e1e1e" paddingX={1}>
            <Text bold color="error">Writes are locked for {ask.serverName}</Text>
            {ask.method ? <Text>{`${ask.method} ${ask.path} can change data on this server.`}</Text> : null}
            <Text dimColor>{`servers.json has allowWrites off for "${ask.serverId}". Unlock writes for this server?`}</Text>
            <Box flexDirection="row" gap={2} height={1}>
              <Button
                key="confirm-yes"
                label={ask.method ? 'Yes, unlock and run' : 'Yes, unlock'}
                variant="primary"
                onPress={() =>
                  void (async () => {
                    await setAllowWrites($, ask.serverId, true)
                    await update($, confirm, () => null)
                    seen[configFile] = -1
                    await sync($)
                    $.ui.toast(`${ask.serverName}: writes unlocked in servers.json`)
                    if (ask.method) await run($)
                  })().catch(() => undefined)
                }
              />
              <Button key="confirm-no" label="No" onPress={() => void update($, confirm, () => null)} />
            </Box>
          </Box>
        ) : null}
        <Client
          key="editor"
          module="./editor.tsx"
          width="100%"
          height={editorHeight}
          props={{ text, rev: await read($, rev), height: editorHeight, row, ...(pasted ? { paste: pasted } : {}), ...(scrolled ? { scroll: scrolled } : {}), ...(cmd ? { cmd } : {}), indices: known }}
        />
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(Math.max(10, (e.props as any).bodyColumns ?? 60))}
        </Text>
        <Text color={statusColor} wrap="truncate-end">
          {statusText}
        </Text>
        <Input
          key="search"
          label="Find "
          placeholder="search the response (/ or ctrl+f from it) · Enter = next"
          value={v.search}
          onInput={(value: string) => void editView($, (vw, m) => jump(m, { ...vw, search: value }, 0))}
          onSubmit={(value: string) => void editView($, (vw, m) => jump(m, { ...vw, search: value }, vw.search === value ? vw.match + 1 : 0))}
        />
        {help ? (
          <Box flexDirection="column" height={viewerHeight + 1} overflow="hidden">
            <Markdown text={HELP} />
          </Box>
        ) : (
          <Client key="viewer" module="./viewer.tsx" width="100%" height={viewerHeight + 1} props={viewerProps} />
        )}
      </Box>
    )
  })
}
