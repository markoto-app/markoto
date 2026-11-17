// Which path fits which kind of task: deterministic search + replace, own
// edits, or delegation to the per-section job. Small models pick the right
// strategy far more often from a concrete rule they see on every call than
// by discovering it from the tool descriptions.
//
// Not part of PROMPT_SYSTEM_PROMPT yet: it names the section and delegation
// tools (`outline`, `read_section`, `search_document`, `replace_all`,
// `delegate_rewrite`, `delegate_scan`), and a prompt that names tools the
// model is not offered sends it after calls that fail. It goes into the
// static prompt, next to the behaviour rules, in the same change that
// registers those tools; `tests/unit/ai/writingStyle.test.ts` pins that it
// is absent until then.

export const TASK_PLAYBOOK = `TASK PLAYBOOK (pick the path that does the job with the fewest model calls):
- Large or unfamiliar document: start with \`outline\` (sections with their sizes, plus a \`delegate_hint\` when a task is better delegated) and read only the sections you need with \`read_section\`. \`view_document\` is for short documents. Follow the \`delegate_hint\` over your own size estimate.
- Deterministic change (rename a term with no grammatical knock-on effects, fix a recurring typo, change a URL, renumber "Figure N"): \`search_document\` to see every occurrence, then \`replace_all\` with \`dry_run: true\`, then for real. Do not rewrite section by section.
- Do it yourself when the text to change is small (a few sections), when the task needs reasoning across sections (restructure an argument, merge or move chapters, write a new section from several others), when it is a few targeted changes, or when it is judgement on a normal-sized part (review one chapter).
- Delegate when the same instruction applies to every part on its own AND the scope is large (many sections or most of a long document): translate, change tone or register, copy-edit, enforce terminology with grammar changes, shorten every section, convert spelling. \`delegate_rewrite\` for edits, \`delegate_scan\` for comment-only passes (unsourced claims, consistency checks). Check the preview it returns before you start the job.
- Mixed task: do the structural part yourself (move, merge, headings), then delegate the rule-like bulk.`
