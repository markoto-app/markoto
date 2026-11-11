import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5'

// Second line of defence for a published page's stored HTML. The print
// page already renders markdown through DOMPurify and the page is served
// with a CSP that runs no script; this pass makes sure that a bypass of
// the first line still cannot put anything ACTIVE into the snapshot that
// the CSP does not cover — above all `<meta http-equiv="refresh">` (a
// redirect to anywhere) and `<base>` (re-pointing every relative URL).
//
// It runs on Chromium's own serialisation of the rendered DOM, through a
// spec-compliant HTML parser (parse5), so what is removed here is exactly
// what a browser would build from the stored text — no regular
// expressions over markup.

type Node = DefaultTreeAdapterMap['node']
type ParentNode = DefaultTreeAdapterMap['parentNode']
type Element = DefaultTreeAdapterMap['element']

/** Elements whose presence alone acts (navigation, embedding, submission) — dropped with their content. */
const DROPPED_ELEMENTS = new Set([
  'script', 'noscript', 'meta', 'base', 'link', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'portal', 'fencedframe'
])

/** Attributes that turn ordinary elements into navigation or submission targets. */
const DROPPED_ATTRIBUTES = new Set(['formaction', 'action', 'http-equiv', 'srcdoc', 'ping'])

function isElement(node: Node): node is Element {
  return 'tagName' in node
}

function hasChildren(node: Node): node is ParentNode & Node {
  return 'childNodes' in node
}

function clean(parent: ParentNode): void {
  parent.childNodes = parent.childNodes.filter(child => !(isElement(child) && DROPPED_ELEMENTS.has(child.tagName.toLowerCase())))
  for (const child of parent.childNodes) {
    if (isElement(child)) {
      child.attrs = child.attrs.filter((a) => {
        const name = a.name.toLowerCase()
        return !name.startsWith('on') && !DROPPED_ATTRIBUTES.has(name)
      })
      // <template> keeps its children in a separate fragment.
      if (child.tagName === 'template') {
        const content = (child as Element & { content?: ParentNode }).content
        if (content) clean(content)
      }
    }
    if (hasChildren(child)) clean(child)
  }
}

export function sanitizeSnapshotHtml(html: string): string {
  const fragment = parseFragment(html)
  clean(fragment)
  return serialize(fragment)
}
