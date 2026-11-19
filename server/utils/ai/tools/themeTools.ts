import { aiStatus } from '~~/shared/ai/statusSteps'
import { SETTINGS_NOT_SUGGESTIBLE } from './textWrite'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import * as Sentry from '@sentry/nuxt'
import { defineDocTool, defineMetaTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import { UpdateThemeArgs, type UpdateThemeInput } from './themeSchema'
import { coerceThemePatch, mergeTheme, summarizePatch } from './themeMerge'
import { writeAccessOf, type DocToolContext, type MetaToolContext } from '../../agentic/toolContext'
import type { DocAccess } from '../../../repos/proofs'
import type { DocTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'
import { themeImagesForDoc } from '~~/shared/utils/theme/themeImages'
import { adaptCustomCssToDoc, formatCustomCssIssues } from '~~/shared/utils/theme/customCss'
import { customCssAppOrigins, themeCustomCssIssues } from '../../rendering/themeCustomCss'
import { capsFor, planHasFeature, resolveDocPlan, resolveUserPlan } from '../../billing/entitlements'
import { THEME_PRESETS, themeFromPreset } from '~~/shared/utils/theme/themePresets'
import {
  SAVED_THEME_DESCRIPTION_MAX,
  SAVED_THEME_NAME_MAX,
  checkSavedThemeDescription,
  checkSavedThemeName
} from '~~/shared/config/savedThemes'
import { resolveDocBrand } from '../../brandKit/docBrand'
import { DOC_OWNED_COVER_FIELDS } from '~~/shared/utils/theme/brandLock'
import { getDoc, updateDocMeta } from '../../../repos/documents'
import { countThemesByUser, createTheme, getThemeById, listThemesByUser } from '../../../repos/themes'
import { getWorkspaceOfDoc } from '../../../repos/workspaces'
import { useLogger } from '../../platform/logger'
import { TOOL_RESULT_CHAR_CAP } from '../../agentic/limits'

// The document's theme: update_theme (patch over a base: current theme,
// preset, saved theme or workspace default), get_theme, list_themes,
// save_theme_as_preset.

const log = useLogger('ai-tools')

/** Room the list_themes result gets, below the loop's result cap. */
const LIST_THEMES_CHAR_BUDGET = TOOL_RESULT_CHAR_CAP - 2_000

// Theme inspection / preset management: three thin tools so the AI can reason about styling beyond just
// "apply a built-in preset":
//   - get_theme: read the current ymeta.theme. No args.
//   - list_themes: enumerate the initiator's saved themes + the
//     workspace default (when applicable). Drives "mix Brand red with
//     academic" requests by giving the model both halves to compare.
//   - save_theme_as_preset: capture the current ymeta.theme as a new
//     row in `themes` for the initiator. Per-user 20-cap.
//
// All three reuse the `initiatorUserId` already on the AI session;
// they're light enough to be ALWAYS-ON (no workspace-gated split).

const GetThemeArgs = z.object({}).describe('Read the document\'s current theme as JSON. Use BEFORE calling `update_theme` for "mix theme X with theme Y" or "tweak the current colors", without it you don\'t know what the doc looks like right now. Pure read; no edits.')

const ListThemesArgs = z.object({}).describe('List the user\'s saved theme presets AND the workspace default theme (if the document is in a workspace and a default is set). Each saved theme returns its theme_id, name, and full theme JSON; pass the theme_id to `update_theme` to apply one as the base. Use when the user mentions a theme by name ("apply my Brand red", "use the workspace default"). Pure read; no edits.')

export const SaveThemeAsPresetArgs = z.object({
  name: z.string().trim().min(1).max(SAVED_THEME_NAME_MAX)
    .describe(`User-visible name for the preset (1–${SAVED_THEME_NAME_MAX} chars). Should describe what the theme is for ("Brand red", "Quarterly report", "Academic mix"). Becomes the label in the user's saved-themes list.`),
  description: z.string().trim().max(SAVED_THEME_DESCRIPTION_MAX).optional()
    .describe(`Optional one-line description shown under the name (≤${SAVED_THEME_DESCRIPTION_MAX} chars), e.g. "Two columns, serif body, for papers".`)
}).describe('Save the document\'s CURRENT theme as a personal preset for the initiator. Available across all their documents from the theme picker afterwards. Capped at 20 saved themes per user, call returns an error if the cap is reached. Only call when the user explicitly asks to save / bookmark / remember a theme. Does NOT change the current document\'s theme; pair with `update_theme` if they also want it applied somewhere.')

async function checkBrandLock(access: DocAccess<'view'>, input: UpdateThemeInput): Promise<ToolResult | null> {
  const doc = await getDoc(access)
  if (!doc || !(await resolveDocBrand(access)).lockedTheme) return null
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && v !== false)
  const outside = entries.filter(([k]) => k !== 'cover').map(([k]) => k)
  const cover = (input as { cover?: Record<string, unknown> }).cover
  const coverOutside = cover ? Object.keys(cover).filter(k => cover[k] !== undefined && !(DOC_OWNED_COVER_FIELDS as readonly string[]).includes(k)) : []
  if (outside.length === 0 && coverOutside.length === 0) return null
  return toolError(`Error: this workspace's admins locked the design, nothing was changed. Every document in the workspace uses the workspace design; only the cover ${DOC_OWNED_COVER_FIELDS.join(', ')} can be changed per document. Tell the user to ask a workspace admin to change the workspace design (Brand kit) if they need a different look.`)
}

async function handleUpdateTheme(
  session: DocToolContext,
  input: UpdateThemeInput
): Promise<ToolResult> {
  // Suggestion mode: a theme can't be suggested.
  if (session.suggestSink) return toolError(SETTINGS_NOT_SUGGESTIBLE)
  const conflictErr = checkBaseSourceConflict(input)
  if (conflictErr) return conflictErr

  // Brand kit: a locked workspace design, only the cover text is
  // the document's own. Anything else would be stored but never shown.
  const lockErr = await checkBrandLock(session.docAccess, input)
  if (lockErr) return lockErr

  const baseResult = await resolveBaseTheme(session, input)
  if (!baseResult.ok) return baseResult.error

  // Image URLs (cover logo, header/footer image) may only point at this
  // document's uploads. Foreign or malformed ones, from the patch or
  // from a base theme made in another document, are cleared first so
  // the result can validate, and the model is told.
  const images = themeImagesForDoc(mergeTheme(baseResult.theme, coerceThemePatch(input)), session.docId)
  const merged = images.theme
  if (!isValidTheme(merged)) {
    // Should never happen: the Zod schema's enums/ranges mirror
    // isValidTheme: but this is defence-in-depth so we never write
    // structurally invalid JSON into the DB or Y.Doc.
    return toolError('Error: merged theme failed validation. Try narrower changes.')
  }

  // Plan gate: a document whose plan lacks custom CSS can't get NEW CSS
  // from the model (CSS already stored, or carried by the base theme, is
  // kept but not applied, the renderers drop it).
  if (typeof input.customCss === 'string' && input.customCss.trim() !== ''
    && !planHasFeature(await resolveDocPlan(session.docId), 'customCss')) {
    return toolError('Error: custom CSS is not included in this document\'s plan, nothing was changed. Retry without customCss, or tell the user it needs a plan with custom CSS.')
  }

  const css = resolveThemeCustomCss(merged, input.customCss !== undefined, session.docId, customCssAppOrigins())
  if (!css.ok) return toolError(css.error)

  session.updateStatus('editing', aiStatus('updateTheme'))
  applyThemeToYDoc(session, css.theme)
  await persistThemeBestEffort(session, css.theme)

  const imageNote = images.dropped.length > 0
    ? ` Note: ${images.dropped.join(', ')} did not point at an image uploaded to this document and ${images.dropped.length === 1 ? 'was' : 'were'} cleared.`
    : ''
  return toolOk(`Theme updated. Changed sections: ${summarizePatch(input)}. Changes are now live in the preview.${css.note}${imageNote}`)
}

/**
 * Custom-CSS gate for `update_theme` (same sanitizer as every other
 * write path). CSS the model SENT is all-or-nothing: any issue rejects
 * the call with line/column details so it can fix and retry. CSS that
 * only came along with the base theme (a saved theme / workspace
 * default made in another document) is adapted instead: rules that
 * can't work here, usually another document's uploaded images, are
 * dropped and the result says so.
 *
 * @internal exported for unit tests; not part of the public API.
 */
export function resolveThemeCustomCss(
  merged: DocTheme,
  cssFromPatch: boolean,
  docId: string,
  origins: readonly string[]
): { ok: true, theme: DocTheme, note: string } | { ok: false, error: string } {
  if (cssFromPatch) {
    const issues = themeCustomCssIssues(merged, docId, origins)
    if (issues.length > 0) {
      return { ok: false, error: `Error: customCss rejected, nothing was changed. Fix these and retry:\n${formatCustomCssIssues(issues)}` }
    }
    return { ok: true, theme: merged, note: '' }
  }
  const adapted = adaptCustomCssToDoc(merged.customCss, { docId, allowedOrigins: origins })
  if (adapted.dropped.length === 0) return { ok: true, theme: merged, note: '' }
  return {
    ok: true,
    theme: { ...merged, customCss: adapted.css },
    note: ` Note: ${adapted.dropped.length} custom CSS rule(s) from the base theme could not be used in this document and were removed.`
  }
}

type BaseResolution = { ok: true, theme: DocTheme } | { ok: false, error: ToolResult }

/**
 * Base theme sources are mutually exclusive in priority order:
 *   - `preset`: built-in id (markoto, modern, …)
 *   - `theme_id`: initiator's own saved-theme id
 *   - `from_workspace_default`: workspace default (snapshot)
 *   - default: current ymeta.theme → DB → markoto
 *
 * Passing more than one is a usage error; surface it loudly so the
 * model self-corrects rather than silently picking one. Other fields
 * in the same call merge on top of whichever base is chosen, so
 * "preset arxiv with my brand red" is one call.
 */
function checkBaseSourceConflict(input: UpdateThemeInput): ToolResult | null {
  const baseSources: string[] = []
  if (input.preset) baseSources.push('preset')
  if (input.theme_id) baseSources.push('theme_id')
  if (input.from_workspace_default) baseSources.push('from_workspace_default')
  if (baseSources.length > 1) {
    return toolError(`Error: pass only ONE of preset/theme_id/from_workspace_default; received: ${baseSources.join(', ')}.`)
  }
  return null
}

/**
 * Resolve the base theme by source. Saved themes are per-user; we tie
 * ownership to the SESSION INITIATOR (the human who triggered the
 * loop), not the AI's synthetic principal, so an AI session can't
 * access another user's saved themes even if the caller hallucinates
 * an id. Returns a `ToolResult` with `error:true` on resolution
 * failure (preset id unknown, saved theme missing, workspace default
 * unset).
 */
async function resolveBaseTheme(session: DocToolContext, input: UpdateThemeInput): Promise<BaseResolution> {
  if (input.preset) {
    const preset = THEME_PRESETS.find(p => p.id === input.preset)
    if (!preset) {
      // Should be unreachable: Zod enum restricts `preset` to known ids.
      return { ok: false, error: toolError(`Error: Unknown preset "${input.preset}".`) }
    }
    // Keep the document's own custom CSS; a preset's template CSS goes in
    // front of it (same behaviour as the theme panel).
    const current = await resolveCurrentTheme(session)
    return { ok: true, theme: themeFromPreset(preset, current.customCss) }
  }
  if (input.theme_id) {
    const saved = await getThemeById(session.self, input.theme_id)
    if (!saved) {
      return { ok: false, error: toolError(`Error: saved theme "${input.theme_id}" not found. Call list_themes for valid ids.`) }
    }
    return { ok: true, theme: saved.theme }
  }
  if (input.from_workspace_default) {
    if (!session.workspaceId) {
      return { ok: false, error: toolError('Error: from_workspace_default requires the document to be in a workspace.') }
    }
    // The document's own workspace (keyed on the document proof).
    const ws = session.docAccess ? await getWorkspaceOfDoc(session.docAccess) : null
    if (!ws?.defaultTheme) {
      return { ok: false, error: toolError('Error: this workspace has no default theme set. Ask an admin to set one, or pick a preset / saved theme instead.') }
    }
    return { ok: true, theme: ws.defaultTheme }
  }
  return { ok: true, theme: await resolveCurrentTheme(session) }
}

function applyThemeToYDoc(session: DocToolContext, merged: DocTheme): void {
  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    session.ymeta.set('theme', merged)
  }, origin)
}

