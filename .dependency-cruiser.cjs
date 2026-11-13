/**
 * dependency-cruiser: layer boundaries of the repo.
 *
 *   bunx depcruise@18.7.2 --config .dependency-cruiser.cjs app server shared modules scripts sync-server/src renderer/src tests
 *
 * Blind spot: Nuxt/Nitro auto-imports (composables, app/utils, server/utils, #shared utils,
 * components) are not import statements, so edges created through them do not exist
 * in this graph. Only explicit imports are checked.
 */

// Files that exist only for tests / dev tooling, never in a production bundle.
const TEST_ONLY = '^tests/'

// The access layer: the only production code that may mint capability proofs
// (DocAccess, WorkspaceAccess, UserScope, AdminActor) and read the
// authorization bootstrap rows they are minted from.
const ACCESS_LAYER = '^server/utils/access/'

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ---------- cycles ----------
    {
      name: 'no-circular',
      comment: 'Circular dependencies make load order fragile. Break the cycle (shared types go to a leaf module).',
      severity: 'error',
      from: {},
      to: { circular: true }
    },

    // ---------- shared is a leaf layer ----------
    {
      name: 'shared-imports-nothing-above',
      comment: 'shared/** is used by app, server, sync-server and renderer; it may not depend on any of them (or on tests).',
      severity: 'error',
      from: { path: '^shared/' },
      to: { path: '^(app|server|sync-server|renderer|tests|scripts|modules)/' }
    },

    // ---------- app <-> server ----------
    {
      name: 'app-never-imports-server',
      comment: 'Browser code must not pull in server code. Share via shared/.',
      severity: 'error',
      from: { path: '^app/' },
      to: { path: '^server/' }
    },
    {
      name: 'server-never-imports-app',
      comment: 'Server code must not pull in browser/Vue code. Share via shared/.',
      severity: 'error',
      from: { path: '^server/' },
      to: { path: '^app/' }
    },

    // ---------- separately deployed packages ----------
    {
      name: 'sync-server-isolated',
      comment: 'sync-server is its own container image: only its own files, shared/ and node_modules.',
      severity: 'error',
      from: { path: '^sync-server/src/' },
      to: { path: '^(app|server|renderer|scripts|modules|tests)/' }
    },
    {
      name: 'renderer-isolated',
      comment: 'renderer is its own container image: only its own files, shared/ and node_modules.',
      severity: 'error',
      from: { path: '^renderer/src/' },
      to: { path: '^(app|server|sync-server|scripts|modules|tests)/' }
    },

    // ---------- server layering ----------
    {
      name: 'server-lower-layers-no-handlers',
      comment: 'server/utils and server/repos are libraries for the handlers; they must not import routes, API handlers, plugins or MCP tools.',
      severity: 'error',
      from: { path: '^server/(utils|repos)/' },
      to: { path: '^server/(api|routes|plugins|mcp)/' }
    },
    {
      name: 'repos-only-use-db-layer',
      comment: 'server/repos may use server/db, shared, other repos and the logger. Business logic belongs in server/utils.',
      severity: 'error',
      from: { path: '^server/repos/' },
      to: {
        path: '^(server|app|sync-server|renderer)/',
        pathNot: ['^server/db/', '^server/repos/', '^server/utils/platform/logger\\.ts$']
      }
    },

    // ---------- production vs test code ----------
    {
      name: 'prod-never-imports-tests',
      comment: 'Production code must not import tests/.',
      severity: 'error',
      from: { pathNot: TEST_ONLY + '|\\.(test|spec)\\.[cm]?[jt]s$|^scripts/' },
      to: { path: TEST_ONLY }
    },

    // ---------- data access ----------
    {
      name: 'db-access-only-in-repos',
      comment:
        'Only server/repos talks to the database: drizzle-orm, pg and server/db/** (schema, '
        + 'connection, transactions) are off limits everywhere else. Add a repo function instead.',
      severity: 'error',
      from: {
        path: '^(app|server|shared|modules)/',
        pathNot: [
          '^server/(repos|db)/',
          // a type-only PoolConfig import; the TLS options it builds are used by server/db and sync-server
          '^shared/utils/runtime/postgresSsl\\.ts$'
        ]
      },
      to: { path: ['^node_modules/(drizzle-orm|pg)/', '^server/db/'] }
    },

    // ---------- capability proofs (docs/SECURITY-HARDENING.md, tenancy) ----------
    {
      name: 'proofs-minted-only-by-access-layer',
      comment: 'The proof mint is private to the access layer. Everyone else receives proofs (handler ctx, tool context) or asks the access layer to prove a need.',
      severity: 'error',
      from: { pathNot: [ACCESS_LAYER, '^server/repos/proofs/'] },
      to: { path: '^server/repos/proofs/mint\\.ts$' }
    },
    {
      name: 'proof-test-mint-only-in-tests',
      comment: 'server/repos/proofs/testing.ts mints proofs without an authorization check; production code must never reach it.',
      severity: 'error',
      from: { pathNot: TEST_ONLY },
      to: { path: '^server/repos/proofs/testing\\.ts$' }
    },
    {
      name: 'authz-bootstrap-reads-only-in-access-layer',
      comment: 'server/repos/access/** reads the rows authorization is decided from (roles, doc ACL, token hashes) without a proof. Only the access layer (and the MCP token authenticator) may call it.',
      severity: 'error',
      from: { pathNot: [ACCESS_LAYER, '^server/repos/access/', '^server/utils/mcp/mcpAuth\\.ts$', TEST_ONLY] },
      to: { path: '^server/repos/access/' }
    },
    {
      name: 'identity-proofs-only-from-policies',
      comment: 'proveSelf / proveAdmin / proveScimWorkspace trust the caller for WHO is acting; only the handler policies, the MCP authenticator and the SCIM / SSO flows establish that.',
      severity: 'error',
      from: {
        pathNot: [
          ACCESS_LAYER,
          '^server/utils/api/policy(Doc|Workspace)?\\.ts$',
          '^server/utils/mcp/mcpAuth\\.ts$',
          '^server/mcp/lib/wrapDocBoundTool\\.ts$',
          '^server/utils/sso/scim\\.ts$',
          TEST_ONLY
        ]
      },
      to: { path: '^server/utils/access/(userProof|scimProof)\\.ts$' }
    }
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(\\.nuxt|\\.output|dist|coverage|\\.data)/' },
    // Type-only imports count: they are real coupling, and a cycle through them still breaks
    // when someone later turns the type import into a value import.
    tsPreCompilationDeps: true,
    // Nuxt generates the path aliases (~, ~~, @, #shared, #server, ...) into this file.
    tsConfig: { fileName: '.nuxt/tsconfig.app.json' },
    moduleSystems: ['es6', 'cjs'],
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.vue', '.json']
    },
    skipAnalysisNotInRules: true,
    reporterOptions: { text: { highlightFocused: true } }
  }
}
