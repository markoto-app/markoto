// Image URLs the in-editor AI may put into the document.
//
// The system prompt's CRITICAL IMAGE RULE says to embed only URLs that a
// tool returned or the user gave, but at temperature 0 Mistral still
// skips `generate_image` and writes a made-up URL straight into the
// document (`https://placehold.co/…`, an invented `api.files.markoto.app`
// path). A prompt rule can't stop that, so the loop enforces it: an edit may only ADD an image whose URL this session
// has already seen — in the document, the user's prompt, or a tool result
// (`generate_image` returns the stored `/api/files/…` path; `web_search`,
// `fetch_url`, `view_other_document` and the knowledge tools return the
// URLs they found). MCP clients are not affected: their own agent decides
// what to embed, and this check lives in the in-editor loop only.

/** Markdown image targets: `![alt](url)`, `![alt](<url>)`, `![alt](url "title")`. */
// Bounded runs: the text comes from documents and web pages, and with
// unbounded `[^\]]*` / `\s+…\s*` every `![` without its `](…)` rescans the
// rest of the text. Real alt texts, URLs and titles fit well inside.
// eslint-disable-next-line security/detect-unsafe-regex -- every run is bounded (see above): linear in the text
const MARKDOWN_IMAGE_RE = /!\[[^\]]{0,1000}\]\(\s{0,32}<?([^\s)>]{1,4096})>?(?:\s{1,32}"[^"]{0,1000}")?\s{0,32}\)/g

/** Every image URL a Markdown snippet references, in order, de-duplicated. */
export function markdownImageUrls(markdown: string): string[] {
  const urls = new Set<string>()
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
    const url = match[1]
    if (url) urls.add(url)
  }
  return [...urls]
}

const UNSEEN_IMAGE_ERROR_PREFIX = 'Error: image URL not from this session'

/**
 * Text this session has seen. An image URL is allowed when it occurs in
 * that text verbatim, so a URL can only come from the document, the
 * user, or a real tool result — never from the model's imagination.
 */
export class ImageUrlProvenance {
  private readonly seen: string[] = []

  constructor(...initial: Array<string | null | undefined>) {
    for (const text of initial) this.note(text)
  }

  note(text: string | null | undefined): void {
    if (text) this.seen.push(text)
  }

  /** Image URLs in `addedText` that no seen text contains. */
  unseenImageUrls(addedText: string, currentDocText: string | null): string[] {
    return markdownImageUrls(addedText).filter(url =>
      !(currentDocText?.includes(url)) && !this.seen.some(text => text.includes(url))
    )
  }
}

export function unseenImageError(urls: string[], canGenerate: boolean): string {
  const list = urls.slice(0, 3).join(', ')
  const fix = canGenerate
    ? 'To add a picture, call generate_image and insert the URL it returns, verbatim.'
    : 'No image tool is available in this session: describe the picture in text instead, or ask the user for an image URL.'
  return `${UNSEEN_IMAGE_ERROR_PREFIX}: ${list}. You may only embed image URLs that appear in the document, the user's request or a tool result of this session. ${fix} The document was not changed.`
}