/**
 * Persist to DB so fresh visitors on a new socket see the new theme
 * during the window before the sync server replays Y.js state. Mirrors
 * the client-side `persistTheme` debounce in `useDocument.ts`.
 *
 * Best-effort: Y.js broadcast already landed the change live to
 * everyone. Worst case on a DB hiccup: a new visitor sees stale
 * theme for the few hundred ms between connect and first Y.js sync.
 */
async function persistThemeBestEffort(session: DocToolContext, merged: DocTheme): Promise<void> {
  try {
    await updateDocMeta(writeAccessOf(session), { theme: merged })
  } catch (e) {
    log.warn('theme DB persist failed', { docId: session.docId, err: e })
    Sentry.captureException(e, {
      tags: { component: 'aiToolAdapter', event: 'theme_persist_failed', docId: session.docId }
    })
  }
}

/**
 * Resolve the document's current theme, in the same priority order
 * `handleUpdateTheme` uses for its no-base-source path:
 *   ymeta.theme → DB documents.theme JSONB → markoto default.
 *
 * Shared because both `get_theme` and `save_theme_as_preset` need
 * "what theme is the doc using right NOW," and we want them in lockstep.
 */
async function resolveCurrentTheme(session: DocToolContext): Promise<DocTheme> {
  const fromYmeta = session.ymeta.get('theme')
  if (isValidTheme(fromYmeta)) return fromYmeta
  const doc = await getDoc(session.docAccess)
  return (doc?.theme && isValidTheme(doc.theme)) ? doc.theme : defaultTheme
}

