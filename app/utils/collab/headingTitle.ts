import type * as Y from 'yjs'
import { firstH1, followHeadingTitle } from '~~/shared/utils/markdown/markdownTitle'

/** Quiet time after the last local edit before the title follows the heading. */
const HEADING_TITLE_DEBOUNCE_MS = 800

export interface HeadingTitleSync {
  /** After the first sync: take the current heading as the baseline (and title an untitled document). */
  start: () => void
  stop: () => void
}

/**
 * Keeps a document's title in step with its first `# Heading` while the
 * title was never set by hand (`followHeadingTitle`). Only this client's
 * own edits trigger it, so the collaborators of a document don't all write
 * the same title; a read-only or suggest-only connection never writes it.
 */
export function createHeadingTitleSync(opts: {
  ytext: Y.Text
  getTitle: () => string
  setTitle: (title: string) => void
  canWrite: () => boolean
  debounceMs?: number
}): HeadingTitleSync {
  let previousH1 = ''
  let started = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function apply(): void {
    timer = null
    const nextH1 = firstH1(opts.ytext.toString())
    const next = followHeadingTitle(opts.getTitle(), previousH1, nextH1)
    previousH1 = nextH1
    if (next !== null && opts.canWrite()) opts.setTitle(next)
  }

  function onChange(_event: Y.YTextEvent, transaction: Y.Transaction): void {
    if (!started || !transaction.local) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(apply, opts.debounceMs ?? HEADING_TITLE_DEBOUNCE_MS)
  }
  opts.ytext.observe(onChange)

  return {
    start() {
      if (started) return
      started = true
      // An untitled document that already starts with a heading takes it
      // now; a renamed one keeps its title (previousH1 '' never matches).
      apply()
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
      opts.ytext.unobserve(onChange)
    }
  }
}
