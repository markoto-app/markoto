import { readFileSync } from 'node:fs'
import path from 'node:path'

// What the product-tour captures show. ONE swappable fixture: point
// REPORT_DIR at another document (body + theme.json) and adjust the
// strings below; every capture spec picks it up.
//
// Today: the flagship demo report — Quaybridge Software GmbH's Q3 2026
// quarterly report (tests/e2e/fixtures/content/q3-report/, invented
// company; README there lists the numbers that must stay consistent).
// Everything the captures add (a colleague's sentence, the AI prompts,
// the knowledge memo) stays consistent with those numbers and makes no
// claims about markoto.

const REPORT_DIR = 'tests/e2e/fixtures/content/q3-report'

const body = readFileSync(path.resolve(REPORT_DIR, 'quaybridge-q3-2026.md'), 'utf8').trim()
const theme: unknown = JSON.parse(readFileSync(path.resolve(REPORT_DIR, 'theme.json'), 'utf8'))

export const demoDocument = {
  /** Document title (topbar + cover); the body has no title heading. */
  title: 'Q3 2026 Quarterly Report',
  /** Full markdown body. */
  markdown: body,
  /** The report's own theme (cover, fonts, header/footer) — a DocTheme. */
  theme,
  /** The "write" sequence types the body from here … */
  writeFrom: '# Executive summary',
  /** … up to (not including) this heading. */
  writeUntil: '## Revenue by region',
  /** Who is signed in, and who joins them. Both appear in the report. */
  author: 'Tomasz Wierzba',
  collaborator: 'Sanne Kuipers',
  /** The collaborator appends this to the paragraph that contains `collaboratorAnchor`. */
  collaboratorAnchor: 'Gross revenue retention also slipped one point',
  collaboratorSentence: 'Both remaining at-risk accounts renewed in October.',
  /** …and comments on the line that contains this. */
  commentAnchor: 'Q3 2026 was the quarter in which Quaybridge turned',
  collaboratorComment: 'Should we put the guidance raise into this first paragraph? The board will look for it.',
  /** An imperative, neutral prompt that edits the document. */
  aiPrompt: 'Write the executive summary for this quarter below the title, with a table of the key figures.',
  /** The document description (document context the AI reads with every prompt): the facts it may use. */
  aiDescription: 'Quaybridge Software GmbH, Q3 2026 quarterly report. Key figures, Q3 2026 vs Q3 2025: revenue EUR 6.51 m vs 5.28 m (+23.3%); ARR EUR 21.3 m vs 17.1 m (+24.6%); EBITDA EUR 0.13 m vs -0.47 m, the first positive quarter; gross margin 73.1% vs 68.4% (+4.7 pp); customers 322 vs 268 (+20.1%). Use only these figures; add no reasons, plans or other claims.',
  /** Text the AI's edit must contain. Its numbers are also checked against the prompt + report. */
  aiMustMention: [/summary/i, /\|/],
  /** The history scene's edit: appended to the paragraph containing the anchor. */
  revisionAnchor: 'We are raising full-year guidance',
  revisionSentence: 'The supervisory board will review the 2027 budget on 9 December.'
}

/** The knowledge file the "answers from your own files" scene uploads (consistent with the report). */
export const knowledgeFile = {
  path: 'tests/e2e/tour/content/carrier-network-memo.html',
  /** Uploaded as a PDF printed from the HTML above. */
  pdfName: 'carrier-network-memo-q3-2026.pdf',
  workspace: 'Quaybridge finance',
  docTitle: 'Carrier network: board notes',
  docBody: '# Carrier network: board notes\n\nNotes for the November board meeting.\n',
  prompt: 'Add a paragraph on what the carrier memo says about no-shows and waiting times.',
  /** Figures only the memo contains — the answer must quote at least three. */
  facts: [/7[.,]9\s?%/, /11[.,]2\s?%/, /28\s?min/i, /41\s?min/i, /1[,.\s]?150/]
}
