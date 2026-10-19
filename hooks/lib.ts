// Pure helpers: request parsing, curl config, the JSON tree the viewer folds.

export type Seg = [string, string]
export type Line = { path: string; segs: Seg[]; fold: boolean; depth: number }
export type Request = { start: number; end: number; method: string; path: string; body: string }

const METHOD = /^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)\s+(\S.*)?$/i

export function isRequestLine(line: string): boolean {
  return METHOD.test(line)
}

export function parseRequests(text: string): Request[] {
  const lines = text.split('\n')
  const out: Request[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = METHOD.exec(lines[i])
    if (!m) continue
    if (out.length) out[out.length - 1].end = i - 1
    out.push({ start: i, end: lines.length - 1, method: m[1].toUpperCase(), path: (m[2] ?? '').trim(), body: '' })
  }
  for (const r of out) {
    r.body = lines
      .slice(r.start + 1, r.end + 1)
      .filter(l => !/^\s*(#|\/\/)/.test(l))
      .join('\n')
      .trim()
  }
  return out
}

export function requestAt(text: string, row: number): Request | undefined {
  const all = parseRequests(text)
  return all.filter(r => r.start <= row).pop() ?? all[0]
}

function isNdjson(path: string): boolean {
  return /(^|\/)_(bulk|msearch|msearch\/template)(\?|$|\/)/.test(path)
}

// Splits a body into its top-level JSON values (for _bulk / _msearch).
function splitValues(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inStr = false
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' || c === ']') {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(body.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

export function requestBody(r: Request): { body?: string; contentType: string } {
  if (!r.body) return { contentType: 'application/json' }
  if (isNdjson(r.path)) {
    const parts = splitValues(r.body).map(p => {
      try {
        return JSON.stringify(JSON.parse(p))
      } catch {
        return p.replace(/\s*\n\s*/g, ' ')
      }
    })
    return { body: parts.join('\n') + '\n', contentType: 'application/x-ndjson' }
  }
  try {
    return { body: JSON.stringify(JSON.parse(r.body)), contentType: 'application/json' }
  } catch {
    return { body: r.body, contentType: 'application/json' }
  }
}

// Pretty-prints the body of the request under `row`; the text as it was when the body is not JSON.
export function formatAt(text: string, row: number): string {
  const r = requestAt(text, row)
  if (!r || !r.body) return text
  const lines = text.split('\n')
  let pretty: string
  if (isNdjson(r.path)) {
    const parts = splitValues(r.body)
    try {
      pretty = parts.map(p => JSON.stringify(JSON.parse(p))).join('\n')
    } catch {
      return text
    }
  } else {
    try {
      pretty = JSON.stringify(JSON.parse(r.body), null, 2)
    } catch {
      return text
    }
  }
  const head = lines.slice(0, r.start + 1)
  const tail = lines.slice(r.end + 1)
  const sep = tail.length ? [''] : []
  return [...head, ...pretty.split('\n'), ...sep, ...tail.filter((l, i) => !(i === 0 && l.trim() === ''))].join('\n')
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}

function curlQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'
}

export const MARK = '__OSCONSOLE__'

export type ServerCreds = { name: string; url: string; username?: string; password?: string; insecure?: boolean; headers?: Record<string, string> }

// A curl config read from stdin, so the password never sits on argv.
export function curlConfig(server: ServerCreds, r: Request): string {
  const { body, contentType } = requestBody(r)
  const lines = [
    `url = ${curlQuote(joinUrl(server.url, r.path))}`,
    `request = ${curlQuote(r.method)}`,
    `header = ${curlQuote('Content-Type: ' + contentType)}`,
    'silent',
    'show-error',
    'max-time = 120',
    `write-out = ${curlQuote('\n' + MARK + '%{http_code} %{time_total}')}`,
  ]
  for (const [k, v] of Object.entries(server.headers ?? {})) lines.push(`header = ${curlQuote(`${k}: ${v}`)}`)
  if (server.username) lines.push(`user = ${curlQuote(`${server.username}:${server.password ?? ''}`)}`)
  if (server.insecure) lines.push('insecure')
  if (r.method === 'HEAD') lines.push('head')
  if (body !== undefined) lines.push(`data-binary = ${curlQuote(body)}`)
  return lines.join('\n') + '\n'
}

export function parseCurlOutput(stdout: string): { text: string; status: number; ms: number } {
  const at = stdout.lastIndexOf('\n' + MARK)
  if (at < 0) return { text: stdout, status: 0, ms: 0 }
  const [code, secs] = stdout.slice(at + MARK.length + 1).trim().split(' ')
  return { text: stdout.slice(0, at), status: Number(code) || 0, ms: Math.round(Number(secs) * 1000) || 0 }
}

export function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

// ---- the viewer's tree ----

const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1')
export const END = '\u0000end'

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

export function buildLines(value: unknown, collapsed: ReadonlySet<string>, ignoreFolds = false): Line[] {
  const out: Line[] = []
  const walk = (v: unknown, key: string | number | null, path: string, depth: number, last: boolean) => {
    const indent: Seg = ['  '.repeat(depth), '']
    const keySegs: Seg[] = typeof key === 'string' ? [[JSON.stringify(key), 'k'], [': ', 'p']] : []
    const comma: Seg = [last ? '' : ',', 'p']
    if (v !== null && typeof v === 'object') {
      const isArr = Array.isArray(v)
      const entries: [string | number, unknown][] = isArr
        ? (v as unknown[]).map((x, i) => [i, x])
        : Object.entries(v as Record<string, unknown>)
      const [open, close] = isArr ? ['[', ']'] : ['{', '}']
      if (entries.length === 0) {
        out.push({ path, depth, fold: false, segs: [['  ', 'f'], indent, ...keySegs, [open + close, 'p'], comma] })
        return
      }
      if (!ignoreFolds && collapsed.has(path)) {
        const n = entries.length
        const what = isArr ? `${n} item${n === 1 ? '' : 's'}` : `${n} key${n === 1 ? '' : 's'}`
        out.push({
          path,
          depth,
          fold: true,
          segs: [['▸ ', 'f'], indent, ...keySegs, [open, 'p'], [` … ${what} `, 'm'], [close, 'p'], comma],
        })
        return
      }
      out.push({ path, depth, fold: true, segs: [['▾ ', 'f'], indent, ...keySegs, [open, 'p']] })
      entries.forEach(([k, x], i) =>
        walk(x, isArr ? null : (k as string), `${path}/${esc(String(k))}`, depth + 1, i === entries.length - 1),
      )
      out.push({ path: path + END, depth, fold: false, segs: [['  ', 'f'], indent, [close, 'p'], comma] })
      return
    }
    const [str, code] =
      typeof v === 'string' ? [JSON.stringify(v), 's'] : typeof v === 'number' ? [String(v), 'n'] : [String(v), 'b']
    out.push({ path, depth, fold: false, segs: [['  ', 'f'], indent, ...keySegs, [str, code], comma] })
  }
  walk(value, null, '', 0, true)
  return out
}

export function rawLines(text: string): Line[] {
  return text.split('\n').map((l, i) => ({ path: `#${i}`, depth: 0, fold: false, segs: [['  ', 'f'], [l, '']] }))
}

export function foldablePaths(value: unknown, minDepth = 1, maxDepth = Infinity): string[] {
  return buildLines(value, new Set(), true)
    .filter(l => l.fold && l.depth >= minDepth && l.depth <= maxDepth)
    .map(l => l.path)
}

export const lineText = (l: Line) => l.segs.slice(1).map(s => s[0]).join('')

// Lines (in fully expanded order) whose text holds the term, case-insensitive.
export function findMatches(all: Line[], term: string): string[] {
  if (!term) return []
  const t = term.toLowerCase()
  return all.filter(l => !l.path.endsWith(END) && lineText(l).toLowerCase().includes(t)).map(l => l.path)
}

export function ancestorsOpen(collapsed: string[], path: string): string[] {
  return collapsed.filter(c => !(path !== c && (c === '' || path.startsWith(c + '/'))))
}

// Splits segments so every occurrence of term carries the highlight code.
export function highlight(segs: Seg[], term: string, code: string): Seg[] {
  if (!term) return segs
  const t = term.toLowerCase()
  const [gutter, ...rest] = segs
  const full = rest.map(s => s[0]).join('')
  const lower = full.toLowerCase()
  const marks: boolean[] = new Array(full.length).fill(false)
  for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + 1)) for (let j = i; j < i + t.length; j++) marks[j] = true
  if (!marks.includes(true)) return segs
  const out: Seg[] = [gutter]
  let pos = 0
  for (const [s, c] of rest) {
    let buf = ''
    let bufHi = false
    for (let i = 0; i < s.length; i++, pos++) {
      const hi = marks[pos]
      if (buf && hi !== bufHi) {
        out.push([buf, bufHi ? code : c])
        buf = ''
      }
      buf += s[i]
      bufHi = hi
    }
    if (buf) out.push([buf, bufHi ? code : c])
  }
  return out
}

