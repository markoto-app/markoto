import MarkdownIt from 'markdown-it'
import anchor from 'markdown-it-anchor'
import toc from 'markdown-it-toc-done-right'
import { trimChars } from '~~/shared/utils/trimChars'

// Renderer for the bundled legal documents (/legal/*). See
// server/api/_internal/legal/[slug].get.ts.

/**
 * Section anchors for the in-page contents list (`[[toc]]` in the
 * sources). ASCII slugs ("5-storage-location-and-retention"), accents
 * folded, so every locale gets readable, stable fragment links.
 */
export function legalSlugify(text: string): string {
  return trimChars(text
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-'), '-')
}

export const legalMarkdown = new MarkdownIt({
  html: false, // markdown source is trusted but defence-in-depth — any future external author can't smuggle raw HTML
  linkify: true, // bare URLs in the body auto-link
  typographer: true // smart quotes
})
  // The typographer's "replacements" rule turns (c) into ©, (r) into ®
  // and +- into ±. Legal texts cite "Art. 6(1)(c) GDPR", so it stays off;
  // smart quotes are a separate rule and keep working.
  .disable('replacements')
  .use(anchor, { level: [2], slugify: legalSlugify, tabIndex: false })
  .use(toc, { level: [2], slugify: legalSlugify, listType: 'ul', containerClass: 'legal-toc' })
