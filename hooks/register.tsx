import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { OsConfirm, OsPending, OsResult, OsServer, OsUnlock, OsView } from '../types'
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
  COPY_COMMANDS,
  credentialSource,
  credentialFingerprint,
  uniqueServers,
  duplicateKey,
  sentBody,
  wrapRows,
  asciiView,
  pageFrom,
  toSlash,
  isAbsolutePath,
  homeOf,
  fromCmdSet,
  ENV_NAME,
  type Server,
} from './lib'

const PANE = 'opensearch'
// The longest body the write prompt shows in full; longer ones can't be sent from a prompt.
const BODY_LIMIT = 20_000
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
// Servers whose writes the person unlocked from the pane, for this session only. Never read from disk.
const unlocked = atom({ plugin: 'opensearch-console', key: 'unlocked' } as const, [])
// Ids and URLs seen tagged production in this session: removing the tag later doesn't count.
const prodSeen = atom({ plugin: 'opensearch-console', key: 'prodSeen' } as const, [])

const HELP = `**Top bar**
- **▾ Server** — open the list of servers from \`servers.json\` and pick one (● is active; production is red)
- **🔒 / 🔓** — writes are locked; a write asks first (run once, or unlock the server for this session) · **↶ ↷** undo / redo
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

**Writes are locked** — only GET/HEAD and POST to search-type endpoints (_search, _count, _msearch, _mget, _explain, _validate, scroll, PIT…) are sent. A write opens a prompt that shows the exact request: **Run this request once**, **Unlock for this session** (not on production servers) or **Cancel**. Unlocks live in memory only; 🔓 locks again. A server that sends credentials asks once before its first request (and again if its host or credential source changes).

**Files** — one JSON session file per console (default \`~/.claude/mods/opensearch/sessions/default.json\`: server, cursorRow, query, lastRun) + \`<name>.response.json\`; servers in \`servers.json\`. Edits show here live.

**Own console per session/agent** — \`/opensearch --filepath <name>.json [--configfilepath <servers>.json]\` (relative names live under \`~/.claude/mods/opensearch/sessions/\`).

Esc returns the keyboard to the prompt · \`/opensearch\` toggles this pane.`

const GUIDE = `OpenSearch / Elasticsearch console (a Kibana Dev Tools-style pane the user sees; works with both). Each console is one JSON session file, so sessions and agents never overwrite each other: open your own with this tool (filepath) or the user types /opensearch --filepath <name>.json [--configfilepath <servers>.json]. The current session's files are kept across reloads.

Session file (default ~/.claude/mods/opensearch/sessions/default.json): {"server": "<name from config>", "cursorRow": <0-based line of the request the user's Run sends>, "query": "<editor text>", "lastRun": {server, method, path, status, ms, at, error?}}.
- query uses Dev Tools syntax: a "METHOD path" line (GET _cat/indices?v, POST my-index/_search), then an optional JSON body; several requests separated by blank lines.
- To inject a query, write the session file (keep the other keys); the pane updates within a second. Set cursorRow to the request's METHOD line so Run sends it. Read the file to see the user's edits.
Response file: the session file with .response.json in place of .json, the last response body (pretty JSON). Read it after the user runs.
Config file (default ~/.claude/mods/opensearch/servers.json): {"servers": [{"id","name","host","port","https","insecure","username","password" | "passwordEnv" | "passwordCommand","tag","headers"?,"indices"?}]}. The session file's "server" is a server id. Never print passwords.
Writes: only reads are sent (GET/HEAD and POST to _search/_count/_msearch/_mget/_explain/_validate/_field_caps/_analyze/_termvectors/templates/scroll/PIT). A write opens a prompt for the user (run once / unlock for this session); unlocks are never read from disk, so editing servers.json cannot unlock anything. A server with credentials asks the user once before its first request. With this tool, configfilepath must be inside ~/.claude/mods/opensearch/.
The user runs requests (▶ in the editor gutter or ctrl+r); do not run them yourself unless asked.`