async function handleGetTheme(
  session: DocToolContext,
  _input: z.output<typeof GetThemeArgs>
): Promise<ToolResult> {
  const theme = await resolveCurrentTheme(session)
  // Pretty-print so the model can read structure in the conversation
  // log. Stringification is bounded, DocTheme is small and flat (a
  // few hundred chars when minified).
  return toolOk(JSON.stringify(theme, null, 2))
}

async function handleListThemes(
  session: MetaToolContext,
  _input: z.output<typeof ListThemesArgs>
): Promise<ToolResult> {
  // Saved themes are SCOPED TO THE SESSION INITIATOR, never the AI's
  // synthetic principal. This is the same ownership boundary
  // `handleUpdateTheme` enforces when accepting a `theme_id`.
  const saved = await listThemesByUser(session.self)
  let workspaceDefault: DocTheme | null = null
  if (session.workspaceId && session.docAccess) {
    const ws = await getWorkspaceOfDoc(session.docAccess)
    workspaceDefault = ws?.defaultTheme ?? null
  }

  // Surface the model's two halves clearly: a structured list of
  // saved themes (ids included for `theme_id` callbacks) plus the
  // workspace default as a separate field. Dumping JSON is more
  // useful than a prose summary because the next likely action is
  // `update_theme` with field-level overrides, the model wants to
  // diff the JSONs.
  const notes = [
    'Pass theme_id to update_theme to apply a saved theme as the base.',
    'Pass from_workspace_default: true to apply the workspace default.',
    'Both replace the base; sibling fields (body.*, headings.*, color.*) merge on top.'
  ]
  const full = {
    savedThemes: saved.map(s => ({ theme_id: s.themeId, name: s.name, description: s.description, theme: listedTheme(s.theme) })),
    workspaceDefault: workspaceDefault ? { theme: listedTheme(workspaceDefault), scope: 'workspace' as const } : null,
    notes
  }
  const pretty = JSON.stringify(full, null, 2)
  if (pretty.length <= LIST_THEMES_CHAR_BUDGET) return toolOk(pretty)
  // Too long with every theme in full: compact JSON, and themes past the
  // budget by name only (applying them by theme_id still works).
  let size = JSON.stringify({ ...full, savedThemes: [] }).length + 400
  const savedThemes = full.savedThemes.map((t) => {
    const entry = JSON.stringify(t)
    if (size + entry.length > LIST_THEMES_CHAR_BUDGET) return { theme_id: t.theme_id, name: t.name, description: t.description, theme: null }
    size += entry.length + 1
    return t
  })
  return toolOk(JSON.stringify({
    savedThemes,
    workspaceDefault: full.workspaceDefault,
    notes: [...notes, 'Themes with "theme": null did not fit in this result (size limit); apply one with update_theme and theme_id, then read it with get_theme.']
  }))
}

