// Project context ("bible"): documents the AI reads with every request in
// the documents they apply to. Shared by the server (resolver, prompt block,
// API) and the client (document panel, explorer badge).

/** `folder`: its own folder and every folder below it (at the root: the whole scope). `all`: every document of its scope. */
export const CONTEXT_SCOPES = ['folder', 'all'] as const
export type ContextScope = typeof CONTEXT_SCOPES[number]

/** Extra context documents one document can have attached (document panel). */
export const MAX_CONTEXT_LINKS = 10

/** Context documents that reach one prompt; further ones are named, not included. */
export const MAX_CONTEXT_DOCS = 12

/**
 * Characters of context text in one prompt (about 4,000 tokens). A document
 * that does not fit its share is shown as an outline plus its first lines,
 * and the AI reads the rest on demand. Kept small: the block is part of
 * every request of the document, and the hosted free allowance is small.
 */
export const CONTEXT_CHAR_BUDGET = 16_000
