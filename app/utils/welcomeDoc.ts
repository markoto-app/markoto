export const welcomeMarkdown = `# Welcome to YPad

YPad is a collaborative markdown editor. Open this document on a second device or share the URL — anyone you invite sees your edits arrive in real time, and you'll see theirs.

> [!TIP]
> Press **Cmd / Ctrl + B** for bold, **Cmd / Ctrl + I** for italic, or open the **File** menu for everything else.

## Working together

Anyone with the link can edit by default. Use **File → Sharing** to lock the document down — make it view-only, password-protect it, or keep it private to just you.

\`\`\`mermaid
flowchart LR
  You[You] -- share link --> Doc[YPad document]
  Doc -- live edits --> Friends[Collaborators]
  Friends -- live edits --> Doc
\`\`\`

The avatars at the top show who's currently looking at the doc, and the **Activity** panel on the right keeps a record of who joined, left, and made changes.

## Writing with the AI

Click the **AI** bar at the bottom of the screen and ask it to draft, rewrite, or restructure something. It joins the document as another collaborator and you watch it type.

For inline tweaks, select some text and use the **Rewrite** popover that appears above your selection — useful when you want a sentence shortened, translated, or made more formal without leaving the line.

> [!NOTE]
> The AI can search the web before it writes. Ask "summarise the latest news on…" and it'll fetch sources first, then draft.

## Make it your own

Open the **Theme** panel from the toolbar to change fonts, colors, page layout, code-block style, and more. The preview on the right is paginated — what you see is what prints.

Hit **Cmd / Ctrl + P** when you're ready to export. The print dialog opens straight on the same paginated view, so saving as PDF is a one-click operation.

## A markdown sampler

You get the usual: **bold**, *italic*, ~~strikethrough~~, ==highlight==, ++inserted++, \`inline code\`, and standard lists.

Code blocks pick up syntax highlighting from the language hint:

\`\`\`python
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b
\`\`\`

Tables work as you'd expect:

| Mode    | What you see              |
| ------- | ------------------------- |
| Edit    | Just the source           |
| Split   | Source + paginated preview |
| Preview | Just the paginated preview |

Math is supported too — inline like $E = mc^2$, or as a centered block:

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

For the rest (footnotes, definition lists, images, the other four alert kinds), peek at the **Insert** menu.

> [!IMPORTANT]
> This is your document. Delete everything below this line and start writing.

---
`
