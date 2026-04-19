export const welcomeMarkdown = `# Welcome to YPad! 👋

YPad is a **collaborative markdown editor** with live sync, AI assistance, and flexible sharing. Start writing below, or use this document as a reference for markdown syntax.

---

## Text Formatting

You can write **bold text**, *italic text*, ~~strikethrough~~, ++inserted text++, or combine them for ***bold italic***. Use \`inline code\` for technical terms, ==highlight important parts==, and reach for H~2~O subscripts or E=mc^2^ superscripts when you need them.

## Headings

Use \`#\` for headings — from \`#\` (largest) to \`######\` (smallest). Attach an ID or CSS class with the \`{#id .class}\` suffix:

### Pinned section {#pinned}

The heading above renders with \`id="pinned"\` so you can link straight to it from elsewhere in the doc.

## Lists

### Unordered
- First item
- Second item
  - Nested item
  - Another nested item
- Third item

### Ordered
1. Step one
2. Step two
3. Step three

### Task Lists
- [x] Create a YPad account
- [x] Open your first document
- [ ] Invite a collaborator
- [ ] Try the AI writing assistant

## Links & Images

[Visit GitHub](https://github.com) — links are created with \`[text](url)\`.

Images can be sized inline using \`![Alt =widthxheight](url)\`:

![A 240×120 placeholder =240x120](https://placehold.co/240x120)

A standalone image with descriptive alt text becomes a \`<figure>\` with caption:

![Caption flows below the image, taken from the alt text.](https://placehold.co/320x140)

## Definitions & Abbreviations

Definition lists pair a term with one or more meanings:

CRDT
: Conflict-free Replicated Data Type — the algorithm family Y.js uses to merge edits across collaborators without a central server.

CSS
: Cascading Style Sheets.
: A stylesheet language for styling structured documents.

Abbreviations get tooltips when you mouse over them: hover HTML or JSON to see what they expand to.

*[HTML]: HyperText Markup Language
*[JSON]: JavaScript Object Notation
*[CRDT]: Conflict-free Replicated Data Type

## Code Blocks

Fenced code blocks with syntax highlighting:

\`\`\`python
def fibonacci(n: int) -> list[int]:
    """Generate the first n Fibonacci numbers."""
    fib = [0, 1]
    for i in range(2, n):
        fib.append(fib[i - 1] + fib[i - 2])
    return fib[:n]

print(fibonacci(10))
# [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
\`\`\`

\`\`\`javascript
const greet = (name) => \`Hello, \${name}!\`;
console.log(greet("YPad"));
\`\`\`

## Blockquotes

> "The best way to predict the future is to invent it."
> — Alan Kay

## Tables

| Feature          | Status | Notes                    |
| ---------------- | ------ | ------------------------ |
| Live sync        | ✅     | Powered by Y.js CRDT    |
| Markdown preview | ✅     | Split view with toolbar  |
| AI assistance    | 🔜     | Cloud + on-device models |
| File attachments | 🔜     | Drag & drop images       |

## Horizontal Rules

Use \`---\` to create a divider:

---

## Math & Special Characters

Emoji shortcodes like \`:rocket:\` → 🚀, \`:heart:\` → ❤️

## Footnotes

YPad supports inline footnotes[^1] that render at the bottom of the page where they appear[^2] — useful for citations, asides, and disclaimers.

[^1]: Like this one. Each footnote is anchored to its reference and floated into the page's bottom margin.
[^2]: Multiple footnotes per page are supported, numbered automatically across the document.

## Tips

- Press **Ctrl+B** for bold, **Ctrl+I** for italic
- Use the toolbar buttons above for quick formatting
- Toggle between Edit, Split, and Preview modes
- Click the document title to rename it

---

*Delete this content and start writing your own document!*
`
