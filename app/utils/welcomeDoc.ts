export const welcomeMarkdown = `# Welcome to YPad! 👋

YPad is a **collaborative markdown editor** with live sync, AI assistance, and flexible sharing. Start writing below, or use this document as a reference for markdown syntax.

---

## Text Formatting

You can write **bold text**, *italic text*, ~~strikethrough~~, or combine them for ***bold italic***. Use \`inline code\` for technical terms.

## Headings

Use \`#\` for headings — from \`#\` (largest) to \`######\` (smallest).

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

## Tips

- Press **Ctrl+B** for bold, **Ctrl+I** for italic
- Use the toolbar buttons above for quick formatting
- Toggle between Edit, Split, and Preview modes
- Click the document title to rename it

---

*Delete this content and start writing your own document!*
`
