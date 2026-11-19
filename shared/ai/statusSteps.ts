// The AI's progress and end-of-session lines in the prompt bar ("Searching
// the web for …", "Done", "Hit turn limit"). The server sends a step code
// with its parameters, and the client renders it in the UI language from
// `ai.step.<key>` in the locale files. The English templates below are the
// server's own text for the same step (`message`, logs, the flow tests'
// `data-last-outcome-message`); `i18n/locales/en.json` must hold the same
// strings (pinned by tests/unit/ai/aiStatusSteps.test.ts).
//
// Template syntax is the vue-i18n subset both sides understand: `{name}`
// placeholders, and two plural forms separated by ` | ` (count 1, else).

export const AI_STATUS_STEPS = {
  thinking: 'Thinking…',
  done: 'Done',
  stopped: 'Stopped',
  stoppedReason: 'Stopped: {reason}',
  turnLimit: 'Stopped after too many steps. Try a more focused prompt.',
  stoppedEarly: 'Stopped before the task was finished (step or time limit). The note says what is done.',
  doneNoAnswer: 'Done. Check the document for the changes.',
  sessionCap: 'Stopped after {cap} steps. Try a more focused prompt.',
  waitingConfirmation: 'Waiting for your confirmation…',
  pointsExhausted: 'AI Points exhausted',
  aiUnavailable: 'The AI is not available right now. Please try again in a moment.',
  aiRateLimited: 'Too many AI requests in a short time. Please wait a minute and try again.',
  teamBudgetExhausted: 'This workspace\'s AI Points for this month are used up. Ask a workspace admin to add seats or AI Points.',
  memberLimitReached: 'You\'ve reached your AI limit in this workspace for this month. Ask a workspace admin to raise it.',
  freeAllowanceExhausted: 'This month\'s free AI allowance is used up. Add your own key in Settings → AI provider to keep going.',
  webSearch: 'Searching the web for "{query}"',
  webSearchAny: 'Searching the web…',
  fetchUrl: 'Fetching {url}',
  fetchUrlAny: 'Fetching URL…',
  readDocument: 'Reading the document…',
  readReferences: 'Reading the bibliography…',
  addReference: 'Looking up DOI {doi}',
  addReferenceAny: 'Looking up a DOI…',
  checkCitations: 'Checking citations…',
  editPassage: 'Editing "{passage}"',
  editDocument: 'Editing the document…',
  insertText: 'Inserting text…',
  applyEdit: 'Applying edit…',
  applyInsert: 'Applying insert…',
  setTitle: 'Setting title to "{title}"',
  setTitleAny: 'Updating title…',
  readTheme: 'Reading current theme…',
  listThemes: 'Listing your saved themes…',
  applyPreset: 'Applying preset "{preset}"…',
  applySavedTheme: 'Applying a saved theme…',
  applyWorkspaceTheme: 'Applying workspace default theme…',
  updateTheme: 'Updating theme…',
  updateThemeSections: 'Updating theme ({sections})…',
  updateThemeCount: 'Updating theme ({count} sections)…',
  saveTheme: 'Saving theme as "{name}"',
  saveThemeAny: 'Saving theme as preset…',
  listWorkspaceDocuments: 'Browsing workspace documents…',
  listMyDocuments: 'Browsing your documents…',
  searchDocuments: 'Searching documents for "{query}"',
  listFolders: 'Browsing folders…',
  moveDocument: 'Moving a document to a folder…',
  createFolder: 'Creating folder "{name}"',
  readOtherDocument: 'Reading document {id}',
  readNamedDocument: 'Reading {title}…',
  readOtherDocumentAny: 'Reading another document…',
  searchKnowledge: 'Searching workspace knowledge for "{query}"',
  searchKnowledgeAny: 'Searching workspace knowledge…',
  openKnowledgeFile: 'Opening workspace knowledge file {id}',
  openKnowledgeFileAny: 'Opening a workspace knowledge file…',
  viewImage: 'Looking at "{name}"',
  viewImageAny: 'Looking at an image…',
  fetchImage: 'Fetching image…',
  generateImage: 'Generating image: "{prompt}"',
  generateImageAny: 'Generating image…',
  uploadImage: 'Uploading generated image…',
  countPages: 'Counting pages…',
  renderPages: 'Rendering {count} page… | Rendering {count} pages…',
  readComments: 'Reading document comments…',
  addComment: 'Adding a comment…',
  replyComment: 'Replying to comment {id}…',
  replyCommentAny: 'Replying to a comment…',
  resolveComment: 'Resolving a comment…',
  reopenComment: 'Reopening a comment…',
  deleteComment: 'Deleting a comment…',
  scanDocument: 'Scanning the document…',
  previewJob: 'Trying the change on sample sections…',
  startJob: 'Starting the background edit…',
  jobWaiting: 'Background edit running; its progress shows above.',
  jobStatus: 'Checking the background edit…'
} as const

export type AiStatusStepKey = keyof typeof AI_STATUS_STEPS

/** A status line as a code: the client renders `ai.step.<key>` with these values. */
export interface AiStatusStep {
  key: AiStatusStepKey
  params?: Record<string, string>
  /** Picks the plural form (templates with ` | `). */
  count?: number
}

/** What the server reports: its English text plus, when it has one, the step code. */
export interface AiStatusLine {
  text: string
  step: AiStatusStep | null
}

function isStepKey(v: unknown): v is AiStatusStepKey {
  return typeof v === 'string' && Object.hasOwn(AI_STATUS_STEPS, v)
}

/** Fill a template: `{name}` placeholders, two plural forms split on ` | `. */
export function renderStatusTemplate(template: string, params: Record<string, string> = {}, count?: number): string {
  const [one = '', other] = template.split(' | ')
  const form = other !== undefined && count !== 1 ? other : one
  const values: Record<string, string> = count === undefined ? params : { count: String(count), ...params }
  return form.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
}

/** A step with its English text. */
export function aiStatus(key: AiStatusStepKey, params?: Record<string, string>, count?: number): AiStatusLine {
  const step: AiStatusStep = { key }
  if (params && Object.keys(params).length > 0) step.params = params
  if (count !== undefined) step.count = count
  return { text: renderStatusTemplate(AI_STATUS_STEPS[key], params, count), step }
}

/** Read a step back from untrusted JSON (the session channel, the client's stream). */
export function parseAiStatusStep(v: unknown): AiStatusStep | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const raw = v as Record<string, unknown>
  if (!isStepKey(raw.key)) return null
  const step: AiStatusStep = { key: raw.key }
  if (typeof raw.params === 'object' && raw.params !== null && !Array.isArray(raw.params)) {
    const params: Record<string, string> = {}
    for (const [name, value] of Object.entries(raw.params)) {
      if (typeof value === 'string') params[name] = value
    }
    if (Object.keys(params).length > 0) step.params = params
  }
  if (typeof raw.count === 'number' && Number.isFinite(raw.count)) step.count = raw.count
  return step
}

/** A plain string (no translation available) or a line with its step. */
export type AiStatusInput = string | AiStatusLine

export function toStatusLine(input: AiStatusInput | undefined): AiStatusLine | null {
  if (input === undefined) return null
  return typeof input === 'string' ? { text: input, step: null } : input
}
