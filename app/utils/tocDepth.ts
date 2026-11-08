/**
 * Drop the table-of-contents levels deeper than `theme.toc.maxDepth` from
 * the HTML (the renderer always emits h1–h4).
 *
 * They used to be hidden with `display: none`, but paged.js measures a
 * hidden list as overflowing: the TOC broke after the first entry that
 * had hidden children, leaving a near-empty page (a preset with TOC depth 2).
 * Removing the nodes avoids the measurement altogether.
 *
 * Works on parsed DOM (inert `<template>`) of sanitised markup;
 * `composeFinalHtml` sanitises the result again. Browser-only.
 */
export function pruneTocDepth(bodyHtml: string, maxDepth: number): string {
  if (maxDepth >= 4 || !bodyHtml.includes('table-of-contents')) return bodyHtml
  const tpl = document.createElement('template')
  tpl.innerHTML = bodyHtml
  const nested = ':scope > ul' + ' > li > ul'.repeat(maxDepth)
  let changed = false
  for (const nav of Array.from(tpl.content.querySelectorAll('.table-of-contents'))) {
    for (const ul of Array.from(nav.querySelectorAll(nested))) {
      ul.remove()
      changed = true
    }
  }
  if (!changed) return bodyHtml
  const wrap = document.createElement('div')
  wrap.append(tpl.content)
  return wrap.innerHTML
}
