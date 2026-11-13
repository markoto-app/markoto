import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

// Every exported repo function takes a capability proof (`DocAccess`,
// `WorkspaceAccess`, `UserScope`, `AdminActor`, `SystemActor`; directly, in a
// union or inside an options object), or is on the exemption list below with
// the reason it cannot. A new function keyed by a raw user / document /
// workspace id fails here until it takes a proof or someone writes down why it
// can't. docs/SECURITY-HARDENING.md → Tenancy, server/repos/AGENTS.md → Proofs.

const ROOT = join(__dirname, '..', '..', '..')
const REPOS = join(ROOT, 'server', 'repos')

const WHY = {
  bootstrap: 'Authorization bootstrap: decides who the caller is or what they may do, so no proof for the caller exists yet.',
  proofs: 'The proof machinery itself.',
  pure: 'Runs no query: a pure helper or an SQL fragment for other repo functions.',
  plumbing: 'Database plumbing (pool, health probe, advisory locks, the embedding column, the operator key-rotation CLI); addresses no tenant row.',
  billing: 'Billing and quota state of the paying subject (user or workspace), which billing resolves once from an authorized request or a named job and hands to every AI call and sweep; a proof minted inside billing from that same id would check nothing.',
  public: 'Serves what is public by design (published pages, the custom-domain routing table) or only whether an id exists.',
  token: 'Addressed by a secret the visitor holds (waitlist confirm / unsubscribe token) or written before any account exists.'
} as const

/** `file#function`, or `file#*` when every export of the file has the same reason. Paths relative to server/repos. */
const EXEMPT: Record<string, keyof typeof WHY> = {
  'access/*': 'bootstrap',
  'users.ts#findSessionUser': 'bootstrap',
  'users.ts#getSessionEpoch': 'bootstrap',
  'userSignIn.ts#upsertOAuthUser': 'bootstrap',
  'sso.ts#getSsoConnectionById': 'bootstrap',
  'sso.ts#getSsoConnectionForWorkspace': 'bootstrap',
  'sso.ts#getSsoConnectionByScimTokenHash': 'bootstrap',
  'sso.ts#findVerifiedDomainOwner': 'bootstrap',
  'sso.ts#isDomainVerifiedForWorkspace': 'bootstrap',
  'sso.ts#findIdentity': 'bootstrap',
  'sso.ts#findIdentityForUser': 'bootstrap',
  'sso.ts#findIdentityById': 'bootstrap',

  'proofs/*': 'proofs',

  'audit.ts#truncateIp': 'pure',
  'brandAssets.ts#isBrandFontAsset': 'pure',
  'brandAssets.ts#isBrandImageAsset': 'pure',
  'brandAssets.ts#brandFontsOf': 'pure',
  'errors.ts#isRepoError': 'pure',
  'sso.ts#ssoSatisfiedSql': 'pure',
  'sso.ts#ssoEnforcedSql': 'pure',
  'workspaceSubscriptions.ts#subscriptionGrantsPlan': 'pure',
  'workspaceSubscriptions.ts#pooledWorkspaceIdsSubquery': 'pure',

  'connection.ts#*': 'plumbing',
  'health.ts#*': 'plumbing',
  'sweepLocks.ts#*': 'plumbing',
  'knowledgeEmbeddings.ts#*': 'plumbing',
  'storedSecrets.ts#*': 'plumbing',

  'litellmKeys.ts#*': 'billing',
  'plans.ts#*': 'billing',
  'litellmSpend.ts#sumKeySpend': 'billing',
  'litellmSpend.ts#sumTeamSpend': 'billing',
  'aiCreditGrants.ts#listUsableGrants': 'billing',
  'aiCreditGrants.ts#listGrants': 'billing',
  'aiCreditGrants.ts#sumUsableCredits': 'billing',
  'aiCreditGrants.ts#listSubjectsWithCredits': 'billing',
  'aiCreditGrants.ts#getSettledUsd': 'billing',
  'aiCreditGrants.ts#recordPeriodPlanBudget': 'billing',
  'aiCreditGrants.ts#getPeriodPlanBudget': 'billing',
  'aiCreditGrants.ts#consumeCredits': 'billing',
  'aiCreditGrants.ts#settleMonth': 'billing',
  'aiCreditGrants.ts#expireGrants': 'billing',
  'aiCreditGrants.ts#deleteCreditsForSubject': 'billing',
  'workspaceSubscriptions.ts#getWorkspaceSubscription': 'billing',
  'workspaceSubscriptions.ts#listSubscriptionsByBillingAdmin': 'billing',
  'workspaceSubscriptions.ts#listSubscriptionsForWorkspaces': 'billing',
  'uploads.ts#sumImageBytesInScope': 'billing',

  'publishedPages.ts#getPublishedPageBySlug': 'public',
  'publishedPages.ts#getPublishedPageById': 'public',
  'publishedPages.ts#publishedPageExists': 'public',
  'customDomains.ts#listOnceVerifiedHostnames': 'public',
  'customDomains.ts#listVerifiedCustomDomains': 'public',
  'documents.ts#docExists': 'public',

  'waitlist.ts#upsertWaitlistSignup': 'token',
  'waitlist.ts#confirmWaitlistSignup': 'token',
  'waitlist.ts#deleteWaitlistSignupByUnsubscribeToken': 'token'
}

