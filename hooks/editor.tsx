// Surface module: the query editor. Keeps its text locally and posts every
// change to the hooks module; a new `rev` in props replaces the text.
import type { ClientModule, ClientKeyEvent } from 'claude-code'

type Props = { text: string; rev: number; height: number; row: number; paste?: { id: number; text: string }; indices?: string[]; scroll?: { id: number; by: number } }
type Pos = { row: number; col: number }
type State = { lines: string[]; row: number; col: number; top: number; rev: number; anchor?: Pos; pasteId?: number; dragging?: boolean; sugSel?: number; sugHide?: string; scrollId?: number }

const COLORS: Record<string, { color?: string; bold?: boolean; dimColor?: boolean }> = {
  method: { color: '#4ec9b0', bold: true },
  url: { color: '#dcdcaa' },
  k: { color: '#9cdcfe' },
  s: { color: '#ce9178' },
  n: { color: '#b5cea8' },
  b: { color: '#569cd6' },
  p: { dimColor: true },
  c: { color: '#6a9955' },
  '': {},
}

const METHOD = /^(\s*)(GET|POST|PUT|DELETE|HEAD|PATCH)(\s+)(.*)$/i
const SPECIAL = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'pageup', 'pagedown',
  'home', 'end', 'escape', 'space',
])

function lex(line: string): [string, string][] {
  const m = METHOD.exec(line)
  if (m) return [[m[1], ''], [m[2], 'method'], [m[3], ''], [m[4], 'url']]
  const out: [string, string][] = []
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '"') {
      let j = i + 1
      while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1
      j = Math.min(j + 1, line.length)
      const rest = line.slice(j).trimStart()
      out.push([line.slice(i, j), rest.startsWith(':') ? 'k' : 's'])
      i = j
    } else if (c === '#' || (c === '/' && line[i + 1] === '/')) {
      out.push([line.slice(i), 'c'])
      break
    } else if (/[-0-9]/.test(c)) {
      const m2 = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(line.slice(i))
      const t = m2 ? m2[0] : c
      out.push([t, m2 ? 'n' : ''])
      i += t.length
    } else if (/[a-z]/i.test(c)) {
      const t = /^[a-z_]+/i.exec(line.slice(i))![0]
      out.push([t, /^(true|false|null)$/.test(t) ? 'b' : ''])
      i += t.length
    } else if ('{}[],:'.includes(c)) {
      out.push([c, 'p'])
      i++
    } else {
      let j = i
      while (j < line.length && !/["#/a-z0-9{}[\],:-]/i.test(line[j])) j++
      if (j === i) j = i + 1
      out.push([line.slice(i, j), ''])
      i = j
    }
  }
  return out
}

const init = (p: Props): State => {
  const lines = p.text.split('\n')
  const row = Math.min(Math.max(0, p.row), lines.length - 1)
  return { lines, row, col: 0, top: Math.max(0, row - 2), rev: p.rev, pasteId: p.paste?.id, scrollId: p.scroll?.id }
}

const before = (a: Pos, b: Pos) => a.row < b.row || (a.row === b.row && a.col < b.col)

// The selection as [start, end), or undefined when nothing is selected.
const range = (s: State): [Pos, Pos] | undefined => {
  if (!s.anchor) return undefined
  const cur = { row: s.row, col: s.col }
  if (s.anchor.row === cur.row && s.anchor.col === cur.col) return undefined
  return before(s.anchor, cur) ? [s.anchor, cur] : [cur, s.anchor]
}

const selectedText = (s: State): string => {
  const r = range(s)
  if (!r) return ''
  const [a, b] = r
  if (a.row === b.row) return s.lines[a.row].slice(a.col, b.col)
  return [s.lines[a.row].slice(a.col), ...s.lines.slice(a.row + 1, b.row), s.lines[b.row].slice(0, b.col)].join('\n')
}

const deleteSelection = (s: State): State => {
  const r = range(s)
  if (!r) return { ...s, anchor: undefined }
  const [a, b] = r
  const lines = [...s.lines]
  lines.splice(a.row, b.row - a.row + 1, lines[a.row].slice(0, a.col) + lines[b.row].slice(b.col))
  return { ...s, lines, row: a.row, col: a.col, anchor: undefined }
}

