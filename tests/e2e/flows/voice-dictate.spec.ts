import { test, expect } from '../fixtures/flow'

// Tier 2: "Speak instead of typing".
//
// User-job: a writer wants to draft a paragraph hands-free — phone in
// kitchen, mid-walk, post-meeting. Job done when the mic is on, words
// stream into the editor as they're spoken, and stopping the mic
// commits the latest finalized transcript.
//
// Pipeline: toolbar mic → `useVoiceDictation` → MediaRecorder + audio
// worklet → WebSocket `/api/ai/dictate` → Mistral Voxtral Realtime
// `streamingRecognize` → interim partials render as ghost text at the
// caret, finals commit to Y.js with origin `dictation:{userId}`.
//
// Mock-driven test: the prod test stack runs with TEST_MODE=1 +
// NUXT_GOOGLE_SPEECH_MOCK=1 (set in scripts/flows-ephemeral.ts; env
// var name carried over from pre-Phase-5 Cloud STT mock). The fake
// SpeechClient (`server/utils/agentic/dictateSpeechClient.ts`) counts
// incoming audio chunks and emits canned interim/final responses at
// fixed thresholds — the real Voxtral Realtime API is never called. The audio chunks come from Chromium's
// `--use-fake-device-for-media-stream` (synthetic 16 kHz tone),
// armed in playwright.config.ts. Combined: the test exercises every
// real layer (mic → worklet → WS → STT abstraction → CM6 ghost text
// → Y.js commit) without touching the network.
//
// Auth required: dictation needs a logged-in user (the JWT in the
// first WS message is minted via `POST /api/ai/dictate/token`, which
// requires a session). Login via the TEST_MODE shim before
// silentSetup.
//
// Mobile NOT skipped — the toolbar mic survives the wrap to mobile,
// and the bottom tab bar surfaces the same toggle. Captions cover
// both surfaces.
// The fake recognizer's two final sentences (dictateSpeechClient.ts).
const FIRST_SENTENCE = 'Lena says the new templates save her about an hour a week.'
const SECOND_SENTENCE = 'The export still feels slow on long reports.'

test('Speak instead of typing', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Dictation auth requires a session; the test-mode login shim is
  // the same path the AI flows use.
  await editor.page.loginAsTestUser('Maya Chen')
  // A short draft and no cover, so the dictated sentences land near the
  // top of both the editor and the preview.
  await editor.silentSetup({
    title: 'Interview notes',
    body: '# Interview notes\n\n## Lena Park, product designer\n\nThirty-minute call about the new release.',
    cover: false
  })

  // Move the caret to the end of the draft so dictation
  // appends rather than overwriting. The CM6 keyboard shortcut works
  // even on mobile because the editor surface accepts focus before
  // the mobile tab bar gets in the way.
  await page.locator('.cm-content').click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')

  // ─── Open the mic ───────────────────────────────────────────────
  await flow.heading('Speak instead of typing', 3)
  await flow.narrate(
    'Click the mic in the toolbar (or the Dictate tab on mobile) and '
    + 'markoto writes what you say into the document, at the cursor, '
    + 'while you speak.'
  )

  // The dictate mic — the toolbar surfaces it on desktop AND mobile
  // (the toolbar wraps; the button stays visible). Direction-anchor
  // the mic since it sits among ~10 other formatting buttons and
  // first-time readers wouldn't know to look there.
  const micButton = editor.isMobile
    ? editor.page.dictateMobileTab
    : editor.page.dictateMicButton

  await flow.click(
    'Click the mic to start dictating',
    micButton,
    {
      annotations: editor.isMobile
        ? [{ label: 'mic tab', selector: '[data-testid="mobile-tab-dictate"]', kind: 'arrow' }]
        : [{ label: 'mic', selector: 'button[aria-label*="dictation" i]', kind: 'arrow' }],
      result: 'The mic lights up red — markoto is listening.',
      after: async () => {
        // Wait for the button to flip into its "recording" visual
        // state. The `animate-pulse` class is added when the
        // dictation state is `recording`. The button reflects state
        // via aria-label too — switching from "Start dictation" to
        // "Stop dictation".
        await expect(micButton).toHaveAttribute('aria-label', /stop dictation/i, { timeout: 15_000 })
      }
    }
  )

  // ─── Watch the words stream in ──────────────────────────────────
  await flow.heading('The words land in the doc', 3)
  await flow.narrate(
    'The words appear as faint text at the cursor first; once a '
    + 'sentence is recognised, it becomes regular text in the document. '
    + 'Your collaborators see it arrive live, and undo removes it like '
    + 'anything you typed.'
  )

  // The mock STT's chunk-counted sequence (dictateSpeechClient.ts
  // MOCK_SEQUENCE) finalises two sentences within ~6 audio chunks
  // (~128 ms each). Wait for the second one to be committed, then
  // bring it into view (clear of the prompt bar).
  await expect(page.locator('.cm-content')).toContainText(FIRST_SENTENCE, { timeout: 20_000 })
  await expect(page.locator('.cm-content')).toContainText(SECOND_SENTENCE, { timeout: 20_000 })
  await editor.page.scrollEditorTo('The export still feels slow')

  await flow.shot(
    'What you said is now part of the document, just like typed text.',
    {
      hero: true,
      highlights: [
        { label: 'dictated text', selector: '.cm-content' }
      ]
    }
  )

  // ─── Stop the mic ───────────────────────────────────────────────
  await flow.heading('Stop the mic when you\'re done', 3)
  await flow.narrate(
    'Click the mic again to stop. The last words you said are written '
    + 'in, and the editor is back to keyboard-only input. Your browser '
    + 'remembers the mic permission, so starting again needs no new prompt.'
  )

  await flow.click(
    'Click the mic again to stop',
    micButton,
    {
      result: 'The mic returns to its idle state — no more streaming.',
      after: async () => {
        // Back to the idle aria-label.
        await expect(micButton).toHaveAttribute('aria-label', /start dictation|dictate$/i, { timeout: 10_000 })
      }
    }
  )

  // ASSERTION: the dictated phrase landed in the markdown source
  // (not just rendered as ghost text). `.cm-content` reads the
  // committed Y.js text, not the interim widget.
  const text = await editor.page.docText()
  expect(text).toContain(FIRST_SENTENCE)
  expect(text).toContain(SECOND_SENTENCE)

  // Forward route: voice in is the entry-level "let me write
  // hands-free" feature; voice INTO the AI prompt bar is the next
  // step (different surface, same Mistral upstream but the one-shot
  // /api/ai/transcribe path → Voxtral Mini Transcribe instead of the
  // streaming Voxtral Realtime one).
  flow.next({
    slug: 'write-with-ai',
    why: 'Now ask the AI to extend what you dictated — voice in, AI out'
  })
})
