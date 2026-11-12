import { docBrandForClient } from '../../../utils/brandKit/docBrand'
import { getDocMetaForViewer } from '../../../repos/documents'
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
  handler: async ({ docId, doc: authz, state, actor, docAccess }) => {
    const decision = decideTokenAccess(state, actor)
    // An expired share link also ends what an earlier password unlock
    // (its JWT) gave — only the owner and members keep seeing the metadata.
    if (decision.outcome !== 'allow' && (state.shareExpired || !actor.hasValidDocJwt)) {
      return {
        // The two answers' discriminant: only a granted one carries the document's fields.
        granted: false as const,
        docId,
        // The effective mode: once a link has expired it reads `private`,
        // never what it was before.
        accessMode: state.accessMode,
        hasPassword: state.accessMode === 'password-protected',
        requiresPassword: decision.outcome === 'password-required',
        forbidden: decision.outcome === 'forbidden'
      }
    }

    // Everyone who reaches this point may open the document; the proof agrees
    // (a doc JWT or the decision above grants file access).
    if (!docAccess.allows('view')) throw apiError('docs/not-found')
    // Explicit projection — never ship `passwordHash` over a public endpoint.
    const doc = await getDocMetaForViewer(docAccess)

    if (!doc) {
      throw apiError('docs/not-found')
    }

    // Boolean is safe to expose; the hash itself is not.
    const hasPassword = doc.accessMode === 'password-protected'
    return {
      granted: true as const,
      ...doc,
      // Share-link controls: this viewer may not download or print.
      noDownload: !canDownload(state, actor, authz.shareNoDownload),
      // Workspace brand kit, as on the token endpoint.
      brandKit: await docBrandForClient(docAccess),
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
