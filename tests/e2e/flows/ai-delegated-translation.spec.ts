import { test, expect, requireLiveAi } from '../fixtures/flow'
import { findAiWritingTells } from '../../../shared/ai/writingTells'
import { generateLargeDocument } from '../../fixtures/largeDocument/generate'

// AI Flow: "Translate many sections at once".
//
// User-job: a German operations handbook (about 17k tokens, 14 chapters)
// has to go out in English, except the introduction and the appendix.
// Job done when chapters 2 to 13 read in English, every code block is
// untouched, chapters 1 and 14 stay German, and Undo in the Activity Log
// brings the German text back.
//
// Runs against the LIVE LiteLLM proxy. The target (chapters 2 to 13, about
// 15k tokens) is above the 12k-token delegation threshold of the task
// playbook and the outline's delegate_hint, so the planner hands the work
// to a background job (delegate_rewrite) that translates each part with
// small worker calls. A smaller target is translated by the planner itself,
// by design: an earlier version of this flow used six short sections and
// never saw a job. When the estimate is large the prompt bar asks before
// the job starts; the flow confirms if asked.
//
// Light variants only (desktop and mobile): the job is minutes of live
// worker calls, and the docs page falls back to the other theme of the same
// form factor (app/components/content/Flow.vue).

test.describe.configure({ retries: 1 })

// The bench generator at about 6000 words. Its upload images point at a
// document that does not exist here, so they are left out.
const DRAFT = generateLargeDocument({ targetWords: 6000 })
  .split('\n')
  .filter(line => !line.startsWith('!['))
  .join('\n')

const TRANSLATED_CHAPTERS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] as const
const GERMAN_CHAPTERS = [1, 14] as const

const GERMAN_WORDS = /\b(?:und|der|die|das|wird|werden|eine?|mit|nicht|kann)\b/gi
const FENCE_RE = /^`{3}[^\n]*\n[\s\S]*?^`{3}$/gm

/** The fenced code blocks of `text`, verbatim. */
function fences(text: string): string[] {
  return text.match(FENCE_RE) ?? []
}