const PROOF_CLASSES = new Set(['DocAccess', 'WorkspaceAccess', 'UserScope', 'AdminActor', 'SystemActor'])
const MINT_FILE = /server\/repos\/proofs\/mint\.ts$/

function repoFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) repoFiles(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Every exported function of server/repos as `file#name`, with whether any signature takes a proof. */
function scanRepoExports(): Map<string, boolean> {
  const files = repoFiles(REPOS)
  const program = ts.createProgram(files, {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    baseUrl: ROOT,
    paths: { '~~/*': ['./*'] }
  })
  const checker = program.getTypeChecker()
  const isProofSymbol = (s: ts.Symbol | undefined): boolean => !!s && PROOF_CLASSES.has(s.getName())
    && (s.getDeclarations() ?? []).some(d => MINT_FILE.test(d.getSourceFile().fileName.replaceAll('\\', '/')))
  // A proof directly, in a union, or as a property of an options object.
  const holdsProof = (type: ts.Type, depth = 0): boolean => {
    if (depth > 2) return false
    if (isProofSymbol(type.getSymbol()) || isProofSymbol(type.aliasSymbol)) return true
    if (type.isUnionOrIntersection()) return type.types.some(t => holdsProof(t, depth))
    if (!(type.flags & ts.TypeFlags.Object)) return false
    const decl = type.getSymbol()?.getDeclarations()?.[0]
    if (decl && decl.getSourceFile().fileName.includes('node_modules')) return false
    return checker.getPropertiesOfType(type).some(p => holdsProof(checker.getTypeOfSymbol(p), depth + 1))
  }

  const out = new Map<string, boolean>()
  for (const file of files) {
    const source = program.getSourceFile(file)
    const moduleSymbol = source && checker.getSymbolAtLocation(source)
    if (!source || !moduleSymbol) continue
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
      const decl = symbol.getDeclarations()?.[0]
      // Re-exports are checked where they are declared.
      if (!decl || decl.getSourceFile() !== source) continue
      const signatures = checker.getTypeOfSymbolAtLocation(symbol, decl).getCallSignatures()
      if (signatures.length === 0) continue
      const takesProof = signatures.some(sig => sig.getParameters().some(p => holdsProof(checker.getTypeOfSymbolAtLocation(p, decl))))
      out.set(`${relative(REPOS, file).replaceAll('\\', '/')}#${exported.getName()}`, takesProof)
    }
  }
  return out
}

function exemptionFor(key: string): string | undefined {
  const [file = '', fn = ''] = key.split('#')
  const dir = file.includes('/') ? `${file.slice(0, file.lastIndexOf('/'))}/*` : null
  return EXEMPT[`${file}#${fn}`] ?? EXEMPT[`${file}#*`] ?? (dir ? EXEMPT[dir] : undefined)
}

describe('repo functions take a capability proof', () => {
  const exportsByKey = scanRepoExports()

  it('finds the repo exports (the scan works)', () => {
    expect(exportsByKey.get('documents.ts#getDoc')).toBe(true)
    expect(exportsByKey.get('documents.ts#docExists')).toBe(false)
  })

  it('every exported function without a proof parameter is on the exemption list', () => {
    const missing = [...exportsByKey].filter(([key, takesProof]) => !takesProof && !exemptionFor(key)).map(([key]) => key)
    expect(missing, 'take a proof (server/repos/AGENTS.md → Proofs), or add the function to EXEMPT with its reason').toEqual([])
  })

  it('every named exemption still exists and still has no proof (the list stays honest)', () => {
    const stale = Object.keys(EXEMPT)
      .filter(key => !key.endsWith('*'))
      .filter(key => exportsByKey.get(key) !== false)
    expect(stale).toEqual([])
  })

  it('every exemption has a written reason', () => {
    expect(Object.entries(EXEMPT).filter(([, why]) => !WHY[why])).toEqual([])
  })

  it('every file-wide exemption names a file or directory that exists', () => {
    const keys = [...exportsByKey.keys()]
    const unused = Object.keys(EXEMPT)
      .filter(key => key.endsWith('*'))
      // `access/*` and `plans.ts#*` both match by prefix ('access/', 'plans.ts#').
      .filter(key => !keys.some(k => k.startsWith(key.slice(0, -1))))
    expect(unused).toEqual([])
  })
})
