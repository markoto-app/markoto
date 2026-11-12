import type OpenAI from 'openai'
import type { DocTheme } from '~~/shared/types/theme'
import { DESIGN_IMPORT_MAX_ROUNDS, type DesignImportErrorCode, type DesignImportPhase } from '~~/shared/config/designImport'
import type { DesignFacts } from './extract'
import { buildRoundMessages, fontMatches, parseProposal, type ProposeDesignInput } from './prompt'
import { themeFromProposal } from './proposal'
import type { DesignImportResult } from './job'
import { useLogger } from '../platform/logger'

const log = useLogger('design-import')

// The design loop, free of I/O so unit tests drive it with fakes:
//   extract (markitdown) → propose (model) → render sample → compare (model)
//   → … at most DESIGN_IMPORT_MAX_ROUNDS model calls.
// A round whose answer can't be used (no tool call, invalid theme) still
// counts — its problems go back to the model as feedback. A failed render
// ends the loop with the best proposal so far (no comparison possible).
// The model can end early with `matches_original: true`.

/** Total tokens over all rounds; the loop stops once a round crosses it. */
const DESIGN_IMPORT_TOKEN_BUDGET = 160_000

export interface ModelAnswer {
  message: { content?: string | null, tool_calls?: Array<{ type?: string, function?: { name?: string, arguments?: string } }> } | undefined
  totalTokens: number
}

export interface PipelineDeps {
  extract: () => Promise<DesignFacts>
  callModel: (messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) => Promise<ModelAnswer>
  /** Our render of `theme` (base64 PNG pages); throws when the renderer is unavailable. */
  render: (theme: DocTheme, round: number) => Promise<string[]>
  progress: (phase: DesignImportPhase, round: number) => Promise<void>
  maxRounds?: number
}

export class DesignImportFailure extends Error {
  readonly code: DesignImportErrorCode
  constructor(code: DesignImportErrorCode, message: string) {
    super(message)
    this.name = 'DesignImportFailure'
    this.code = code
  }
}

interface Best {
  input: ProposeDesignInput
  theme: DocTheme
  /** Our render of exactly this theme, when there is one. */
  render: string[] | null
}

export async function runDesignImportPipeline(deps: PipelineDeps): Promise<DesignImportResult> {
  const maxRounds = deps.maxRounds ?? DESIGN_IMPORT_MAX_ROUNDS
  await deps.progress('reading', 0)
  const facts = await deps.extract()

  // A property, not a `let`: TS narrows a `let` to its initial null inside the loop.
  const state: { best: Best | null } = { best: null }
  let feedback: string[] = []
  let tokens = 0
  let rounds = 0
  let canRender = true

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round
    await deps.progress('designing', round)
    const messages = buildRoundMessages({
      facts,
      round,
      maxRounds,
      previous: state.best?.input,
      ours: state.best?.render ?? undefined,
      feedback
    })
    const answer = await deps.callModel(messages)
    tokens += answer.totalTokens

    const parsed = parseProposal(answer.message)
    if (!parsed.ok) {
      feedback = [parsed.error]
    } else {
      const applied = themeFromProposal(parsed.value.theme)
      if (!applied.ok) {
        feedback = [applied.error]
      } else {
        const previous: Best | null = state.best
        const unchanged: boolean = previous !== null && JSON.stringify(previous.theme) === JSON.stringify(applied.theme)
        state.best = { input: parsed.value, theme: applied.theme, render: unchanged && previous ? previous.render : null }
        feedback = [...parsed.notes, ...applied.notes]
      }
    }

    // Server log only: what went back to the model (never document text).
    log.info('round finished', { round, maxRounds, proposal: parsed.ok, totalTokens: answer.totalTokens, feedbackNotes: feedback.length })
    const finished = parsed.ok && round > 1 && feedback.length === 0
      && (parsed.value.matches_original === true || state.best?.render !== null)
    if (finished) break
    if (round === maxRounds || tokens >= DESIGN_IMPORT_TOKEN_BUDGET) break
    if (state.best && state.best.render === null && canRender) {
      await deps.progress('rendering', round)
      try {
        state.best.render = await deps.render(state.best.theme, round)
      } catch (e) {
        log.warn('sample render failed, finishing without comparison', { err: e })
        canRender = false
        // Without a render there is nothing to compare: a valid proposal is final.
        if (feedback.length === 0) break
      }
    }
  }

  const best = state.best
  if (!best) throw new DesignImportFailure('invalid-design', feedback[0] ?? 'The model did not return a usable design.')

  if (best.render === null && canRender) {
    await deps.progress('rendering', rounds)
    try {
      best.render = await deps.render(best.theme, rounds + 1)
    } catch (e) {
      log.warn('final preview render failed', { err: e })
    }
  }

  const { theme } = best
  const swatches = [...new Set([theme.color.brand, theme.headings.color, theme.color.secondary, theme.body.color].map(c => c.toUpperCase()))]
  return {
    theme,
    name: best.input.name,
    description: best.input.description,
    preview: best.render ?? [],
    original: facts.pages.slice(0, 2).map(p => p.png),
    fonts: fontMatches(facts),
    swatches,
    rounds
  }
}