/** Characters of a theme's custom CSS shown by list_themes; applying the theme keeps all of it. */
const LISTED_CUSTOM_CSS_MAX = 1_500

/** A theme as list_themes shows it: long custom CSS shortened. */
function listedTheme(theme: DocTheme): DocTheme {
  const css = theme.customCss
  if (typeof css !== 'string' || css.length <= LISTED_CUSTOM_CSS_MAX) return theme
  return { ...theme, customCss: `${css.slice(0, LISTED_CUSTOM_CSS_MAX)}\n/* ${css.length - LISTED_CUSTOM_CSS_MAX} more characters not shown here; applying this theme keeps them */` }
}

async function handleSaveThemeAsPreset(
  session: DocToolContext,
  input: z.output<typeof SaveThemeAsPresetArgs>
): Promise<ToolResult> {
  const nameCheck = checkSavedThemeName(input.name)
  if (!nameCheck.ok) {
    return toolError(nameCheck.issue === 'too-long'
      ? `Error: name too long (max ${SAVED_THEME_NAME_MAX}).`
      : `Error: name is required (1–${SAVED_THEME_NAME_MAX} chars).`)
  }
  const name = nameCheck.value
  const descriptionCheck = checkSavedThemeDescription(input.description)
  if (!descriptionCheck.ok) {
    return toolError(`Error: description too long (max ${SAVED_THEME_DESCRIPTION_MAX}).`)
  }

  // Saved themes are personal, anonymous AI sessions (no logged-in
  // initiator) can't have saved themes. The `/api/ai/prompt` route
  // requires login, so this branch is defence-in-depth.
  if (!session.initiatorUserId) {
    return toolError('Error: saving a theme requires a logged-in user.')
  }

  // Cap check before write, the same plan limit (`savedThemes`) the
  // REST endpoint enforces. The cap is correctness-critical (storage
  // growth), not a rate limit, so we re-check rather than relying on a
  // Valkey hint.
  const owned = await countThemesByUser(session.self)
  const savedThemesLimit = capsFor(await resolveUserPlan(session.initiatorUserId)).savedThemes
  if (owned >= savedThemesLimit) {
    return toolError(`Error: you've reached the saved-theme limit of the user's plan (${savedThemesLimit}). Ask the user to delete an unused saved theme first.`)
  }

  const theme = await resolveCurrentTheme(session)

  session.updateStatus('tool', aiStatus('saveTheme', { name: name.slice(0, 40) }))

  const themeId = nanoid(10)
  await createTheme(session.self, {
    themeId,
    name,
    description: descriptionCheck.value,
    theme
  })

  return toolOk(`Saved current theme as "${name}" (theme_id: ${themeId}). It's now in the user's saved themes; reapply later via update_theme with theme_id.`)
}

