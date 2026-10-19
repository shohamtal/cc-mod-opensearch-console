import { describe, expect, test } from 'claude-code/testing'

import {
  ancestorsOpen, buildLines, curlConfig, findMatches, foldablePaths, formatAt, highlight,
  lineText, parseCurlOutput, parseRequests, requestAt, requestBody, writeGuard, parseArgs,
} from './lib'

const CONSOLE = `GET _cluster/health

POST idx/_search
{"query":{"match":{"title":"shoe"}}}

POST _bulk
{"index":{"_index":"a"}}
{"x":1}
`

describe('requests', () => {
  test('splits the console into requests and picks the one under the cursor', async () => {
    const all = parseRequests(CONSOLE)
    expect(all.map(r => `${r.method} ${r.path}`)).toEqual(['GET _cluster/health', 'POST idx/_search', 'POST _bulk'])
    expect(requestAt(CONSOLE, 3)?.path).toBe('idx/_search')
    expect(requestAt(CONSOLE, 0)?.path).toBe('_cluster/health')
  })

  test('bulk bodies go as ndjson, search bodies as compact json', async () => {
    const [, search, bulk] = parseRequests(CONSOLE)
    expect(requestBody(search!).body).toBe('{"query":{"match":{"title":"shoe"}}}')
    expect(requestBody(bulk!)).toEqual({ body: '{"index":{"_index":"a"}}\n{"x":1}\n', contentType: 'application/x-ndjson' })
  })

  test('format pretty-prints the body under the cursor only', async () => {
    const out = formatAt(CONSOLE, 2)
    expect(out).toContain('POST idx/_search\n{\n  "query": {')
    expect(out).toContain('POST _bulk\n{"index":{"_index":"a"}}')
  })

  test('curl config carries creds and body, and its output parses', async () => {
    const cfg = curlConfig({ name: 'stg', url: 'https://h:9200/', username: 'u', password: 'p"w', insecure: true }, parseRequests(CONSOLE)[1]!)
    expect(cfg).toContain('url = "https://h:9200/idx/_search"')
    expect(cfg).toContain('user = "u:p\\"w"')
    expect(cfg).toContain('insecure')
    expect(parseCurlOutput('{"a":1}\n__OSCONSOLE__200 0.034')).toEqual({ text: '{"a":1}', status: 200, ms: 34 })
  })
})

describe('viewer tree', () => {
  const value = { took: 3, hits: { total: { value: 2 }, hits: [{ _id: 'a', _source: { title: 'Red shoe' } }, { _id: 'b' }] } }

  test('collapses a node into a summary line', async () => {
    const open = buildLines(value, new Set())
    const shut = buildLines(value, new Set(['/hits/hits']))
    expect(shut.length).toBeLessThan(open.length)
    expect(shut.map(lineText).join('\n')).toContain('"hits": [ … 2 items ]')
  })

  test('collapse all keeps the root open, depth folds deeper levels', async () => {
    expect(foldablePaths(value, 1)).toEqual(['/hits', '/hits/total', '/hits/hits', '/hits/hits/0', '/hits/hits/0/_source', '/hits/hits/1'])
    expect(buildLines(value, new Set(foldablePaths(value, 1))).length).toBe(4)
  })

  test('search finds hidden lines and opens their ancestors', async () => {
    const all = buildLines(value, new Set(), true)
    const paths = findMatches(all, 'red SHOE')
    expect(paths).toEqual(['/hits/hits/0/_source/title'])
    expect(ancestorsOpen(['/hits', '/hits/hits/0', '/took'], paths[0]!)).toEqual(['/took'])
  })

  test('highlight splits segments around each match', async () => {
    const segs = highlight([['  ', 'f'], ['"title"', 'k'], [': ', 'p'], ['"Red shoe"', 's']], 'shoe', 'H')
    expect(segs).toContainEqual(['shoe', 'H'])
    expect(segs.map(s => s[0]).join('')).toBe('  "title": "Red shoe"')
  })
})

describe('write guard', () => {
  test('lets reads through', async () => {
    for (const [method, path] of [
      ['GET', 'idx/_doc/1'], ['GET', '_cat/indices?v'], ['POST', 'idx/_search'], ['POST', '/idx,b/_count?x=1'],
      ['POST', '_msearch'], ['POST', '_search/scroll'], ['DELETE', '_search/scroll'], ['POST', 'idx/_explain/7'],
      ['HEAD', 'idx'], ['POST', 'idx/_search/template'],
    ]) expect(writeGuard({ method: method!, path: path! })).toBeUndefined()
  })
  test('refuses writes', async () => {
    for (const [method, path] of [
      ['PUT', 'idx'], ['DELETE', 'idx'], ['POST', '_bulk'], ['POST', 'idx/_doc'], ['POST', 'idx/_update/1'],
      ['POST', 'idx/_delete_by_query'], ['POST', 'idx/_update_by_query'], ['POST', '_reindex'], ['PATCH', 'x'],
      ['POST', 'idx/_close'], ['POST', 'idx/_forcemerge'], ['POST', '_aliases'], ['POST', 'idx/_search/../_bulk'],
    ]) expect(writeGuard({ method: method!, path: path! })).toBeDefined()
  })
})

test('parses /opensearch arguments', async () => {
  expect(parseArgs('--filepath s1.json --configfilepath ~/c.json')).toEqual({ file: 's1.json', config: '~/c.json', rest: [] })
  expect(parseArgs('--file="my session.json"')).toEqual({ file: 'my session.json', rest: [] })
  expect(parseArgs('')).toEqual({ rest: [] })
})
