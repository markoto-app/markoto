# Marketing site, SEO and pricing page

The public pages of the hosted instance: the product tour on `/`, marketing content pages, comparison and template pages, `/pricing`, and the SEO plumbing they share. Most of it is on only with `NUXT_MARKETING_SITE_ENABLED` (`useInstanceConfig().marketingSite`); self-hosted instances keep a plain home page. Agent rules are in [`app/AGENTS.md`](../../app/AGENTS.md).

## Product tour (`app/components/landing/`)

Logged-out visitors on the marketing site see `ProductTour.vue` on `/`; signed-in users get the dashboard (`app/components/home/Dashboard.vue`, lazy). Each scene shows a short looping video recorded from the real app by `bun run tour:capture` (`scripts/capture-tour.ts`); assets and metadata are in `public/tour/manifest.json`, validated on the server only (`shared/tour/schema.ts`, `shared/tour/data.ts`) and handed to the client by `useTourManifest()`.

- **CSS first.** On desktops with scroll-driven animation support (and no reduced motion) one sticky stage window travels through the scenes on scroll timelines (keyframes from `shared/tour/manifest.ts#stageSideKeyframes`). Elsewhere a static layout. Videos play only when on screen (`TourVisual.vue`); reduced motion shows the poster.
- **Scroll settling.** On the pinned layout `app/composables/marketing/useTourScroll.ts` loads Lenis with a dynamic import after load + idle (never on other pages, phones, the static layout or reduced motion). The visitor scrolls freely; when input stops the page settles on the nearest scene rest, or the next one in the direction of travel (`shared/tour/paging.ts#settleTarget`, unit-tested). Paging keys jump to the next rest. It fires `mk-tour:rest` / `mk-tour:depart` on `window`. Native CSS snapping is off while Lenis runs.
- **Light → dark.** The tour page starts light whatever the OS prefers and turns dark from the scene named by `TOUR_DARK_FROM` (`shared/tour/config.ts`) via `useTourTone()`. Its header toggle fixes the mode for the visit. A colour mode stored earlier never disables the flip.
- **Copy** is `tour.*` in all six locales: plain and concrete, nothing the product doesn't do, no preset counts.

## SEO (`shared/seo/`)

- **Titles:** template `%s · markoto` (`shared/seo/meta.ts#applyTitleTemplate`, set in `app.vue`). Pages set only their own title.
- **`useMarketingSeo({...})`** on every indexable page (`/`, `/pricing`, marketing content, `/docs/**`, `/legal/**`): description, robots, Open Graph, Twitter card. Absolute URLs come from the site URL, never from the request Host.
- **Social cards:** 1200×630 JPEGs in `public/og/`, built by `scripts/build-og-images.ts` (`shared/seo/ogImages.ts`). Keep the alt texts in step with the text the script draws.
- **Canonical:** `useCanonical()` for every route (`shared/seo/paths.ts#canonicalUrl`): `NUXT_CANONICAL_SITE_URL`, else `NUXT_SITE_URL`; none for `/d/**`. `/docs/**` off the marketing site points at `NUXT_DOCS_CANONICAL_BASE`.
- **Structured data:** one JSON-LD `@graph` per page (`shared/seo/structuredData.ts`): `useHomeStructuredData` on `/`, `usePageStructuredData` elsewhere, breadcrumbs from `shared/seo/breadcrumbs.ts`. No ratings or reviews. `tests/unit/seo/pageStructuredData.test.ts` checks required fields, references and duplicate ids.
- **Dates:** docs frontmatter `updated: 'YYYY-MM-DD'` (required on every docs page, `tests/unit/seo/seoAssets.test.ts`) and marketing `updated` feed dateModified and the sitemap; legal pages use their effective dates. Bump `updated` for substantive edits.
- **Lean first load:** public pages (logged-out `/`, `app/layouts/marketing.vue`, `app/layouts/docs.vue`, `/legal/**`) call `useLeanResourceHints()`, and `server/plugins/lean-resource-hints.ts` removes Nuxt's module preloads from their HTML. Code a logged-out visitor doesn't need stays in lazy components (dashboard, new-document dialog, signed-in menu, onboarding overlays). Sentry's browser SDK loads after idle (`app/plugins/sentry.client.ts`).
- **Server side:** `server/routes/sitemap.xml.ts` (`server/utils/platform/sitemap.ts`), robots and `X-Robots-Tag` (`server/plugins/robots.ts`; `NUXT_SITE_INDEXABLE=false` on staging).
- Measure with `make seo-audit` and `make lighthouse`. Title / description lengths are pinned by `tests/unit/seo/seoMetaLengths.test.ts`.

