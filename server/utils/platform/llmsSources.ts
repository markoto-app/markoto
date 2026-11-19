import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { buildLlmsFullTxt, buildLlmsTxt, type SourceFile } from './llmsTxt'

// The Markdown sources of llms.txt / llms-full.txt (server/utils/platform/llmsTxt.ts):
// content/docs (the user docs) and content/marketing/en (the English
// marketing pages), read from the content/ folder the image ships
// (Dockerfile, like the legal texts). Built once per process and origin:
// the files change only with a new image.

async function markdownFiles(dir: string): Promise<SourceFile[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own content folder (fixed names under process.cwd())
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files = entries
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => join(e.parentPath, e.name))
    .sort()
  return Promise.all(files.map(async file => ({
    path: relative(dir, file).split(sep).join('/'),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths come from listing our own content folder
    raw: await readFile(file, 'utf8')
  })))
}

interface LlmsDocuments {
  index: string
  full: string
}

const cache = new Map<string, Promise<LlmsDocuments>>()

async function build(base: string): Promise<LlmsDocuments> {
  const root = join(process.cwd(), 'content')
  const [docs, marketing] = await Promise.all([
    markdownFiles(join(root, 'docs')),
    markdownFiles(join(root, 'marketing', 'en'))
  ])
  return { index: buildLlmsTxt({ base, docs, marketing }), full: buildLlmsFullTxt({ base, docs }) }
}

/** llms.txt and llms-full.txt for a site origin (cached). */
export function llmsDocuments(base: string): Promise<LlmsDocuments> {
  let documents = cache.get(base)
  if (!documents) {
    documents = build(base)
    // A failed read is retried on the next request instead of cached.
    documents.catch(() => cache.delete(base))
    cache.set(base, documents)
  }
  return documents
}
