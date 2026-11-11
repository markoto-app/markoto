/**
 * Central registry of `data-testid` strings for Playwright e2e flows.
 *
 * Why a registry:
 *   - Renames become compile errors (referencing TESTID.fooBar in a
 *     deleted entry won't typecheck) instead of runtime test failures
 *     where the locator silently times out.
 *   - One place to grep when answering "is there a testid for X?".
 *   - Components and specs share the same source — a rename touches
 *     both call sites in one PR.
 *
 * Conventions:
 *   - Static testids are constants on the TESTID object.
 *   - Parametric testids (one per row, per preset, etc.) are factory
 *     functions that return the string. Keep the prefix lowercased
 *     and stable so spec-side `[data-testid^="prefix-"]` selectors
 *     still work for "any" matches.
 *   - Both Vue templates and `.spec.ts` files import from here. Vue
 *     `<button :data-testid="TESTID.fooBar">` works as long as
 *     TESTID is registered as an auto-import OR the file has an
 *     explicit `import` line.
 *
 * NOT included here:
 *   - Older testids that predate the registry (the dozens written
 *     before Phase B). Migrating them retroactively is a separate
 *     ticket; new code uses TESTID, old code stays as-is until
 *     touched.
 */

export const TESTID = {
  // Top-level dashboard CTAs
  LANDING_NEW_DOCUMENT: 'landing-new-document',
  LANDING_NEW_WORKSPACE: 'landing-new-workspace',
  WORKSPACE_NEW_DOCUMENT: 'workspace-new-document',

  // Editor topbar
  ACCESS_LOCK_BUTTON: 'access-lock-button',
  VIEW_MODE_EDIT: 'view-mode-edit',
  VIEW_MODE_SPLIT: 'view-mode-split',
  VIEW_MODE_PREVIEW: 'view-mode-preview',

  // Editor menubar
  MENUBAR_FILE: 'menubar-file',
  MENUBAR_EDIT: 'menubar-edit',
  MENUBAR_VIEW: 'menubar-view',
  MENUBAR_INSERT: 'menubar-insert',
  MENUBAR_FORMAT: 'menubar-format',
  MENUBAR_SHARING: 'menubar-sharing',
  MENUBAR_HELP: 'menubar-help',

  // Right-sidebar tabs
  SIDEBAR_TAB_DOCUMENT: 'sidebar-tab-document',
  SIDEBAR_TAB_COMMENTS: 'sidebar-tab-comments',
  SIDEBAR_TAB_ACTIVITY: 'sidebar-tab-activity',
  SIDEBAR_TAB_THEME: 'sidebar-tab-theme',
  SIDEBAR_TAB_KNOWLEDGE: 'sidebar-tab-knowledge',

  // Mobile bottom drawer (EditorCommandsPanel insert grid)
  ECP_INSERT_CODE_BLOCK: 'ecp-insert-code-block',
  ECP_INSERT_ALERT: 'ecp-insert-alert',
  ECP_INSERT_MATH: 'ecp-insert-math',
  ECP_INSERT_DIAGRAM: 'ecp-insert-diagram',
  ECP_FILE_IMPORT: 'ecp-file-import',
  ECP_FILE_EXPORT_PDF: 'ecp-file-export-pdf',
  ECP_FILE_EXPORT_MD: 'ecp-file-export-md',

  // Modals: share / password / restore / duplicate / delete / import
  SHARE_PASSWORD_INPUT: 'share-password-input',
  SHARE_PASSWORD_SAVE: 'share-password-save',
  PASSWORD_MODAL_INPUT: 'password-modal-input',
  PASSWORD_MODAL_UNLOCK: 'password-modal-unlock',
  PASSWORD_MODAL_CANCEL: 'password-modal-cancel',
  RESTORE_CONFIRM: 'restore-confirm',
  RESTORE_CANCEL: 'restore-cancel',
  DUPLICATE_CONFIRM: 'duplicate-confirm',
  DUPLICATE_CANCEL: 'duplicate-cancel',
  DELETE_CONFIRM_INPUT: 'delete-confirm-input',
  DELETE_CONFIRM: 'delete-confirm',
  DELETE_CANCEL: 'delete-cancel',
  IMPORT_DROPZONE: 'import-dropzone',
  IMPORT_SUBMIT: 'import-submit',
  IMPORT_REPLACE_ALL: 'import-replace-all',
  IMPORT_APPEND: 'import-append',
  IMPORT_CONFLICT_CANCEL: 'import-conflict-cancel',

  // Workspace creation + members
  WORKSPACE_FORM_NAME: 'workspace-form-name',
  WORKSPACE_FORM_DESCRIPTION: 'workspace-form-description',
  WORKSPACE_FORM_SUBMIT: 'workspace-form-submit',
  WORKSPACE_MEMBERS_TRIGGER: 'workspace-members-trigger',
  WORKSPACE_INVITE_EMAIL: 'workspace-invite-email',
  WORKSPACE_INVITE_SUBMIT: 'workspace-invite-submit',
  WORKSPACE_AI_TAKEOVER: 'workspace-ai-takeover',

  // Knowledge panel
  KNOWLEDGE_UPLOAD_BUTTON: 'knowledge-upload-button',

  // Pricing page
  PRICING_CURRENT_PLAN_BADGE: 'pricing-current-plan-badge'
} as const

/**
 * Convenience: build a `[data-testid="..."]` CSS selector from a
 * registry key. Spec files use this when they reach for
 * `page.locator(...)` directly (rather than going through the
 * EditorPage page-object's typed getters).
 */
export const sel = (testid: string): string => `[data-testid="${testid}"]`
