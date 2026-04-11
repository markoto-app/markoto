export const queryKeys = {
  user: {
    documents: () => ['user', 'documents'] as const,
    workspaces: () => ['user', 'workspaces'] as const
  },
  docs: {
    meta: (docId: string) => ['docs', docId, 'meta'] as const,
    activity: (docId: string) => ['docs', docId, 'activity'] as const,
    token: (docId: string) => ['docs', docId, 'token'] as const
  },
  workspaces: {
    detail: (wsId: string) => ['workspaces', wsId] as const
  }
}
