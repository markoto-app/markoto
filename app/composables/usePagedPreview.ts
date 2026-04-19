import type { Ref } from 'vue'
import type { DocTheme } from '~~/shared/types/theme'
import { themeToCss, themeFontsImport } from '~~/shared/utils/themeToCss'
import { PAGEDJS_POLYFILL_URL } from '~~/shared/utils/pagedjsCdn'

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
    isPaginating.value = true
    ;(iframe.contentWindow as unknown as { __renderDoc: (o: unknown) => void }).__renderDoc({
      html: opts.html.value,
      themeCss,
      fontsImport
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
    iframe.srcdoc = IFRAME_BOOTSTRAP.replace('__PAGEDJS_POLYFILL_URL__', PAGEDJS_POLYFILL_URL)
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
    padding: 24px 16px;
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
</style>
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
    // Track paged.js's accumulated <style> elements so they don't pile up
    // in iframe head over a long editing session and slow re-renders.
    var stylesFromLastRender = [];

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

        await document.fonts.ready;

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
        var wasNearBottom = (scrollY + window.innerHeight >= document.documentElement.scrollHeight - 50);
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
