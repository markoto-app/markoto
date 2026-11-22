import type { DocTheme } from '../types/theme'
import { cssFontStack } from './cssValues'

// Citations, the generated bibliography, cross-references, labelled
// equations and the lists of figures / tables (app/utils/markdown/
// citationResolve.ts writes the markup). Emitted for every theme: the
// rules only match elements a document with citations or labels has.

export function citationBlock(theme: DocTheme): string {
  const { leaderStyle, showPageNumbers } = theme.toc
  const indent = 'var(--doc-reference-indent, 1.5em)'
  const rules = [
    `.paged-doc .csl-sc { font-variant: small-caps; }
.paged-doc a.csl-cite-link, .paged-doc a.markoto-xref { color: inherit; text-decoration: none; }
.paged-doc .markoto-bibliography { margin: 0.4em 0 1em; }
.paged-doc .csl-entry { margin: 0 0 0.45em; overflow-wrap: anywhere; }
.paged-doc .csl-author-date > .csl-entry { padding-left: ${indent}; text-indent: calc(-1 * ${indent}); }
.paged-doc .csl-numeric > .csl-entry { display: flex; gap: 0.5em; }
.paged-doc .csl-numeric .csl-left-margin { flex: 0 0 2.4em; font-variant-numeric: lining-nums tabular-nums; }
.paged-doc .csl-numeric .csl-right-inline { flex: 1 1 0; min-width: 0; }
.paged-doc .csl-entry a { color: inherit; }`,
    // Unknown key or label: visible in the preview and the PDF alike, so
    // the author notices it before handing the document in.
    `.paged-doc .markoto-broken-ref {
  color: #b42318;
  background: rgba(180, 35, 24, 0.08);
  border-bottom: 1px dashed currentColor;
  font-weight: 600;
}`,
    // Labelled display equation: number at the right margin, centred on the formula.
    `.paged-doc .markoto-equation { display: flex; align-items: center; gap: 1em; }
.paged-doc .markoto-equation > .katex-block { flex: 1 1 0; min-width: 0; }
.paged-doc .markoto-equation::after {
  content: attr(data-markoto-number);
  flex: none;
  font-variant-numeric: lining-nums tabular-nums;
}`,
    // [[lof]] / [[lot]]: laid out like the table of contents.
    `.paged-doc .markoto-list { margin: 1.2em 0 2.2em 0; }
.paged-doc .markoto-list-title {
  font-family: ${cssFontStack(theme.headings.font)};
  font-size: 1.25em;
  font-weight: 700;
  color: var(--doc-heading-color);
  margin-bottom: 0.6em;
}
.paged-doc .markoto-list ul { list-style: none; padding-left: 0; margin: 0; }
.paged-doc .markoto-list li { margin: 0; break-inside: avoid; }
.paged-doc .markoto-list li + li { margin-top: 0.3em; }
.paged-doc .markoto-list a { display: flex; align-items: baseline; gap: 0.4em; text-decoration: none; color: var(--doc-text); }
.paged-doc .markoto-list-number { flex: none; min-width: 6em; }`
  ]
  if (leaderStyle !== 'none') {
    rules.push(`.paged-doc .markoto-list a::before {
  content: '';
  flex: 1;
  order: 2;
  border-bottom: 1px ${leaderStyle} var(--doc-secondary);
  transform: translateY(-0.25em);
  margin: 0 0.3em;
}`)
  }
  if (showPageNumbers) {
    rules.push(`.paged-doc .markoto-list a::after {
  content: target-counter(attr(href url), page);
  order: 3;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--doc-secondary);
}`)
  }
  return rules.join('\n')
}
