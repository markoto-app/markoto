// Edit decision list of the demo video (README.md in this folder).
//
// The cut follows the music: every segment starts at a fixed time on the
// track (`at`, seconds) and lasts until the next one starts; the last one
// ends with the track. The times are the cut points of the original
// November 2026 edit, which were placed on the track's breaks and drops,
// so the new footage lands on the same beats.
//
// Footage comes from the product-tour recorder (tests/e2e/tour/*.capture.ts
// and tests/e2e/demo-video/*.capture.ts): `parts` are [from, to] windows on
// a clip's own timeline in seconds (12 fps, clip.json); they play back to
// back, sped up or slowed down evenly to fill the slot. `to: 'end'` means
// the clip's last frame.
//
// Card titles mark the italic (display emphasis) words with *asterisks*.

/** Visible chapter count on the cards ("02 / 11"). */
export const CHAPTER_COUNT = 11

export type ClipTime = number | 'end'

export interface TerminalLine {
  /** `cmd` lines are typed after a `$` prompt; the others appear whole. */
  kind: 'cmd' | 'cont' | 'out' | 'ok' | 'comment'
  text: string
}

export type Card
  = | { type: 'chapter', n: number, label: string, title: string, sub: string }
    | { type: 'terminal', n: number, label: string, title: string, sub: string, lines: TerminalLine[] }
    | { type: 'hood', title: string, items: string[] }
    | { type: 'pdf', caption: string, scene: string }
    | { type: 'claim', title: string, sub: string }
    | { type: 'end', title: string, sub: string, footer: string }

export type Segment
  = | { at: number, kind: 'card', card: Card }
    | { at: number, kind: 'clip', scene: string, parts: Array<[number, ClipTime]> }

/** Where the clone in the self-hosting card comes from. */
export const REPO_URL = 'https://github.com/markoto-app/markoto'

/**
 * The cut. `mcpToolCount` is read from server/mcp/tools/ at build time,
 * so the MCP card never states a stale number.
 */
