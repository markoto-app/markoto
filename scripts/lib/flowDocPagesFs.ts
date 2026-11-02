import fs from 'node:fs'
import path from 'node:path'
import { buildFlowDocPages } from '../../shared/docs/flowDocPages'

/**
 * Read every markdown file under `docsDir` (content/docs) and return the
 * flow slug → docs route map. Synchronous on purpose: nuxt.config.ts calls
 * it while the config object is being built.
 */
export function scanFlowDocPages(docsDir: string): Record<string, string> {
  if (!fs.existsSync(docsDir)) return {}
  const files = fs.readdirSync(docsDir, { recursive: true, encoding: 'utf8' })
    .filter(rel => rel.endsWith('.md'))
    .map(rel => ({ path: rel, text: fs.readFileSync(path.join(docsDir, rel), 'utf8') }))
  return buildFlowDocPages(files)
}
