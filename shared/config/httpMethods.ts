/** HTTP methods that change state; the CSRF origin check and the onboarding gate apply to these only. */
export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