const insert = (s0: State, text: string): State => {
  const s = deleteSelection(s0)
  const lines = [...s.lines]
  const cur = lines[s.row]
  const parts = text.replace(/\r\n?/g, '\n').split('\n')
  const head = cur.slice(0, s.col)
  const tail = cur.slice(s.col)
  if (parts.length === 1) {
    lines[s.row] = head + parts[0] + tail
    return { ...s, lines, col: s.col + parts[0].length }
  }
  const last = parts[parts.length - 1]
  lines.splice(s.row, 1, head + parts[0], ...parts.slice(1, -1), last + tail)
  return { ...s, lines, row: s.row + parts.length - 1, col: last.length }
}

type Suggest = { start: number; prefix: string; items: string[]; id: string }

// Index names for the path being typed on a request line: `GET logs-2|`, `POST a,b|/_search`.
export const suggest = (s: State, names: readonly string[]): Suggest | undefined => {
  if (!names.length || s.anchor) return undefined
  const head = s.lines[s.row].slice(0, s.col)
  const m = /^(\s*(?:GET|POST|PUT|DELETE|HEAD|PATCH)\s+\/?(?:[^\s/?,]*,)*)([^\s/?,]+)$/i.exec(head)
  if (!m) return undefined
  const prefix = m[2]!
  const low = prefix.toLowerCase()
  const starts = names.filter(n => n.toLowerCase().startsWith(low) && n !== prefix)
  const inside = names.filter(n => !n.toLowerCase().startsWith(low) && n.toLowerCase().includes(low))
  const items = [...starts, ...inside].slice(0, 8)
  if (!items.length) return undefined
  const id = `${s.row}:${m[1]!.length}:${prefix}`
  if (s.sugHide === id) return undefined
  return { start: m[1]!.length, prefix, items, id }
}

