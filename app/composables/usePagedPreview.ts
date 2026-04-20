import type { Ref } from 'vue'
import type { DocTheme } from '~~/shared/types/theme'
import { themeToCss, themeFontsImport } from '~~/shared/utils/themeToCss'
import { PAGEDJS_POLYFILL_URL } from '~~/shared/utils/pagedjsCdn'
import { hljsThemeUrl } from '~~/shared/utils/hljsCdn'
import { KATEX_CSS_URL } from '~~/shared/utils/katexCdn'
import { MERMAID_ESM_URL } from '~~/shared/utils/mermaidCdn'

/**
 * Preview pane backed by a persistent same-origin iframe.
 *
 * Why an iframe instead of rendering paged.js directly into the host page:
 *
 *   paged.js was designed to paginate a static document once. It mutates
 *   global state — appends `<style>` elements to `document.head`, sets
 *   `:root` custom properties — and re-paginates the entire doc on every
 *   call. When you re-run paged.js into the same window on every keystroke,
 *   the new render's stylesheet retroactively re-styles the OLD pages
 *   still on screen (causing visible reflow), accumulated stylesheets pile
 *   up in head, and subpixel layout differences between renders show up
 *   as horizontal jitter on the live preview.
 *
 *   We tried six rounds of mitigations (off-screen swap, style cleanup,
 *   height pin, position-fixed, sequential queueing, adaptive debounce)
 *   and the symptom kept resurfacing in different forms. The conclusion:
 *   we were fighting paged.js's design assumption that it owns the
 *   document. The clean fix is to give it its own document context.
 *
 *   Inside an iframe, every paged.js head-style mutation, every :root
 *   var, every layout reflow stays scoped to the iframe. The parent app
 *   is fully insulated. Even the iframe's internal flicker is bounded —
 *   it's just the preview pane visibly re-rendering, which the user
 *   already expects to do during pagination.
 *
 * Communication is one-way through `iframe.contentWindow.__renderDoc(opts)`
 * (parent → iframe) and a single `postMessage` event for page count
 * (iframe → parent). The iframe initialization document is built inline
 * in `IFRAME_BOOTSTRAP` below — it loads the paged.js polyfill from the
 * `/api/_internal/pagedjs-polyfill.js` Nitro endpoint (same one the PDF
 * print iframe uses) and exposes the render function once `Paged.Previewer`
 * is available.
 */
export function usePagedPreview(opts: {
  html: Ref<string>
  theme: Ref<DocTheme>
  title: Ref<string>
  container: Ref<HTMLElement | null>
}) {
  const pageCount = ref(0)
  const isPaginating = ref(false)
  const isReady = ref(false)
  const error = ref<string | null>(null)

  let iframe: HTMLIFrameElement | null = null
  // If a render is requested before the iframe is ready, queue it. Only
  // the latest pending render matters — earlier ones are coalesced.
  let pendingRender = false

  function handleMessage(e: MessageEvent) {
    if (!iframe || e.source !== iframe.contentWindow) return
    const data = e.data as { type?: string; pageCount?: number; message?: string } | undefined
    if (!data?.type) return
    if (data.type === 'iframe-ready') {
      isReady.value = true
      error.value = null
      if (pendingRender) {
        pendingRender = false
        render()
      }
    } else if (data.type === 'paginated') {
      pageCount.value = data.pageCount ?? 0
      isPaginating.value = false
    } else if (data.type === 'iframe-error') {
      error.value = data.message ?? 'Preview failed to load.'
      isPaginating.value = false
    }
  }

  function render() {
    if (!isReady.value || !iframe?.contentWindow) {
      pendingRender = true
      return
    }
    const themeCss = themeToCss(opts.theme.value, {
      title: opts.title.value || '',
      date: new Date().toISOString().slice(0, 10)
    })
    const fontsImport = themeFontsImport(opts.theme.value)
    const hljsUrl = hljsThemeUrl(opts.theme.value.code.theme)
    const mermaidTheme = opts.theme.value.mermaid.theme
    isPaginating.value = true
    ;(iframe.contentWindow as unknown as { __renderDoc: (o: unknown) => void }).__renderDoc({
      html: opts.html.value,
      themeCss,
      fontsImport,
      hljsUrl,
      mermaidTheme
    })
  }

  // 250ms debounce. Lower than the previous 800ms because the iframe
  // contains the layout cost — re-paginates don't cause cross-contamination
  // and there's no off-screen-swap dance to amortize. Could probably go
  // lower; tune based on user feel.
  const debouncedRender = useDebounceFn(render, 250)

  let firstRender = true
  watch([opts.html, opts.theme, opts.title], () => {
    if (firstRender) {
      firstRender = false
      render()  // immediate first paint after sync
    } else {
      debouncedRender()
    }
  })

  onMounted(() => {
    if (!opts.container.value) return
    window.addEventListener('message', handleMessage)
    iframe = document.createElement('iframe')
    iframe.title = 'Document preview'
    iframe.style.cssText = 'width: 100%; height: 100%; border: 0; display: block; background: transparent;'
    // hljs theme is set per-render (depends on `theme.blocks.codeBlockTheme`).
    // Bootstrap leaves the link href empty; renderDoc fills it.
    iframe.srcdoc = IFRAME_BOOTSTRAP
      .replace('__PAGEDJS_POLYFILL_URL__', PAGEDJS_POLYFILL_URL)
      .replace('__KATEX_CSS_URL__', KATEX_CSS_URL)
      .replace('__MERMAID_ESM_URL__', MERMAID_ESM_URL)
    opts.container.value.appendChild(iframe)
  })

  onUnmounted(() => {
    window.removeEventListener('message', handleMessage)
    if (iframe?.parentNode) iframe.remove()
    iframe = null
  })

  return {
    pageCount: readonly(pageCount),
    isPaginating: readonly(isPaginating),
    isReady: readonly(isReady),
    error: readonly(error)
  }
}

