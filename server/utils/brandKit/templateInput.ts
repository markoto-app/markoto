import { WORKSPACE_TEMPLATE_DESCRIPTION_MAX, WORKSPACE_TEMPLATE_NAME_MAX } from '~~/shared/config/brandKit'

// Shared field checks for workspace templates (WP10c).

export function parseTemplateName(raw: unknown, required: boolean): string | undefined {
  if (raw === undefined && !required) return undefined
  if (typeof raw !== 'string' || !raw.trim()) throw createError({ statusCode: 400, message: 'Give the template a name.', data: { code: 'template/invalid', field: 'name' } })
  const name = raw.replace(/\s+/g, ' ').trim()
  if (name.length > WORKSPACE_TEMPLATE_NAME_MAX) throw createError({ statusCode: 400, message: `Name too long (max ${WORKSPACE_TEMPLATE_NAME_MAX}).`, data: { code: 'template/invalid', field: 'name' } })
  return name
}

export function parseTemplateDescription(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return ''
  if (typeof raw !== 'string') throw createError({ statusCode: 400, message: 'Description must be text.', data: { code: 'template/invalid', field: 'description' } })
  const text = raw.trim()
  if (text.length > WORKSPACE_TEMPLATE_DESCRIPTION_MAX) throw createError({ statusCode: 400, message: `Description too long (max ${WORKSPACE_TEMPLATE_DESCRIPTION_MAX}).`, data: { code: 'template/invalid', field: 'description' } })
  return text
}
