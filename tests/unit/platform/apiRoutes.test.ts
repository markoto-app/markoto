import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, it, expect } from 'vitest'
import { isPublicRoute, PUBLIC_ROUTES, TEST_ONLY_PUBLIC_ROUTES } from '../../../server/utils/auth/publicRoutes'
import { classifyInternalRoute } from '../../../server/utils/platform/internalRoutes'
import { RAW_HANDLER_EXCEPTIONS } from './apiRoutes.exceptions'

// Every handler file declares its access structurally (docs/contributing/api-handlers.md).
// The source is parsed, never imported: no handler code runs here.
//
//   - The default export is `defineApiHandler({...})`, unless the file is a
//     listed raw exception.
//   - `access` is an `allow.*()` call; public, custom and doc-lookup policies say why.
//   - POST / PUT / PATCH handlers declare their `body`.
//   - A policy is sessionless exactly when the middleware lets the route
//     through without a session (public allowlist, or the internal-secret prefix).
//   - Every allowlist entry is used by some handler or module route.

const ROOT = join(__dirname, '..', '..', '..')
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head'])

/** Routes registered by modules, with no file in server/. */
const MODULE_ROUTES: ReadonlyArray<{ route: string, method: string, reason: string }> = [
  { route: '/mcp', method: 'POST', reason: '@nuxtjs/mcp-toolkit; PAT-authenticated in server/mcp/' },
  { route: '/api/_auth/session', method: 'GET', reason: 'nuxt-auth-utils session read (pre-login app shell)' },
  { route: '/api/_auth/session', method: 'DELETE', reason: 'nuxt-auth-utils logout, must work with a stale cookie' },
  { route: '/api/_nuxt_icon/lucide.json', method: 'GET', reason: '@nuxt/icon server bundle' }
]

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

interface HandlerFile {
  file: string
  route: string
  /** Upper-case method, or 'ALL' for a file without a method suffix. */
  method: string
}

/** Route + method the way Nitro derives them from the file path. */
function routeOf(file: string): HandlerFile {
  const isApi = file.startsWith('server/api/')
  let rest = file.replace(/^server\/(api|routes)\//, '').replace(/\.ts$/, '')
  let method = 'ALL'
  const suffix = /\.(\w+)$/.exec(rest)
  if (suffix && METHODS.has(suffix[1]!)) {
    method = suffix[1]!.toUpperCase()
    rest = rest.slice(0, -suffix[0].length)
  }
  const segments = rest.split('/').filter(s => s !== 'index').map(s => s.replace(/^\[\.\.\.(\w+)\]$/, '**:$1').replace(/\[(\w+)\]/g, ':$1'))
  return { file, route: `${isApi ? '/api' : ''}/${segments.join('/')}`.replace(/\/$/, '') || '/', method }
}

/** Parameters whose values the router constrains further (`/api/published/:pageId/:kind/:file`, kind = files | brand). */
const SAMPLE_VALUES: Record<string, string> = { kind: 'files' }

/** A concrete path for a route pattern: `:docId` → `docId1`. */
const samplePath = (route: string) => route.replace(/:(\w+)/g, (_w, n: string) => SAMPLE_VALUES[n] ?? `${n}1`).replace(/\*\*/g, 'x')

interface Declaration {
  callee: string | null
  props: Map<string, ts.Expression>
  access?: { kind: string, args: readonly ts.Expression[] }
}

function declarationOf(file: string): Declaration {
  const sf = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true)
  const exp = sf.statements.find(ts.isExportAssignment)
  const call = exp && ts.isCallExpression(exp.expression) ? exp.expression : undefined
  const callee = call && ts.isIdentifier(call.expression) ? call.expression.text : null
  const props = new Map<string, ts.Expression>()
  const arg = call?.arguments[0]
  if (arg && ts.isObjectLiteralExpression(arg)) {
    for (const p of arg.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) props.set(p.name.text, p.initializer)
    }
  }
  const a = props.get('access')
  let access: Declaration['access']
  if (a && ts.isCallExpression(a) && ts.isPropertyAccessExpression(a.expression)
    && ts.isIdentifier(a.expression.expression) && a.expression.expression.text === 'allow') {
    access = { kind: a.expression.name.text, args: a.arguments }
  }
  return { callee, props, access }
}

function objectProp(expr: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (!expr || !ts.isObjectLiteralExpression(expr)) return undefined
  for (const p of expr.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) return p.initializer
  }
  return undefined
}

const nonEmptyString = (e: ts.Expression | undefined) => !!e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && e.text.trim() !== ''
const isTrue = (e: ts.Expression | undefined) => e?.kind === ts.SyntaxKind.TrueKeyword

/** Whether the declared policy lets a caller in without a session. */
function sessionless(access: NonNullable<Declaration['access']>): boolean {
  switch (access.kind) {
    case 'public': case 'internal': case 'scim': case 'testOnly': return true
    case 'doc': return isTrue(objectProp(access.args[1], 'anonymous'))
    case 'custom': return isTrue(objectProp(access.args[1], 'sessionless'))
    default: return false
  }
}

