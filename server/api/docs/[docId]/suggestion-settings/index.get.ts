// GET /api/docs/:docId/suggestion-settings: the document's suggestion mode
// settings, for the owner and workspace admins (the share dialog).
export default defineApiHandler({
  access: allow.doc('manage', { deny: 'share/not-allowed' }),
  handler: async ({ event, doc }) => {
    setHeader(event, 'cache-control', 'private, no-store')
    return doc.suggestionPolicy
  }
})
