// Paged.js library types are not shipped, declare a minimal Previewer
// surface for the live preview composable (app/composables/preview/usePagedPreview.ts).
// The PDF print iframe loads paged.js via the polyfill bundle served by
// /api/_internal/pagedjs-polyfill.js, which doesn't need types here.
declare module 'pagedjs' {
  export class Previewer {
    constructor()
    preview(
      content: string | HTMLElement,
      stylesheets: (string | HTMLStyleElement)[],
      renderTo: HTMLElement
    ): Promise<{ total: number, pages: unknown[] }>
  }
}