const files = [...walk(join(ROOT, 'server/api')), ...walk(join(ROOT, 'server/routes'))].map(f => relative(ROOT, f)).sort()
const handlers = files.map(routeOf)
describe('API route declarations', () => {
  it('the exception list names existing files only', () => {
    expect(Object.keys(RAW_HANDLER_EXCEPTIONS).filter(f => !files.includes(f))).toEqual([])
  })

  it('every handler is declared with defineApiHandler or is a listed exception', () => {
    const problems: string[] = []
    for (const { file } of handlers) {
      if (RAW_HANDLER_EXCEPTIONS[file]) continue
      const d = declarationOf(file)
      if (d.callee !== 'defineApiHandler') problems.push(`${file}: default export is ${d.callee ?? 'not a call'}, not defineApiHandler`)
    }
    expect(problems).toEqual([])
  })

  it('converted handlers declare an allow.* policy with a reason where required, and a body on writes', () => {
    const problems: string[] = []
    for (const { file, method } of handlers) {
      const d = declarationOf(file)
      if (d.callee !== 'defineApiHandler') continue
      if (!d.access) {
        problems.push(`${file}: access is not an allow.*() call`)
        continue
      }
      const a = d.access
      if ((a.kind === 'public' || a.kind === 'custom') && !nonEmptyString(a.args[0])) problems.push(`${file}: allow.${a.kind} needs a reason string`)
      if (a.kind === 'doc' && ts.isStringLiteral(a.args[0]!) && a.args[0].text === 'lookup' && !nonEmptyString(objectProp(a.args[1], 'reason'))) {
        problems.push(`${file}: allow.doc('lookup') needs a reason`)
      }
      if (['POST', 'PUT', 'PATCH'].includes(method) && !d.props.has('body')) problems.push(`${file}: ${method} handler without a body declaration`)
    }
    expect(problems).toEqual([])
  })

  it('sessionless policies are exactly the routes the middleware lets through without a session', () => {
    const problems: string[] = []
    for (const { file, route, method } of handlers) {
      const d = declarationOf(file)
      if (d.callee !== 'defineApiHandler' || !d.access || !route.startsWith('/api/')) continue
      const path = samplePath(route)
      const methods = method === 'ALL' ? ['GET', 'POST'] : [method]
      for (const m of methods) {
        const open = isPublicRoute(path, m, { testMode: true })
          || (classifyInternalRoute(path, m) === 'internal-api' && path.startsWith('/api/internal/'))
        if (open !== sessionless(d.access)) {
          problems.push(`${file}: policy allow.${d.access.kind} is ${sessionless(d.access) ? '' : 'not '}sessionless, but the middleware ${open ? 'lets' : 'does not let'} ${m} ${path} through`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('every allowlist entry is used by a handler file or a module route', () => {
    const targets = [
      ...handlers.flatMap(h => (h.method === 'ALL' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : [h.method]).map(m => ({ path: samplePath(h.route), method: m }))),
      ...MODULE_ROUTES.map(r => ({ path: r.route, method: r.method }))
    ]
    const stale = [...PUBLIC_ROUTES, ...TEST_ONLY_PUBLIC_ROUTES].flatMap(r => r.methods
      .filter(m => !targets.some(t => t.method === m && r.path.test(t.path)))
      .map(m => `${m} ${r.path.source}`))
    expect(stale).toEqual([])
  })

  it('outside /api every handler declares an allow.* policy (the middleware guards /api only)', () => {
    const raw = handlers.filter(h => !h.route.startsWith('/api/') && !RAW_HANDLER_EXCEPTIONS[h.file])
      .filter(h => !declarationOf(h.file).access)
    expect(raw.map(h => h.file)).toEqual([])
  })

  it('per-client limits that throttle probing count every request (before the session and the lookup)', () => {
    // Anonymous-reachable routes whose 404 for an unknown id must not be free.
    const probing = [
      'server/api/docs/[docId]/token.get.ts',
      'server/api/docs/[docId]/index.delete.ts',
      'server/api/docs/[docId]/file-token.get.ts',
      'server/api/docs/[docId]/pdf.get.ts',
      'server/api/docs/[docId]/brand/[file].get.ts',
      'server/api/published/[pageId]/[kind]/[file].get.ts',
      'server/api/import.post.ts'
    ]
    // `rateLimit` is one spec or a list of them; one of them must count early.
    const countsEarly = (spec: ts.Expression) => {
      const phase = objectProp(spec, 'phase')
      return !!phase && ts.isStringLiteral(phase) && phase.text === 'before-access'
    }
    const missing = probing.filter((file) => {
      const limit = declarationOf(file).props.get('rateLimit')
      if (!limit) return true
      const specs = ts.isArrayLiteralExpression(limit) ? [...limit.elements] : [limit]
      return !specs.some(countsEarly)
    })
    expect(missing).toEqual([])
  })
})
