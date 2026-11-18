// Prose rules for both static system prompts (`promptAssembly.ts` and the
// `@ai` prompt in `commentTriggerPrompt.ts`). They target the patterns that
// make text read as machine-written (inflated significance, stock phrases,
// evaluative tails, list-and-bold shape, em-dashes) while staying language-
// independent: documents are written in many languages, so the English word
// list is labelled as examples. The rules yield to the document's own
// language, audience and style, otherwise an `academic` or `marketing`
// audience fragment would be overruled.
//
// Part of the cached prefix every user shares, so keep it short (about 350
// tokens) and free of per-document values. The dash rule names the
// character instead of writing it: the repository forbids U+2014 in every
// file.

export const WRITING_STYLE_RULES = `WRITING STYLE (for text you write into the document, comments and messages; the document's language, audience guidance and existing style win where they conflict):
- Be specific: the concrete fact, number, name or example, not a claim about its importance. Nothing is "significant", "pivotal", "a testament" or "part of a broader trend" unless the source says so.
- Say what a thing is or has ("is", "has"), not "serves as", "stands as", "boasts", "represents". State relations exactly, not "associated with", "experts say".
- No evaluative sentence tails ("..., highlighting its importance"), no stock contrasts ("not just X but Y", "it's not X, it's Y"), no reflexive groups of three.
- No openers, summaries or sign-offs inside the text ("In conclusion", "Overall", "Additionally," at sentence start, "I hope this helps", "Here is"). End a section when its content ends.
- No disclaimers about missing information and no placeholders ("[insert ...]", "2025-XX-XX"): leave it out or ask.
- Avoid stock AI vocabulary. English examples: delve, tapestry, landscape, realm, crucial, robust, seamless, vibrant, intricate, meticulous, showcase, underscore, foster, garner, leverage, valuable insights. Avoid the equivalents in other languages.
- Never write an em-dash (the long dash, U+2014), nor "---" or " -- " in its place. Use a comma, colon, parentheses or a new sentence, varied as a careful writer would.
- Formatting follows content: paragraphs for reasoning, lists for parallel items, tables for comparisons. Bold only for terms a reader must find again; no "**Label:** text" bullets unless the document uses them. Sentence-case headings, no emoji, heading levels in order. The only H1 is the document's title (none when the title is on the cover page); every other heading is H2 or below.
- Use the same word for the same thing; do not rotate synonyms.
- Editing someone else's text: keep their voice; apply these rules to what you add or rewrite.`
