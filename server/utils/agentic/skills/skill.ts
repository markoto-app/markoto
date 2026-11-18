/**
 * A built-in skill: task guidance the model gets only when the task needs
 * it, instead of carrying it in the static prompt every call sends. Bodies
 * are shipped code (trusted), English, and follow WRITING_STYLE_RULES.
 */
export interface Skill<Id extends string = string> {
  /** Stable id: the `load_skill` enum value and the `<skill id>` attribute. */
  id: Id
  title: string
  /** One line for the catalogue in the static prompt: when the skill helps. */
  when: string
  /** The guidance, returned by `load_skill` or preselected into the first user message. */
  body: string
}