## Marketing pages

- **Content:** `content/marketing/<locale>/<slug>.md` (collection `marketing` in `content.config.ts`), rendered by `app/pages/[...marketing].vue`; rules in `shared/seo/marketing.ts`. English at `/<slug>`, German and French at `/<locale>/<slug>`. Pages with `reviewed: false` are `noindex`, show a notice and get no hreflang; the review flag is `reviewed: false` in the frontmatter of the `content/marketing/de` and `content/marketing/fr` files.
- **UI language on `/de/…`, `/fr/…`** follows the URL (`app/plugins/marketing-locale.ts`) without writing the language cookie.
- **Shell:** `app/components/marketing/Header.vue` (short: Pricing, Self-host, Docs, GitHub) and `app/components/common/LegalFooter.vue` (columns for product, use cases, comparisons, templates, legal). Use-case, comparison and template pages are linked from the footer only. Built from Nuxt UI page components (`UFooter`, `UPageCTA`, `UPageGrid`, `UPageCard`) and utilities; scoped CSS only where no class reaches.
- **MDC blocks** (`app/components/content/`): `::cta`, `::flow-strip`, `::tour-clip`, `::faq`, `::sample`, `::try-it`, `::sub-processors`, `::compare-table`, `::compare-facts`, `::compare-note`, `::template-cards`, `::page-shots`.
  - `::sample` renders committed Markdown with `renderTrustedMarkdown`, which skips DOMPurify on the server. Committed content only, never user input. Its headings become `div`s (`app/utils/marketing/sampleHeadings.ts`) so a sample doesn't add page headings.
  - `::try-it` shows a live editor + preview, loaded only when near the viewport. Visitor text never touches the trusted renderer; "Open as a document" goes through `useAnonDocCreate()`.
  - `::sub-processors` reads the live registry (`/api/_internal/sub-processors`); never retype the list.
- **Comparison pages:** competitor facts live in `content/compare/<slug>.yml`, each claim with a source and a `checked` date. `tests/unit/seo/compareClaims.test.ts` fails once a check is older than nine months: re-verify at the source, then bump the date. Every page keeps a "Where <competitor> is better" section.
- **Template pages:** "Use this template" is `::cta{template="<id>"}`, which opens the new-document dialog with that template. Gallery pictures in `public/templates/` are rendered by `make template-gallery` (`tests/unit/theme/templateGallery.test.ts`).
- `tests/unit/seo/marketingPages.test.ts` requires an English original with the same MDC blocks for every translation and Swiss German spelling (no `ß`).

## Pricing (`app/pages/pricing.vue`, `app/components/pricing/`)

With billing on or plans "coming soon": a single billing-period switch and currency select, three cards (Free, Pro, Teams with a Team / Business switch and a seat stepper; at most four highlight lines each from `PlanHighlights.vue`: AI Points, workspaces or people per workspace, then what a plan adds over the one below it, all read from the tier map), one line on extra AI Points packs, one line linking no-account writing and self-hosting (`MoreOptions.vue`), a comparison table (Free / Pro / Team / Business) behind a "Compare all details" disclosure, and an FAQ. While plans are "coming soon" a single waitlist bar sits above the cards and the paid cards' buttons focus it; on a self-hosted instance with billing off: one "Limits on this instance" card. Numbers come only from live config: caps from `GET /api/billing/tiers`, prices from `GET /api/billing/prices` (Stripe with billing on, else `shared/config/pricing.ts` + `TIER_<PLAN>_PRICE_*`). While plans are "coming soon" prices are shown as planned and left out of the Offer JSON-LD (`pricingStructuredData`). `/pricing` is not behind the `marketing-pages` middleware.
