// The app ↔ renderer wire contract: the body of POST /render, its answer,
// and the manifest the renderer writes next to a stored render.
//
// Types only, dependency-free on purpose: the renderer image is built from
// `renderer/` alone and carries a byte-identical copy at
// `renderer/src/contract.ts`, pinned by tests/unit/platform/renderContract.test.ts.
// The app parses what it receives with the schemas in `renderSchemas.ts`.

/** What a stored render holds: the PDF, per-page PNGs, or both. */
export type RenderFormat = 'pdf' | 'png' | 'both'

/** Body of POST /render. */
export interface RenderRequest {
  docId: string
  /** The `yjs_updates` row the render reflects (its cache key). */
  snapshotId: number
  /** 'html': the web snapshot for a published page — returned, not stored. */
  format: RenderFormat | 'html'
  /** Brand-kit fingerprint (16 hex chars), appended to the output folder. */
  variant?: string
}

/** The web snapshot a published page is made of (format 'html'). */
export interface WebSnapshot {
  html: string
  css: string
  fontsImport: string
  hljsTheme: string
  hljsUrl: string | null
  language: string
}

/** Answer of POST /render (200). */
export interface RenderResponse {
  pageCount: number
  pdfKey?: string
  pageKeys: string[]
  /** format 'html' only: the print page's web snapshot. */
  web?: WebSnapshot
}

/**
 * `renders/{docId}/{folder}/manifest.json`, written LAST by the renderer as
 * the readiness sentinel of a stored render.
 */
export interface RenderManifest {
  snapshotId: number
  pageCount: number
  format: RenderFormat
  /** ISO 8601. */
  renderedAt: string
  pdfKey: string | null
  pageKeys: string[]
}
