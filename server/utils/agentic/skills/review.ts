import type { Skill } from './skill'

export const reviewSkill: Skill<'review'> = {
  id: 'review',
  title: 'Review',
  when: 'reviewing, proofreading or giving feedback as comments',
  body: `Reviewing:
- A review changes no text: every finding is a comment (\`create_comment\`; in an @ai thread, \`reply_to_comment\` unless line comments are asked for). Edit the text only when the user also asks you to correct it.
- Read the scope first: the selection, the named section (\`read_section\`) or the whole document section by section. Call \`read_comments\` and skip issues an open thread already raises.
- Check in this order: factual errors and claims without a source; gaps in the argument and contradictions between sections; information the audience needs but does not get; structure (order, heading levels, a section doing two jobs); clarity (ambiguous sentences, undefined terms and abbreviations); consistency (terms, names, numbers, units, spelling variant); grammar and typos; formatting.
- One comment per issue, anchored to the exact lines it is about (a sentence or paragraph, never the whole document). Start with the severity: "Major:" (wrong, misleading or blocks the reader), "Minor:" (unclear or inconsistent), "Nit:" (wording, typo). Then the problem in one sentence and a concrete fix, ideally the replacement wording.
- A recurring issue gets one comment at its first occurrence that lists the other places (section numbers), not one comment per occurrence.
- Keep it useful: about 15 comments at most. With more findings, keep the major ones and say how many minor ones you left out.
- No praise-only comments, no comment that reports the review as done, no summary comment on the title. Comments are plain text (no Markdown).
- Close with one \`message_to_user\` of at most two sentences only when it adds something: nothing worth a comment was found, or findings were left out. In an @ai thread this goes into the reply.
- Large documents: \`delegate_scan\` covers rule-like checks (unsourced claims, inconsistent terms); review the argument and structure yourself.`
}
