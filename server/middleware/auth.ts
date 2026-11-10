import { isTestModeEnabled } from '../../shared/utils/testMode'

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // Only protect /api/ routes
  if (!path.startsWith('/api/')) return

  // Public routes that don't require authentication.
  //
  // DEFAULT-DENY MODEL: any /api route NOT matched here requires a valid
  // session — there is no fall-through-open branch. Adding a new public
  // endpoint means adding an explicit entry to this list (with a comment
  // saying WHY it's public and where its own gating lives). The previous
  // model (whitelist + protected-prefix list + implicit fall-through) left
  // the most sensitive route class (/api/admin) with no middleware
  // backstop: a future admin route missing `requireAdminUser` would have
  // been silently world-readable.
  const publicRoutes = [
    { path: /^\/api\/health$/, methods: ['GET'] },
    { path: /^\/api\/status$/, methods: ['GET'] }, // Public per-component status board for an external status page
    { path: /^\/api\/version$/, methods: ['GET'] }, // SPA version-skew polling — anonymous sessions poll it too
    // nuxt-auth-utils session endpoint. GET returns the (possibly empty)
    // sealed-cookie session; DELETE clears it. Both must work WITHOUT a
    // valid session: GET is what the pre-login app shell calls to learn
    // "not logged in", and DELETE is logout — which must still work when
    // SESSION_VERSION bumped and the cookie is stale.
    { path: /^\/api\/_auth\/session$/, methods: ['GET', 'DELETE'] },
    // @nuxt/icon server bundle — icon JSON consumed by the pre-login
    // landing page and every anonymous editor surface.
    { path: /^\/api\/_nuxt_icon\//, methods: ['GET'] },
    // Test-only endpoints (login shim etc.) are public ONLY while test mode
    // is active (`isTestModeEnabled`: TEST_MODE=1 on a non-production-
    // looking instance). Otherwise they fall through to default-deny, and
    // the handlers 404 on top of that.
    ...(isTestModeEnabled() ? [{ path: /^\/api\/_test\//, methods: ['POST'] }] : []),
    // Resolved tier-cap map for the pricing page — logged-out visitors
    // browse /pricing, and the caps it returns are displayed there
    // anyway. Static config, no per-user data.
    { path: /^\/api\/billing\/tiers$/, methods: ['GET'] },
    // Monthly plan prices for the same page (planned prices while paid
    // plans are "coming soon"). Static config, no per-user data.
    { path: /^\/api\/billing\/prices$/, methods: ['GET'] },
    { path: /^\/api\/docs$/, methods: ['POST'] }, // Anonymous doc creation allowed (IP-rate-limited in the handler)
    { path: /^\/api\/docs\/[^/]+$/, methods: ['DELETE'] }, // Anon doc owner-less deletion is endpoint-gated
    { path: /^\/api\/docs\/[^/]+\/meta$/, methods: ['GET'] }, // Public doc metadata
    // PDF download — endpoint-gated via decideFileAccess, mirrors /api/files
    // semantics. Anonymous on open-* docs; owner / workspace member on private.
    { path: /^\/api\/docs\/[^/]+\/pdf$/, methods: ['GET'] },
    // Image-read token for the sandboxed preview / print iframes — same
    // decideFileAccess gate as /api/files (anonymous on open-* docs,
    // password holders via the doc JWT as Bearer).
    { path: /^\/api\/docs\/[^/]+\/file-token$/, methods: ['GET'] },
    { path: /^\/api\/docs\/[^/]+\/token$/, methods: ['GET'] }, // Returns anonymous token if no session
    { path: /^\/api\/docs\/[^/]+\/password$/, methods: ['POST'] }, // Password verify is public; set/remove check ownership inside
    { path: /^\/api\/docs\/[^/]+\/activity$/, methods: ['GET'] }, // Endpoint-gated — public on open-edit/open-view, members-only on private/password-protected
    // Match ANY activityId segment (not just `\d+`) so malformed ids
    // hit the endpoint's own validation (400) rather than the auth
    // middleware's 401 — clearer errors for bad clients, identical
    // security envelope for valid ones.
    { path: /^\/api\/docs\/[^/]+\/activity\/[^/]+\/diff$/, methods: ['GET'] }, // Endpoint-gated — same auth tiers as /activity (decideActivityAccess)
    { path: /^\/api\/docs\/[^/]+\/activity\/[^/]+\/comment-context$/, methods: ['GET'] }, // Endpoint-gated — same auth tiers as /activity
    // /restore is NOT in the public whitelist — the endpoint itself
    // requires `requireDocEditAccess`, which needs a user session.
    // Falls through to the default-deny branch below.
    // In-doc image reads — endpoint-gated via decideFileAccess (same
    // decision as the PDF endpoint). Anonymous users on open-* docs
    // load images through this route; a session requirement here would
    // break every image in anonymously-shared docs.
    { path: /^\/api\/files\/[^/]+\/[^/]+$/, methods: ['GET'] },
    // Workspace brand-kit fonts + logos of a document (WP10) — same
    // decideFileAccess gate as /api/files (session, or the file-access
    // token the preview / print iframes and the renderer carry).
    { path: /^\/api\/docs\/[^/]+\/brand\/[^/]+$/, methods: ['GET'] },
    // Files of a published web page (WP13) — public like the page itself;
    // copies under the page's own S3 prefix, nothing of the document.
    { path: /^\/api\/published\/[^/]+\/(?:files|brand)\/[^/]+$/, methods: ['GET'] },
    { path: /^\/api\/import$/, methods: ['POST'] }, // Import is public — user uploads their own file for conversion
    { path: /^\/api\/internal\//, methods: ['POST'] }, // Internal endpoints auth via shared secret header (not user session)
    // Traefik's HTTP provider (WP13) — token header checked in the handler.
    { path: /^\/api\/internal\/traefik\/custom-domains$/, methods: ['GET'] },
    // Renderer-container bootstrap: GET-only, gated by a render-token JWT
    // (verifyRenderToken) carried in the query string. No session expected.
    { path: /^\/api\/_internal\/render-bootstrap$/, methods: ['GET'] },
    // Flow gallery index — read-only enumeration of public/flows/. The
    // contents are derived from already-public assets, no session
    // needed; the docs site fetches it during SSR.
    { path: /^\/api\/_internal\/flows-index$/, methods: ['GET'] },
    // Docs search index (Cmd-K modal on /docs/**): derived from the
    // public docs content, fetched by the browser when search opens.
    { path: /^\/api\/_internal\/docs-search$/, methods: ['GET'] },
    // Legal-document renderer. Anonymous + logged-in users alike
    // need to read the privacy policy / terms / DPA / abuse policy.
    // Slug allowlist + locale guard live in the handler.
    { path: /^\/api\/_internal\/legal\/[^/]+$/, methods: ['GET'] },
    // Public sub-processor list. Required disclosure under GDPR
    // Article 13(1)(e) — readers (incl. regulators) need to be
    // able to inspect this without an account.
    { path: /^\/api\/_internal\/sub-processors$/, methods: ['GET'] },
    // Cookie-consent banner submission + read. Anonymous users
    // hit this; we anchor the decision on a first-party
    // `markoto-anon` cookie set by the handler on first call.
    { path: /^\/api\/consent$/, methods: ['GET', 'POST'] },
    // Anonymous gate (server/utils/anonGate/): the ALTCHA challenge an
    // anonymous visitor solves before creating a doc or filing a report.
    // IP-rate-limited; issuing one costs one PBKDF2 derivation.
    { path: /^\/api\/anon-gate\/challenge$/, methods: ['GET'] },
    // DSA Art.16 notice form: open to anyone. Anonymous reporters need a
    // fresh ALTCHA solution + per-IP limits; signed-in ones a per-user
    // limit. Checked in the handler.
    { path: /^\/api\/abuse-reports$/, methods: ['POST'] },
    // Paid-plans waitlist (double opt-in). Sign-up is open to logged-out
    // visitors of /pricing; confirm + unsubscribe are reached from email
    // links. All three are IP-rate-limited; tokens are 256-bit and hashed
    // at rest. Sign-up 404s unless the waitlist is open (billing off +
    // NUXT_PLANS_COMING_SOON).
    { path: /^\/api\/waitlist$/, methods: ['POST'] },
    // "Sign in with your organisation" (WP14): email → the SSO sign-in
    // link of the workspace that verified its domain. Rate-limited.
    { path: /^\/api\/auth\/sso\/discover$/, methods: ['POST'] },
    { path: /^\/api\/waitlist\/(?:confirm|unsubscribe)$/, methods: ['POST'] },
    // Stripe webhooks: auth'd via `Stripe-Signature` header + our
    // webhook secret. No user session — Stripe's servers don't have
    // one. Handler does full cryptographic signature verification.
    { path: /^\/api\/webhooks\/stripe$/, methods: ['POST'] },
    // Live-dictation WS relay: authenticated via short-lived JWT in
    // the upgrade URL (`?token=`), not the session cookie — crossws
    // gives the upgrade hook a raw Request, not an H3Event, so reading
    // the sealed cookie there isn't feasible. The JWT itself is minted
    // by POST /api/ai/dictate/token which still requires a session.
    { path: /^\/api\/ai\/dictate$/, methods: ['GET'] }
  ]

  // HEAD is semantically a GET without a body — external monitors and
  // some proxies probe /api/health with HEAD. Treat it as GET for the
  // whitelist check so a HEAD to a public GET route isn't 401'd.
  const method = event.method === 'HEAD' ? 'GET' : event.method

  const isPublic = publicRoutes.some(
    route => route.path.test(path) && route.methods.includes(method)
  )

  if (isPublic) return

  // DEFAULT-DENY: every other /api route requires a valid session.
  // This is the middleware backstop for admin routes, billing, user
  // data, workspaces, MCP token management, and anything added in the
  // future — handlers still run their own finer-grained authz
  // (requireAdminUser, canManageDoc, workspace roles) on top.
  //
  // Uses the validated helper so stale-user sessions are cleared centrally.
  // Result is cached on event.context — endpoints that call the helper again
  // don't re-query the DB.
  await requireValidatedUserSession(event)
})
