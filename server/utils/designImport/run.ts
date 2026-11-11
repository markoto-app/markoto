import * as Sentry from '@sentry/nuxt'
import type OpenAI from 'openai'
import type { DesignImportErrorCode, DesignImportExt } from '~~/shared/config/designImport'
import { DESIGN_IMPORT_MAX_ROUNDS } from '~~/shared/config/designImport'
import { litellmCompletion } from '../litellm/createCompletion'
import { FEATURE_TAGS, featureMetadata } from '../litellm/featureTags'
import { isBudgetExceededError } from '../litellm/userKeys'
import { isFreeAllowanceExhaustedError } from '../litellm/freeTierTeam'
import { useLitellmForUser } from '../ai/litellmClient'
import { AiProviderCallError, providerRequestFields, withProviderErrors } from '../aiProviders/requestFields'
import { AiProviderUrlRefused } from '../aiProviders/urlPolicy'
import type { ResolvedAiProvider } from '../aiProviders/resolve'
import { releaseSessionLock } from '../platform/rateLimit'
import { DesignExtractError, extractDesignFacts } from './extract'
import { DesignImportFailure, runDesignImportPipeline, type ModelAnswer } from './pipeline'
import { proposeDesignTool } from './prompt'
import { renderDesignSample } from './sampleRender'
import { writeJob, type DesignImportJobState } from './job'

// Production wiring of the design-import pipeline: markitdown extract,
// the user's chat provider through LiteLLM (their virtual key — BYOK is
// zero-cost there, a platform default debits their AI budget like any AI
// chat), the renderer sample, and the Valkey job state the dialog polls.
// Runs in the background after `POST /api/themes/from-document/start`.

/** Whole run, extract to final preview. Above it the job fails with `internal`. */
const RUN_DEADLINE_MS = 6 * 60_000
/** Output cap per model call: a full proposal with CSS is ~2–3 k tokens. */
const MAX_OUTPUT_TOKENS = 6000

export const DESIGN_IMPORT_LOCK = 'design-import-active'

export interface StartRunArgs {
  jobId: string
  userId: number
  bytes: Uint8Array
  ext: DesignImportExt
  provider: ResolvedAiProvider
  virtualKey: string
}

async function callModel(args: StartRunArgs, messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[], signal: AbortSignal): Promise<ModelAnswer> {
  const fields = await providerRequestFields(args.provider)
  const resp = await withProviderErrors(args.provider, () => litellmCompletion(useLitellmForUser(args.virtualKey), {
    ...fields,
    messages,
    tools: [proposeDesignTool()],
    tool_choice: 'required',
    temperature: 0,
    max_tokens: MAX_OUTPUT_TOKENS,
    ...featureMetadata(FEATURE_TAGS.designImport, { userId: args.userId })
  }, { signal }))
  const message = resp.choices?.[0]?.message
  return {
    message: message ? { content: message.content, tool_calls: message.tool_calls?.map(c => c.type === 'function' ? { type: c.type, function: c.function } : { type: c.type }) } : undefined,
    totalTokens: resp.usage?.total_tokens ?? 0
  }
}

/** Map any failure of the run to a stable code + a plain sentence (no upstream text). */
export function classifyRunError(e: unknown): { code: DesignImportErrorCode, message: string } {
  if (e instanceof DesignImportFailure) return { code: e.code, message: e.message }
  if (e instanceof DesignExtractError) {
    if (e.status === 413) return { code: 'too-large', message: 'The file is too large or too complex to read.' }
    if (e.status === 422 || e.status === 400) return { code: 'unreadable', message: 'The file could not be read. Is it a PDF or Word document that opens normally?' }
    return { code: 'internal', message: 'The file could not be read right now. Please try again.' }
  }
  if (isFreeAllowanceExhaustedError(e) || isBudgetExceededError(e)) {
    return { code: 'budget', message: 'Your AI budget for this month is used up.' }
  }
  if (e instanceof AiProviderCallError || e instanceof AiProviderUrlRefused) {
    return { code: 'provider-error', message: 'Your AI provider returned an error.' }
  }
  return { code: 'internal', message: 'Something went wrong while creating the design.' }
}

export async function runDesignImportJob(args: StartRunArgs): Promise<void> {
  const base: Pick<DesignImportJobState, 'userId' | 'maxRounds' | 'format'> = {
    userId: args.userId,
    maxRounds: DESIGN_IMPORT_MAX_ROUNDS,
    format: args.ext
  }
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), RUN_DEADLINE_MS)
  try {
    const result = await runDesignImportPipeline({
      extract: () => extractDesignFacts(args.bytes, args.ext, controller.signal),
      callModel: messages => callModel(args, messages, controller.signal),
      render: (theme, round) => renderDesignSample(theme, round),
      progress: (phase, round) => writeJob(args.jobId, { ...base, phase, round })
    })
    await writeJob(args.jobId, { ...base, phase: 'done', round: result.rounds, result })
  } catch (e) {
    const { code, message } = classifyRunError(e)
    if (code === 'internal') {
      console.error('[design-import] run failed:', e instanceof Error ? e.message.slice(0, 300) : e)
      Sentry.captureException(e, { tags: { component: 'design-import', event: 'run_failed' } })
    }
    await writeJob(args.jobId, { ...base, phase: 'error', round: 0, error: { code, message } }).catch(() => undefined)
  } finally {
    clearTimeout(deadline)
    await releaseSessionLock(DESIGN_IMPORT_LOCK, String(args.userId)).catch(() => undefined)
  }
}
