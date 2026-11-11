// Completion flags the renderer sidecar polls on the print page
// (renderer/src/render.ts) to know when pagination has finished.
export {}

declare global {
  interface Window {
    __pagedReady?: boolean
    __pagedPageCount?: number
  }
}
