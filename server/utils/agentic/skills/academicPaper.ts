import type { Skill } from './skill'

export const academicPaperSkill: Skill<'academic-paper'> = {
  id: 'academic-paper',
  title: 'Academic paper',
  when: 'papers and theses: abstract, citations, figure and table numbering',
  body: `Academic papers (the document's discipline, venue and existing conventions win):
- Structure: title, abstract, keywords if used, introduction, background or related work, method, results, discussion, conclusion, references, appendices. Keep the document's order unless asked to change it.
- Abstract: one paragraph, 150 to 250 words unless the venue says otherwise: problem, approach, main result with its numbers, implication. No citations, no undefined abbreviations, no claim the body does not support. Write or update it from the body.
- Claims: a fact from outside the paper carries a citation, and the sentence says only what that source supports. Never invent a reference, author, year, title, DOI or page number. A claim without a source gets a comment asking for one, not a placeholder.
- Citations: keep the document's style (numeric [1], author-year (Smith, 2020) or footnotes [^1]) and do not mix styles. Every in-text citation has a reference entry and every entry is cited. Numeric lists follow the order of first citation, author-year lists are alphabetical.
- Numbering: figures, tables and equations are numbered in order of appearance and referred to by number ("Figure 3", "Table 2", "Eq. (4)"). After inserting, moving or deleting one, renumber it and every reference to it (\`search_document\` finds them). Each figure and table has a caption that is understandable on its own.
- Voice and tense follow the audience and discipline. Sciences and engineering: "we" for the authors' own actions, passive where the actor does not matter ("samples were stored at 4 °C"). Present tense for established facts and the paper's claims, past tense for what was done and found.
- Define every abbreviation at its first use (in the abstract and again in the body), then use only the abbreviation. SI units with a space before the unit.
- Hedging matches the evidence: "suggests" for correlation, "shows" for direct evidence. "Significant" only with a statistical test behind it.
- A paper look on request: \`update_theme\` with \`cover.layout: 'title-block'\` (title, authors, affiliations and the abstract on page 1) and \`headings.numbering\` instead of typing section numbers.`
}