/**
 * Iframe bootstrap document. Loads the paged.js polyfill (with auto-init
 * disabled) and exposes `window.__renderDoc` to the parent. Holds the
 * preview's CSS chrome (page card background, drop shadow, scroll
 * behavior) — the theme CSS that defines `@page` rules, body styles,
 * and headers/footers is pushed in dynamically per render.
 *
 * Scroll handling: capture `window.scrollY` before the swap, restore
 * after. Snap to bottom if the user was within 50px of the end — Letter
 * common case where small edits at the doc bottom would otherwise jump
 * back to the previous valid scrollTop after a re-pagination shrinks
 * the doc by one line.
 */
const IFRAME_BOOTSTRAP = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: #f1f5f9;
    scrollbar-gutter: stable;
  }
  body {
    /* Heavy bottom padding so scrolling reveals the last page in full
       even though the floating AI bar (in the parent app) overlays
       this iframe's bottom 80–100 px. Without it the final page sits
       behind the bar and looks cropped. */
    padding: 24px 16px 120px 16px;
    min-height: 100vh;
    box-sizing: border-box;
  }
  .paged-mount .pagedjs_pages {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    /* Responsive scaling: pages are absolute-sized via @page (A4 = ~794px),
       which would clip on narrow screens. \`zoom\` shrinks the visual
       AND the layout box (unlike \`transform: scale\` which leaves the
       layout box at full size and overflows). The scale factor is
       computed in JS after each pagination and on iframe resize so the
       page width always equals the available column. */
    zoom: var(--page-zoom, 1);
  }
  .paged-mount .pagedjs_page {
    background: white;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08), 0 4px 12px rgba(0, 0, 0, 0.05);
  }
  /* Off-screen scratch mount used during pagination — sits in the
     fixed-position layer (relative to the iframe viewport, not body)
     so it doesn't contribute to body's scroll height. Same class as
     the visible mount so paged.js's flex centering computes identically. */
  #pending {
    position: fixed;
    left: -10000px;
    top: 0;
    visibility: hidden;
    pointer-events: none;
  }

  /* Dark-mode preview — only the chrome behind the pages flips. The
     pages themselves render exactly as the theme says (white paper,
     dark text) so what you see in the editor is what you'll print.
     The body bg is overridden at runtime to match the parent app's
     chrome (see syncDarkPreview below); page styling stays untouched.
     Heavier shadow so the page sits cleanly against the dark canvas. */
  body.dark-preview .paged-mount .pagedjs_page {
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5), 0 8px 24px rgba(0, 0, 0, 0.4);
  }
</style>
<!-- KaTeX stylesheet — static, doesn't change with theme. Loaded
     statically in head so the math glyph fonts start fetching as soon
     as the iframe initializes. -->