const DEFAULT_SERVERS = {
  _help:
    'One entry per cluster, listed in the pane\'s server menu by name. Fields: id, name, host, port (9200), https, insecure (skip the certificate check), username, password or passwordEnv (an environment variable) or passwordCommand (argv whose output is the password), tag (production | staging | development | local), path (URL prefix), headers, indices (extra autocomplete names).',
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
// The session file's text as this pane last read or wrote it: two writes within one mtime tick
// still differ in content.
const seenText: Record<string, string> = {}
// The server id the session file (or the person's menu pick) asked for. When the config doesn't
// have it (yet), the pane shows another entry but never sends to it or saves it in its place.
let wantedServer = ''
let saveTimer: Timer | undefined
let viewerHeight = 20
let editorBottom = 14
let model: Model | undefined
let matchCache: { key: string; paths: string[] } | undefined

const responseFile = () => sessionFile.replace(/(\.json)?$/, '.response.json')
const indicesFile = () => `${base}/indices.json`

async function onWindows($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

async function homeDir($: EngineInterface): Promise<string> {
  return homeOf(await $.env.get('HOME'), await $.env.get('USERPROFILE'), await onWindows($))
}

// A Windows program by full path, so a same-named .exe in the working folder never runs instead.
async function system32($: EngineInterface, exe: string): Promise<string> {
  return `${toSlash((await $.env.get('SystemRoot')) || 'C:\\Windows').replace(/\/+$/, '')}/System32/${exe}`
}

// curl: Windows' own curl.exe when it's there, else the one on PATH.
async function curlBin($: EngineInterface): Promise<string> {
  if (!(await onWindows($))) return 'curl'
  const own = await system32($, 'curl.exe')
  return (await $.fs.exists(own).catch(() => false)) ? own : 'curl'
}

async function resolvePath($: EngineInterface, p: string, under: string): Promise<string> {
  if (!(await onWindows($))) {
    if (p.startsWith('~/')) return (await homeDir($)) + p.slice(1)
    if (p.startsWith('/')) return p
    return `${under}/${p}`
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) return (await homeDir($)) + toSlash(p.slice(1))
  if (isAbsolutePath(p)) return toSlash(p)
  return `${under}/${toSlash(p)}`
}

async function write($: EngineInterface, file: string, text: string) {
  // Recorded before the write: a sync landing between the write and the stat knows it's ours.
  seenText[file] = text
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
  return uniqueServers(list.map(x => normalizeServer(x)).filter((s): s is Server => !!s)).servers
}

// The password from the file, an environment variable or a command (keychain, 1Password, pass).
async function passwordOf($: EngineInterface, s: Server): Promise<string> {
  if (s.passwordCommand) {
    const out = await $.process.run(s.passwordCommand, { timeoutMs: 15_000 })
    if (out.exitCode !== 0) throw new Error(`passwordCommand for ${s.name} exited ${out.exitCode}`)
    return out.stdout.replace(/\r?\n$/, '')
  }
  if (s.passwordEnv) {
    // $.env.get takes only literal names, so a configured variable is read through another program:
    // printenv, or on Windows System32's cmd `set` (by full path, for a plain variable name only).
    if (!(await onWindows($))) {
      const out = await $.process.run(['printenv', s.passwordEnv]).catch(() => undefined)
      return out && out.exitCode === 0 ? out.stdout.replace(/\r?\n$/, '') : ''
    }
    if (!ENV_NAME.test(s.passwordEnv)) return ''
    const set = await $.process.run([await system32($, 'cmd.exe'), '/d', '/c', 'set', s.passwordEnv]).catch(() => undefined)
    return set && set.exitCode === 0 ? fromCmdSet(set.stdout, s.passwordEnv) ?? '' : ''
  }
  return s.password ?? ''
}

async function credsFor($: EngineInterface, s: Server): Promise<ServerCreds> {
  // A password is only resolved (and a passwordCommand only run) when there is a user to send it for.
  return { name: s.id, url: baseUrl(s), username: s.username, password: s.username ? await passwordOf($, s) : undefined, insecure: s.insecure, headers: s.headers }
}

async function findServer($: EngineInterface, id: string): Promise<Server | undefined> {
  return (await readServers($)).find(s => s.id === id)
}

// Approved credential fingerprints live in the mod's own store, not in a file the console reads.
async function isTrusted($: EngineInterface, s: Server): Promise<boolean> {
  if (!credentialSource(s)) return true
  const trusted = ((await $.store.get('trusted')) as string[] | undefined) ?? []
  return trusted.includes(credentialFingerprint(s))
}

async function trust($: EngineInterface, fingerprint: string) {
  const trusted = ((await $.store.get('trusted')) as string[] | undefined) ?? []
  if (!trusted.includes(fingerprint)) await $.store.set('trusted', [...trusted, fingerprint].slice(-200))
}

async function isProduction($: EngineInterface, s: Server): Promise<boolean> {
  const seen = [...((await read($, prodSeen)) ?? []), ...(((await $.store.get('prodSeen')) as string[] | undefined) ?? [])]
  return s.tag === 'production' || seen.includes(`id:${s.id}`) || seen.includes(`url:${baseUrl(s)}`)
}

async function rememberProduction($: EngineInterface, list: Server[]) {
  const marks = list.filter(s => s.tag === 'production').flatMap(s => [`id:${s.id}`, `url:${baseUrl(s)}`])
  if (!marks.length) return
  await update($, prodSeen, seen => [...new Set([...(seen ?? []), ...marks])])
  // Kept across sessions too: a production server stays one even if its tag is gone next time.
  const kept = ((await $.store.get('prodSeen')) as string[] | undefined) ?? []
  const next = [...new Set([...kept, ...marks])]
  if (next.length !== kept.length) await $.store.set('prodSeen', next.slice(-20000))
}

// A session unlock counts only for the server entry it was given to, unchanged.
async function isUnlockedNow($: EngineInterface, s: Server): Promise<boolean> {
  if (await isProduction($, s)) return false
  const fp = credentialFingerprint(s)
  return ((await read($, unlocked)) ?? []).some(u => u.id === s.id && u.url === baseUrl(s) && u.fingerprint === fp)
}

async function askTrust($: EngineInterface, s: Server, req: OsPending | null, then: 'run' | 'indices') {
  await update($, confirm, () => ({
    kind: 'trust' as const,
    req,
    serverId: s.id,
    serverName: s.name,
    url: baseUrl(s),
    source: credentialSource(s) ?? '',
    fingerprint: credentialFingerprint(s),
    then,
  }))
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
  if (!list.length) return
  const want = wantedServer || (await read($, server))
  const hit = list.find(s => s.id === want) ?? list.find(s => s.name === want)
  if (hit) {
    wantedServer = hit.id
    if (hit.id !== (await read($, server))) await update($, server, () => hit.id)
    return
  }
  if (!wantedServer) {
    wantedServer = list[0]!.id
    await update($, server, () => list[0]!.id)
  } else {
    const shown = await read($, server)
    if (!list.some(s => s.id === shown)) await update($, server, () => list[0]!.id)
  }
}

// The session asks for a server the config doesn't have: say so rather than send elsewhere.
async function missingServer($: EngineInterface): Promise<string | undefined> {
  const list = (await read($, servers)) ?? []
  return wantedServer && list.length && !list.some(s => s.id === wantedServer) ? wantedServer : undefined
}

async function sync($: EngineInterface) {
  if (!sessionFile) return
  if (await changed($, configFile)) {
    const list = await readServers($)
    await rememberProduction($, list)
    await update($, servers, () =>
      list.map(s => ({
        id: s.id,
        name: s.name,
        host: s.host,
        url: baseUrl(s),
        ...(s.tag ? { tag: s.tag } : {}),
        ...(s.indices ? { indices: s.indices } : {}),
      })),
    )
  }
  // Changed by mtime or, within one mtime tick, by content; the pane's own last write is not a change.
  const moved = await changed($, sessionFile)
  const raw = moved || seenText[sessionFile] !== undefined ? await $.fs.read(sessionFile).catch(() => undefined) : undefined
  if (raw !== undefined && raw !== seenText[sessionFile]) {
    seenText[sessionFile] = raw
    // A prompt answers for the request it shows; any outside change to the console cancels it.
    if (await read($, confirm)) await update($, confirm, () => null)
    let st: any
    try {
      st = raw === undefined ? undefined : JSON.parse(raw)
    } catch {
      st = undefined
    }
    if (st) {
      if (typeof st.server === 'string' && st.server) wantedServer = st.server
      if (typeof st.query === 'string' && st.query !== (await read($, query))) {
        await update($, query, () => st.query)
        await update($, rev, n => n + 1)
      }
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
    const meta = (await readJson($, sessionFile))?.lastRun ?? {}
    // Another run with the same body still brings its own status line.
    if (text !== undefined && (text !== cur?.text || String(meta.at ?? '') !== cur?.at)) {
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
  base = `${await homeDir($)}/.claude/mods/opensearch`
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
    // A save still pending for the old console lands there now, never in the new one.
    if (saveTimer) {
      saveTimer.cancel()
      saveTimer = undefined
      await saveSession($).catch(() => undefined)
    }
    sessionFile = nextFile
    configFile = nextConfig
    for (const k of Object.keys(seen)) delete seen[k]
    for (const k of Object.keys(seenText)) delete seenText[k]
    wantedServer = ''
    await update($, paths, () => ({ file: nextFile, config: nextConfig }))
    await update($, result, () => null)
    await update($, view, () => EMPTY_VIEW)
  }
  await sync($)
  return undefined
}

// The system clipboard first (pbcopy, wl-copy, xclip, clip.exe): the terminal's own route (OSC 52)
// is off by default in iTerm2 and missing in Terminal.app, where it reports success and copies nothing.
async function copyText($: EngineInterface, text: string): Promise<boolean> {
  const windows = await onWindows($)
  for (const cmd of COPY_COMMANDS) {
    // On Windows, System32's clip.exe by full path, so a same-named .exe in the working folder never runs.
    const argv = cmd[0] === 'clip.exe' ? (windows ? [await system32($, 'clip.exe')] : null) : windows ? null : cmd
    if (!argv) continue
    const out = await $.process.run(argv, { stdin: text, timeoutMs: 5_000 }).catch(() => undefined)
    if (out && out.exitCode === 0) return true
  }
  return (await $.ui.copy({ text })).isCopied
}

// Closes the prompt only if it is still the one this drawing showed: a press on a prompt that an
// outside change already cancelled, or replaced, does nothing.
async function takePrompt($: EngineInterface, same: (c: OsConfirm | null) => boolean): Promise<boolean> {
  let ok = false
  await update($, confirm, c => {
    if (!same(c ?? null)) return c
    ok = true
    return null
  })
  return ok
}

// One save at a time: two overlapping saves would each take the other's write for an outside one.
// Never call saveSession from anything a save runs (sync, resolveServer): it would wait on itself.
// A failed save tells the person, since nothing else would.
let saving: Promise<void> = Promise.resolve()
let badJson = ''
function saveSession($: EngineInterface, extra: Record<string, unknown> = {}, file = sessionFile): Promise<void> {
  const run = saving.then(() => saveSessionNow($, extra, file))
  saving = run.catch(err => {
    try {
      $.ui.toast(`Not saved: ${file}: ${String(err).slice(0, 160)}`)
    } catch {
      // the chain must go on even if the toast can't show
    }
  })
  return run
}

async function saveSessionNow($: EngineInterface, extra: Record<string, unknown>, file: string) {
  if (!file) return
  // A server the config lacks is saved as asked for, never as the entry shown in its place.
  const mine = { server: wantedServer || (await read($, server)), cursorRow: await read($, cursorRow), query: await read($, query) }
  // The engine has no atomic write, so the file is read again just before the write: when someone
  // else saved in between, the merge starts over on top of their save, and after three tries the pane
  // gives up rather than overwrite them.
  for (let tries = 0; ; tries++) {
    // Someone else (the agent, another editor) wrote the file since this pane last read or wrote it:
    // their editor fields win, only `extra` (a run's lastRun, a menu pick) is merged in, and the pane
    // reloads them. The mtime is read before the text, so a write in between counts as theirs.
    const mtime = await $.fs.stat(file).then(st => st.mtimeMs, () => undefined)
    const raw = await $.fs.read(file).catch(() => undefined)
    let old: Record<string, unknown> = {}
    try {
      old = raw === undefined ? {} : (JSON.parse(raw) ?? {})
    } catch {
      // A hand edit with a JSON typo is never replaced by the pane's state; said once per broken version.
      if (badJson !== raw) $.ui.toast(`Not saved: ${file} is not valid JSON. Fix it, or delete it to start over.`)
      badJson = raw ?? ''
      return
    }
    const external =
      file !== sessionFile ||
      (mtime !== undefined && seen[file] !== undefined && mtime !== seen[file]) ||
      (raw !== undefined && seenText[file] !== undefined && raw !== seenText[file])
    // Nothing of the pane's to add to their save: it is left as they wrote it.
    if (!external || Object.keys(extra).length) {
      const text = JSON.stringify({ ...old, ...(external ? {} : mine), ...extra }, null, 2) + '\n'
      if ((await $.fs.read(file).catch(() => undefined)) !== raw) {
        if (tries < 2) continue
        $.ui.toast(`Not saved: ${file} keeps changing. Your edits are still in the pane.`)
        return
      }
      await write($, file, text)
    }
    if (external && file === sessionFile) {
      delete seen[file]
      delete seenText[file]
      await sync($)
    }
    return
  }
}

function scheduleSave($: EngineInterface) {
  saveTimer?.cancel()
  saveTimer = $.clock.after(250, () => void saveSession($).catch(() => undefined))
}


// ---- running a request ----

async function catNames($: EngineInterface, creds: ServerCreds, path: string, field: string): Promise<string[]> {
  // -q first: curl must not read ~/.curlrc (a proxy or trace file there would see credentials).
  const out = await $.process.run([await curlBin($), '-q', '-K', '-'], {
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
  if (!(await isTrusted($, s))) return askTrust($, s, null, 'indices')
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
  const s = await findServer($, name)
  // Loads names only for a server that needs no credentials or whose credentials the person approved.
  if (s && !(await read($, indices))?.[baseUrl(s)] && (await isTrusted($, s))) await refreshIndices($, name)
}

async function run($: EngineInterface) {
  if (await read($, running)) return
  const text = await read($, query)
  const req = requestAt(text, await read($, cursorRow))
  if (!req) return $.ui.toast('No request in the console (a line like `GET index/_search`).')
  const missing = await missingServer($)
  if (missing) return $.ui.toast(`Not sent: this console asks for server "${missing}", which isn't in ${configFile}. Add it, or pick a server from the menu.`)
  const name = await read($, server)
  const target = await findServer($, name)
  if (!target) return $.ui.toast(`No server "${name}" in ${configFile}`)
  const shown = sentBody(req)
  const dup = req.body ? duplicateKey(req.body) : undefined
  if (dup) return $.ui.toast(`Not sent: the body repeats the key "${dup}" (only the last one would count). Remove the duplicate.`)
  const pending: OsPending = {
    serverId: target.id,
    serverName: target.name,
    url: baseUrl(target),
    fingerprint: credentialFingerprint(target),
    method: req.method,
    path: req.path,
    body: req.body,
    sent: shown.body,
    ...(shown.summary ? { summary: shown.summary } : {}),
    production: await isProduction($, target),
  }
  // Writes ask first, unless the person unlocked this exact server entry from the pane in this session.
  const isWrite = !!writeGuard(req)
  if (isWrite && !(await isUnlockedNow($, target))) {
    await update($, menuOpen, () => false)
    await update($, confirm, () => ({ kind: 'write' as const, req: pending, shownFrom: 0 }))
    return
  }
  await send($, pending)
}

// Sends exactly `pending`: the server must still resolve to the same address, and its
// credentials must be approved. Nothing here reads the editor again.
async function send($: EngineInterface, pending: OsPending) {
  const target = await findServer($, pending.serverId)
  if (!target || baseUrl(target) !== pending.url || credentialFingerprint(target) !== pending.fingerprint) {
    return $.ui.toast(`Not sent: server "${pending.serverName}" changed in ${configFile}. Run it again.`)
  }
  if (!(await isTrusted($, target))) return askTrust($, target, pending, 'run')
  const req = { start: 0, end: 0, method: pending.method, path: pending.path, body: pending.body }
  // The console this request belongs to: a switch to another session file meanwhile doesn't move it.
  const file = sessionFile
  const responsePath = responseFile()
  await update($, running, () => true)
  const started = Date.now()
  let next: OsResult
  try {
    const creds = await credsFor($, target)
    const out = await $.process.run([await curlBin($), '-q', '-K', '-'], { stdin: curlConfig(creds, req), timeoutMs: 130_000 })
    const parsed = parseCurlOutput(out.stdout)
    next = {
      id: Date.now(),
      server: target.name,
      method: req.method,
      path: req.path,
      status: parsed.status,
      ms: parsed.ms || Date.now() - started,
      text: pretty(parsed.text || (out.exitCode !== 0 ? out.stderr : '')),
      ...(out.exitCode !== 0 ? { error: out.stderr.trim() || `curl exited ${out.exitCode}` } : {}),
      at: new Date().toISOString(),
    }
  } catch (err) {
    next = { id: Date.now(), server: target.name, method: req.method, path: req.path, status: 0, ms: Date.now() - started, text: String(err), error: String(err), at: new Date().toISOString() }
  }
  await update($, running, () => false)
  if (file === sessionFile) {
    await update($, result, () => next)
    await update($, view, v => ({ ...EMPTY_VIEW, search: v?.search ?? '' }))
  }
  // lastRun first: a pane that sees the new response then reads the matching status line.
  const { text: _t, id: _i, ...meta } = next
  // A failed lastRun save (it toasts) must not lose the response itself.
  await saveSession($, { lastRun: meta }, file).catch(() => undefined)
  await write($, responsePath, next.text)
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
    // An agent may open its own console, but only with a config inside the mod's folder:
    // pointing the pane at another config is the person's call (/opensearch --configfilepath).
    if (input.configfilepath) {
      if (!base) await ensureBase($)
      const want = await resolvePath($, input.configfilepath, base)
      // Backslashes are separators only on Windows; elsewhere `opensearch\\x` is a sibling folder.
      const slash = (await onWindows($)) ? toSlash : (p: string) => p
      const real = slash((await $.fs.stat(want, { resolve: true }).catch(() => undefined))?.realPath ?? want)
      const root = slash((await $.fs.stat(base, { resolve: true }).catch(() => undefined))?.realPath ?? base)
      if (!real.startsWith(root + '/') || real.toLowerCase().startsWith((root + '/sessions/').toLowerCase())) return { result: `configfilepath must be inside ${base}/ (not sessions/). Ask the user to open other configs with /opensearch --configfilepath.`, isError: true }
    }
    const refused = await attach($, input.filepath, input.configfilepath)
    if (refused) return { result: refused, isError: true }
    let placed = ''
    if (action === 'open') {
      const opened = await $.ui.open({ id: PANE, title: `OpenSearch · ${sessionFile.split('/').pop()}` })
      placed = opened.isPlaced ? 'Pane is open. ' : `Pane not shown yet (${(opened as any).reason ?? 'terminal too narrow'}); the user can type /opensearch. `
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
      await editView($, (v0, m) => {
        // Start from the window as drawn: a taller viewer shows rows above the stored top.
        const v = keepVisible(v0, linesOf(m, v0).length)
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
      if (data.type !== 'run' && data.type !== 'copy' && (await read($, confirm))) await update($, confirm, () => null)
      if (typeof data.text === 'string') await update($, query, () => data.text)
      if (typeof data.row === 'number') await update($, cursorRow, () => data.row)
      // A cut carries its text on the edit post; a copy has its own.
      if (typeof data.copy === 'string') $.ui.toast((await copyText($, data.copy)) ? 'Copied' : 'Copy failed')
      if (data.type === 'copy') {
        // nothing more: the text and cursor were taken above
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
        await editView($, (v0, m) => {
          const v = keepVisible(v0, linesOf(m, v0).length)
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
    // The pane's own rows (the terminal's height is larger: transcript, prompt and footer share it).
    const rows = (e.props as any).scroll?.bodyRows ?? e.viewport?.rows ?? 36
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
    const targetFull = target ? await findServer($, target.id) : undefined
    const isUnlocked = !!targetFull && (await isUnlockedNow($, targetFull))
    const ask = await read($, confirm)
    const cols = (e.props as any).bodyColumns ?? 100
    // A write prompt takes the whole pane. It draws ASCII only (\uXXXX for anything else), counts
    // every row it uses from the pane's real size, and shows the body forward from the furthest
    // point already shown; the send buttons appear only once the end has been on screen.
    const promptWidth = Math.max(10, cols - 4)
    const isWritePrompt = !!ask && ask.kind === 'write'
    const urlRows = isWritePrompt ? wrapRows(asciiView(`${ask.req.method} ${ask.req.url}/${ask.req.path.replace(/^\/+/, '')}`), promptWidth) : []
    const bodyView = isWritePrompt ? asciiView(ask.req.sent) : ''
    const chrome = 8 + urlRows.length + (isWritePrompt && ask.req.summary ? 1 : 0)
    const pageSize = rows - chrome
    const tooLong = bodyView.length > BODY_LIMIT
    const tooSmall = isWritePrompt && pageSize < (bodyView ? 3 : 0)
    const shown = isWritePrompt && bodyView && !tooLong && !tooSmall ? pageFrom(bodyView, ask.shownFrom, promptWidth, pageSize) : { rows: [] as string[], end: bodyView.length }
    const bodySeen = isWritePrompt && !tooLong && !tooSmall && shown.end >= bodyView.length
    const cmd = await read($, editorCmd)
    const help = await read($, showHelp)
    const pasted = await read($, paste)
    const scrolled = await read($, editorScroll)
    const loadingIdx = (await read($, indicesLoading)) === current
    let budget = 60_000
    const known = [...new Set([...(target?.indices ?? []), ...(((await read($, indices)) ?? {})[target?.url ?? ''] ?? [])])].filter(n => (budget -= n.length + 3) > 0)

    const fixed = 11
    // An open menu or prompt sits under the toolbar; the editor gives up its rows.
    const extra = isMenu ? Math.max(1, list.length) + 2 : ask?.kind === 'trust' ? 6 : 0
    const editorHeight = Math.max(3, Math.floor((rows - fixed) * 0.4) - extra)
    viewerHeight = Math.max(4, rows - fixed - editorHeight)
    editorBottom = 2 + extra + editorHeight

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
            // No menu while a write prompt is open: it would push the prompt's buttons out of view.
            onPress={() => void (ask?.kind === 'write' ? $.ui.toast('Finish or cancel the write prompt first.') : update($, menuOpen, o => !o))}
          />
          <Button
            key="lock"
            label={isUnlocked ? '🔓 writes on' : '🔒 writes locked'}
            onPress={() =>
              void (async () => {
                if (!target) return
                if (isUnlocked) {
                  await update($, unlocked, l => (l ?? []).filter(u => u.id !== target.id))
                  $.ui.toast(`${target.name}: writes locked`)
                } else $.ui.toast('Writes unlock from the prompt that a write opens, one request or one session at a time.')
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
        {isMenu && ask?.kind !== 'write' ? (
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
                      await update($, confirm, () => null)
                      // The person's pick wins over a session file someone else just wrote.
                      wantedServer = sv.id
                      await saveSession($, { server: sv.id })
                      void ensureIndices($).catch(() => undefined)
                    })()
                  }
                />
                {sv.tag ? <Text color={tagColor(sv.tag)}>{sv.tag}</Text> : null}
                <Text dimColor>{sv.url}</Text>
              </Box>
            ))}
          </Box>
        ) : null}
        {ask && ask.kind === 'write' ? (
          <Box flexDirection="column" borderStyle="round" borderColor="#f14c4c" backgroundColor="#1e1e1e" paddingX={1}>
            <Text bold color="error" wrap="truncate-end">{`Writes are locked for ${asciiView(ask.req.serverName)}`}</Text>
            {urlRows.map(r => (
              <Text wrap="truncate-end">{r}</Text>
            ))}
            {ask.req.summary ? <Text color="warning" wrap="truncate-end">{ask.req.summary}</Text> : null}
            {!bodyView ? (
              <Text dimColor>no body</Text>
            ) : tooLong ? (
              <Text color="error" wrap="truncate-end">{`body: ${bodyView.length} characters, too long to review here, so it can't be sent.`}</Text>
            ) : tooSmall ? (
              <Text color="error" wrap="truncate-end">Make the pane taller to review this body.</Text>
            ) : (
              <Box flexDirection="column">
                <Text dimColor wrap="truncate-end">{`body as sent (${bodyView.length} characters, shown up to ${Math.floor((shown.end / bodyView.length) * 100)}%):`}</Text>
                {shown.rows.map(l => (
                  <Text wrap="truncate-end">{l || ' '}</Text>
                ))}
              </Box>
            )}
            <Text dimColor wrap="truncate-end">{bodySeen ? 'This request can change data. Run sends exactly what is shown here.' : tooLong ? 'Cancel, and send a smaller body.' : tooSmall ? 'Enlarge the pane, or cancel.' : 'Read the whole body before you can run it.'}</Text>
            <Box flexDirection="row" gap={2} height={1}>
              {!bodySeen && !tooLong && !tooSmall ? (
                <Button
                  key="body-next"
                  label="Next page"
                  variant="primary"
                  onPress={() => {
                    // Moves on from what this drawing showed; a stale press (another prompt by now) does nothing.
                    const from = ask.shownFrom
                    const to = shown.end
                    const same = JSON.stringify(ask.req)
                    void update($, confirm, c => (c && c.kind === 'write' && JSON.stringify(c.req) === same && c.shownFrom === from ? { ...c, shownFrom: to } : c))
                  }}
                />
              ) : null}
              {bodySeen ? (
                <Button
                  key="confirm-once"
                  label="Run this request once"
                  variant="primary"
                  onPress={() =>
                    void (async () => {
                      const req = ask.req
                      if (!(await takePrompt($, c => c?.kind === 'write' && JSON.stringify(c.req) === JSON.stringify(req)))) return
                      await send($, req)
                    })().catch(() => undefined)
                  }
                />
              ) : null}
              {bodySeen && !ask.req.production ? (
                <Button
                  key="confirm-session"
                  label="Unlock for this session"
                  onPress={() =>
                    void (async () => {
                      const req = ask.req
                      if (!(await takePrompt($, c => c?.kind === 'write' && JSON.stringify(c.req) === JSON.stringify(req)))) return
                      await update($, unlocked, l => [...(l ?? []).filter(u => u.id !== req.serverId), { id: req.serverId, url: req.url, fingerprint: req.fingerprint } as OsUnlock])
                      $.ui.toast(`${req.serverName}: writes unlocked until this session ends (🔓 locks again)`)
                      await send($, req)
                    })().catch(() => undefined)
                  }
                />
              ) : null}
              <Button key="confirm-no" label="Cancel" onPress={() => void update($, confirm, () => null)} />
            </Box>
          </Box>
        ) : null}
        {ask && ask.kind === 'trust' ? (
          <Box flexDirection="column" borderStyle="round" borderColor="#d7a700" backgroundColor="#1e1e1e" paddingX={1}>
            <Text bold color="warning" wrap="truncate-end">{`Send credentials to ${asciiView(ask.serverName)}?`}</Text>
            <Text wrap="wrap">{asciiView(`${ask.url} gets ${ask.source}.`)}</Text>
            <Text dimColor>Asked once per server, and again whenever its host or credential source changes in the config.</Text>
            <Box flexDirection="row" gap={2} height={1}>
              <Button
                key="trust-yes"
                label="Allow"
                variant="primary"
                onPress={() =>
                  void (async () => {
                    const a = ask
                    if (!(await takePrompt($, c => c?.kind === 'trust' && c.fingerprint === a.fingerprint && c.then === a.then && JSON.stringify(c.req) === JSON.stringify(a.req)))) return
                    await trust($, a.fingerprint)
                    if (a.then === 'run' && a.req) await send($, a.req)
                    else await refreshIndices($, a.serverId)
                  })().catch(() => undefined)
                }
              />
              <Button key="trust-no" label="Cancel" onPress={() => void update($, confirm, () => null)} />
            </Box>
          </Box>
        ) : null}
        {ask?.kind === 'write' ? null : (<>
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
        </>)}
      </Box>
    )
  })
}
