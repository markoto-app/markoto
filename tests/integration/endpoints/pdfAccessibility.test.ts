// The server PDF is a tagged PDF: structure tree, MarkInfo, a document
// language, a title shown in the viewer's title bar and bookmarks. Renders
// the accessibility fixture through the REAL renderer (test stack, see
// docPdf.test.ts). `scripts/pdf-a11y-check.sh` runs this file with
// PDF_A11Y_OUT_DIR set to keep the PDFs and validates them with veraPDF.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { resetDb, testDb } from '../setup/db'
import { anonClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import { first } from '../../helpers/assert'

const FIXTURE = readFileSync(
  resolve(fileURLToPath(import.meta.url), '../../../fixtures/pdf-a11y/fixture.md'),
  'utf8'
)

const s3 = new S3Client({
  endpoint: 'http://127.0.0.1:8334',
  region: 'us-east-1',
  credentials: { accessKeyId: 'ypad-access-key', secretAccessKey: 'ypad-secret-key' },
  forcePathStyle: true
})

async function insertYjsRow(docname: string, content: string): Promise<number> {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, content)
  const r = await testDb().query<{ id: number }>(
    `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2) RETURNING id`,
    [docname, Buffer.from(Y.encodeStateAsUpdate(ydoc))]
  )
  return Number(first(r.rows).id)
}

/** Render a document and return the PDF bytes from the render cache. */
async function renderPdf(opts: { title: string, language: string, name: string }): Promise<string> {
  const owner = await createUser()
  const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit', title: opts.title, language: opts.language })
  const snapId = await insertYjsRow(doc.docId, FIXTURE)
  const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
  expect(res.status).toBe(302)
  const got = await s3.send(new GetObjectCommand({ Bucket: 'ypad', Key: `renders/${doc.docId}/${snapId}/document.pdf` }))
  const bytes = await got.Body!.transformToByteArray()
  // eslint-disable-next-line markoto/no-raw-env -- output switch of scripts/pdf-a11y-check.sh, not app configuration
  const outDir = process.env.PDF_A11Y_OUT_DIR
  if (outDir) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, `${opts.name}.pdf`), bytes)
  }
  return new TextDecoder('latin1').decode(bytes)
}

/** A PDF text string (literal or hex, PDFDocEncoding or UTF-16BE) as JS text. */
function pdfString(raw: string): string {
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/\s/g, '')
    const bytes = hex.match(/../g)?.map(h => Number.parseInt(h, 16)) ?? []
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      let out = ''
      for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0))
      return out
    }
    return String.fromCharCode(...bytes)
  }
  return raw.slice(1, -1).replace(/\\([()\\])/g, '$1')
}

function stringEntry(pdf: string, key: string): string | null {
  const m = new RegExp(`/${key}\\s*(\\((?:\\\\.|[^\\\\)])*\\)|<[0-9A-Fa-f\\s]*>)`).exec(pdf)
  return m?.[1] ? pdfString(m[1]) : null
}

beforeEach(async () => {
  await resetDb()
})

describe('server PDF accessibility', () => {
  it('is tagged, with language, title, bookmarks and the document structure', async () => {
    const pdf = await renderPdf({ title: 'Quarterly accessibility report', language: 'de', name: 'fixture-de' })

    expect(pdf).toMatch(/\/StructTreeRoot\s+\d+\s+\d+\s+R/)
    expect(pdf).toMatch(/\/MarkInfo\s*<<[^>]*\/Marked\s+true/)
    expect(stringEntry(pdf, 'Lang')).toBe('de')
    expect(stringEntry(pdf, 'Title')).toBe('Quarterly accessibility report')
    expect(pdf).toMatch(/\/DisplayDocTitle\s+true/)
    expect(pdf).toMatch(/\/Outlines\s+\d+\s+\d+\s+R/)

    // Structure elements for the fixture's headings, lists, table, figure and links.
    for (const role of ['H1', 'H2', 'H3', 'L', 'LI', 'Table', 'TR', 'TH', 'TD', 'Figure', 'Link']) {
      expect(pdf, `structure type /${role}`).toMatch(new RegExp(`/S\\s*/${role}\\b`))
    }
    expect(stringEntry(pdf, 'Alt')).toBe('The markoto app icon')
  }, 90_000)

  it('maps a typed language name to its tag and an unknown one to und', async () => {
    const named = await renderPdf({ title: 'Rapport', language: 'Français', name: 'fixture-fr' })
    expect(stringEntry(named, 'Lang')).toBe('fr')
    const unknown = await renderPdf({ title: '   ', language: 'Klingon', name: 'fixture-und' })
    expect(stringEntry(unknown, 'Lang')).toBe('und')
    expect(stringEntry(unknown, 'Title')).toBe('Untitled')
  }, 120_000)
})
