import { expect, test } from 'claude-code/testing'

test('the pane draws on the terminal', async $ => {
  const ui = await $.ui.mount({
    plugin: 'opensearch-console',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'opensearch',
    props: { title: 'OpenSearch', isFocused: true, bodyColumns: 100, placement: 'dock' } as any,
    viewport: { columns: 100, rows: 40 } as any,
  })
  expect(await ui.find({ key: 'format' })).toBeDefined()
  expect(await ui.find({ key: 'run' })).toBeUndefined()
})
