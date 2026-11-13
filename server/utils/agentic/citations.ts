// Citation reminders appended to `web_search` / `fetch_url` tool results
// in the in-editor loop.
//
// The system prompt already asks the model to link its web sources, but
// at temperature 0 Mistral Small tends to write the facts and drop the
// links. The instruction works when it sits in the tool result the model
// is reading when it writes, the same place the URLs are. MCP results
// are not touched: an MCP client's own agent decides how to present
// sources.

export function webSearchCitationReminder(sources: ReadonlyArray<{ title: string, uri: string }>): string {
  const first = sources[0]
  if (!first) return ''
  return '\n\nEvery fact you write from these results into the document MUST carry a Markdown link to its source '
    + `right next to it, a one-line note too, e.g. "… ([${first.title}](${first.uri}))". `
    + 'Use only URLs listed above.'
}

export function fetchUrlCitationReminder(url: string): string {
  if (!url) return ''
  return `\n\nSource page: ${url}\nWhat you write from this page into the document MUST link it next to that text `
    + `as Markdown: [page title](${url}).`
}
