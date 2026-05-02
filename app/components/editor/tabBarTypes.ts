// Shared type so MobileTabBar and EditorLayout agree on the panel
// identifier for the new "editor" drawer (alongside the existing
// document / comments / activity / theme / knowledge panels).

export type TabName
  = | 'document'
    | 'comments'
    | 'activity'
    | 'theme'
    | 'knowledge'
    | 'editor'
