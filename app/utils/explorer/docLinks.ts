// Opening a document from a tree whose rows are buttons, not links (the
// editor's left panel): Ctrl / Cmd + click and middle click open it in a
// new tab, as they would on a link; anything else opens it here.

export type DocOpenTarget = 'here' | 'new-tab'

export function docOpenTarget(e: Pick<MouseEvent, 'ctrlKey' | 'metaKey'> & { button?: number } | null | undefined): DocOpenTarget {
  if (!e) return 'here'
  return e.ctrlKey || e.metaKey || e.button === 1 ? 'new-tab' : 'here'
}

export function docPath(docId: string): string {
  return `/d/${encodeURIComponent(docId)}`
}

export function openDocInNewTab(docId: string): void {
  globalThis.open(docPath(docId), '_blank', 'noopener')
}
