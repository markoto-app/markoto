import { z } from 'zod'
import { nanoid } from 'nanoid'
import { defineDocTool, defineMetaTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import type { DocToolContext, MetaToolContext } from '../../agentic/toolContext'
import { TEMPLATE_IDS, TEMPLATE_TOOL_HINT } from '~~/shared/templates'
import { AUDIENCE_KINDS } from '~~/shared/audiences'
import { resolveDocProperties } from '../../documents/docProperties'
import { buildMarkdownExport } from '~~/shared/utils/markdown/markdownFrontmatter'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { getDoc } from '../../../repos/documents'
import { proveWorkspaceAccess } from '../../access/workspaceAccess'
import { proveDocMembership } from '../../access/docProof'
import type { WorkspaceAccess } from '../../../repos/proofs'
import { DOWNLOAD_DISABLED_MESSAGE, userMayDownload } from '../../access/shareSettings'
import { openTrustedCommentClient } from '../../documents/commentsServerClient'
import { createDocument } from '../../documents/createDocument'
import { withoutEmDashes } from '../dashFilter'
import { duplicateDocument } from '../../documents/duplicateDocument'
import { useS3Client } from '../../storage/s3'
import { resolveImageQuota } from '../../storage/imageQuota'
import { useEnv } from '~~/shared/env/load'
import { folderWorkspace } from './folderTools'

// Host-style tools: tools that operate AT the user's library level rather than inside a
// specific doc: create + duplicate + export. Available to both the
// in-app agentic loop and MCP clients.

const TEMPLATE_ID_ENUM = TEMPLATE_IDS.length > 0
  ? (TEMPLATE_IDS as [string, ...string[]])
  : (['blank'] as [string, ...string[]])

const CreateDocumentArgs = z.object({
  title: z.string().trim().max(255).optional()
    .describe('Doc title (≤255 chars after trimming). Empty / omitted falls back to "Untitled".'),
  initial_markdown: z.string().max(100_000).optional()
    .describe('Optional initial body for the new doc. Up to 100k chars. The new doc is opened as a Y.js client and this string is inserted at the start before the tool returns. Omit to get an empty doc.'),
  workspace_id: z.string().min(1).optional()
    .describe('Optional workspace id to file the doc into. Caller MUST be admin or editor of the workspace; viewers and non-members get a 403. Omit for a personal (non-workspace) doc, or to use folder_id\'s workspace.'),
  folder_id: z.string().trim().min(1).max(64).optional()
    .describe('Optional folder to file the doc in (an id from list_folders). Without workspace_id the doc goes into the folder\'s own workspace (or your personal documents for a personal folder).'),
  description: z.string().max(500).optional()
    .describe('Optional one-sentence summary, ≤500 chars. Surfaced in doc listings + injected into AI prompts as the doc\'s purpose statement.'),
  audience: z.enum(AUDIENCE_KINDS as [string, ...string[]]).optional()
    .describe(`Audience the doc is written for, drives AI tone steering. One of: ${AUDIENCE_KINDS.join(', ')}.`),
  language: z.string().trim().min(1).max(50).optional()
    .describe('Free-form language label ("English", "Deutsch", "Schwiizerdütsch"). Used in AI prompts as the writing language.'),
  template_id: z.enum(TEMPLATE_ID_ENUM).optional()
    .describe(`Template: a starting text plus the design it is written for. Its body becomes the initial markdown when initial_markdown is NOT provided, and without theme_preset / theme_id the doc gets the template's design. One of: ${TEMPLATE_TOOL_HINT}.`),
  theme_preset: z.string().min(1).optional()
    .describe('Built-in theme preset id to apply (one of THEME_PRESETS); overrides the template\'s design. Mutually exclusive with theme_id.'),
  theme_id: z.string().min(1).max(64).optional()
    .describe('User-saved theme preset id (from list_themes). Mutually exclusive with theme_preset. Caller must own the theme.')
}).describe('Create a NEW document owned by the initiator. Returns { doc_id, url } so the caller can deep-link or follow up with view_document / insert_text. Optional initial_markdown seeds the doc body in one call.')

const DuplicateDocumentArgs = z.object({
  source_doc_id: z.string().trim().min(1)
    .describe('The doc id to duplicate. Caller must have edit access on the source.'),
  title: z.string().trim().max(255).optional()
    .describe('Title for the duplicate. Defaults to "Copy of {source title}" when omitted.'),
  workspace_id: z.string().optional()
    .describe('Target workspace id, or empty string to park as a personal (non-workspace) doc. Omit to inherit the source\'s workspace. Caller must be admin or editor of the target.')
}).describe('Duplicate a document into a new docId owned by the initiator. Carries over title, theme, accessMode, content (Y.js state with image-URL rewrite), and S3 image assets. Returns { doc_id, url }.')

export const ExportDocumentAsMarkdownArgs = z.object({
  doc_id: z.string().min(1)
    .describe('The doc id to export.')
}).describe('Export a document as a markoto Markdown file: YAML frontmatter (title, description, audience, language, templateId, theme) followed by the body without line-number prefixes. Use to deliver the doc to the user as a file, archive a snapshot, or feed it into another tool.')

async function handleCreateDocument(
  session: MetaToolContext,
  input: z.output<typeof CreateDocumentArgs>
): Promise<ToolResult> {
  // Anonymous initiators can't reach this path, every consumer
  // (MCP wrapper + agentic loop's prompt endpoint) requires an
  // authenticated user. The session.initiatorUserId is the real
  // human's id; we pass it through as ownerId.
  let workspaceId = input.workspace_id ?? null
  if (input.folder_id !== undefined && input.workspace_id === undefined) {
    // A folder belongs to one scope; filing into it implies that scope.
    const folderWs = await folderWorkspace(session.initiatorUserId, input.folder_id)
    if (folderWs === undefined) return toolError(`Error: folder "${input.folder_id}" not found.`)
    workspaceId = folderWs
  }
  let result: { docId: string, url: string }
  try {
    result = await createDocument({
      owner: session.self,
      title: input.title,
      description: input.description,
      audience: input.audience as Parameters<typeof createDocument>[0]['audience'],
      language: input.language,
      templateId: input.template_id,
      themePreset: input.theme_preset,
      themeId: input.theme_id,
      workspaceId,
      folderId: input.folder_id ?? null
    })
  } catch (e) {
    // createDocument throws createError(...); bubble the user-facing
    // message up as a tool error so the model self-corrects (e.g.
    // "Not a member of this workspace" → model picks a different
    // workspace_id or omits it).
    const msg = e instanceof Error ? e.message : 'Document creation failed'
    return toolError(`Error: ${msg}`)
  }

  // Optional initial markdown: open a transient Hocuspocus client on
  // the new doc, insert the body in one transact, disconnect. Mirrors
  // the `openTrustedCommentClient` pattern (server-side mutation
  // broadcast live so any other client connecting in the next few
  // seconds sees the seeded body via Y.js sync, not a refresh).
  //
  // Origin tag: 'seed:{userId}': the activity_log row sync-server
  // emits for this transact carries this string in `actor_principal`,
  // so the audit chain still resolves to the human (no agent kind,
  // because seeding isn't an agent action, just bootstrapping).
  const seed = input.initial_markdown === undefined ? undefined : withoutEmDashes(input.initial_markdown)
  if (seed && seed.length > 0) {
    try {
      const client = await openTrustedCommentClient(
        result.docId,
        `seed:${session.initiatorUserId}`
      )
      try {
        const ytext = client.ydoc.getText('content')
        client.ydoc.transact(() => {
          ytext.insert(0, seed)
        }, `seed:${session.initiatorUserId}`)
      } finally {
        await client.destroy()
      }
    } catch (e) {
      // Doc was created successfully; seeding failed. Surface as a
      // partial-success message so the caller knows to either retry
      // the seed or use insert_text.
      const msg = e instanceof Error ? e.message : 'unknown'
      return toolOk(JSON.stringify({
        doc_id: result.docId,
        url: result.url,
        warning: `Document created but initial_markdown seed failed: ${msg}. Use insert_text({doc_id: "${result.docId}", insert_line: 0, insert_text: "..."}) to populate.`
      }, null, 2))
    }
  }

  return toolOk(JSON.stringify({
    doc_id: result.docId,
    url: result.url
  }, null, 2))
}

async function handleDuplicateDocument(
  session: MetaToolContext,
  input: z.output<typeof DuplicateDocumentArgs>
): Promise<ToolResult> {
  // Authz mirrors the in-app duplicate endpoint:
  //   - canEditDoc on source (anyone who can edit can fork)
  //   - admin/editor on target workspace if specified (else inherit
  //     source's workspace)
  const proven = await proveDocMembership(session.initiatorUserId, input.source_doc_id, 'edit')
  const source = proven ? await getDoc(proven.access) : null
  if (!proven || !source) {
    return toolError(`Error: source document "${input.source_doc_id}" not found, or you don't have access to it.`)
  }
  // View only: a copy is a download.
  if (!(await userMayDownload(input.source_doc_id, session.initiatorUserId))) {
    return toolError(`Error: ${DOWNLOAD_DISABLED_MESSAGE} Tell the user.`)
  }

  // Resolve target workspace. `''` from the schema means "park as
  // personal" (null); `undefined` means "inherit source"; a non-empty
  // string is an explicit target.
  let targetWorkspaceId: string | null
  if (input.workspace_id === undefined) {
    targetWorkspaceId = source.workspaceId
  } else if (input.workspace_id === '') {
    targetWorkspaceId = null
  } else {
    targetWorkspaceId = input.workspace_id
  }
  let target: WorkspaceAccess<'editor'> | null = null
  if (targetWorkspaceId !== null) {
    const member = await proveWorkspaceAccess(session.initiatorUserId, targetWorkspaceId, 'member')
    if (!member?.allows('editor')) {
      return toolError(`Error: cannot duplicate into workspace "${targetWorkspaceId}", must be admin or editor.`)
    }
    target = member
  }

  const title = input.title?.trim() || `Copy of ${source.title}`
  const newDocId = nanoid(10)
  const env = useEnv()
  try {
    await duplicateDocument(
      {
        source: proven.access,
        newDocId,
        owner: session.self,
        workspace: target,
        title
      },
      {
        s3: useS3Client(),
        bucket: env.storage.bucket,
        imageQuota: await resolveImageQuota(session.initiatorUserId, null, targetWorkspaceId)
      }
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Duplicate failed'
    return toolError(`Error: ${msg}`)
  }
  return toolOk(JSON.stringify({
    doc_id: newDocId,
    url: `/d/${newDocId}`
  }, null, 2))
}

async function handleExportDocumentAsMarkdown(
  session: DocToolContext,
  _input: z.output<typeof ExportDocumentAsMarkdownArgs>
): Promise<ToolResult> {
  // The wrapper has already authz-checked + checked out the YDocPool
  // entry, so session.ytext / ymeta are the live synced doc.
  const doc = await getDoc(session.docAccess)
  if (!doc) return toolError('Error: document not found.')
  // Share-link controls: a visitor may not download a view-only doc.
  if (!(await userMayDownload(session.docId, session.initiatorUserId))) {
    return toolError(`Error: ${DOWNLOAD_DISABLED_MESSAGE} Tell the user.`)
  }
  // Same file the editor's "Download Markdown" writes: markoto YAML
  // frontmatter (theme + properties, live ymeta first, row as fallback)
  // on top of the raw body. NO line-number prefixes, view_document is
  // for inspection; this is for delivery / archival / re-import.
  const props = resolveDocProperties(session.ymeta, doc)
  return toolOk(buildMarkdownExport(session.ytext.toJSON(), {
    title: props.title,
    description: props.description,
    audience: props.audience,
    language: props.language,
    templateId: props.templateId,
    theme: props.theme ?? defaultTheme
  }))
}

export const createDocumentTool = defineMetaTool({
  name: 'create_document',
  description: 'Create a NEW document owned by the initiator. Optional initial_markdown seeds the doc body in one call (no follow-up insert_text needed). Optional workspace_id files into a workspace (caller must be admin/editor of it), optional folder_id into one of its folders. Returns { doc_id, url }, share the url with the user or follow up with view_document / insert_text against the new doc_id.',
  schema: CreateDocumentArgs,
  trustBoundary: 'confirm',
  handler: handleCreateDocument
})

export const duplicateDocumentTool = defineMetaTool({
  name: 'duplicate_document',
  description: 'Duplicate an existing document into a new docId owned by the initiator. Carries title, theme, accessMode, content (Y.js state with image-URL rewrite), and S3 image assets. Caller must have edit access on the source. Use for "fork this template", "make a copy I can edit", "branch this for revision". Returns { doc_id, url }.',
  schema: DuplicateDocumentArgs,
  trustBoundary: 'confirm',
  handler: handleDuplicateDocument
})

// Reads ytext directly: DOC-bound. Pure read; no mutation.
export const exportDocumentAsMarkdownTool = defineDocTool({
  name: 'export_document_as_markdown',
  description: 'Export a document as a markoto Markdown file, the same file the editor\'s "Download Markdown" writes: YAML frontmatter (markoto version, title, description, audience, language, templateId, theme) followed by the full body without line-number prefixes. Importing the file restores the theme and properties. Use when the caller wants the doc as a file (deliver to user, archive, feed to another tool). Different from view_document, which is for AI inspection of the working text.',
  schema: ExportDocumentAsMarkdownArgs,
  handler: handleExportDocumentAsMarkdown
})
