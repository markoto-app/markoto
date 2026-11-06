/**
 * Markdown vocabulary reference injected into the AI system prompts so
 * the model knows the FULL set of features available in markoto documents
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
 * by `scripts/audit-markdown-pipeline.mjs` — that script runs the full
 * markdown-it + every plugin + DOMPurify chain (identical config to
 * `app/utils/renderMarkdown.ts`) and prints both raw and sanitized
 * output for every case. Rules for edits to this file:
 *   1. Add the syntax case to the audit script first.
 *   2. Run `bun scripts/audit-markdown-pipeline.mjs` and confirm the
 *      CLEAN output matches what you're about to claim here.
 *   3. Only then update the reference text.
 * Do NOT add "should work" syntaxes — the AI will emit them and ship
 * broken output silently.
 */
export const MARKDOWN_REFERENCE = `MARKDOWN VOCABULARY (features verified to render correctly in markoto):

Inline:
  **bold**  *italic*  ~~strike~~  ==highlight==  ++inserted++  \`code\`
  H~2~O (subscript), E=mc^2^ (superscript)
  [link](https://example.com) — inline link. Auto-opens in a new tab; do NOT add target/rel manually.
  [link text][ref] … [ref]: https://example.com  — reference-style link (define once, reuse).
  Bare URLs are auto-linked: https://example.com → clickable. Emails too: foo@bar.com → mailto link.
  Abbreviation (case-sensitive, can be defined before OR after use): *[HTML]: HyperText Markup Language
  Emoji shortcodes: :rocket: → 🚀, :heart: → ❤️, :+1: → 👍, :100: → 💯. Also works inside headings.
  Clickable image: [![alt](cat.jpg)](https://target.com)  — wraps the figure's image in an anchor.

Typography (auto — don't fight it):
  --  becomes  –  (en-dash),  ---  becomes  —  (em-dash),  ...  becomes  …,  "x"/'x' become smart quotes.
  A single newline inside a paragraph becomes a <br>. Use a blank line for a real paragraph break.

Headings: #, ##, …, ######. Every heading auto-gets a slug \`id\`.
  Unnumbered heading (when the theme numbers sections): \`# References {.unnumbered}\` (Pandoc's \`{-}\` works too) — no number, the counters don't advance, its TOC entry has no number either. Use it for References, Acknowledgements, Appendix intros.
  Reference list: a section headed "References" (or Bibliography, Literatur, Références, Referencias, 参考文献 …) is recognised automatically — its numbered list or paragraphs get the theme's reference style (hanging indent / [1] labels). Write the entries as a numbered list (\`1. A. Author, "Title," …\`) or one paragraph each; no class needed.

Attribute syntax \`{…}\` (CRITICAL — unlocks classes / custom IDs / inline style on most elements):
  After the element, in curly braces:
    {#custom-id}                     set the id
    {.class-name}                    add a class (space-separated = multiple classes)
    {key=value}                      set attribute (bare values, or quoted for spaces)
    {style="css: value"}             inline CSS
    {aria-label="…"} / {role="…"}    a11y attributes pass through unchanged.
    Combine: {#intro .lead style="text-align: center"}
  Works on: headings, paragraphs, links, inline code, images, blockquotes.
  Heading example:          # Title {#intro .lead}
  Paragraph example:        A paragraph here.\n  {.callout}         ← attrs on the NEXT line, alone, attach to paragraph
  Link example:             [click](url){.btn}
  Inline code example:      \`var x\`{.highlight}
  Image examples below.
  Note: \`data-*\` attributes are stripped by the sanitizer — only a curated allow-list survives (class, id, style, width, height, target, rel, title, aria-*, role, and a few MathML bits).

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

Private comments (NOT rendered in preview, PDF, or shared view — only visible in the markdown source):
  <!-- TODO: rewrite this section -->          single-line, on its own line — entire line removed
  <!-- a private note --> in a paragraph        inline within prose — comment stripped, surrounding text kept
  <!--                                          multi-line block — every line consumed
  notes that span
  multiple lines
  -->
  Use comments to leave private notes for the writer (todos, reminders, alternative phrasings) without polluting the output. Markdown inside a comment is NOT processed (\`<!-- **bold** -->\` emits nothing, no bold). \`<!-- pagebreak -->\` keeps its special pagebreak meaning and is NOT treated as a comment.

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
  Caption (Pandoc syntax): a paragraph starting with \`Table:\` (or just \`:\`) right before or after the table — \`Table: Key figures (CHF million)\` — becomes the table's caption. The theme places it above or below and can number it ("Table 1:"). Refer to tables in the text by number ("Table 2 shows …"); the label is added by the theme, don't type it into the caption.

Blockquotes: lines prefixed with \`> \`. Nest with \`> > \`.

Horizontal rule: \`---\`, \`***\`, or \`___\` on its own line.

Footnotes: text[^1]. … and [^1]: footnote body somewhere later in the doc.

Math (KaTeX):
  Inline: $E = mc^2$.  Escape a literal dollar sign with \\$ so it isn't parsed as math.
  Block (markers on their own lines):
    $$
    \\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
    $$
  Environments work too: \`\\begin{pmatrix}…\\end{pmatrix}\`, \`\\begin{aligned}…\\end{aligned}\`, \`\\begin{cases}…\\end{cases}\`, etc.
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

  Valid kinds: \`NOTE\`, \`TIP\`, \`IMPORTANT\`, \`WARNING\`, \`CAUTION\` (lowercase also accepted: \`[!note]\` works). Any other kind (\`DANGER\`, \`INFO\`, etc.) degrades to a plain blockquote. The \`[!KIND]\` line must be alone — trailing text like \`> [!NOTE] Custom title\` is NOT supported.
  Nested content works: lists, bold, inline code, and links all render normally inside an alert body.

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
