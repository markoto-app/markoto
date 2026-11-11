import { GetObjectCommand } from '@aws-sdk/client-s3'
import { customAlphabet } from 'nanoid'
import { DocThemeSchema, type DocTheme } from '~~/shared/types/theme'
import { cleanupRendersForDoc, renderPngUncached } from '../renderClient'
import { useS3Client } from '../s3'
import { useValkey } from '../valkey'

// Renders a fixed sample document in a proposed theme through the normal
// renderer sidecar → print page path, so the model (and the dialog) see
// exactly what markoto would print. The sample is not a document: its
// markdown + theme sit in Valkey under a one-off id for the render's
// duration, and `/api/_internal/render-bootstrap` serves them for that id
// (`loadDesignSample`) after the usual render-token check. The PNGs land
// in S3 under `renders/{id}/` like any render and are deleted right after
// they are read.

/** `design-sample-` + 20 alphanumerics: a shape no nanoid document id has (they are shorter). */
export const DESIGN_SAMPLE_ID_RE = /^design-sample-[A-Za-z0-9]{20}$/
const sampleId = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 20)

const SAMPLE_TTL_SECONDS = 180
/** Cover + the first text pages, so a cover that runs over still leaves text pages in view. */
const SAMPLE_PAGES = 3

const DESIGN_SAMPLE_TITLE = 'Quarterly update'

/**
 * A short document that shows every part of a design on two pages:
 * headings h1–h3, text, emphasis, a link, a list, a table, a quote, an
 * alert. Neutral English text — the model judges the design, not the words.
 */
const DESIGN_SAMPLE_MARKDOWN = `# Summary

This quarter we finished the move to the new platform and opened two offices. Revenue grew by **18 %**, and costs grew more slowly than revenue for the third quarter in a row. The [full figures](https://example.com) follow below.

## Results

The new service is used by most of our larger customers. Three things made the difference:

- shorter response times after the move,
- the forecasting add-on, and
- a simpler price list.

| Segment | Q2 | Q3 | Change |
|---|---:|---:|---:|
| Dashboards | 21.4 | 25.9 | +21 % |
| Forecasting | 8.2 | 10.6 | +29 % |
| Consulting | 6.0 | 5.5 | −8 % |

Table: Revenue by segment (millions)

> We grow slowly, and we grow well.

### Next steps

The team will focus on the two new offices and on the reporting tools our customers asked for. We expect growth of 12 to 15 % next year.

> [!NOTE]
> The figures are not yet audited.

## Outlook

Most of the growth will come from customers who already use two or more of our products. We will publish the audited figures in the next update.
`

export interface DesignSample {
  markdown: string
  theme: DocTheme
  title: string
  language: string
}

function sampleKey(id: string): string {
  return `design-sample:${id}`
}

/** For render-bootstrap: the sample behind a design-sample id, or null. */
export async function loadDesignSample(id: string): Promise<DesignSample | null> {
  if (!DESIGN_SAMPLE_ID_RE.test(id)) return null
  const raw = await useValkey().get(sampleKey(id))
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const { markdown, theme, title, language } = value as Record<string, unknown>
    if (typeof markdown !== 'string' || typeof title !== 'string' || typeof language !== 'string') return null
    const parsed = DocThemeSchema.safeParse(theme)
    if (!parsed.success) return null
    return { markdown, theme: parsed.data, title, language }
  } catch {
    return null
  }
}

/**
 * Render the sample in `theme`; returns up to three pages as base64 PNG.
 * Throws when the renderer is unavailable — the caller then goes on
 * without a comparison round.
 */
export async function renderDesignSample(theme: DocTheme, round: number): Promise<string[]> {
  const id = `design-sample-${sampleId()}`
  const sample: DesignSample = { markdown: DESIGN_SAMPLE_MARKDOWN, theme, title: DESIGN_SAMPLE_TITLE, language: 'en' }
  const valkey = useValkey()
  await valkey.set(sampleKey(id), JSON.stringify(sample), 'EX', SAMPLE_TTL_SECONDS)
  try {
    const { pageKeys } = await renderPngUncached(id, round)
    const config = useRuntimeConfig()
    const s3 = useS3Client()
    const pages: string[] = []
    for (const key of pageKeys.slice(0, SAMPLE_PAGES)) {
      const got = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }))
      const bytes = await got.Body?.transformToByteArray()
      if (bytes) pages.push(Buffer.from(bytes).toString('base64'))
    }
    return pages
  } finally {
    await valkey.del(sampleKey(id)).catch(() => 0)
    await cleanupRendersForDoc(id)
  }
}
