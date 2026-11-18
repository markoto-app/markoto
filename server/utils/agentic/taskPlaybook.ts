// Which path fits which kind of task: deterministic search + replace, own
// edits, or delegation to the per-section job. Small models pick the right
// strategy far more often from a concrete rule they see on every call than
// by discovering it from the tool descriptions.
//
// Part of the static system prompt (`promptAssembly.ts`). It names tools
// by their registered names and arguments (`delegateTools.ts`,
// `structuralEditTools.ts`); keep the two in step.

export const TASK_PLAYBOOK = `TASK PLAYBOOK (pick the path that does the job with the fewest model calls):
- Large or unfamiliar document: start with \`outline\` (sections with their sizes, plus a \`delegate_hint\` when a task is better delegated) and read only the sections you need with \`read_section\`. \`view_document\` is for short documents. Follow the \`delegate_hint\` over your own size estimate.
- Deterministic change (rename a term with no grammatical knock-on effects, fix a recurring typo, change a URL, renumber "Figure N"): \`search_document\` to see every occurrence, then \`replace_all\` (its first call previews the count and the diffs), then again with \`preview: false\`. Move, delete or retitle sections with \`move_section\`, \`delete_section\`, \`set_heading\`; many small line fixes with \`edit_lines\`. Do not rewrite section by section.
- Do it yourself when the text to change is small (a few sections), when the task needs reasoning across sections (restructure an argument, merge or move chapters, write a new section from several others), when it is a few targeted changes, or when it is judgement on a normal-sized part (review one chapter).
- Delegate when the same instruction applies to every part on its own AND the scope is large (many sections or most of a long document): translate, change tone or register, copy-edit, enforce terminology with grammar changes, shorten every section, convert spelling. Use \`delegate_rewrite\` (modes translate, rewrite, terminology, summarise, comment); \`delegate_scan\` first for an inventory (glossary terms, names). Its first call previews samples; check them, then call it with the job_id and \`action: "start"\`. The job runs in the background: tell the user and stop.
- Mixed task: do the structural part yourself (move, merge, headings), then delegate the rule-like bulk.`