<link rel="stylesheet" href="__KATEX_CSS_URL__">
<style id="theme-fonts"></style>
<style id="theme-css"></style>
</head>
<body>
<div id="mount" class="paged-mount"></div>
<div id="pending" class="paged-mount"></div>
<script>window.PagedConfig = { auto: false };</script>
<script src="__PAGEDJS_POLYFILL_URL__" onerror="window.parent.postMessage({type:'iframe-error',message:'Could not load paged.js polyfill from CDN. Check your network connection.'}, '*')"></script>
<script>
(function() {
  // 'targetOrigin' is intentionally '*' for srcdoc iframes — they have an
  // opaque origin in some browsers (Chromium reports "null" for srcdoc),
  // so an origin-restricted postMessage would silently fail. The trust
  // boundary on the parent side is the e.source === iframe.contentWindow
  // check in handleMessage, which is sufficient here.
  var POLL_INTERVAL = 30;
  var POLL_TIMEOUT = 10000;
  var pollStart = Date.now();

  // Mirror the parent app's color mode + chrome bg onto the iframe so
  // the dark-preview overrides kick in AND the area around the pages
  // matches the rest of the app (instead of hardcoded pure black).
  // srcdoc iframes share the parent origin, so we can read parent
  // styles directly and observe class-list changes — no postMessage
  // round-trip needed.
  function readParentChromeBg() {
    try {
      // Walk up from body to html, returning the first non-transparent
      // background. Nuxt UI tends to put the canvas color on body, but
      // some layouts move it to html.
      var candidates = [window.parent.document.body, window.parent.document.documentElement];
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (!el) continue;
        var bg = window.parent.getComputedStyle(el).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
      }
    } catch (e) { /* parent inaccessible */ }
    return null;
  }

  function syncDarkPreview() {
    try {
      var parentHtml = window.parent.document.documentElement;
      var isDark = parentHtml.classList.contains('dark');
      document.body.classList.toggle('dark-preview', isDark);
      // \`color-scheme\` is what tells the browser to render native UA
      // widgets (scrollbar, form controls) in dark variants. Without
      // this the iframe scrollbar stays light grey in dark mode and
      // breaks the theme line. Mirroring the parent so the iframe
      // scrollbar always matches the app's.
      document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
      var bg = readParentChromeBg();
      if (bg) document.body.style.background = bg;
    } catch (e) { /* parent inaccessible — give up silently */ }
  }
  syncDarkPreview();
  try {
    var parentObserver = new MutationObserver(syncDarkPreview);
    parentObserver.observe(window.parent.document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });
  } catch (e) { /* MutationObserver setup failed — initial sync is still in place */ }

  function whenPagedReady(cb) {
    if (window.Paged && window.Paged.Previewer) { cb(); return; }
    if (Date.now() - pollStart > POLL_TIMEOUT) {
      window.parent.postMessage({
        type: 'iframe-error',
        message: 'Paged.js failed to initialize within 10 seconds.'
      }, '*');
      return;
    }
    setTimeout(function() { whenPagedReady(cb); }, POLL_INTERVAL);
  }

  whenPagedReady(function() {
    var Previewer = window.Paged.Previewer;
    var lastFontsImport = null;
    var lastHljsUrl = null;
    // Track paged.js's accumulated <style> elements so they don't pile up
    // in iframe head over a long editing session and slow re-renders.
    var stylesFromLastRender = [];

    // Mermaid lazy loader — only imports the ~1MB ESM module on the
    // first render that contains a mermaid block. Subsequent renders
    // reuse the same module; theme is re-initialized only when it
    // changes (mermaid doesn't expose per-render theme overrides).
    var mermaidPromise = null;
    var lastMermaidTheme = null;
    function ensureMermaid(theme) {
      if (!mermaidPromise) {
        mermaidPromise = import('__MERMAID_ESM_URL__').then(function (mod) {
          return mod.default;
        }).catch(function (err) {
          // Reset so a transient network failure doesn't permanently
          // disable mermaid for the rest of the session.
          mermaidPromise = null;
          throw err;
        });
      }
      return mermaidPromise.then(function (m) {
        if (theme !== lastMermaidTheme) {
          m.initialize({
            startOnLoad: false,
            theme: theme,
            // Strict blocks raw HTML in diagram labels — safe default
            // for anything the user (or AI) types into a code fence.
            securityLevel: 'strict',
            // 12px works across diagram types — the default 16px
            // crowds multi-line cells in tables/state diagrams and
            // pushes node bounds outside their column on flowcharts.
            // 12px reads cleanly at print resolution without feeling
            // cramped on single-word nodes.
            themeVariables: { fontSize: '12px' },
            // htmlLabels=true uses <foreignObject> so node sizing comes
            // from real HTML layout — which is accurate. The previous
            // SVG-text path consistently undersized cylinders and stadiums
            // because mermaid couldn't measure text width without fonts
            // loaded, then clipped multi-word labels. Modern paged.js
            // (0.4.x) handles foreignObject pagination correctly; the
            // historical aversion to it was based on older versions.
            // Extra padding + wider text-wrap give multi-word labels
            // visual breathing room.
            flowchart: { htmlLabels: true, padding: 15, wrappingWidth: 200 },
            fontFamily: 'inherit'
          });
          lastMermaidTheme = theme;
        }
        return m;
      });
    }

    // Recompute the page-fit zoom after pagination and on viewport resize.
    // Page widths are absolute (A4 = 794px @ 96dpi); the available width
    // is the body's content area minus its padding. Capped at 1 — we
    // never enlarge pages, only shrink to fit narrow viewports.
    function applyPageZoom() {
      var mount = document.getElementById('mount');
      if (!mount) return;
      var pages = mount.querySelector('.pagedjs_pages');
      var firstPage = mount.querySelector('.pagedjs_page');
      if (!pages || !firstPage) return;
      // Reset zoom temporarily to measure the natural page width — without
      // this we'd read the already-scaled width and the zoom would drift
      // smaller on every recompute.
      pages.style.setProperty('--page-zoom', '1');
      var pageWidth = firstPage.offsetWidth;
      var available = mount.clientWidth;
      if (!pageWidth || !available) return;
      var zoom = Math.min(1, available / pageWidth);
      pages.style.setProperty('--page-zoom', String(zoom));
    }

    window.addEventListener('resize', applyPageZoom);

    window.__renderDoc = async function(opts) {
      try {
        var fontsEl = document.getElementById('theme-fonts');
        if (opts.fontsImport !== lastFontsImport) {
          fontsEl.textContent = opts.fontsImport || '';
          lastFontsImport = opts.fontsImport;
        }

        // Swap the highlight.js theme stylesheet when the user switches
        // codeBlockTheme. Idempotent: only update href when it changes,
        // so we don't trigger an unnecessary network round-trip per
        // re-render. An empty url ('none' theme) clears the link so
        // theme CSS's plain-monospace rules take over.
        // Highlight.js theme stylesheet — created lazily and only when
        // a non-empty URL is requested. We intentionally do NOT keep a
        // pre-injected link element around: a link without an href (or
        // with an empty one) confused paged.js's Polisher and wedged
        // pagination silently.
        if (opts.hljsUrl !== lastHljsUrl) {
          var hljsEl = document.getElementById('hljs-theme');
          if (opts.hljsUrl) {
            if (!hljsEl) {
              hljsEl = document.createElement('link');
              hljsEl.id = 'hljs-theme';
              hljsEl.rel = 'stylesheet';
              document.head.appendChild(hljsEl);
            }
            hljsEl.setAttribute('href', opts.hljsUrl);
          } else if (hljsEl) {
            hljsEl.remove();
          }
          lastHljsUrl = opts.hljsUrl;
        }

        // Cap font wait at 1s — if Google Fonts is slow or a font name
        // is unresolvable, document.fonts.ready can stall forever and
        // wedge the entire pagination. Falls back to whatever fonts are
        // ready by then; the next render will pick up any late arrivals.
        await Promise.race([
          document.fonts.ready,
          new Promise(function (r) { setTimeout(r, 1000); })
        ]);

        var mount = document.getElementById('mount');
        var pending = document.getElementById('pending');
        // Match the visible mount's width so paged.js's flex centering
        // produces the same column offsets in both contexts. Without
        // matching width, pages render off-center off-screen and shift
        // when swapped into the visible mount.
        pending.style.width = mount.clientWidth + 'px';
        pending.innerHTML = '';

        // Wait for images to decode so paged.js measures real dimensions,
        // not placeholder sizes. Without this, an image that loads after
        // pagination triggers a second re-paginate as the doc reflows
        // around the now-known-size image — visible jitter on every edit
        // that touches a paragraph above an image. We decode against an
        // off-screen scratch container (not pending — paged.js needs
        // pending empty so it can append its own pages there).
        // img.decode() rejects for broken images; swallow per-image
        // errors so one bad img doesn't kill the whole render.
        var scratch = document.createElement('div');
        scratch.style.cssText = 'position:fixed;left:-20000px;top:0;visibility:hidden;';
        scratch.innerHTML = opts.html;
        document.body.appendChild(scratch);
        try {
          var imgs = scratch.querySelectorAll('img');
          if (imgs.length > 0) {
            await Promise.all(Array.prototype.map.call(imgs, function(img) {
              return img.decode ? img.decode().catch(function() {}) : Promise.resolve();
            }));
          }

          // Mermaid pre-process — replace each \`pre code.language-mermaid\`
          // with the rendered SVG IN PLACE in the scratch DOM, then pick
          // up the modified innerHTML below. paged.js never sees the
          // original code blocks; from its perspective the content is
          // just inline SVG it can paginate normally.
          //
          // Done sequentially (not Promise.all) to keep mermaid's internal
          // id counter and DOM scratch usage predictable. Failures fall
          // back to an inline error message rather than killing the whole
          // render — one bad diagram shouldn't blank the preview.
          var mermaidBlocks = Array.prototype.slice.call(
            scratch.querySelectorAll('pre code.language-mermaid')
          );
          if (mermaidBlocks.length > 0) {
            var mer = await ensureMermaid(opts.mermaidTheme);
            for (var mi = 0; mi < mermaidBlocks.length; mi++) {
              var codeEl = mermaidBlocks[mi];
              var preEl = codeEl.parentElement;
              var source = codeEl.textContent || '';
              var renderId = 'mmd-' + Math.random().toString(36).slice(2, 10);
              try {
                var rendered = await mer.render(renderId, source);
                var wrap = document.createElement('div');
                wrap.className = 'mermaid';
                wrap.innerHTML = rendered.svg;
                preEl.replaceWith(wrap);
              } catch (err) {
                var errEl = document.createElement('div');
                errEl.className = 'mermaid-error';
                errEl.textContent = 'Mermaid error: ' + (err && err.message ? err.message : 'invalid diagram');
                preEl.replaceWith(errEl);
              }
            }
            // Hand the post-mermaid HTML to paged.js so it paginates the
            // SVGs, not the original \`<pre>\` source.
            opts.html = scratch.innerHTML;
          }
        } finally {
          scratch.remove();
        }

        var stylesBefore = new Set(document.head.querySelectorAll('style'));

        var previewer = new Previewer();
        var result = await previewer.preview(
          '<div class="paged-doc">' + opts.html + '</div>',
          [{ 'theme.css': opts.themeCss }],
          pending
        );

        var stylesAfter = Array.prototype.slice.call(document.head.querySelectorAll('style'));
        var newStyles = stylesAfter.filter(function(s) { return !stylesBefore.has(s); });

        // Atomic swap. replaceChildren is a single mutation so the browser
        // can't lay out an empty mount between clearing and refilling —
        // scroll height stays stable, no scrollbar thumb resize.
        var scrollY = window.scrollY;
        // Snap-to-bottom heuristic only kicks in when the previous doc
        // was meaningfully scrollable. Before the first render the mount
        // is empty and scrollHeight equals the viewport, which would
        // false-positive the "near bottom" check on every page reload
        // and dump the user at the end of the doc.
        var prevScrollHeight = document.documentElement.scrollHeight;
        var hadScrollableContent = prevScrollHeight > window.innerHeight + 100;
        var wasNearBottom = hadScrollableContent
          && (scrollY + window.innerHeight >= prevScrollHeight - 50);
        mount.replaceChildren.apply(mount, Array.prototype.slice.call(pending.children));

        // Remove the previous render's paged.js stylesheets only AFTER
        // the new pages are in place — pulling them earlier would briefly
        // unstyle the new content as paged.js classes lose their rules.
        for (var i = 0; i < stylesFromLastRender.length; i++) {
          stylesFromLastRender[i].remove();
        }
        stylesFromLastRender = newStyles;

        // Apply responsive zoom to the freshly-swapped pages.
        applyPageZoom();

        // Restore scroll. Snap to the new bottom if the user was at the
        // end of the doc — common case where small edits at the bottom
        // would otherwise jump up after a re-pagination shrinks the doc
        // by one line.
        if (wasNearBottom) {
          window.scrollTo(0, document.documentElement.scrollHeight);
        } else {
          window.scrollTo(0, scrollY);
        }

        window.parent.postMessage({
          type: 'paginated',
          pageCount: (result && result.total) || 0
        }, '*');
      } catch (e) {
        console.error('[paged-iframe] render failed:', e);
        window.parent.postMessage({ type: 'paginated', pageCount: 0 }, '*');
      }
    };

    window.parent.postMessage({ type: 'iframe-ready' }, '*');
  });
})();
</script>
</body>
</html>`
