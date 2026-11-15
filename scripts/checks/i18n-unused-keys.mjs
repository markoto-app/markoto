#!/usr/bin/env bun
// Lists en.json keys with no literal reference in the sources.
//
// A key counts as referenced when its full dotted name appears in app/, server/,
// shared/, modules/ or content/, or when it sits under a dynamic prefix such as
// t(`pricing.plan.${id}.name`) / t('pricing.plan.' + id). By default a literal
// reference to an ancestor object (tm('a.b')) also counts; pass --strict to
// disable that. Output is a candidate list: keys built from runtime data in
// ways no static scan can see still show up, so review before deleting.
//
// --check fails on a candidate not listed in i18n-unused-keys.baseline (a key
// added without a reference, or one whose last reference was removed) and on a
// baseline entry that is referenced again or gone, so the list only shrinks.
// A key that is used in a way the scan can't see goes into the baseline.
//   bun scripts/checks/i18n-unused-keys.mjs [--strict] [--json] [--check]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const strict = process.argv.includes('--strict')

const flatten = (o, p = '', r = []) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, r)
    else r.push(key)
  }
  return r
}
const keys = flatten(JSON.parse(readFileSync(join(root, 'i18n/locales/en.json'), 'utf8')))

const sources = execFileSync(
  'git',
  ['ls-files', '-z', 'app', 'server', 'shared', 'modules', 'content', 'nuxt.config.ts', 'content.config.ts'],
  { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }
)
  .split('\0')
  .filter(f => /\.(ts|tsx|vue|mjs|js|md|yml|yaml|json)$/.test(f))
const haystack = sources.map(f => readFileSync(join(root, f), 'utf8')).join('\n')

const prefixes = new Set()
for (const m of haystack.matchAll(/['"`]([\w-]+(?:\.[\w-]+)*\.)\$\{/g)) prefixes.add(m[1])
for (const m of haystack.matchAll(/['"`]([\w-]+(?:\.[\w-]+)*\.)['"`]\s*\+/g)) prefixes.add(m[1])
const prefixList = [...prefixes]

const literal = k => haystack.includes(k)
const ancestors = (k) => {
  const parts = k.split('.')
  const out = []
  for (let i = 2; i < parts.length; i++) out.push(parts.slice(0, i).join('.'))
  return out
}

const unused = keys.filter((k) => {
  if (literal(k)) return false
  if (prefixList.some(p => k.startsWith(p))) return false
  if (!strict && ancestors(k).some(a => new RegExp(`['"\`]${a.replaceAll('.', '\\.')}['"\`]`).test(haystack))) return false
  return true
})

if (process.argv.includes('--check')) {
  const baselinePath = join(root, 'scripts/checks/i18n-unused-keys.baseline')
  const baseline = new Set(
    readFileSync(baselinePath, 'utf8')
      .split('\n')
      .map(line => line.replace(/#.*/, '').trim())
      .filter(Boolean)
  )
  const unlisted = unused.filter(k => !baseline.has(k))
  const stale = [...baseline].filter(k => !unused.includes(k))
  for (const k of unlisted) console.error(`unused i18n key: ${k} (remove it from every locale, or list it in scripts/checks/i18n-unused-keys.baseline if the scan can't see its use)`)
  for (const k of stale) console.error(`stale baseline entry: ${k} (referenced again or removed; delete it from scripts/checks/i18n-unused-keys.baseline)`)
  if (unlisted.length || stale.length) process.exit(1)
  console.log(`i18n keys: no new unused keys (${baseline.size} known in the baseline)`)
} else if (process.argv.includes('--json')) console.log(JSON.stringify({ total: keys.length, dynamicPrefixes: prefixList, unused }, null, 2))
else {
  for (const k of unused) console.log(k)
  console.error(`\n${unused.length} of ${keys.length} en.json keys have no literal reference (${prefixList.length} dynamic prefixes discounted${strict ? ', strict' : ''})`)
}
