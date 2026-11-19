import type { Skill } from './skill'

export const academicPaperSkill: Skill<'academic-paper'> = {
  id: 'academic-paper',
  title: 'Academic paper',
  when: 'papers and theses: abstract, citations, figure and table numbering',
  body: `Academic papers (the document's discipline, venue and existing conventions win):
- Structure: title, abstract, keywords if used, introduction, background or related work, method, results, discussion, conclusion, references, appendices. Keep the document's order unless asked to change it.
- Abstract: one paragraph, 150 to 250 words unless the venue says otherwise: problem, approach, main result with its numbers, implication. No citations, no undefined abbreviations, no claim the body does not support. Write or update it from the body.
- Claims: a fact from outside the paper carries a citation, and the sentence says only what that source supports. Never invent a reference, author, year, title, DOI or page number. A claim without a source gets a comment asking for one, not a placeholder.
- Citations: cite bibliography keys (\`list_references\`) as \`[@key, p. 12]\` or \`@key\`; the style and the reference list are generated, never typed. Add a work only with \`add_reference_by_doi\`; finish with \`check_citations\`. A document with hand-written citations keeps its style.
- Numbering: label figures, tables, equations and sections (\`{#fig:x}\`, \`{#tbl:x}\`, \`{#eq:x}\`, \`{#sec:x}\`) and refer with \`@fig:x\`, so numbers stay right. Each figure and table has a caption that stands on its own.
- Voice and tense follow the audience and discipline. Sciences and engineering: "we" for the authors' own actions, passive where the actor does not matter ("samples were stored at 4 °C"). Present tense for established facts and the paper's claims, past tense for what was done and found.
- Define every abbreviation at its first use (in the abstract and again in the body), then use only the abbreviation. SI units with a space before the unit.
- Hedging matches the evidence: "suggests" for correlation, "shows" for direct evidence. "Significant" only with a statistical test behind it.
- A paper look on request: \`update_theme\` with \`cover.layout: 'title-block'\` (title, authors, affiliations and the abstract on page 1) and \`headings.numbering\` instead of typing section numbers.`
}
