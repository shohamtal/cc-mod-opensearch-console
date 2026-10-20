import { expect, test } from 'claude-code/testing'

import { suggest, suggestFreeInit } from './editor'

const st = (line: string) => ({ lines: [line], row: 0, col: line.length, top: 0, rev: 0 })
const NAMES = ['products', 'products_v2', 'prod-reviews', 'reviews', '.kibana']
const items = (line: string) => suggest(st(line), NAMES)?.items

test('methods at the start of a request line', async () => {
  expect(items('PO')).toEqual(['POST'])
  expect(items('de')).toEqual(['DELETE'])
})

test('index names and endpoints on the path', async () => {
  expect(items('GET prod')).toEqual(['products', 'products_v2', 'prod-reviews'])
  expect(items('POST /reviews,prod')).toEqual(['products', 'products_v2', 'prod-reviews'])
  expect(items('GET rev')).toEqual(['reviews', 'prod-reviews'])
  expect(items('GET _c')!.slice(0, 4)).toEqual(['_count', '_cat', '_cluster', '_component_template'])
  expect(items('GET products/_se')!.slice(0, 3)).toEqual(['_search', '_settings', '_search_shards'])
  expect(items('GET _cat/in')![0]).toBe('indices')
  expect(items('GET _cluster/')![0]).toBe('health')
  expect(items('GET ')!.slice(0, 2)).toEqual(['products', 'products_v2'])
})

test('query parameters after ?', async () => {
  expect(items('GET _cat/indices?v&fo')).toEqual(['format=json'])
})

test('query DSL words inside a JSON key, nowhere else', async () => {
  expect(items('  "mu')!.slice(0, 3)).toEqual(['must', 'must_not', 'multi_match'])
  expect(items('{ "bo')).toEqual(['bool', 'boost'])
  expect(items('  "title": "mu')).toBeUndefined()
  expect(items('  "query": prod')).toBeUndefined()
})

test('an accepted suggestion stays hidden until the word changes', async () => {
  expect(suggest({ ...st('GET prod'), sugHide: '0:4:prod' }, NAMES)).toBeUndefined()
})

test('control characters never reach the drawing', async () => {
  const { lines } = suggestFreeInit('GET x\x1b[<0;141;4M\tz\r\n\x07ok')
  expect(lines).toEqual(['GET x[<0;141;4M  z', 'ok'])
})
