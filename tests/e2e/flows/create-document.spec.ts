import { test } from '../fixtures/flow'

// Anonymous user creates a doc, switches to a useful view mode, names
// it, sees the status bar update. Doc creation IS the story here, so
// we record the canonical preamble (homepage → click → mount → split)
// and add the title-rename + status-bar tail.
//
// For flows where the editor is just setup (e.g. "Insert a table"),
// use editor.silentSetup() instead and skip the preamble entries.

test('Create a new document', async ({ flow, editor }) => {
  // Records: heading + narrate + 4 step shots (homepage / click /
  // editor mounted / split-view toggle).
  await editor.recordPreamble()

  await flow.heading('Renaming the document', 3)
  await flow.narrate(
    'The title sits in the top-left header. Clicking it swaps the '
    + 'display for an inline text input, focuses it, and selects all — '
    + 'so you can start typing immediately.'
  )

  await flow.step('Click the "Untitled" label to start renaming', () =>
    editor.page.startTitleEdit()
  )

  await flow.step('Type your new title and press Enter to save', () =>
    editor.page.commitTitleEdit('My first doc')
  )

  await flow.shot('The new title is saved — no save button needed')

  await flow.heading('The status bar', 3)
  await flow.narrate(
    'The footer always shows live word + character counts on the left, '
    + 'and the sync state on the right. Watching "Synced" appear is how '
    + 'you know your edits made it to the server.'
  )

  await flow.shot('Two things to watch in the status bar', {
    highlights: [
      { label: 'Word + char count', selector: '[data-testid="word-count"]' },
      { label: 'Sync status', selector: '[data-testid="sync-status"]' }
    ]
  })
})
