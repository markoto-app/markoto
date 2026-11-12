#!/usr/bin/env bun
// Reports backticked repo paths in tracked Markdown that no longer exist.
//
// Docs rot when files move; this catches `server/utils/foo.ts` style references
// that point nowhere. Run: `bun scripts/checks/md-paths.mjs [--json]`.
//
// Resolution (any hit passes): repo root, the Markdown file's own directory,
// any ancestor of that directory (sub-AGENTS.md files say `repos/x.ts` for
// `server/repos/x.ts`), and, for bare file names, the base name of any tracked
// file. Fenced code blocks are skipped (they hold commands, not references).
//
// Opt-outs: put `md-paths-ignore` anywhere on the line (e.g. in an HTML
// comment), or list the path in scripts/checks/md-paths.allowlist
// (`path`, `dir/` prefix, or `file.md: path`; `#` comments).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const ls = (...args) =>
  execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter(Boolean)

// Cached + untracked-not-ignored: new files in a working tree count, ignored ones do not.
const files = [...new Set([...ls(), ...ls('--others', '--exclude-standard')])]
const fileSet = new Set(files)
const dirSet = new Set()
const baseSet = new Set()
for (const f of files) {
  baseSet.add(basename(f))
  for (let d = dirname(f); d !== '.'; d = dirname(d)) dirSet.add(d)
}
const topLevel = new Set(files.map(f => f.split('/')[0]))

const EXCLUDE = [/^content\//, /^tests\/fixtures\//, /^shared\/templates\/content\//, /^CHANGELOG\.md$/, /(^|\/)node_modules\//]
const docs = files.filter(f => f.endsWith('.md') && !EXCLUDE.some(re => re.test(f)) && existsSync(join(root, f)))

const EXTENSIONS = new Set(['ts', 'tsx', 'vue', 'md', 'yml', 'yaml', 'sql', 'sh', 'json', 'jsonc', 'mjs', 'cjs', 'js', 'css', 'py', 'toml', 'conf', 'properties', 'lock', 'html', 'txt', 'svg', 'png', 'woff', 'woff2'])
const EXT = { test: p => EXTENSIONS.has(p.slice(p.lastIndexOf('.') + 1)) && p.includes('.') }
const allow = []
const allowPath = join(root, 'scripts/checks/md-paths.allowlist')
if (existsSync(allowPath)) {
  for (const raw of readFileSync(allowPath, 'utf8').split('\n')) {
    const hash = raw.indexOf('#')
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim()
    if (!line) continue
    // eslint-disable-next-line sonarjs/super-linear-regex -- the repo's own allowlist file, one short line at a time
    const m = line.match(/^(\S+\.md):\s*(.+)$/)
    allow.push(m ? { doc: m[1], p: m[2].trim() } : { doc: null, p: line })
  }
}
const allowed = (doc, p) =>
  allow.some(a => (a.doc === null || a.doc === doc) && (a.p.endsWith('/') ? p.startsWith(a.p) : a.p === p))

function exists(doc, p) {
  const bare = !p.includes('/')
  const clean = p.replace(/\/$/, '')
  const has = c => fileSet.has(c) || dirSet.has(c)
  if (has(clean)) return true
  // Import specifiers drop the extension (`shared/utils/security/secrets`).
  if (!EXT.test(clean) && ['.ts', '.vue', '.mjs', '.js', '.json'].some(e => has(clean + e))) return true
  for (let d = dirname(doc); ; d = dirname(d)) {
    if (d === '.') break
    if (has(posix.join(d, clean))) return true
  }
  if (bare) return baseSet.has(clean)
  // Trees in docs abbreviate (`db/schema.ts` under a `server/` heading): accept a
  // unique-enough suffix of a tracked path.
  const suffix = '/' + clean
  return files.some(f => f.endsWith(suffix)) || [...dirSet].some(d => d.endsWith(suffix))
}

const missing = []
for (const doc of docs) {
  let fenced = false
  const lines = readFileSync(join(root, doc), 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      return
    }
    if (fenced || line.includes('md-paths-ignore')) return
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      let t = m[1].trim()
      if (/[\s<>{}*$|=,;!?"'\\^]/.test(t) || t.includes('://')) continue
      if (/^(\/|~|@|-|\.\.\.|#)/.test(t)) continue
      // `file.ts:123` and `file.py:Symbol` point at a place inside the file.
      t = t.replace(/^\.\//, '')
      if (t.includes('#')) t = t.slice(0, t.indexOf('#'))
      t = t.replace(/:(\d+(-\d+)?|\w+)$/, '').replace(/\(\)$/, '')
      // A bare extension (`.md`, `.png`) is a pattern, not a path; `.env`/`.nuxt`/`.output` are runtime.
      if (!t || (EXT.test(t) && t.startsWith('.') && !t.includes('/') && !t.startsWith('.github')) || /^\.(env|nuxt|output|ansible)/.test(t) || t.startsWith('../')) continue
      const hasSlash = t.includes('/')
      const looksPath = hasSlash
        ? EXT.test(t) || topLevel.has(t.split('/')[0])
        : EXT.test(t) && /^[\w.[\]()-]+$/.test(t) && !/^\d/.test(t) && !/^[\w-]+\.(com|app|io|dev|org|net|ch)$/.test(t)
      if (!looksPath) continue
      if (/\.\w+\.\w+$/.test(t) && !EXT.test(t)) continue
      if (/^[A-Za-z0-9-]+\.[a-z]+$/.test(t) && /^(node|bun|vue|next|nuxt|chart|d3|three)\.js$/i.test(t)) continue
      if (allowed(doc, t) || exists(doc, t)) continue
      missing.push({ doc, line: i + 1, path: t })
    }
  })
}

if (process.argv.includes('--json')) console.log(JSON.stringify(missing, null, 2))
else {
  for (const m of missing) console.log(`${m.doc}:${m.line}: missing path \`${m.path}\``)
  console.log(`\n${missing.length} dangling path reference(s) in ${docs.length} Markdown files`)
}
process.exit(missing.length ? 1 : 0)
