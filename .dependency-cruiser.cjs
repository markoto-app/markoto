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

// Files outside server/repos that still import drizzle-orm / server/db/schema directly.
// Move their queries into a repo, then delete the entry.
const DB_OFFENDERS = [
  '^server/api/abuse-reports\\.post\\.ts$',
  '^server/api/admin/abuse-reports\\.get\\.ts$',
  '^server/api/admin/abuse-reports/\\[reportId\\]\\.patch\\.ts$',
  '^server/api/ai/credits\\.get\\.ts$',
  '^server/api/billing/checkout\\.post\\.ts$',
  '^server/api/billing/portal\\.post\\.ts$',
  '^server/api/billing/topup\\.post\\.ts$',
  '^server/api/consent\\.get\\.ts$',
  '^server/api/consent\\.post\\.ts$',
  '^server/api/docs/\\[docId\\]/meta\\.get\\.ts$',
  '^server/api/internal/comments-snapshot\\.post\\.ts$',
  '^server/api/mcp/tokens/index\\.get\\.ts$',
  '^server/api/mcp/tokens/index\\.post\\.ts$',
  '^server/api/mcp/tokens/\\[tokenId\\]\\.delete\\.ts$',
  '^server/api/user/ai-model\\.put\\.ts$',
  '^server/api/workspaces/index\\.post\\.ts$',
  '^server/api/workspaces/\\[wsId\\]/billing/index\\.get\\.ts$',
  '^server/api/workspaces/\\[wsId\\]/billing/members/\\[userId\\]\\.patch\\.ts$',
  '^server/api/workspaces/\\[wsId\\]/knowledge/confirm\\.post\\.ts$',
  '^server/api/workspaces/\\[wsId\\]/usage\\.get\\.ts$',
  '^server/plugins/knowledge-sweep\\.ts$',
  '^server/plugins/mcp-sessions-sweep\\.ts$',
  '^server/utils/accountDeletionPlan\\.ts$',
  '^server/utils/accountDeletionSweep\\.ts$',
  '^server/utils/aiCredits\\.ts$',
  '^server/utils/aiProviders/resolve\\.ts$',
  '^server/utils/aiRecordsSweep\\.ts$',
  '^server/utils/aiSessions\\.ts$',
  '^server/utils/billing\\.ts$',
  '^server/utils/dataExport\\.ts$',
  '^server/utils/email/workspaceBillingEmails\\.ts$',
  '^server/utils/entitlements\\.ts$',
  '^server/utils/healthProbes\\.ts$',
  '^server/utils/imageQuota\\.ts$',
  '^server/utils/inactiveDocSweep\\.ts$',
  '^server/utils/legalRetentionSweep\\.ts$',
  '^server/utils/litellm/keyReconcile\\.ts$',
  '^server/utils/litellm/userKeys\\.ts$',
  '^server/utils/litellm/workspaceTeams\\.ts$',
  '^server/utils/mcpAuth\\.ts$',
  '^server/utils/moderationDecision\\.ts$',
  '^server/utils/moderationNotices\\.ts$',
  '^server/utils/processKnowledge\\.ts$',
  '^server/utils/publish/publishDocument\\.ts$',
  '^server/utils/restoreDoc\\.ts$',
  '^server/utils/sso/completeLogin\\.ts$',
  '^server/utils/sso/membership\\.ts$',
  '^server/utils/sso/scim\\.ts$',
  '^server/utils/stripeWebhook\\.ts$',
  '^server/utils/webhookEventSweep\\.ts$',
  '^server/utils/workspaceBillingLifecycle\\.ts$',
  '^server/utils/workspaceBudgetAlerts\\.ts$',
  '^server/utils/workspaceStripe\\.ts$'
]

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ---------- cycles ----------
    {
      name: 'no-circular',
      comment: 'Circular dependencies make load order fragile. Fix the cycle; do not add to the allowlist.',
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
      comment: 'server/repos may use server/db, shared, other repos and the database handle. Business logic belongs in server/utils.',
      severity: 'error',
      from: { path: '^server/repos/' },
      to: {
        path: '^(server|app|sync-server|renderer)/',
        pathNot: ['^server/db/', '^server/repos/', '^server/utils/database\\.ts$']
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
        'drizzle-orm and server/db/schema belong behind server/repos. '
        + 'The files below are existing offenders (allowlist in pathNot) — move their queries into repos and delete the entry; never add new ones.',
      severity: 'error',
      from: {
        path: '^(app|server|shared|sync-server|renderer|modules)/',
        pathNot: [
          '^server/(repos|db)/',
          // the database handle + boot-time migration runner are the sanctioned non-repo users
          '^server/utils/database\\.ts$',
          '^server/plugins/00-db-migrate\\.ts$',
          // known offenders: shrink this list, never grow it
          ...DB_OFFENDERS
        ]
      },
      to: { path: ['^node_modules/drizzle-orm', '^server/db/schema\\.ts$'] }
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
