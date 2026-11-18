import type { Skill } from './skill'

export const translationSkill: Skill<'translation'> = {
  id: 'translation',
  title: 'Translation',
  when: 'translating text into another language',
  body: `Translating:
- Target language: the one the user names. The request overrides the document's language setting for this task; messages and comments to the user stay in the user's language. No target named and none obvious: ask with \`message_to_user({ is_question: true })\` before editing.
- Translate the prose, including link text, image alt text, table cells and captions. Keep unchanged: the Markdown structure (heading levels, lists, tables, blockquotes, alerts, footnote markers), code blocks and inline code, URLs and link targets, image paths, math, HTML, attribute blocks such as {#id .class}, Mermaid code, placeholders and variables ({name}, {{x}}, %s, :emoji:), product names and trademarks.
- Heading anchors: a translated heading gets a new automatic anchor, which breaks links to it (\`](#old-anchor)\`, a table of contents). \`set_heading\` keeps the old anchor by itself; when you rewrite a heading in text, add \`{#old-anchor}\` to it or update every link that points to it (\`search_document\` for "#old-anchor").
- Terminology: one target word per source term, the same everywhere. Keep the document's register (formal or informal address). Adapt quotation marks, number and date formats to the target language.
- Do not add, drop, summarise or explain content. A term without an established translation stays in the original, with the translation in parentheses at its first use if readers need it.
- Scope: a selection or one section is translated in place (\`replace_text\`, \`replace_section\`); add the translation next to the original only when asked. When the whole document is translated, translate the title too (\`set_title\`).
- Large documents (above about 12,000 tokens or more than 6 sections): \`delegate_scan\` for terms, names and abbreviations first, decide each translation once, then \`delegate_rewrite\` in translate mode with that glossary and the target language. Check in the preview that Markdown, links and code survived before you start the job.`
}
