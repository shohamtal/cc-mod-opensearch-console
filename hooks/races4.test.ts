import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
const TOOL = 'mcp__opensearch-console__console'
const HOME = '/home/tester'
const BASE = `${HOME}/.claude/mods/opensearch`
const PANE = { plugin: 'opensearch-console', surface: 'terminal', component: 'Pane', requestId: 'opensearch', props: { title: 'OpenSearch', isFocused: true, bodyColumns: 110, placement: 'dock' }, viewport: { columns: 110, rows: 44 } } as any
function world(on: On, seed: Record<string, string> = {}, failWrite?: RegExp) {
  const files = new Map<string, string>([[`${BASE}/servers.json`, JSON.stringify({ servers: [{ id: 'a', name: 'A', host: '10.0.0.1' }] })], ...Object.entries(seed)])
  let tick = 1
  const mtimes = new Map<string, number>()
  mock.env(on, { HOME }); mock.store(on); mock.clock(on)
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => { if (!files.has(e.path)) throw new Error('ENOENT'); return { value: files.get(e.path)! } })
  on('fs.write', ($, e) => { if (failWrite?.test(e.path)) throw new Error('EACCES'); files.set(e.path, e.text); mtimes.set(e.path, tick++); return { value: undefined } })
  on('fs.stat', ($, e) => { if (!files.has(e.path) && e.path !== BASE) throw new Error('ENOENT'); return { value: { kind: 'file', size: 1, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false, realPath: e.path } } })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.panes', () => ({ value: [] }) as any)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{"ok":1}\n__OSCONSOLE__200 0.01', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any)
  return { files }
}
test("a console can't be named after another console's run or response file", async ($, on) => {
  const w = world(on, { [`${BASE}/sessions/x.run.json`]: JSON.stringify({ query: 'GET precious' }) })
  for (const filepath of ['x.run.json', 'x.response', 'x.Run.json']) {
    const out: any = await $.tool.call({ tool: TOOL, action: 'status', filepath } as any)
    expect(out.isError).toBe(true)
  }
  expect(JSON.parse(w.files.get(`${BASE}/sessions/x.run.json`)!).query).toBe('GET precious')
})
test("the agent tool can't put a console outside the mod's sessions folder", async ($, on) => {
  const w = world(on)
  for (const filepath of ['/work/repo/conf.json', '../servers.json', `${BASE}/other.json`]) {
    const out: any = await $.tool.call({ tool: TOOL, action: 'status', filepath } as any)
    expect(out.isError).toBe(true)
  }
  expect([...w.files.keys()].filter(k => !k.startsWith(`${BASE}/`))).toEqual([])
  const ok: any = await $.tool.call({ tool: TOOL, action: 'status', filepath: 'mine.json' } as any)
  expect(ok.isError).toBeFalsy()
})
test('a run file that cannot be written still keeps the response', async ($, on) => {
  const w = world(on, {}, /\.run\.json$/)
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 's1.json' } as any)
  const ui: any = await $.ui.mount(PANE)
  await ui.post({ type: 'run', text: 'GET x', row: 0 }, { in: 'editor' })
  expect(w.files.get(`${BASE}/sessions/s1.response.json`)).toContain('"ok"')
})
test('a console from before 0.3.0 still shows its status line from lastRun', async ($, on) => {
  const at = '2026-10-01T00:00:00.000Z'
  world(on, {
    [`${BASE}/sessions/old.json`]: JSON.stringify({ server: 'a', cursorRow: 0, query: 'GET x', lastRun: { server: 'A', method: 'GET', path: 'x', status: 200, ms: 7, at } }),
    [`${BASE}/sessions/old.response.json`]: '{"ok":1}',
  })
  await $.tool.call({ tool: TOOL, action: 'status', filepath: 'old.json' } as any)
  const ui: any = await $.ui.mount(PANE)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('200')
  expect(drawn).not.toContain('ERR')
})
