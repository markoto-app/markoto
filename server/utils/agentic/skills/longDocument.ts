import type { Skill } from './skill'

// The details behind the TASK PLAYBOOK in the static prompt: the section
// tools step by step, the size thresholds (the same 12,000 tokens as the
// outline's delegate_hint) and how to run a delegated job.

export const longDocumentSkill: Skill<'long-document'> = {
  id: 'long-document',
  title: 'Long documents',
  when: 'large documents, changes across the whole document',
  body: `Working with a long document:
1. Orient: \`outline\` first (section ids like s-12, numbers, line ranges, words, rev); \`outline\` with \`under\` lists one chapter. Read only what the task needs with \`read_section\`. Never page through a long document with \`view_document\`.
2. Locate: \`search_document\` lists every match of a word, name or pattern with its section. Use it before a document-wide change and again afterwards to check that nothing was missed.
3. Exact patterns: \`replace_all\` previews first (count, skipped code and URLs, diffs, word forms). Check it, then call again with \`preview: false\`, \`matchIds\` (only some) or \`forms\` (whole words, e.g. a German linking "s"). Only when no grammar around it changes.
4. Structure: \`move_section\`, \`swap_sections\`, \`delete_section\`, \`set_heading\` and \`insert_markdown\` work by section id without copying text. To exchange two chapters call \`swap_sections\` once, never two moves; headings keep their numbers, so put them in order with one \`renumber_headings\` call; \`replace_section\` rewrites one section; \`edit_lines\` applies many small line fixes against one \`base_rev\`. Pass \`expected_rev\` when you edit what you read earlier, so a concurrent change by a collaborator is refused instead of overwritten.
5. Size: do it yourself when the text to change is under about 8,000 tokens or at most 3 sections, or when the task needs reasoning across sections. Delegate when the same instruction applies to each part on its own and the target is over about 12,000 tokens or more than 6 sections. The outline's \`delegate_hint\` applies these numbers for you; follow it.
6. Delegating: when consistency matters (terms, names, abbreviations), run \`delegate_scan\` first and turn its result into a glossary. Give \`delegate_rewrite\` a precise instruction: register, person, spelling variant, and what must not change. Read the preview samples; if they are wrong, fix the instruction and preview again before you start. Do not edit the target sections yourself while the job runs. Tell the user about skipped or flagged parts.
7. Mixed task: structural work first (move, merge, retitle), then the rule-like bulk.
8. Line numbers shift with every edit; section ids do not. Address sections by id, not by line numbers you read before an edit.`
}
