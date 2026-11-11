import { docBrandForClient } from '../../../utils/brandKit/docBrand'
import { eq } from 'drizzle-orm'
import { documents } from '../../../db/schema'
import { renderTemplate } from '../../../utils/documents/templateRenderer'
import { canDownload, decideTokenAccess } from '../../../../shared/utils/documents/docPermissions'

// GET /api/docs/:docId/meta — document metadata.
//
// Public route (whitelisted), but gated by the SAME decision as the
// token endpoint (`decideTokenAccess`): a caller who couldn't open the
// doc learns only what the editor needs to draw the gate —
// `{ accessMode, requiresPassword, forbidden }` — never the title,
// description, owner, theme or workspace. A visitor who unlocked a
// password-protected doc proves it with the doc JWT from
// `POST /password` (`Authorization: Bearer …`) and gets the full shape;
// the editor uses that to hydrate theme + document context after the
// unlock.
export default defineApiHandler({
  access: allow.doc('lookup', {
    anonymous: true,
    // Session-shaped doc JWTs only: a `file-access` token does not unlock the metadata.
    jwt: true,
    reason: 'decideTokenAccess (or a doc JWT from the password unlock, void once the share link expired): full metadata, otherwise only the gate fields'
  }),
  handler: async ({ docId, doc: authz, state, actor }) => {
    const decision = decideTokenAccess(state, actor)
    // An expired share link also ends what an earlier password unlock
    // (its JWT) gave — only the owner and members keep seeing the metadata.
    if (decision.outcome !== 'allow' && (state.shareExpired || !actor.hasValidDocJwt)) {
      return {
        docId,
        // The effective mode: once a link has expired it reads `private`,
        // never what it was before.
        accessMode: state.accessMode,
        hasPassword: state.accessMode === 'password-protected',
        requiresPassword: decision.outcome === 'password-required',
        forbidden: decision.outcome === 'forbidden'
      }
    }

    // Explicit projection — never ship `passwordHash` over a public endpoint.
    const db = useDatabase()
    const doc = (await db
      .select({
        id: documents.id,
        docId: documents.docId,
        ownerId: documents.ownerId,
        title: documents.title,
        accessMode: documents.accessMode,
        sizeBytes: documents.sizeBytes,
        wordCount: documents.wordCount,
        theme: documents.theme,
        description: documents.description,
        audience: documents.audience,
        language: documents.language,
        templateId: documents.templateId,
        workspaceId: documents.workspaceId,
        createdAt: documents.createdAt,
        lastActive: documents.lastActive
      })
      .from(documents)
      .where(eq(documents.docId, docId))
      .limit(1))[0]

    if (!doc) {
      throw apiError('docs/not-found')
    }

    // Boolean is safe to expose; the hash itself is not.
    const hasPassword = doc.accessMode === 'password-protected'
    // The workspace id is read for the brand kit only; it is not part of this
    // public shape.
    const { workspaceId, ...publicDoc } = doc
    return {
      ...publicDoc,
      // Share-link controls: this viewer may not download or print.
      noDownload: !canDownload(state, actor, authz.shareNoDownload),
      // Workspace brand kit, as on the token endpoint.
      brandKit: await docBrandForClient(workspaceId),
      hasPassword,
      requiresPassword: false,
      forbidden: false,
      // Rendered template body, same as the token endpoint ships — lets
      // the editor seed an empty doc after a password unlock.
      initialBody: renderTemplate(doc.templateId, {
        title: doc.title,
        description: doc.description,
        language: doc.language
      })
    }
  }
})
