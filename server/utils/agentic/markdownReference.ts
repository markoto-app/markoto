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
 * Keep it tight. This is per-request system overhead (~800 tokens), so
 * favour terse lookup-table form over tutorial prose. The model is
 * already fluent in markdown — this is a delta against its baseline.
 *
 * Every claim below has been verified against the live render pipeline
 * (see `/tmp/md-audit.mjs` pattern). When a new plugin is added in
 * `app/utils/renderMarkdown.ts`, (1) add it to the audit script, (2)
 * verify the syntax actually renders, (3) add the confirmed form here.
 * Do NOT add "should work" syntaxes — the AI will happily emit them
 * and silently produce broken output.
 */
export const MARKDOWN_REFERENCE = `MARKDOWN VOCABULARY (features verified to render correctly in YPad):

Inline:
  **bold**  *italic*  ~~strike~~  ==highlight==  ++inserted++  \`code\`
  H~2~O (subscript), E=mc^2^ (superscript)
  [link](https://example.com) — auto-opens in a new tab; do NOT add target/rel manually.
  abbreviation defined elsewhere: *[HTML]: HyperText Markup Language
  Emoji shortcodes: :rocket: → 🚀, :heart: → ❤️, :+1: → 👍, :100: → 💯.

Typography (auto — don't fight it):
  --  becomes  –  (en-dash),  ---  becomes  —  (em-dash),  ...  becomes  …,  "x"/'x' become smart quotes.
  A single newline inside a paragraph becomes a <br>. Use a blank line for a real paragraph break.

Headings: #, ##, …, ######. Every heading auto-gets a slug \`id\`.

Attribute syntax \`{…}\` (CRITICAL — unlocks classes / custom IDs / inline style on most elements):
  After the element, in curly braces:
    {#custom-id}                     set the id
    {.class-name}                    add a class (space-separated = multiple classes)
    {key=value}                      set attribute (bare values, or quoted for spaces)
    {style="css: value"}             inline CSS
    Combine: {#intro .lead style="text-align: center"}
  Works on: headings, paragraphs, links, inline code, images, blockquotes.
  Heading example:          # Title {#intro .lead}
  Paragraph example:        A paragraph here.\n  {.callout}         ← attrs on the NEXT line, alone, attach to paragraph
  Link example:             [click](url){.btn}
  Inline code example:      \`var x\`{.highlight}
  Image examples below.

Images (always render as <figure> with alt as the caption):
  ![alt text](url)                              figure with alt as caption
  ![alt](url "visible caption")                 title overrides the caption shown
  ![alt](url){width=50%}                        50% of column width, height auto
  ![alt](url){width=200 height=100}             bare numbers are px
  ![alt](url){style="width: 50%; float: right"} arbitrary inline CSS
  ![alt](url){.centered width=60%}              class + size together
  NEVER: ![alt =50%](url)  or  ![alt](url =50%)  — neither syntax is enabled in this pipeline.

Auto table of contents: \`[[toc]]\` on its own line generates a nested list of every h1–h4 with page numbers in the printed output. Drop one near the top of long documents.

Page break: \`<!-- pagebreak -->\` on its own line forces a new page in the printed/exported doc.

Lists:
  - unordered (also * or + work)
  1. ordered
  - [ ] todo,  - [x] done          ← task list (works in BOTH unordered AND ordered lists)
  Nest by indenting two spaces.

Definition lists:
  Term
  : body of the definition
  : another meaning for the same term

Code:
  Inline \`code\`. Fenced blocks with language hints get syntax highlighting:
    \`\`\`python
    def f(x): return x + 1
    \`\`\`
  Common languages: python, javascript, typescript, bash, html, css, json, yaml, sql,
  rust, go, java, c, cpp, php, ruby, swift, kotlin, and ~190 more via highlight.js.

Tables (pipe syntax):
  | A | B   | C |
  |:--|:---:|--:|
  | l | c   | r |
  Use \`:---\`, \`:---:\`, \`---:\` in the separator row for left/center/right alignment.

Blockquotes: lines prefixed with \`> \`. Nest with \`> > \`.

Horizontal rule: \`---\`, \`***\`, or \`___\` on its own line.

Footnotes: text[^1]. … and [^1]: footnote body somewhere later in the doc.

Math (KaTeX):
  Inline: $E = mc^2$
  Block (markers on their own lines):
    $$
    \\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
    $$
  Malformed math renders in red rather than crashing the doc — but fix it when you see it.

GitHub-style alerts — use a blockquote whose first line is \`[!KIND]\` ALONE:
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

  Valid kinds: \`NOTE\`, \`TIP\`, \`IMPORTANT\`, \`WARNING\`, \`CAUTION\`. The \`[!KIND]\` line must be alone — trailing text like \`> [!NOTE] Custom title\` is NOT supported and degrades to a plain blockquote.

Diagrams (Mermaid — fenced code block with \`mermaid\` language):
  \`\`\`mermaid
  flowchart LR
    A[Start] --> B{Decision}
    B -->|Yes| C[Done]
    B -->|No| D[Retry]
  \`\`\`
  Supported types: \`flowchart\`, \`sequenceDiagram\`, \`classDiagram\`, \`stateDiagram-v2\`, \`erDiagram\`, \`gantt\`, \`pie\`, \`mindmap\`, \`gitGraph\`, \`timeline\`. Reach for Mermaid whenever a diagram communicates a relationship more clearly than prose — do NOT use \`generate_image\` for diagrams.

Do NOT:
  - Write raw HTML tags — they're sanitized away. Use the markdown above.
  - Use \`:::warning :::\` style containers — they no longer render. Use \`> [!WARNING]\`.
  - Add \`target="_blank"\` or \`rel="noopener"\` to links — the renderer does it for you.
  - Try to size images with \`=WIDTHxHEIGHT\` in the alt or after the URL — use \`{width=…}\` attrs.`
