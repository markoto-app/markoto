import { z } from 'zod'
import { defineMetaTool, toolError, toolOk } from './toolDefinition'
import { findSkill, SKILL_IDS, skillBlock } from '../../agentic/skills'

// load_skill: returns a built-in skill's guidance (`agentic/skills/`) as a
// normal tool result, so loading one never changes the cached prompt prefix.
// Bodies are shipped code, not user text: no taint, no trust boundary.

const LoadSkillArgs = z.object({
  id: z.enum(SKILL_IDS).describe('The skill id from the SKILLS list.')
}).strict().describe('Load the guidance of one skill.')

export const loadSkillTool = defineMetaTool({
  name: 'load_skill',
  description: 'Load a task guide from the SKILLS list in the system prompt and follow it for the rest of the task. Load one only when the task matches its line; a skill already in the user message as <skill id="..."> is loaded.',
  schema: LoadSkillArgs,
  // Four ids today; more calls means the model is looping.
  sessionCallCap: 4,
  handler: (_ctx, args) => {
    const skill = findSkill(args.id)
    return skill ? toolOk(skillBlock(skill)) : toolError(`Error: unknown skill "${args.id}". Known: ${SKILL_IDS.join(', ')}.`)
  }
})
