import { describe, it, expect } from 'vitest'
import { PROMPT_SYSTEM_PROMPT } from '../../../server/utils/agentic/promptAssembly'
import { COMMENT_TRIGGER_SYSTEM_PROMPT } from '../../../server/utils/agentic/commentTriggerPrompt'
import { MARKDOWN_REFERENCE } from '../../../server/utils/agentic/markdownReference'
import { WRITING_STYLE_RULES } from '../../../server/utils/agentic/writingStyle'
import { TASK_PLAYBOOK } from '../../../server/utils/agentic/taskPlaybook'
import { AUDIENCES } from '../../../shared/audiences'

// The prose rules reach both system prompts, and no prompt teaches or
// contains the em-dash the rules forbid.

const EM_DASH = '\u2014'

describe('writing style in the system prompts', () => {
  it.each([
    ['editor prompt', PROMPT_SYSTEM_PROMPT],
    ['comment-trigger prompt', COMMENT_TRIGGER_SYSTEM_PROMPT]
  ])('the %s contains the writing rules and no em-dash', (_name, prompt) => {
    expect(prompt).toContain(WRITING_STYLE_RULES)
    expect(prompt).not.toContain(EM_DASH)
  })

  it('the rules forbid the em-dash and yield to the document language, audience and style', () => {
    expect(WRITING_STYLE_RULES).toMatch(/never write an em-dash/i)
    expect(WRITING_STYLE_RULES).toContain('the document\'s language, audience guidance and existing style win')
    expect(WRITING_STYLE_RULES).not.toContain(EM_DASH)
  })

  it('stays short: every token of it is in the prefix of every call', () => {
    expect(WRITING_STYLE_RULES.length).toBeLessThan(2000)
  })

  it('the Markdown reference no longer teaches the em-dash, the en-dash for ranges stays', () => {
    expect(MARKDOWN_REFERENCE).not.toMatch(/em-dash/)
    expect(MARKDOWN_REFERENCE).toMatch(/--\s+becomes\s+–\s+\(en-dash/)
  })

  it('no audience fragment contains an em-dash or asks for bulleted lists', () => {
    for (const { promptFragment } of Object.values(AUDIENCES)) {
      expect(promptFragment).not.toContain(EM_DASH)
      expect(promptFragment).not.toMatch(/bullet/i)
    }
  })

  it('the task playbook is in the editor prompt, short and without an em-dash', () => {
    expect(PROMPT_SYSTEM_PROMPT).toContain(TASK_PLAYBOOK)
    expect(TASK_PLAYBOOK).toMatch(/delegate_rewrite/)
    expect(TASK_PLAYBOOK).not.toContain(EM_DASH)
    // Every token of it is in the prefix of every call; details go into the long-document skill.
    expect(TASK_PLAYBOOK.length).toBeLessThan(2400)
  })
})
