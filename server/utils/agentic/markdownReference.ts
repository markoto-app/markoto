/**
 * Markdown vocabulary reference injected into the AI system prompts so
 * the model knows the FULL set of features available in YPad documents
 * — not just the markdown-it core. Without this, the model defaults to
 * its pre-training notion of "GitHub-flavored markdown" and never reaches
 * for the extensions we've shipped (alerts, math, definition lists,
 * highlight, ins, etc.).
 *
 * Imported by both:
 *   - `server/api/ai/prompt.post.ts` — agentic loop (top-bar prompt)
 *   - `server/api/ai/rewrite.post.ts` — inline selection rewrite
 *
 * Keep it tight. This is per-request system overhead (~600 tokens), so
 * favour terse lookup-table form over tutorial prose. The model is
 * already fluent in markdown — this is a delta against its baseline.
 *
 * When a new plugin is added in `app/utils/renderMarkdown.ts`, add a
 * line here too. Otherwise the model will keep producing markdown that
 * round-trips fine but never demonstrates the new capability.
 */
export const MARKDOWN_REFERENCE = `MARKDOWN VOCABULARY (use these features when appropriate — they all render correctly in YPad):

Inline:
  **bold**  *italic*  ~~strike~~  ==highlight==  ++inserted++  \`code\`
  H~2~O (subscript), E=mc^2^ (superscript)
  [link](https://example.com), abbreviation defined elsewhere: *[HTML]: HyperText Markup Language

Headings: #, ##, ..., ###### (1–6). Every heading auto-gets an \`id\` slug for linking; you can override with \`{#custom-id}\` after the heading text.

Auto table of contents: \`[[toc]]\` on its own line generates a hierarchical link list of every heading (h1–h4), with page numbers in the printed output. Drop one near the top of long documents.

Page break: \`<!-- pagebreak -->\` on its own line forces a new page in the printed/exported document. Use to keep a heading at the top of a fresh page or to separate logical sections in a long doc.

Lists:
  - unordered (also * works)
  1. ordered
  - [ ] todo,  - [x] done           ← task lists
  Nested: indent two spaces.

Definition lists:
  Term
  : definition body
  : another meaning

Code:
  Inline \`code\`. Fenced blocks with language hints get syntax highlighting:
    \`\`\`python
    def f(x): return x + 1
    \`\`\`
  Languages: python, javascript, typescript, bash, html, css, json, yaml, sql, rust, go, java, c, cpp, php, ruby, and more.

Tables (pipe syntax):
  | A | B   |
  | - | --- |
  | 1 | two |
  Use \`:---\`, \`:---:\`, \`---:\` in the separator row for left/center/right alignment.

Blockquotes: lines prefixed with \`> \`.

Horizontal rule: \`---\` on its own line.

Footnotes: text[^1]. … and [^1]: footnote body somewhere later in the doc.

Images:
  ![alt text](url)               standalone with caption (renders as <figure>)
  ![alt =200x100](url)           explicit width × height in px

Math (KaTeX):
  Inline: $E = mc^2$
  Block:
    $$
    \\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
    $$

GitHub-style alerts (use a blockquote with a \`[!KIND]\` first line):
  > [!NOTE]
  > Informational context.

  > [!TIP]
  > Helpful suggestion.

  > [!IMPORTANT]
  > Crucial information the reader can't miss.

  > [!WARNING]
  > Something the reader should be careful about.

  > [!CAUTION]
  > Risk of harm or data loss.

Diagrams (Mermaid — fenced code block with \`mermaid\` language):
  \`\`\`mermaid
  flowchart LR
    A[Start] --> B{Decision}
    B -->|Yes| C[Done]
    B -->|No| D[Retry]
  \`\`\`
Supported diagram types: \`flowchart\`, \`sequenceDiagram\`, \`classDiagram\`, \`stateDiagram-v2\`, \`erDiagram\`, \`gantt\`, \`pie\`, \`mindmap\`, \`gitGraph\`, \`timeline\`. Use Mermaid syntax exactly as documented at mermaid.js. Diagrams render to SVG inside the document; reach for them when a flowchart, sequence, or chart communicates a relationship more clearly than prose.

Emoji shortcodes: \`:rocket:\` → 🚀, \`:heart:\` → ❤️, \`:thumbsup:\` → 👍.

Notes:
  - A single newline in a paragraph becomes a <br> (GFM-style hard wrap). Use a blank line for a real paragraph break.
  - Do NOT use raw HTML tags — they're sanitized away. Use the markdown above.
  - Do NOT use \`:::warning :::\` style containers — they no longer render. Use \`> [!WARNING]\` instead.`
