// Shared so MobileTabBar and EditorLayout agree on the panel identifiers (including the "editor" drawer
// and the phone's "navigator" sheet: the desktop left panel's outline and workspace documents).

export type TabName
  = | 'document'
    | 'comments'
    | 'suggestions'
    | 'activity'
    | 'theme'
    | 'knowledge'
    | 'references'
    | 'editor'
    | 'navigator'
