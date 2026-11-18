import { z } from 'zod'
import { defineDocTool, toolOk, type ToolResult } from './toolDefinition'
import type { DocToolContext } from '../../agentic/toolContext'
import { appendAiMessage } from '../../../repos/aiSessionMessages'
import { useLogger } from '../../platform/logger'
import { withoutEmDashes } from '../dashFilter'

const log = useLogger('ai-tools')

// message_to_user: the AI's only direct response surface OUTSIDE the document. Renders in
// a thin panel above the prompt bar, auto-collapsed after 2s for plain
// messages, sticky for questions. The doc itself remains the artefact;
// this is just where the AI says one short thing back to the user.
//
// Contract:
//   - `message`: at most 600 chars. Anything longer belongs in the doc.
//   - `is_question`: true means the message stays on screen until the
//     user dismisses it or replies. Default false (auto-collapse).
//
// Use cases the system prompt teaches: answer a user question that
// doesn't belong in the doc; report a finding; ask for clarification
// when the task is genuinely ambiguous. NOT for "Done" / status reports
// those stay silent.

const MessageToUserArgs = z.object({
  message: z.string().trim().min(1).max(600)
    .describe('Short user-facing message, max 600 characters. Plain text or lightweight markdown. Use complete sentences. NOT for status reports ("Done", "Changes applied"), silence is the correct answer there. The doc edit IS the deliverable; this is for things the user needs to read OUTSIDE the doc.'),
  is_question: z.boolean().optional()
    .describe('Set true ONLY when you are asking the user something AND cannot proceed without their answer. Sticky on screen until the user dismisses or replies. Default false: the message auto-collapses after 2s and the user can re-expand it on demand.')
}).strict()
  .describe('Send a short ephemeral message back to the user, rendered above the AI prompt bar. Use when the user asked a question whose answer does NOT belong in the document (a status report on what you found, a brief explanation, a clarifying question), OR when the task is genuinely ambiguous and you need the user to choose. Prefer SILENCE for "Done" / "Changes applied", the diff is the receipt. Each session shows only the latest message; no history.')

/**
 * `message_to_user`: a short ephemeral answer for the person who ran
 * the session, rendered in the response panel above their prompt bar.
 *
 * Delivered through `session.deliverResponse` = the initiator-only
 * session channel (`agentic/sessionChannel.ts`), NOT awareness:
 * awareness reaches every participant of the document, and these
 * answers can summarise the initiator's other documents or knowledge.
 * One response per session, replaced not appended; `ts` lets the client
 * detect a fresh message even when the body repeats.
 *
 * The model's `output` is intentionally short, it just confirms the
 * message landed so the model doesn't try to repeat it.
 */
async function handleMessageToUser(
  session: DocToolContext,
  input: z.output<typeof MessageToUserArgs>
): Promise<ToolResult> {
  const isQuestion = input.is_question === true
  const message = withoutEmDashes(input.message)
  session.deliverResponse?.({ message, isQuestion, ts: Date.now() })

  // Persist a verbatim memory row so a follow-up prompt's
  // `<conversation_history>` block can show what the AI told the user.
  // Fire-and-forget: a memory hiccup never aborts the user-visible
  // message. Swallow errors at the boundary the same way activity
  // logging does.
  try {
    await appendAiMessage(session.docAccess, {
      sessionId: session.sessionId,
      kind: 'message_to_user',
      body: { message, isQuestion }
    })
  } catch (e) {
    log.warn('message_to_user memory append failed', { err: e })
  }

  return toolOk(
    isQuestion
      ? 'Question shown to user (sticky). Wait for their reply in a follow-up turn, do not send another question.'
      : 'Message shown to user (auto-collapses after 2s). Do not repeat it in a comment or in the document.'
  )
}

export const messageToUserTool = defineDocTool({
  name: 'message_to_user',
  description: 'Send a short ephemeral message to the user above the AI prompt bar. Use when the user asked something whose answer does NOT belong in the document (a quick finding, a brief explanation, a clarifying question), OR when the task is genuinely ambiguous and you need the user to choose before proceeding. Set `is_question: true` ONLY when you cannot proceed without an answer, that keeps the message on screen until they reply or dismiss. Plain messages auto-collapse after 2 seconds. Prefer SILENCE for "Done" / "Changes applied", the doc edit is already the receipt. Counts as a valid terminal tool call: a turn that ends with `message_to_user` (and optionally edits) is fine.',
  schema: MessageToUserArgs,
  handler: handleMessageToUser
})
