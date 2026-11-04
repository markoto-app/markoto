// @vitest-environment nuxt
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { mountSuspended, mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { EditorView } from '@codemirror/view'
import { TryIt } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'

// The marketing `::try-it` block (components/content/TryIt.vue +
// components/marketing/TryItWorkbench.vue):
//   - SSR / before mount: a static rendering of the COMMITTED source via
//     the trusted renderer, and no editor;
//   - the editor + preview mount only when the block nears the viewport
//     (IntersectionObserver) or is clicked;
//   - what the visitor types goes through `renderMarkdown` (DOMPurify)
//     into the preview composable — never through `renderTrustedMarkdown`;
//   - both actions use the existing endpoints: POST /api/docs (with the
//     text as `content`) and GET /api/docs/:id/pdf.

const md = vi.hoisted(() => ({
  trusted: vi.fn(async (src: string) => `<p data-trusted="1">${src.length} chars</p>`),
  sanitised: vi.fn(async (src: string) => `<p data-sanitised="1">${src.length} chars</p>`)
}))

vi.mock('../../app/utils/renderMarkdown', () => ({
  renderTrustedMarkdown: md.trusted,
  renderMarkdown: md.sanitised
}))

interface PreviewOpts { html: Ref<string>, title: Ref<string>, docId: Ref<string>, language?: Ref<string> }
const preview = vi.hoisted(() => ({ opts: null as PreviewOpts | null }))
mockNuxtImport('usePagedPreview', () => (opts: PreviewOpts) => {
  preview.opts = opts
  return { pageCount: ref(1), isPaginating: ref(false), isReady: ref(true), error: ref(null) }
})

// A controllable IntersectionObserver.
const io = vi.hoisted(() => ({ callbacks: [] as Array<(entries: Array<{ isIntersecting: boolean }>) => void> }))
class FakeIntersectionObserver {
  constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    io.callbacks.push(cb)
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const created = vi.hoisted(() => ({ bodies: [] as Array<Record<string, unknown>>, pdfQueries: [] as Array<Record<string, unknown>>, pdfStatus: 200 }))
registerEndpoint('/api/docs', {
  method: 'POST',
  handler: async (event) => {
    const { readBody } = await import('h3')
    created.bodies.push(await readBody(event))
    return { docId: 'doc123' }
  }
})
registerEndpoint('/api/docs/doc123/pdf', async (event) => {
  const { getQuery, createError } = await import('h3')
  created.pdfQueries.push(getQuery(event))
  if (created.pdfStatus !== 200) throw createError({ statusCode: created.pdfStatus, message: 'nope' })
  return { url: 'https://s3.example.test/renders/doc123/document.pdf' }
})

const SOURCE = '# Field notes\n\nSome **Markdown**.\n'

function setConfig(patch: Partial<InstanceConfig>): void {
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, ...patch }
}

function enterViewport(): void {
  for (const cb of io.callbacks) cb([{ isIntersecting: true }])
}

async function mountLive(route?: string) {
  const wrapper = await mountSuspended(TryIt, route ? { props: { source: SOURCE }, route } : { props: { source: SOURCE } })
  enterViewport()
  await flushPromises()
  await vi.waitFor(() => expect(wrapper.find('[data-testid="try-it-live"]').exists()).toBe(true))
  return wrapper
}

function editorView(wrapper: Awaited<ReturnType<typeof mountLive>>): EditorView {
  const el = wrapper.find('.cm-editor').element
  if (!(el instanceof HTMLElement)) throw new Error('no editor')
  const view = EditorView.findFromDOM(el)
  if (!view) throw new Error('no view')
  return view
}

// The workbench is a lazy chunk (CodeMirror + the preview). Its first
// import compiles it in the test runner, which under a full parallel run
// can take longer than `vi.waitFor`'s second — load it once up front so
// the tests time the mount, not the compile.
beforeAll(async () => {
  await import('~/components/marketing/TryItWorkbench.vue')
}, 30_000)

beforeEach(() => {
  io.callbacks = []
  md.trusted.mockClear()
  md.sanitised.mockClear()
  preview.opts = null
  created.bodies = []
  created.pdfQueries = []
  created.pdfStatus = 200
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  setConfig({ anonGate: false, anonDocTtlDays: 30 })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('::try-it before it is used', () => {
  it('renders the committed source statically through the trusted renderer, without an editor', async () => {
    const wrapper = await mountSuspended(TryIt, { props: { source: SOURCE } })
    const fallback = wrapper.find('[data-testid="try-it-static"]')
    expect(fallback.exists()).toBe(true)
    expect(fallback.text()).toContain('# Field notes')
    expect(wrapper.find('[data-trusted="1"]').exists()).toBe(true)
    expect(md.trusted).toHaveBeenCalledWith(SOURCE)
    expect(wrapper.find('[data-testid="try-it-live"]').exists()).toBe(false)
    expect(wrapper.find('.cm-editor').exists()).toBe(false)
    expect(preview.opts).toBeNull()
    wrapper.unmount()
  })
})

describe('::try-it lazy mount', () => {
  it('mounts the editor + preview once the block nears the viewport', async () => {
    const wrapper = await mountLive()
    expect(wrapper.find('[data-testid="try-it-static"]').exists()).toBe(false)
    expect(wrapper.find('.cm-editor').exists()).toBe(true)
    // No document behind the preview: no file token is ever fetched.
    expect(preview.opts?.docId.value).toBe('')
    wrapper.unmount()
  })

  it('also mounts when the visitor clicks "Edit this example"', async () => {
    const wrapper = await mountSuspended(TryIt, { props: { source: SOURCE } })
    await wrapper.find('[data-testid="try-it-start"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.cm-editor').exists()).toBe(true))
    wrapper.unmount()
  })
})

describe('::try-it visitor input', () => {
  it('goes through the sanitising renderer into the preview, never through the trusted one', async () => {
    const wrapper = await mountLive()
    const view = editorView(wrapper)
    const evil = '\n<img src=x onerror=alert(1)>\n'
    view.dispatch({ changes: { from: view.state.doc.length, insert: evil } })
    await flushPromises()

    const typed = `${SOURCE}${evil}`
    await vi.waitFor(() => expect(md.sanitised).toHaveBeenCalledWith(typed))
    for (const call of md.trusted.mock.calls) expect(call[0]).not.toContain('onerror')
    expect(md.trusted.mock.calls.every(call => call[0] === SOURCE)).toBe(true)
    await vi.waitFor(() => expect(preview.opts?.html.value).toBe(`<p data-sanitised="1">${typed.length} chars</p>`))
    expect(preview.opts?.title.value).toBe('Field notes')
    wrapper.unmount()
  })
})

describe('::try-it actions', () => {
  it('says plainly that the actions create a document, and for how long', async () => {
    const wrapper = await mountLive()
    expect(wrapper.find('[data-testid="try-it-notice"]').text()).toContain('30 days without edits')
    wrapper.unmount()
  })

  it('"Open as a document" creates the document with the text, then opens it', async () => {
    const router = useRouter()
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined)
    const wrapper = await mountLive()
    await wrapper.find('[data-testid="try-it-open"]').trigger('click')
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/d/doc123'))
    expect(created.bodies).toEqual([{ content: SOURCE, title: 'Field notes', language: 'en' }])
    wrapper.unmount()
  })

  it('on a translated page the preview and the created document take the page\'s language', async () => {
    vi.spyOn(useRouter(), 'push').mockResolvedValue(undefined)
    // The marketing-pages middleware lets /de/… through on the marketing site only.
    setConfig({ anonGate: false, anonDocTtlDays: 30, marketingSite: true })
    const wrapper = await mountLive('/de/markdown-to-pdf')
    expect(preview.opts?.language?.value).toBe('de')
    await wrapper.find('[data-testid="try-it-open"]').trigger('click')
    await vi.waitFor(() => expect(created.bodies).toHaveLength(1))
    expect(created.bodies[0]).toMatchObject({ language: 'de' })
    wrapper.unmount()
  })

  it('"Download PDF" creates the document, asks the PDF route for JSON and downloads; same text → same document', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const hrefs: string[] = []
    click.mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(this.href)
    })
    const wrapper = await mountLive()
    await wrapper.find('[data-testid="try-it-pdf"]').trigger('click')
    await vi.waitFor(() => expect(hrefs).toEqual(['https://s3.example.test/renders/doc123/document.pdf']))
    expect(created.pdfQueries).toEqual([{ response: 'json' }])

    await wrapper.find('[data-testid="try-it-pdf"]').trigger('click')
    await vi.waitFor(() => expect(hrefs).toHaveLength(2))
    expect(created.bodies).toHaveLength(1)
    wrapper.unmount()
  })

  it('a refused PDF shows a clear message and a link to the created document', async () => {
    created.pdfStatus = 429
    const wrapper = await mountLive()
    await wrapper.find('[data-testid="try-it-pdf"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="try-it-error"]').exists()).toBe(true))
    const error = wrapper.find('[data-testid="try-it-error"]')
    expect(error.text()).toContain('Too many PDFs')
    expect(error.find('a').attributes('href')).toBe('/d/doc123')
    wrapper.unmount()
  })
})
