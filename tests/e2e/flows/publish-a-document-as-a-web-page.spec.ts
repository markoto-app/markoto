import { test, expect } from '../fixtures/flow'

// "Publish a document as a web page".
//
// User-job: a writer wants a document readable by anyone at a clean,
// public address: without opening the document itself to the world.
// Job done when the page is published, its address is copied, a visitor
// in their own browser reads the page, and the document stays private.

test('Publish a document as a web page', async ({ page, flow, editor }) => {
  test.skip(editor.isMobile, 'publishing is set up at a desk')
  test.setTimeout(120_000)
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({
    title: 'Harbourline depot guide',
    body: '# Harbourline depot guide\n\nEverything drivers need for the three Harbourline depots.\n\n## Opening hours\n\n| Depot | Weekdays | Saturday |\n| --- | --- | --- |\n| North quay | 05:30–22:00 | 07:00–14:00 |\n| Rail yard | 06:00–20:00 | closed |\n| Airport | 24 h | 24 h |\n\n## Booking a slot\n\n1. Book at least two hours ahead.\n2. Bring the booking code; the gate reads it.\n3. Late by more than 30 minutes? The slot is released.\n\n> [!TIP]\n> The airport depot has the shortest queues before 07:00.\n',
    cover: false
  })
  const docUrl = page.url()
  const docId = new URL(docUrl).pathname.split('/').pop()!

  await flow.heading('Publish it', 3)
  await flow.narrate(
    'Publishing puts a copy of the document at its own public address. '
    + 'The document itself stays exactly as shared as before, here it is '
    + 'private. Publish again whenever you want the page to show your latest changes.'
  )
  await flow.click(
    'Open the share dialog',
    editor.page.accessLockButton,
    { chain: true, after: () => page.getByTestId('publish-panel').waitFor({ state: 'visible', timeout: 10_000 }) }
  )
  await page.getByTestId('publish-panel').scrollIntoViewIfNeeded()
  await flow.click(
    'Publish',
    page.getByTestId('publish-submit'),
    {
      chain: true,
      annotations: [{ label: 'Publish as a web page', selector: '[data-testid="publish-panel"]', kind: 'box' }],
      after: () => page.getByTestId('publish-url').waitFor({ state: 'visible', timeout: 30_000 })
    }
  )
  const url = await page.getByTestId('publish-url').inputValue()
  expect(url).toMatch(/\/p\/harbourline-depot-guide-[a-z0-9]{6}$/)
  await flow.click(
    'Copy the address',
    page.getByTestId('publish-copy'),
    { chain: true, after: () => expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url) }
  )
  await editor.page.dismissToasts()
  await flow.shot('The page is published at its own address', {
    highlights: [{ label: 'Public address', selector: '[data-testid="publish-url"]' }]
  })
  await page.keyboard.press('Escape')

  // The reader
  await flow.heading('What readers see', 3)
  const reader = await flow.spawn('reader')
  await reader.page.goto(url)
  await reader.page.getByRole('heading', { name: 'Harbourline depot guide' }).waitFor({ state: 'visible', timeout: 15_000 })
  await expect(reader.page.getByText('The airport depot has the shortest queues')).toBeVisible()
  await reader.flow.shot('Anyone with the address reads the page, no account, no editor', {
    hero: true,
    addressBar: new URL(url).pathname
  })
  // The document itself is still private.
  const token = await (await reader.page.request.get(`/api/docs/${docId}/token`)).json() as { token: string | null }
  expect(token.token).toBeNull()

  flow.next({ slug: 'limit-a-share-link', why: 'Share the document itself, view only and with an end date.' })
})