/** The prose of `text`: without fenced code, inline code and link targets. */
function prose(text: string): string {
  return text.replace(FENCE_RE, ' ').replace(/`[^`\n]*`/g, ' ').replace(/\]\([^)]*\)/g, ']')
}

function germanShare(text: string): number {
  const p = prose(text)
  return (p.match(GERMAN_WORDS)?.length ?? 0) / Math.max(1, p.split(/\s+/).length)
}

/** Chapter `no`: its H1 and everything up to the next H1. */
function chapterText(doc: string, no: number): string {
  const start = doc.search(new RegExp(`^# ${no} `, 'm'))
  if (start === -1) return ''
  const rest = doc.slice(start + 1)
  const next = rest.search(/^# \d+ /m)
  return next === -1 ? doc.slice(start) : doc.slice(start, start + 1 + next)
}

test('Translate many sections with AI', async ({ flow, editor }, testInfo) => {
  test.skip(testInfo.project.name.includes('-dark-'), 'Live background job: light variants only, the docs fall back to them')
  requireLiveAi()
  test.setTimeout(600_000)
  const page = editor.page.page

  await editor.page.loginAsTestUser('Lena Graf')
  await editor.silentSetup({ title: 'Betriebshandbuch', body: DRAFT, cover: false })

  await flow.heading('Ask for the translation', 3)
  await flow.narrate(
    'For a change that applies to a large part of the document in the same way, such as a translation, '
    + 'the AI tries it on a sample first and then works through the sections in the background. '
    + 'Code samples stay exactly as they are. For a few short sections the AI makes the change itself.'
  )

  await flow.click('Click into the AI prompt bar', editor.page.ai.promptBarInput, {
    chain: true,
    after: () => editor.page.ai.promptBarInput.waitFor({ state: 'visible' })
  })
  const prompt = 'Translate chapters 2 to 13 into English. The introduction and the appendix stay in German.'
  await flow.type('Say which chapters and which language', editor.page.ai.promptBarInput, prompt, {
    result: 'Your request is ready to send.'
  })
  await flow.click('Click send', editor.page.ai.promptBarSend, {
    result: 'The AI tries the translation on a sample section.',
    after: () => editor.page.waitForAiActive()
  })

  // A large estimate is confirmed in the prompt bar; a small one starts
  // directly. A session that ends without either never started a job:
  // fail right away instead of waiting out the timeout.
  const confirm = page.locator('[data-testid="ai-confirm-panel"][data-kind="job"]')
  const jobPanel = page.locator('[data-testid="ai-job-panel"]')
  const promptBar = editor.page.ai.promptBar
  await expect.poll(async () => (await confirm.isVisible())
    || (await jobPanel.isVisible())
    || (await promptBar.getAttribute('data-active')) === 'false', { timeout: 300_000 }).toBe(true)
  if (!(await confirm.isVisible()) && !(await jobPanel.isVisible())) {
    const outcome = await promptBar.getAttribute('data-last-outcome')
    const message = await promptBar.getAttribute('data-last-outcome-message')
    throw new Error(`The AI session ended (${outcome ?? 'no outcome'}${message ? `: ${message}` : ''}) without starting a background job`)
  }
  if (await confirm.isVisible()) {
    await flow.click('Start the translation', page.locator('[data-testid="ai-confirm-allow"]'), {
      result: 'The prompt bar showed the cost and the time before anything changed.'
    })
  }

  await flow.heading('Watch it work through the sections', 3)
  await expect(jobPanel).toBeVisible({ timeout: 120_000 })
  await expect.poll(() => jobPanel.getAttribute('data-job-status'), { timeout: 360_000 }).toMatch(/^(done|failed|cancelled)$/)
  await expect(jobPanel).toHaveAttribute('data-job-status', 'done')
  await editor.page.waitForAiIdle()

  const translated = await editor.page.docText()
  for (const no of TRANSLATED_CHAPTERS) {
    expect(germanShare(chapterText(translated, no)), `chapter ${no} should be English`).toBeLessThan(0.03)
  }
  for (const no of GERMAN_CHAPTERS) {
    expect(germanShare(chapterText(translated, no)), `chapter ${no} stays German`).toBeGreaterThan(0.05)
  }
  for (const block of fences(DRAFT)) expect(translated).toContain(block)
  const aiText = TRANSLATED_CHAPTERS.map(no => chapterText(translated, no)).join('\n')
  expect(findAiWritingTells(aiText)).toEqual([])

  await flow.shot('Chapters 2 to 13 are in English; the introduction, the appendix and every code block stayed as they were.', { hero: true })

  await flow.heading('Undo the whole job in one step', 3)
  const activityTab = editor.isMobile ? editor.page.mobileTabs.activity : editor.page.sidebar.activity
  await flow.click('Open the Activity tab', activityTab, {
    result: 'The translation is one entry, with the number of sections it changed.',
    after: () => page.locator('[data-testid^="activity-row-undo-job-"]').first().waitFor({ state: 'visible', timeout: 30_000 })
  })
  await flow.click('Click Undo job', page.locator('[data-testid^="activity-row-undo-job-"]').first(), {
    force: editor.isMobile,
    result: 'markoto asks before it puts the German text back.'
  })
  await flow.click('Confirm', page.locator('[data-testid^="activity-row-undo-job-yes-"]').first(), {
    force: editor.isMobile,
    result: 'The chapters are German again. Parts someone edited after the job would have stayed as they are.'
  })
  await expect.poll(() => editor.page.docText(), { timeout: 30_000 }).toBe(DRAFT)
  await editor.page.dismissToasts()
  await flow.shot('The German text is back in every chapter the job had translated.')

  flow.next({ slug: 'restore-an-earlier-version', why: 'Go back to any earlier state of a document' })
})
