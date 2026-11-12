// Per-layout placement of the cover page (editorial, banner, minimal,
// classic).

interface CoverCtx {
  justifyItems: string
  align: 'left' | 'center' | 'right'
  coverHeightMm: string
}

/**
 * Map the cover-page text-align value to the CSS Grid `justify-items`
 * keyword. Used uniformly across all cover layouts so a `text-align: right`
 * cover also right-aligns the logo / title block.
 */
export function textAlignToJustifyItems(align: 'left' | 'center' | 'right'): string {
  if (align === 'left') return 'start'
  if (align === 'right') return 'end'
  return 'center'
}

/** flexbox equivalent of `justify-items` (for non-grid layouts). */
function justifyItemsToFlexAlign(j: string): string {
  if (j === 'start') return 'flex-start'
  if (j === 'end') return 'flex-end'
  return 'center'
}

export function renderCoverLayoutCss(layout: string, ctx: CoverCtx): string {
  if (layout === 'title-block') return ''
  if (layout === 'editorial') return editorialCoverCss(ctx)
  if (layout === 'banner') return bannerCoverCss(ctx)
  if (layout === 'minimal') return minimalCoverCss(ctx)
  return classicCoverCss(ctx)
}

/**
 * Editorial: 6-row grid (logo → spacer 1fr → title+subtitle → spacer 1fr
 * → meta → spacer 1fr). Three equal spacers anchor logo at top, title
 * block at ~1/3, meta at ~2/3, with the bottom third intentionally empty.
 * A short accent rule sits above the title and a hairline above the
 * author/date block; a cover without a logo gets a full-bleed accent band
 * along the top edge (`markoto-cover--no-logo`, set by coverHtml.ts) so
 * it isn't a bare white sheet — the editorial cousin of `banner`.
 * The subtitle sits at the top of the spacer row under the title: two
 * items in ONE row of a grid without explicit columns get auto-placed
 * side by side (title left, subtitle right), so every item is pinned to
 * column 1.
 */
function editorialCoverCss({ justifyItems, align, coverHeightMm }: CoverCtx): string {
  return `.paged-doc .markoto-cover {
  page: cover-page;
  break-after: page;
  page-break-after: always;
  display: grid;
  grid-template-rows: auto 1fr auto 1fr auto 1fr;
  justify-items: ${justifyItems};
  align-items: start;
  text-align: ${align};
  height: ${coverHeightMm};
  padding: 24mm 18mm;
  box-sizing: border-box;
}
.paged-doc .markoto-cover-logo { grid-row: 1; grid-column: 1; }
.paged-doc .markoto-cover-title { grid-row: 3; grid-column: 1; }
.paged-doc .markoto-cover-title::before {
  content: '';
  display: block;
  width: 16mm;
  height: 0;
  border-top: 2.5pt solid var(--doc-brand);
  margin: 0 ${align === 'right' ? '0' : 'auto'} 0.45em ${align === 'left' ? '0' : 'auto'};
}
.paged-doc .markoto-cover-subtitle { grid-row: 4; grid-column: 1; align-self: start; }
.paged-doc .markoto-cover-meta {
  grid-row: 5;
  grid-column: 1;
  border-top: 0.75pt solid color-mix(in srgb, var(--doc-secondary) 60%, transparent);
  padding-top: 0.9em;
  min-width: 55%;
}
.paged-doc .markoto-cover--no-logo {
  background: linear-gradient(var(--doc-brand), var(--doc-brand)) top left / 100% 7mm no-repeat;
}`
}

/**
 * Banner: brand-tinted top band holding logo + title, page colour beneath
 * with subtitle and meta. One full-width grid column; the band is the
 * cover's `::before` (a grid item spanning the logo + title rows) so the
 * logo keeps its own size and the title its own width — painting the
 * tint on the logo `<img>` itself stretched an empty tinted box beside
 * the title. With no logo, the title is the first child and takes the
 * band's top padding itself.
 */
function bannerCoverCss({ justifyItems, align, coverHeightMm }: CoverCtx): string {
  return `.paged-doc .markoto-cover {
  page: cover-page;
  break-after: page;
  page-break-after: always;
  display: grid;
  grid-template-columns: 100%;
  grid-template-rows: auto auto auto 1fr auto;
  justify-items: ${justifyItems};
  text-align: ${align};
  height: ${coverHeightMm};
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
.paged-doc .markoto-cover::before {
  content: '';
  grid-row: 1 / 3;
  grid-column: 1;
  justify-self: stretch;
  align-self: stretch;
  background: color-mix(in srgb, var(--doc-brand) 12%, var(--doc-bg));
}
.paged-doc .markoto-cover-logo { grid-row: 1; grid-column: 1; box-sizing: content-box; padding: 24mm 18mm 0 18mm; }
.paged-doc .markoto-cover-title { grid-row: 2; grid-column: 1; box-sizing: border-box; max-width: 100%; margin: 0; padding: 0.6em 18mm 18mm 18mm; }
.paged-doc .markoto-cover-title:first-child { padding-top: 24mm; }
.paged-doc .markoto-cover-subtitle { grid-row: 3; grid-column: 1; box-sizing: border-box; max-width: 100%; margin: 0; padding: 14mm 18mm 0 18mm; }
.paged-doc .markoto-cover-meta { grid-row: 5; grid-column: 1; margin: 0; padding: 0 18mm 24mm 18mm; }`
}

/**
 * Minimal: title (and optional subtitle) centered. Logo + meta are
 * HIDDEN in this layout regardless of their toggles — "minimal" is a
 * stronger statement than "what you toggled on".
 */
function minimalCoverCss({ justifyItems, align, coverHeightMm }: CoverCtx): string {
  return `.paged-doc .markoto-cover {
  page: cover-page;
  break-after: page;
  page-break-after: always;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: ${justifyItemsToFlexAlign(justifyItems)};
  text-align: ${align};
  height: ${coverHeightMm};
  padding: 24mm 18mm;
  box-sizing: border-box;
}
.paged-doc .markoto-cover-logo,
.paged-doc .markoto-cover-meta { display: none; }`
}

/**
 * Classic — flex-column, vertically centered, everything stacked.
 * Default spacing between elements via per-element margins.
 */
function classicCoverCss({ justifyItems, align, coverHeightMm }: CoverCtx): string {
  return `.paged-doc .markoto-cover {
  page: cover-page;
  break-after: page;
  page-break-after: always;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: ${justifyItemsToFlexAlign(justifyItems)};
  text-align: ${align};
  height: ${coverHeightMm};
  padding: 24mm 18mm;
  box-sizing: border-box;
}`
}
