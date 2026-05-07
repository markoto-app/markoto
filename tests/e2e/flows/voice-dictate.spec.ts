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
test('Speak instead of typing', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Dictation auth requires a session; the test-mode login shim is
  // the same path the AI flows use.
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  // Markoto theme ships with cover.enabled=true; the preview iframe
  // shows the cover sheet, hiding the dictated text that lands at
  // the cursor (page 4+ of the welcome doc). Disable cover so the
  // preview shows actual content.
  await editor.page.disableCoverPage()

  // Move the caret to the end of the welcome doc so dictation
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
    + 'markoto streams what you say into the doc. Words land at the '
    + 'caret as you speak — interim partials render as ghost text, '
    + 'and committed finals become real document content the moment '
    + 'the speech recognizer is confident.'
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
      result: 'The mic lights up red — the WebSocket is open, your audio is '
        + 'streaming, the speech recognizer is listening.',
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
    'The audio worklet captures 128 ms chunks at 16 kHz and posts '
    + 'them straight to Mistral Voxtral Realtime. Interim transcripts appear as '
    + 'ghost text at the caret; once the recognizer is confident, '
    + 'they commit into the Y.js document with a `dictation:{userId}` '
    + 'origin so undo / collaborator awareness recognises them.'
  )

  // The mock STT's chunk-counted sequence: chunk 3 → "hello"
  // (interim) → chunk 4 → "hello world" (interim) → chunk 5 → "how"
  // (interim) → chunk 6 → "how are you" (FINAL). The audio worklet
  // emits chunks every ~128 ms, so the final lands after roughly
  // 768 ms of fake-audio capture. Wait for the editor body to
  // contain the committed text.
  await expect(page.locator('.cm-content')).toContainText(/how are you/i, { timeout: 20_000 })

  await flow.shot(
    'The recognized phrase commits into the doc — same Y.js path as a typed character.',
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
    'Click the mic again to close the WebSocket. markoto sends a '
    + '`{type: "stop"}` frame, the recognizer flushes any remaining '
    + 'partials as a final, and the editor returns to keyboard-only '
    + 'input. The mic permission stays granted for the rest of the '
    + 'session — re-clicking the mic resumes streaming without a '
    + 'new permission prompt.'
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
  const editorText = await page.locator('.cm-content').textContent()
  expect(editorText).toMatch(/how are you/i)

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
