export interface User {
  id: number
  login?: string
  name: string
  email?: string
  avatar?: string
  provider: 'github' | 'google' | 'oidc'
}

export interface Document {
  id: number
  doc_id: string
  owner_id: number | null
  title: string
  access_mode: 'open-edit' | 'open-view' | 'password-protected'
  size_bytes: number
  word_count: number
  created_at: number
  last_active: number
}

export interface Workspace {
  id: number
  workspace_id: string
  owner_id: number
  name: string
  created_at: number
}