const Editor: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let st: State = surface.state && surface.state.rev === props.rev ? surface.state : init(props)
  const height = Math.max(1, props.height)
  const gutter = String(st.lines.length).length + 3

  const commit = (next: State, type = 'edit') => {
    if (type === 'edit' && next.sugSel === st.sugSel) next.sugSel = 0
    if (next.row < next.top) next.top = next.row
    if (next.row >= next.top + height) next.top = next.row - height + 1
    surface.setState(next)
    surface.post({ type, text: next.lines.join('\n'), row: next.row })
  }

  // A wheel tick the hooks module heard over the editor moves the window, not the cursor.
  if (props.scroll && props.scroll.id !== st.scrollId) {
    const maxTop = Math.max(0, st.lines.length - height)
    st = { ...st, top: Math.max(0, Math.min(maxTop, st.top + props.scroll.by)), scrollId: props.scroll.id }
    surface.setState(st)
  }

  // A paste the hooks module read from the clipboard (ctrl+v) lands once.
  if (props.paste && props.paste.id !== st.pasteId) {
    st = { ...insert(st, props.paste.text), pasteId: props.paste.id }
    commit(st)
  }

  surface.onKey((k: ClientKeyEvent) => {
    const s: State = st
    const sug = suggest(s, props.indices ?? [])
    if (sug && !k.ctrl && !k.meta && !k.shift) {
      const sel = Math.min(s.sugSel ?? 0, sug.items.length - 1)
      if (k.key === 'down' || k.key === 'up') {
        const n = (sel + (k.key === 'down' ? 1 : -1) + sug.items.length) % sug.items.length
        surface.setState({ ...s, sugSel: n })
        return
      }
      if (k.key === 'tab' || k.key === 'return' || k.key === 'enter') {
        const pick = sug.items[sel]!
        const lines = [...s.lines]
        const l = lines[s.row]!
        lines[s.row] = l.slice(0, sug.start) + pick + l.slice(s.col)
        const col = sug.start + pick.length
        return commit({ ...s, lines, col, sugSel: 0, sugHide: `${s.row}:${sug.start}:${pick}` })
      }
    }
    const line = s.lines[s.row]
    const key = k.key
    const text = () => s.lines.join('\n')
    if ((k.ctrl && (key === 'return' || key === 'enter' || key === 'r')) || (k.meta && key === 'return')) {
      surface.post({ type: 'run', text: text(), row: s.row })
      return
    }
    if ((k.ctrl || k.meta) && key === 'l') return surface.post({ type: 'format', text: text(), row: s.row })
    if ((k.ctrl || k.meta) && key === 'a') {
      const last = s.lines.length - 1
      return commit({ ...s, anchor: { row: 0, col: 0 }, row: last, col: s.lines[last].length }, 'cursor')
    }
    if ((k.ctrl || k.meta) && (key === 'c' || key === 'x')) {
      const sel = selectedText(s) || line
      surface.post({ type: 'copy', copy: sel, text: text(), row: s.row })
      if (key === 'x') {
        if (range(s)) return commit(deleteSelection(s))
        const lines = [...s.lines]
        lines.splice(s.row, 1)
        if (!lines.length) lines.push('')
        const row = Math.min(s.row, lines.length - 1)
        return commit({ ...s, lines, row, col: 0, anchor: undefined })
      }
      return
    }
    if ((k.ctrl || k.meta) && key === 'v') return surface.post({ type: 'paste', text: text(), row: s.row })

    // Movement; shift extends the selection from where it started.
    const move = (to: Pos) =>
      commit({ ...s, ...to, anchor: k.shift ? (s.anchor ?? { row: s.row, col: s.col }) : undefined }, 'cursor')
    const clamp = (row: number) => Math.min(s.col, s.lines[row].length)
    switch (key) {
      case 'up': { const row = Math.max(0, s.row - 1); return move({ row, col: clamp(row) }) }
      case 'down': { const row = Math.min(s.lines.length - 1, s.row + 1); return move({ row, col: clamp(row) }) }
      case 'pageup': { const row = Math.max(0, s.row - height); return move({ row, col: clamp(row) }) }
      case 'pagedown': { const row = Math.min(s.lines.length - 1, s.row + height); return move({ row, col: clamp(row) }) }
      case 'left': {
        const r = range(s)
        if (r && !k.shift) return move(r[0])
        if (s.col > 0) return move({ row: s.row, col: s.col - 1 })
        if (s.row > 0) return move({ row: s.row - 1, col: s.lines[s.row - 1].length })
        return move({ row: 0, col: 0 })
      }
      case 'right': {
        const r = range(s)
        if (r && !k.shift) return move(r[1])
        if (s.col < line.length) return move({ row: s.row, col: s.col + 1 })
        if (s.row < s.lines.length - 1) return move({ row: s.row + 1, col: 0 })
        return move({ row: s.row, col: s.col })
      }
      case 'home': return move({ row: s.row, col: 0 })
      case 'end': return move({ row: s.row, col: line.length })
      case 'tab': return commit(insert(s, '  '))
      case 'space': return commit(insert(s, ' '))
      case 'return':
      case 'enter': {
        const base = deleteSelection(s)
        const l = base.lines[base.row]
        const indent = /^\s*/.exec(l)![0]
        const prev = l.slice(0, base.col).trimEnd()
        const next = l.slice(base.col).trimStart()
        const opens = prev.endsWith('{') || prev.endsWith('[')
        const closes = next.startsWith('}') || next.startsWith(']')
        if (opens && closes) {
          const inner = indent + '  '
          const n = insert(base, '\n' + inner + '\n' + indent)
          return commit({ ...n, row: n.row - 1, col: inner.length })
        }
        return commit(insert(base, '\n' + indent + (opens ? '  ' : '')))
      }
      case 'backspace': {
        if (range(s)) return commit(deleteSelection(s))
        const lines = [...s.lines]
        if (s.col > 0) {
          const back = /^ +$/.test(line.slice(0, s.col)) && s.col % 2 === 0 ? 2 : 1
          lines[s.row] = line.slice(0, s.col - back) + line.slice(s.col)
          return commit({ ...s, lines, col: s.col - back, anchor: undefined })
        }
        if (s.row === 0) return
        const col = lines[s.row - 1].length
        lines.splice(s.row - 1, 2, lines[s.row - 1] + line)
        return commit({ ...s, lines, row: s.row - 1, col, anchor: undefined })
      }
      case 'delete': {
        if (range(s)) return commit(deleteSelection(s))
        const lines = [...s.lines]
        if (s.col < line.length) lines[s.row] = line.slice(0, s.col) + line.slice(s.col + 1)
        else if (s.row < lines.length - 1) lines.splice(s.row, 2, line + lines[s.row + 1])
        else return
        return commit({ ...s, lines, anchor: undefined })
      }
    }
    if (k.ctrl) {
      if (key === 'e') return move({ row: s.row, col: line.length })
      if (key === 'k') {
        const lines = [...s.lines]
        lines[s.row] = line.slice(0, s.col)
        return commit({ ...s, lines, anchor: undefined })
      }
      return
    }
    if (k.meta || SPECIAL.has(key)) return
    // A character, or a paste arriving as one run of text.
    const typed = key
    const pairs: Record<string, string> = { '{': '}', '[': ']', '"': '"' }
    if (!range(s) && typed.length === 1 && pairs[typed] && (s.col === line.length || /[\s,\]}]/.test(line[s.col]))) {
      if (!(typed === '"' && line[s.col] === '"')) {
        const n = insert(s, typed + pairs[typed])
        return commit({ ...n, col: n.col - 1 })
      }
    }
    if (!range(s) && typed.length === 1 && (typed === '}' || typed === ']' || typed === '"') && line[s.col] === typed) {
      return commit({ ...s, col: s.col + 1 }, 'cursor')
    }
    return commit(insert(s, typed))
  })

  surface.onPointer(ev => {
    const toPos = (): Pos => {
      const row = Math.max(0, Math.min(st.lines.length - 1, st.top + ev.y))
      return { row, col: Math.min(Math.max(0, ev.x - gutter), st.lines[row].length) }
    }
    if (ev.type === 'down' && ev.button === 'left') {
      const row = st.top + ev.y
      if (row < st.lines.length && ev.x < gutter - 1 && METHOD.test(st.lines[row])) {
        surface.post({ type: 'run', text: st.lines.join('\n'), row })
        return
      }
      const pos = toPos()
      const anchor = ev.shift ? (st.anchor ?? { row: st.row, col: st.col }) : pos
      commit({ ...st, ...pos, anchor, dragging: true }, 'cursor')
    } else if (ev.type === 'move' && st.dragging && ev.button === 'left') {
      const pos = toPos()
      if (pos.row !== st.row || pos.col !== st.col) commit({ ...st, ...pos }, 'cursor')
    } else if (ev.type === 'up' && st.dragging) {
      commit({ ...st, ...toPos(), dragging: false }, 'cursor')
    }
  })

  const sel = range(st)
  const isSel = (r: number, c: number) =>
    !!sel && !before({ row: r, col: c }, sel[0]) && before({ row: r, col: c }, sel[1])

  const rows = []
  for (let r = st.top; r < Math.min(st.lines.length, st.top + height); r++) {
    const text = st.lines[r]
    const isReq = METHOD.test(text)
    const num = String(r + 1).padStart(gutter - 3)
    const parts = []
    let pos = 0
    for (const [t, c] of lex(text)) {
      const style = COLORS[c] ?? {}
      // Split the token where cursor or selection changes the look.
      let buf = ''
      let look = ''
      const flush = () => {
        if (!buf) return
        parts.push(
          <Text {...style} inverse={look === 'cur' ? true : undefined} backgroundColor={look === 'sel' ? '#264f78' : undefined}>
            {buf}
          </Text>,
        )
        buf = ''
      }
      for (let i = 0; i < t.length; i++) {
        const col = pos + i
        const l = r === st.row && col === st.col ? 'cur' : isSel(r, col) ? 'sel' : ''
        if (l !== look) {
          flush()
          look = l
        }
        buf += t[i]
      }
      flush()
      pos += t.length
    }
    if (r === st.row && st.col >= text.length) parts.push(<Text inverse> </Text>)
    else if (sel && isSel(r, text.length)) parts.push(<Text backgroundColor="#264f78"> </Text>)
    rows.push(
      <Box flexDirection="row" height={1}>
        <Text color={isReq ? '#4ec9b0' : undefined} dimColor={!isReq}>
          {isReq ? '▶' : ' '}
          {num}{' '}
        </Text>
        <Text wrap="truncate-end">{parts}</Text>
      </Box>,
    )
  }
  const sug = suggest(st, props.indices ?? [])
  let popup = null
  if (sug) {
    const sel = Math.min(st.sugSel ?? 0, sug.items.length - 1)
    const width = Math.min(60, Math.max(...sug.items.map(i => i.length)) + 4)
    const y = st.row - st.top
    const below = y + 1 + sug.items.length + 2 <= height
    popup = (
      <Box
        position="absolute"
        top={below ? y + 1 : Math.max(0, y - sug.items.length - 2)}
        left={gutter + sug.start}
        width={width}
        flexDirection="column"
        borderStyle="round"
        borderColor="#4ec9b0"
        backgroundColor="#1e1e1e"
      >
        {sug.items.map((item, i) => (
          <Text wrap="truncate-end" inverse={i === sel ? true : undefined} color={i === sel ? undefined : '#dcdcaa'}>
            {item}
          </Text>
        ))}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" height={height}>
      {rows}
      {popup}
    </Box>
  )
}

export default Editor