// ---- read-only guard ----

// POST endpoints that only read. Anything else that is not GET/HEAD is refused.
const READ_POSTS = [
  '_search', '_msearch', '_count', '_mget', '_explain', '_validate', '_field_caps', '_analyze',
  '_termvectors', '_mtermvectors', '_rank_eval', '_search/template', '_msearch/template',
  '_render/template', '_search/scroll', '_search_shards', 'point_in_time',
]

// Why the request is refused, or undefined when it only reads.
export function writeGuard(r: Pick<Request, 'method' | 'path'>): string | undefined {
  const p = r.path.split('?')[0]!.replace(/^\/+|\/+$/g, '')
  const parts = p.split('/')
  if (r.method === 'GET' || r.method === 'HEAD') return undefined
  if (r.method === 'DELETE' && /(^|\/)_search\/scroll(\/|$)/.test(p)) return undefined
  if (r.method === 'DELETE' && /(^|\/)_search\/point_in_time(\/|$)/.test(p)) return undefined
  if (r.method === 'POST') {
    const tail2 = parts.slice(-2).join('/')
    const tail1 = parts[parts.length - 1] ?? ''
    const scrollId = parts.length >= 3 && parts[parts.length - 3] === '_search' && parts[parts.length - 2] === 'scroll'
    if (READ_POSTS.includes(tail1) || READ_POSTS.includes(tail2) || scrollId) return undefined
    // `<index>/_explain/<id>`, `<index>/_termvectors/<id>`
    if (parts.length >= 2 && ['_explain', '_termvectors'].includes(parts[parts.length - 2]!)) return undefined
  }
  return `Read-only console: ${r.method} ${r.path || '/'} could write to the cluster, so it was not sent. Allowed: GET, HEAD, and POST to search/count/mget/explain/validate/field_caps/analyze/termvectors/templates/scroll.`
}

// `--filepath x.json --configfilepath y.json` (also `--file`, `--config`, `=` forms, quotes).
export function parseArgs(args: string): { file?: string; config?: string; rest: string[] } {
  const tokens = [...args.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)].map(m => m[0].replace(/"([^"]*)"|'([^']*)'/g, '$1$2'))
  const out: { file?: string; config?: string; rest: string[] } = { rest: [] }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    const m = /^--?(filepath|file|configfilepath|config)(?:=(.*))?$/.exec(t)
    if (!m) {
      out.rest.push(t)
      continue
    }
    const value = m[2] ?? tokens[++i] ?? ''
    if (m[1] === 'filepath' || m[1] === 'file') out.file = value
    else out.config = value
  }
  return out
}
