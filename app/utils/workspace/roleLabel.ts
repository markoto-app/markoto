type WorkspaceRole = 'admin' | 'editor' | 'viewer' | 'guest'

const ROLE_KEYS: Record<WorkspaceRole, string> = {
  admin: 'workspace.roles.admin',
  editor: 'workspace.roles.editor',
  viewer: 'workspace.roles.viewer',
  guest: 'workspace.roles.guest'
}

/**
 * Locale key of a workspace role's name. The names are nouns and shown
 * as written in the locale file (German capitalises them), so callers
 * must not lowercase the result. An unknown role reads as the least
 * privileged member role.
 */
export function workspaceRoleKey(role: string | null | undefined): string {
  return ROLE_KEYS[role as WorkspaceRole] ?? ROLE_KEYS.viewer
}
