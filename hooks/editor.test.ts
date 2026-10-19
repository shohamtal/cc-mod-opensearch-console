import { expect, test } from 'claude-code/testing'

import { suggest } from './editor'

const st = (line: string) => ({ lines: [line], row: 0, col: line.length, top: 0, rev: 0 })
const NAMES = ['products', 'products_v2', 'prod-reviews', 'reviews', '.kibana']

test('suggests index names for the path being typed', async () => {
  expect(suggest(st('GET prod'), NAMES)?.items).toEqual(['products', 'products_v2', 'prod-reviews'])
  expect(suggest(st('POST /reviews,prod'), NAMES)?.items).toEqual(['products', 'products_v2', 'prod-reviews'])
  expect(suggest(st('GET rev'), NAMES)?.items).toEqual(['reviews', 'prod-reviews'])
  expect(suggest(st('GET products/_se'), NAMES)).toBeUndefined()
  expect(suggest(st('  "query": prod'), NAMES)).toBeUndefined()
  expect(suggest({ ...st('GET prod'), sugHide: '0:4:prod' }, NAMES)).toBeUndefined()
})
