import { test, expect, requireLiveAi } from '../fixtures/flow'
import { generateLargeDocument } from '../../fixtures/largeDocument/generate'

// AI Flow: "Swap two chapters and renumber".
//
// User-job: in a numbered German handbook two chapters have to trade
// places, and the numbering must stay in order afterwards. Job done when
// chapter 10 holds what was chapter 12 and the other way round, every
// chapter, section and subsection number runs in order, every heading keeps
// its level, no text is lost, and the prompt bar answers for this request.
//
// Regression for staging, 2026-11-18: the renumbering ran as a chain of
// replace_all calls that left chapters 10 to 12 all numbered 12, pinned 31
// stale `{#h-...}` ids, and a follow-up turned every ## / ### heading of
// those chapters into a level-1 heading. The answer reported a state the
// document did not have. Runs against the LIVE LiteLLM proxy; assertions
// check the document, not which tools ran.
//
// Light variants only (desktop and mobile): live AI on a long document, and
// the docs page falls back to the other theme of the same form factor.

test.describe.configure({ retries: 1 })

// The bench generator at about 6000 words (14 chapters, numbered H1 / H2 /
// H3). Its upload images point at a document that does not exist here.
const DRAFT = generateLargeDocument({ targetWords: 6000 })
  .split('\n')
  .filter(line => !line.startsWith('!['))
  .join('\n')

const FENCE_RE = /^`{3}[^\n]*\n[\s\S]*?^`{3}$/gm

interface Heading { level: number, number: string | null, title: string }

/** ATX headings outside code fences: level, number and the text after it. */
function headings(text: string): Heading[] {
  return text.replace(FENCE_RE, '').split('\n').flatMap((line) => {
    const m = /^(#{1,6}) (?:(\d+(?:\.\d+)*) )?(.*)$/.exec(line)
    return m ? [{ level: m[1]!.length, number: m[2] ?? null, title: m[3]! }] : []
  })
}

/** Numbered headings read 1, 1.1, 1.1.1, ... in document order. */
function numberingProblems(text: string): string[] {
  const counters: number[] = []
  const problems: string[] = []
  for (const h of headings(text)) {
    if (!h.number) continue
    counters.length = h.level
    counters[h.level - 1] = (counters[h.level - 1] ?? 0) + 1
    const want = counters.map(n => n ?? 1).join('.')
    if (h.number !== want) problems.push(`${'#'.repeat(h.level)} ${h.number} ${h.title} (expected ${want})`)
  }
  return problems
}

/** The chapter (H1) titled with number `no`, without its {#id}. */
function chapterTitle(text: string, no: number): string | null {
  return headings(text).find(h => h.level === 1 && h.number === String(no))?.title.replace(/\s*\{#[^}]+\}$/, '') ?? null
}

/** The lines of `text` with every number replaced, sorted: the content, whatever the numbering. */
function contentLines(text: string): string[] {
  return text.split('\n').map(l => l.replace(/\d+(?:\.\d+)*/g, 'N')).sort()
}

test('Swap two chapters and renumber with AI', async ({ flow, editor }, testInfo) => {
  test.skip(testInfo.project.name.includes('-dark-'), 'Live AI on a long document: light variants only, the docs fall back to them')
  requireLiveAi()
  test.setTimeout(420_000)
  const page = editor.page.page

  await editor.page.loginAsTestUser('Martina Studer')
  await editor.silentSetup({ title: 'Betriebshandbuch', body: DRAFT, cover: false })
  const ten = chapterTitle(DRAFT, 10)
  const twelve = chapterTitle(DRAFT, 12)
  expect(ten && twelve).toBeTruthy()

  await flow.heading('Ask for the swap', 3)
  await flow.narrate(
    'Chapters can trade places in one request. Ask for the renumbering in the same sentence: '
    + 'the AI moves both chapters with all their sections and then puts every number back in order.'
  )

  await flow.click('Click into the AI prompt bar', editor.page.ai.promptBarInput, {
    chain: true,
    after: () => editor.page.ai.promptBarInput.waitFor({ state: 'visible' })
  })
  const prompt = 'Swap chapter 10 and chapter 12, and renumber them so the numbering stays in order.'
  await flow.type('Say which chapters should trade places', editor.page.ai.promptBarInput, prompt, {
    result: 'Your request is ready to send.'
  })
  await flow.click('Click send', editor.page.ai.promptBarSend, {
    result: 'The AI swaps the chapters and renumbers the headings.',
    after: () => editor.page.waitForAiActive()
  })

  await flow.heading('Chapters swapped, numbers in order', 3)
  await editor.page.waitForAiIdle()
  await expect(editor.page.ai.promptBar).toHaveAttribute('data-last-outcome', 'done')

  const after = await editor.page.docText()
  // The chapters traded places and carry the numbers of their new position.
  expect(chapterTitle(after, 10)).toBe(twelve)
  expect(chapterTitle(after, 12)).toBe(ten)
  // Every chapter, section and subsection number is in order.
  expect(numberingProblems(after)).toEqual([])
  // Same headings, same levels: only their order and numbers changed.
  expect(headings(after).map(h => h.level).sort()).toEqual(headings(DRAFT).map(h => h.level).sort())
  expect(headings(after).filter(h => h.level === 1)).toHaveLength(headings(DRAFT).filter(h => h.level === 1).length)
  // No text lost or added, and no explicit ids made up from old numbers.
  expect(contentLines(after)).toEqual(contentLines(DRAFT))
  expect(after).not.toMatch(/\{#h-\d/)

  // The prompt bar answers for this request (not an earlier one).
  const answer = page.locator('[data-testid="ai-response-panel"]')
  await expect(answer).toBeVisible({ timeout: 15_000 })

  await editor.page.scrollEditorTo(new RegExp(`^# 10 `))
  await flow.shot(`Chapter 10 is now "${twelve}", and every number below it follows the new order.`, { hero: true })

  flow.next({ slug: 'translate-many-sections-with-ai', why: 'Translate or restyle many sections at once' })
})
