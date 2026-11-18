import { test, expect, requireLiveAi } from '../fixtures/flow'
import { findAiWritingTells } from '../../../shared/ai/writingTells'

// AI Flow: "Translate many sections at once".
//
// User-job: a German guide has to go out in English, but only its middle
// chapters. Job done when sections 2 to 5 read in English, the code
// samples are untouched, sections 1 and 6 stay German, and Undo in the
// Activity Log brings the German text back.
//
// Runs against the LIVE LiteLLM proxy: the model hands the rule-like work
// to a background job (delegate_rewrite), which translates each section
// with small worker calls. When the estimate is large the prompt bar asks
// before it starts; the flow confirms if asked.

const CODE = 'markoto sync --all --region eu'

const SECTIONS = [
  ['1 Einleitung', 'Dieses Handbuch beschreibt, wie das Team seine Notizen pflegt. Es richtet sich an alle, die neu im Team sind.'],
  ['2 Installation', 'Die Installation dauert nur wenige Minuten. Melde dich zuerst mit deinem Konto an und führe danach den folgenden Befehl einmal aus:\n\n```bash\n' + CODE + '\n```\n\nDanach sind alle Notizen auf deinem Gerät verfügbar.'],
  ['3 Arbeitsbereiche', 'Jeder Arbeitsbereich hat eigene Mitglieder und eigene Vorlagen. Die Verantwortlichen legen fest, wer Dokumente bearbeiten darf und wer sie nur lesen kann.'],
  ['4 Freigaben', 'Ein Dokument kann mit einem Link geteilt werden. Der Link lässt sich jederzeit widerrufen, und ein Ablaufdatum sorgt dafür, dass er nicht ewig gültig bleibt.'],
  ['5 Sicherung', 'Alle Dokumente werden täglich gesichert. Die Sicherungen werden dreissig Tage lang aufbewahrt und können bei Bedarf vom Betrieb wiederhergestellt werden.'],
  ['6 Kontakt', 'Bei Fragen hilft das Supportteam gerne weiter. Schreibe eine Nachricht an den internen Kanal, und jemand meldet sich noch am selben Tag.']
] as const

const GERMAN_WORDS = /\b(?:und|der|die|das|wird|werden|eine?|mit|nicht|kann)\b/gi
const germanShare = (text: string): number => (text.match(GERMAN_WORDS)?.length ?? 0) / Math.max(1, text.split(/\s+/).length)

function sectionText(doc: string, no: number): string {
  const start = doc.search(new RegExp(`^# ${no} `, 'm'))
  const rest = doc.slice(start + 1)
  const next = rest.search(/^# \d /m)
  return next === -1 ? doc.slice(start) : doc.slice(start, start + 1 + next)
}

test('Translate many sections with AI', async ({ flow, editor }) => {
  requireLiveAi()
  test.setTimeout(480_000)
  const page = editor.page.page

  await editor.page.loginAsTestUser('Lena Graf')
  const draft = SECTIONS.map(([h, body]) => `# ${h}\n\n${body}\n`).join('\n')
  await editor.silentSetup({ title: 'Teamhandbuch', body: draft, cover: false })

  await flow.heading('Ask for the translation', 3)
  await flow.narrate(
    'For a change that applies to many sections in the same way, such as a translation, '
    + 'the AI tries it on a sample first and then works through the sections in the background. '
    + 'Code samples stay exactly as they are.'
  )

  await flow.click('Click into the AI prompt bar', editor.page.ai.promptBarInput, {
    chain: true,
    after: () => editor.page.ai.promptBarInput.waitFor({ state: 'visible' })
  })
  const prompt = 'Translate sections 2 to 5 into English'
  await flow.type('Say which sections and which language', editor.page.ai.promptBarInput, prompt, {
    result: 'Your request is ready to send.'
  })
  await flow.click('Click send', editor.page.ai.promptBarSend, {
    result: 'The AI tries the translation on a sample section.',
    after: () => editor.page.waitForAiActive()
  })

  // A large estimate is confirmed in the prompt bar; a small one starts directly.
  const confirm = page.locator('[data-testid="ai-confirm-panel"][data-kind="job"]')
  const jobPanel = page.locator('[data-testid="ai-job-panel"]')
  await expect.poll(async () => (await confirm.isVisible()) || (await jobPanel.isVisible()), { timeout: 240_000 }).toBe(true)
  if (await confirm.isVisible()) {
    await flow.click('Start the translation', page.locator('[data-testid="ai-confirm-allow"]'), {
      result: 'The prompt bar showed the cost and the time before anything changed.'
    })
  }

  await flow.heading('Watch it work through the sections', 3)
  await expect(jobPanel).toBeVisible({ timeout: 120_000 })
  await expect.poll(() => jobPanel.getAttribute('data-job-status'), { timeout: 300_000 }).toMatch(/^(done|failed|cancelled)$/)
  await expect(jobPanel).toHaveAttribute('data-job-status', 'done')
  await editor.page.waitForAiIdle()

  const translated = await editor.page.docText()
  for (const no of [2, 3, 4, 5]) {
    const text = sectionText(translated, no)
    expect(germanShare(text), `section ${no} should be English`).toBeLessThan(0.03)
  }
  for (const no of [1, 6]) expect(germanShare(sectionText(translated, no)), `section ${no} stays German`).toBeGreaterThan(0.05)
  expect(translated).toContain(`\`\`\`bash\n${CODE}\n\`\`\``)
  expect(findAiWritingTells(translated)).toEqual([])

  await flow.shot('Sections 2 to 5 are in English; the introduction, the contact section and the command stayed as they were.', { hero: true })

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
    result: 'The sections are German again. Parts someone edited after the job would have stayed as they are.'
  })
  await expect.poll(() => editor.page.docText(), { timeout: 30_000 }).toBe(draft)
  await editor.page.dismissToasts()
  await flow.shot('The German text is back in every section the job had translated.')

  flow.next({ slug: 'restore-an-earlier-version', why: 'Go back to any earlier state of a document' })
})
