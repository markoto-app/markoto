// The plain environment passthrough of the compose stacks, generated from
// the env registry (shared/env/) so the hosted and the self-host stack can
// no longer drift apart by hand-copying.
//
// A service's `environment:` list carries a marked region:
//
//     environment:
//       # BEGIN env:gen app — every registry variable the app reads ...
//       - NUXT_FOO=${NUXT_FOO:-}
//       # END env:gen app
//       - NUXT_SITE_URL=https://${DOMAIN:?DOMAIN required}   <- hand-written
//
// `bun scripts/env-gen.ts` rewrites the region: one line per registry
// variable the service reads in the stack's scopes (not `notPassed`, not
// `internal`) that the block does not already set by hand. Hand-written
// lines are the ones whose value is not a plain passthrough: a pinned
// value, a derived URL, a compose-level default, another variable's value.
// Variables the stack requires are `${NAME:?NAME required}`, others
// `${NAME:-}` (empty = the process's own default).

import { parse } from 'yaml'
import { registeredVars } from '../../shared/env/registry'
import { nameFor, type AnyVar, type Scope, type Service } from '../../shared/env/define'

export interface ComposeEnvStack {
  /** Compose file, relative to the repo root. */
  file: string
  /** Deployment shapes the stack serves (registry `scope`). */
  scopes: readonly Scope[]
  /** Variables required at boot become `:?` (compose refuses to start without them). */
  failFast: boolean
}

export const COMPOSE_ENV_STACKS: readonly ComposeEnvStack[] = [
  { file: 'deploy/compose/compose.prod.yml', scopes: ['both', 'hosted'], failFast: true },
  { file: 'deploy/compose/compose.selfhost.yml', scopes: ['both', 'self-host'], failFast: false }
]

const BEGIN = /^(\s*)# BEGIN env:gen ([a-z-]+)\b.*$/
const END = /^\s*# END env:gen ([a-z-]+)\s*$/

/** The registry variables `service` reads that a stack of these scopes passes. */
function passedVars(service: Service, scopes: readonly Scope[]): AnyVar[] {
  return registeredVars()
    .map(v => v.spec)
    .filter(spec => spec.services.includes(service) && scopes.includes(spec.scope) && !spec.notPassed && !spec.internal)
}

function required(spec: AnyVar): boolean {
  return spec.required === 'always' || spec.required === 'production'
}

/** The generated line of one variable. */
function line(spec: AnyVar, service: Service, stack: ComposeEnvStack): string {
  const value = stack.failFast && required(spec) ? `\${${spec.name}:?${spec.name} required}` : `\${${spec.name}:-}`
  return `- ${nameFor(spec, service)}=${value}`
}

/** Keys of `services.<service>.environment` in compose text. */
function envKeys(text: string, service: string): Set<string> {
  const doc = parse(text) as { services?: Record<string, { environment?: string[] | Record<string, unknown> }> }
  const env = doc.services?.[service]?.environment
  if (!env) return new Set()
  return new Set(Array.isArray(env) ? env.map(e => e.split('=')[0] ?? e) : Object.keys(env))
}

interface Region { start: number, end: number, indent: string, service: Service }

/** The marked regions of `lines`. Throws on a BEGIN without its END. */
function findRegions(file: string, lines: readonly string[]): Region[] {
  const regions: Region[] = []
  let open: Omit<Region, 'end'> | undefined
  lines.forEach((text, index) => {
    const begin = BEGIN.exec(text)
    if (begin && !open) {
      open = { start: index, indent: begin[1] ?? '', service: (begin[2] ?? '') as Service }
      return
    }
    const end = END.exec(text)
    if (!end || !open) return
    if (end[1] !== open.service) throw new Error(`${file}: "# BEGIN env:gen ${open.service}" ends with "# END env:gen ${end[1]}"`)
    regions.push({ ...open, end: index })
    open = undefined
  })
  if (open) throw new Error(`${file}: "# BEGIN env:gen ${open.service}" has no matching END`)
  return regions
}

/** `text` with every marked region regenerated. */
export function renderComposeEnv(stack: ComposeEnvStack, text: string): string {
  const lines = text.split('\n')
  const regions = findRegions(stack.file, lines)
  if (regions.length === 0) return text
  // Hand-written keys: the file with the generated lines left out.
  const inRegion = (index: number): boolean => regions.some(r => index > r.start && index < r.end)
  const handWrittenText = lines.filter((_, index) => !inRegion(index)).join('\n')

  const out: string[] = []
  let cursor = 0
  for (const r of regions) {
    out.push(...lines.slice(cursor, r.start))
    const own = envKeys(handWrittenText, r.service)
    const generated = passedVars(r.service, stack.scopes)
      .filter(spec => !own.has(nameFor(spec, r.service)))
      .map(spec => `${r.indent}${line(spec, r.service, stack)}`)
    out.push(
      `${r.indent}# BEGIN env:gen ${r.service} — plain passthrough of the registry variables (shared/env/); regenerate with \`bun run env:gen\`.`,
      ...generated,
      `${r.indent}# END env:gen ${r.service}`
    )
    cursor = r.end + 1
  }
  out.push(...lines.slice(cursor))
  return out.join('\n')
}
