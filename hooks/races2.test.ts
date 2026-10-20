import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
const TOOL = 'mcp__opensearch-console__console'
const HOME = '/home/tester'
const BASE = `${HOME}/.claude/mods/opensearch`
const PANE = { plugin: 'opensearch-console', surface: 'terminal', component: 'Pane', requestId: 'opensearch', props: { title: 'OpenSearch', isFocused: true, bodyColumns: 110, placement: 'dock' }, viewport: { columns: 110, rows: 44 } } as any
function world(on: On, servers: unknown[]) {
  const files = new Map<string, string>([[`${BASE}/servers.json`, JSON.stringify({ servers })]])
  let tick = 1
  const mtimes = new Map<string, number>()
  mock.env(on, { HOME }); mock.store(on); mock.clock(on)
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => { if (!files.has(e.path)) throw new Error('ENOENT'); return { value: files.get(e.path)! } })
  on('fs.write', ($, e) => { files.set(e.path, e.text); mtimes.set(e.path, tick++); return { value: undefined } })
  on('fs.stat', ($, e) => { if (!files.has(e.path) && e.path !== BASE) throw new Error('ENOENT'); return { value: { kind: 'file', size: 1, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false, realPath: e.path } } })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.panes', () => ({ value: [] }) as any)
  const big = JSON.stringify(Array.from({ length: 80 }, (_, i) => i + 1000))
  on('process.run', () => ({ value: { exitCode: 0, stdout: big + '\n__OSCONSOLE__200 0.01', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any)
  return { files }
}
test('a click after the viewer grew (server menu open) lands on the line it was drawn on', async ($, on) => {
  world(on, [{ id: 'a', name: 'A', host: '10.0.0.1' }, { id: 'b', name: 'B', host: '10.0.0.2' }, { id: 'c', name: 'C', host: '10.0.0.3' }])
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 's1.json' } as any)
  const ui: any = await $.ui.mount(PANE)
  await ui.post({ type: 'run', text: 'GET x', row: 0 }, { in: 'editor' })
  await ui.post({ type: 'key', key: 'G' }, { in: 'viewer' })
  await ui.press({ key: 'server-menu' })
  const d1 = JSON.stringify(await ui.drawn())
  const firstShown = /"(10\d\d),?"/.exec(d1)?.[1]
  await ui.post({ type: 'click', y: 0, x: 3 }, { in: 'viewer' })
  const d2 = JSON.stringify(await ui.drawn())
  // Line 1 is "[", so value 1000 is line 2: the clicked first row must be where the cursor lands.
  expect(firstShown).toBeDefined()
  expect(/(\d+)\/82/.exec(d2)?.[1]).toBe(String(Number(firstShown) - 998))
})
