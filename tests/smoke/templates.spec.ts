import { test, expect } from '@playwright/test'
import { api, createAnonDoc } from './_helpers'

// Template bodies are read server-side from shared/templates/content/*.md by
// templateRenderer.ts. Those files weren't in the prod Docker image, so every
// non-blank template body came back null in prod. The token endpoint returns
// the server-rendered initialBody — a non-empty body proves the files ship
// and templateRenderer resolves them.
test('template new-doc seeds a non-empty body', async () => {
  const docId = await createAnonDoc({ templateId: 'business-plan', language: 'en' })

  const res = await fetch(api(`/api/docs/${docId}/token`))
  expect(res.status).toBe(200)
  const body = await res.json() as { templateId?: string, initialBody?: string }

  expect(body.templateId, 'templateId echoed back').toBe('business-plan')
  expect((body.initialBody ?? '').length, 'template initialBody should be non-empty').toBeGreaterThan(50)
})