export const updateThemeTool = defineDocTool({
  name: 'update_theme',
  description: 'Update the document theme (page size, fonts, colors, margins, columns, headers/footers, code styling, tables, TOC, etc.). Pass ONLY the fields you want to change, omitted keys keep their current value. Changes appear live in the preview and persist. Use this whenever the user asks for typographic, layout, or styling changes. Three optional base sources (mutually exclusive): `preset` (built-in id), `theme_id` (one of the user\'s saved themes from list_themes), or `from_workspace_default: true` (the workspace\'s default theme). Without any base source, your patch merges over the CURRENT theme.',
  schema: UpdateThemeArgs,
  handler: handleUpdateTheme
})

export const getThemeTool = defineDocTool({
  name: 'get_theme',
  description: 'Read the document\'s current theme as JSON. Use this BEFORE update_theme when the user asks for a TWEAK to current styling ("make it warmer", "tighten the margins") or wants to MIX the current theme with another. Without this call you can only blindly replace the theme.',
  schema: GetThemeArgs,
  handler: handleGetTheme
})

export const listThemesTool = defineMetaTool({
  name: 'list_themes',
  description: 'List the user\'s saved theme presets and the workspace\'s default theme (when applicable). Use BEFORE update_theme when the user names a theme by NAME ("apply my Brand red", "use the workspace default") or asks to combine two named themes. Returns each saved theme with its theme_id and full JSON so you can compare side-by-side and merge specific fields.',
  schema: ListThemesArgs,
  handler: handleListThemes
})

export const saveThemeAsPresetTool = defineDocTool({
  name: 'save_theme_as_preset',
  description: 'Save the CURRENT document theme as one of the user\'s personal presets, available across all their documents going forward. Per-user cap is 20 saved themes; over-cap calls error. Only call when the user explicitly asks to save / bookmark / remember a theme, never volunteer this. Does not modify the document.',
  schema: SaveThemeAsPresetArgs,
  handler: handleSaveThemeAsPreset
})
