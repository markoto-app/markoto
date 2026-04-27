import { AUDIENCES, type AudienceKind } from '~~/shared/audiences'
import { resolveLanguageDisplayName } from '~~/shared/languages'

/**
 * Build the `<document_context>` block prepended to every AI system
 * prompt. The block carries the durable per-document properties the
 * model needs every turn:
 *   - `Title` — what to call this thing
 *   - `About` — the user's one-line description (omitted line if empty
 *     to keep the prompt lean; the block itself is always present)
 *   - `Language` — display name of the doc's language; the AI is told
 *     to write all prose in this language
 *   - `Audience guidance` — the curated tone fragment from
 *     `shared/audiences/index.ts`
 *
 * Why one always-present block (not a conditional "if any field set"
 * gate): the schema makes all four fields NOT NULL with sane defaults,
 * so every doc has authoritative values. A conditional block would only
 * skip itself for theoretical legacy NULL data that can no longer
 * exist after migration 0001.
 *
 * Returns the block as a string ready to concatenate into the system
 * prompt — including its trailing newlines so the next block can be
 * appended raw without spacing fixes at the call site.
 */

export interface DocumentContext {
  title: string
  description: string
  audience: AudienceKind
  language: string
}

export function buildDocumentContext(ctx: DocumentContext): string {
  const fragment = AUDIENCES[ctx.audience].promptFragment
  const languageName = resolveLanguageDisplayName(ctx.language)
  // Conditionally emit the `About:` line — empty description = "user
  // didn't fill it in", and adding "About: " with a blank value just
  // wastes tokens and looks broken to the model.
  const aboutLine = ctx.description.trim().length > 0
    ? `About: ${ctx.description}\n`
    : ''
  return (
    `<document_context>\n`
    + `Title: ${ctx.title}\n`
    + aboutLine
    + `Language: ${languageName}\n\n`
    + `Audience guidance:\n${fragment}\n\n`
    + `Language guidance:\n`
    + `Write all prose in ${languageName}. This includes section headings, body text, bullet labels, and any prose you generate. Do NOT translate code blocks, technical identifiers, or proper nouns that have an established form in another language. If the existing document body contains text in another language, treat it as legacy content — write your additions in ${languageName} regardless.\n`
    + `</document_context>\n\n`
  )
}
