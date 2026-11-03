import { DEMO_DOC_BODY, SMOKE_DOCS_ENV, TEMPLATE_DOC_BODY, createAnonDoc } from './_helpers'

// Creates the smoke run's anonymous documents ONCE, before any spec runs,
// and hands their ids to every worker through the environment (workers
// inherit process.env set here). Hosted anonymous creation is limited to
// 10/hour per network and a smoke run comes from one runner address:
// specs therefore share these documents, and a retried spec reuses them
// instead of creating new ones. Total: 2 anonymous creations per run.
export default async function globalSetup(): Promise<void> {
  const demo = await createAnonDoc(DEMO_DOC_BODY)
  const template = await createAnonDoc(TEMPLATE_DOC_BODY)
  process.env[SMOKE_DOCS_ENV] = JSON.stringify({ demo, template })
}