export function editDecisionList(mcpToolCount: number): Segment[] {
  return [
    { at: 0, kind: 'card', card: { type: 'chapter', n: 1, label: 'Editor', title: 'Write Markdown, get *pages.*', sub: 'A4 or Letter, as you type.' } },
    { at: 2.8, kind: 'clip', scene: 'write', parts: [[0, 'end']] },

    { at: 11.2, kind: 'card', card: { type: 'chapter', n: 2, label: 'Layout', title: 'Headers, footers, page numbers.', sub: 'Charts, diagrams, math and footnotes too.' } },
    { at: 13.4, kind: 'clip', scene: 'rich', parts: [[1.0, 'end']] },

    { at: 23.9, kind: 'card', card: { type: 'chapter', n: 3, label: 'Themes', title: 'Change the look, not the Markdown.', sub: 'Templates and themes, your fonts, a cover.' } },
    // The template picker (business tab), then the new document in its design.
    { at: 26.0, kind: 'clip', scene: 'templates', parts: [[4.6, 7.0], [8.6, 11.6]] },
    // The new accent colour reaching the chart, then the cover.
    { at: 30.2, kind: 'clip', scene: 'themes', parts: [[6.0, 8.6], [16.0, 'end']] },

    { at: 34.4, kind: 'card', card: { type: 'chapter', n: 4, label: 'AI', title: 'An assistant that *writes with you.*', sub: 'It edits while you watch.' } },
    // The prompt, then the summary arriving (the wait cut out).
    { at: 36.5, kind: 'clip', scene: 'ai', parts: [[1.4, 6.3], [9.3, 11.0]] },

    { at: 42.8, kind: 'card', card: { type: 'chapter', n: 5, label: 'Knowledge', title: 'Answers from your own files.', sub: 'PDF, Word or Excel files.' } },
    // Upload, processed, the question, the search, the answer.
    { at: 44.9, kind: 'clip', scene: 'knowledge', parts: [[1.4, 3.4], [6.6, 7.8], [9.4, 11.4], [13.8, 14.3], [15.9, 17.0]] },

    { at: 51.2, kind: 'card', card: { type: 'chapter', n: 6, label: 'Collaboration', title: 'Write together, live.', sub: 'Cursors, comments, @mentions.' } },
    { at: 53.4, kind: 'clip', scene: 'collab', parts: [[0, 'end']] },

    { at: 66.0, kind: 'card', card: { type: 'chapter', n: 7, label: 'History', title: 'Every change, with a diff.', sub: 'Restore any version in one click.' } },
    { at: 68.1, kind: 'clip', scene: 'history', parts: [[0, 'end']] },

    { at: 78.6, kind: 'card', card: { type: 'hood', title: 'Under the *hood.*', items: ['MCP server · /mcp', 'Self-hosting · ./install.sh', 'Your own AI key'] } },
    {
      at: 85.0,
      kind: 'card',
      card: {
        type: 'terminal',
        n: 8,
        label: 'MCP server',
        title: 'Bring your own agent.',
        sub: 'Claude Code, Claude Desktop or Cursor, through /mcp.',
        lines: [
          { kind: 'cmd', text: 'claude mcp add --transport http markoto \\' },
          { kind: 'cont', text: '  https://markoto.app/mcp \\' },
          { kind: 'cont', text: '  --header "Authorization: Bearer mkt_…"' },
          { kind: 'comment', text: `# ${mcpToolCount} tools: view_document, replace_text,` },
          { kind: 'comment', text: '#   update_theme, search_knowledge, …' }
        ]
      }
    },
    {
      at: 89.0,
      kind: 'card',
      card: {
        type: 'terminal',
        n: 9,
        label: 'Self-hosting',
        title: 'Self-host with one script.',
        sub: 'The whole stack on one Linux machine, with Docker or Podman.',
        lines: [
          { kind: 'cmd', text: `git clone ${REPO_URL}.git` },
          { kind: 'cmd', text: 'cd markoto && ./install.sh' },
          { kind: 'out', text: '==> Configuration (.env)' },
          { kind: 'ok', text: 'configuration written' },
          { kind: 'out', text: '==> Starting; waiting for the app to become healthy' },
          { kind: 'ok', text: 'app container healthy' },
          { kind: 'out', text: '==> markoto is running' }
        ]
      }
    },
    { at: 93.5, kind: 'card', card: { type: 'chapter', n: 10, label: 'Your AI', title: 'Bring your own key.', sub: 'OpenAI-compatible, or a local model.' } },
    // The key goes in, is verified: connected.
    { at: 95.5, kind: 'clip', scene: 'yours', parts: [[5.1, 7.6]] },

    { at: 97.5, kind: 'card', card: { type: 'chapter', n: 11, label: 'Share & export', title: 'Share a link, export the PDF.', sub: 'The PDF matches the preview.' } },
    // The share dialog opens, then its QR code.
    { at: 99.5, kind: 'clip', scene: 'share', parts: [[1.3, 4.4]] },
    { at: 101.8, kind: 'card', card: { type: 'pdf', caption: 'The exported PDF', scene: 'share' } },

    // A quick look back, on the four hits before the break.
    { at: 104.0, kind: 'clip', scene: 'themes', parts: [[-0.6, 'end']] },
    { at: 104.5, kind: 'clip', scene: 'history', parts: [[-2.0, -1.4]] },
    { at: 105.0, kind: 'clip', scene: 'ai', parts: [[12.4, 13.0]] },
    { at: 105.5, kind: 'clip', scene: 'write', parts: [[-0.6, 'end']] },

    { at: 106.0, kind: 'card', card: { type: 'claim', title: 'Beautifully rendered *Markdown.*', sub: 'Write plain text. Hand over a finished document.' } },
    { at: 110.0, kind: 'card', card: { type: 'end', title: 'Free on *markoto.app.*', sub: 'No sign-up needed. Or host it yourself.', footer: `Source-available · ${REPO_URL.replace('https://', '')}` } }
  ]
}

/** The poster (README / watch page): the claim beside the finished report. */
export const POSTER = {
  title: 'Beautifully rendered *Markdown.*',
  body: 'A collaborative Markdown editor with a live, paginated preview.',
  action: 'Watch the demo',
  /** Clip whose last frame fills the window. */
  scene: 'write'
}
