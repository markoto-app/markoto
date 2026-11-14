// HTML for the demo video's cards, the window frame around the footage
// and the poster: 1920×1080 pages in the brand type (Fraunces, Inter,
// JetBrains Mono from node_modules, as scripts/build-og-images.ts) and
// tokens (app/assets/css/main.css: sumi bone + ink, the shu seal).
//
// Every page defines `window.__render(t)`: it pauses all CSS animations at
// `t` seconds and types the terminal lines up to `t`, so build.ts can
// screenshot any instant deterministically (no screen recording, no
// timing jitter). `window.__end()` is the time after which nothing moves.

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHAPTER_COUNT, type Card, type TerminalLine } from './edl'

export const WIDTH = 1920
export const HEIGHT = 1080

/** Where the footage sits inside the window frame (1440×900 viewport at 1536×960). */
export const SCREEN = { x: 192, y: 80, w: 1536, h: 960 }

const C = {
  bg: '#FAF8F4',
  ink: '#14110D',
  soft: '#5F5C56',
  muted: '#7A7468',
  rule: '#EAE5D7',
  bar: '#F2EFE7',
  dot: '#D5CFC0',
  seal: '#B5371F',
  ok: '#3F6B45'
}

/** Background of every card and of the window frame (ffmpeg fades to it). */
export const BACKGROUND = C.bg

function esc(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** `*word*` → italic; every word its own span so it can be revealed. */
function revealWords(title: string, from: number, step = 0.085): { html: string, end: number } {
  let i = 0
  const html = title.split(/(\*[^*]+\*)/).filter(Boolean).map((chunk) => {
    const italic = chunk.startsWith('*')
    const words = (italic ? chunk.slice(1, -1) : chunk).split(/(\s+)/)
    const spans = words.map((w) => {
      if (/^\s+$/.test(w)) return ' '
      if (!w) return ''
      return `<span class="w" style="animation-delay:${(from + step * i++).toFixed(3)}s">${esc(w)}</span>`
    }).join('')
    return italic ? `<em>${spans}</em>` : spans
  }).join('')
  return { html, end: from + step * i + 0.7 }
}

function page(root: string, body: string, css = ''): string {
  const font = (p: string) => pathToFileURL(join(root, 'node_modules', p)).href
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="${font('@fontsource-variable/fraunces/opsz.css')}">
<link rel="stylesheet" href="${font('@fontsource-variable/fraunces/opsz-italic.css')}">
<link rel="stylesheet" href="${font('@fontsource-variable/inter/index.css')}">
<link rel="stylesheet" href="${font('@fontsource-variable/jetbrains-mono/index.css')}">
<style>
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: ${C.bg}; }
  body { position: relative; color: ${C.ink}; font-family: 'Inter Variable', sans-serif; -webkit-font-smoothing: antialiased; }
  .serif { font-family: 'Fraunces Variable', serif; font-optical-sizing: auto; font-weight: 300; letter-spacing: -0.025em; text-wrap: balance; }
  .serif em { font-style: italic; font-weight: 400; }
  /* No ligatures: "==>" stays three characters, as in a real terminal. */
  .mono { font-family: 'JetBrains Mono Variable', monospace; font-variant-ligatures: none; }
  .eyebrow { display: flex; align-items: center; gap: 18px; font-size: 27px; letter-spacing: 0.12em; text-transform: uppercase; color: ${C.soft}; }
  .seal { width: 22px; height: 22px; border-radius: 3px; background: ${C.seal}; flex: none; }
  .sub { font-size: 38px; line-height: 1.3; color: ${C.soft}; }
  .w { display: inline-block; animation: reveal 0.7s cubic-bezier(.2,.7,.2,1) both; }
  .fade { animation: fade 0.6s ease-out both; }
  .rise { animation: rise 0.7s cubic-bezier(.2,.7,.2,1) both; }
  @keyframes reveal { from { opacity: 0; filter: blur(14px); transform: translateY(12px); } to { opacity: 1; filter: none; transform: none; } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
  .colophon { position: absolute; left: 216px; right: 216px; top: 924px; height: 80px; border-top: 1.5px solid ${C.rule}; display: flex; align-items: center; justify-content: space-between; }
  .colophon img { height: 34px; display: block; margin-top: 4px; }
  .colophon .count { font-size: 27px; letter-spacing: 0.08em; color: ${C.soft}; }
${css}
</style></head>
<body>${body}
<script>
  window.__render = (t) => {
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000 }
    for (const el of document.querySelectorAll('[data-type]')) {
      const start = Number(el.dataset.start), cps = Number(el.dataset.cps), full = el.dataset.type
      const n = Math.max(0, Math.min(full.length, Math.floor((t - start) * cps)))
      el.textContent = full.slice(0, n)
    }
    for (const el of document.querySelectorAll('[data-show]')) {
      el.style.visibility = t >= Number(el.dataset.show) ? 'visible' : 'hidden'
    }
  }
  window.__end = () => Math.max(0, ...document.getAnimations().map(a => {
    const tm = a.effect.getComputedTiming(); return (tm.endTime || 0) / 1000
  }), ...[...document.querySelectorAll('[data-type]')].map(el => Number(el.dataset.start) + el.dataset.type.length / Number(el.dataset.cps)),
  ...[...document.querySelectorAll('[data-show]')].map(el => Number(el.dataset.show)))
</script>
</body></html>`
}

function colophon(root: string, n?: number): string {
  const logo = pathToFileURL(join(root, 'public/markoto-logos/primary-lockup-light.svg')).href
  const count = n ? `<span class="count mono">${String(n).padStart(2, '0')} / ${CHAPTER_COUNT}</span>` : ''
  return `<div class="colophon"><img src="${logo}" alt="">${count}</div>`
}

function eyebrow(n: number, label: string): string {
  return `<div class="eyebrow mono fade"><span class="seal"></span>${String(n).padStart(2, '0')} · ${esc(label)}</div>`
}

function chapter(root: string, card: Extract<Card, { type: 'chapter' }>): string {
  const title = revealWords(card.title, 0.15)
  return page(root, `
  <main style="position:absolute;left:216px;right:216px;top:0;bottom:156px;display:flex;flex-direction:column;justify-content:center;gap:34px">
    ${eyebrow(card.n, card.label)}
    <h1 class="serif" style="margin:0;font-size:132px;line-height:1.02">${title.html}</h1>
    <p class="sub rise" style="margin:0;animation-delay:${(title.end - 0.35).toFixed(2)}s">${esc(card.sub)}</p>
  </main>${colophon(root, card.n)}`)
}

function terminalLines(lines: TerminalLine[], start: number): string {
  const CPS = 55
  let t = start
  return lines.map((line) => {
    let html: string
    if (line.kind === 'cmd' || line.kind === 'cont') {
      const prompt = line.kind === 'cmd' ? `<span class="p">$</span> ` : ''
      html = `<div class="l" data-show="${t.toFixed(2)}">${prompt}<span data-type="${esc(line.text)}" data-start="${t.toFixed(2)}" data-cps="${CPS}"></span></div>`
      t += line.text.length / CPS + 0.12
    } else {
      const cls = line.kind === 'ok' ? 'ok' : line.kind === 'comment' ? 'c' : 'o'
      const text = line.kind === 'ok' ? `<span class="okk">ok</span>  ${esc(line.text)}` : esc(line.text)
      html = `<div class="l ${cls}" data-show="${t.toFixed(2)}">${text}</div>`
      t += 0.28
    }
    return html
  }).join('')
}

function terminal(root: string, card: Extract<Card, { type: 'terminal' }>): string {
  const title = revealWords(card.title, 0.15)
  return page(root, `
  <main style="position:absolute;left:200px;width:600px;top:0;bottom:156px;display:flex;flex-direction:column;justify-content:center;gap:30px">
    ${eyebrow(card.n, card.label)}
    <h1 class="serif" style="margin:0;font-size:100px;line-height:1.04">${title.html}</h1>
    <p class="sub rise" style="margin:0;font-size:34px;animation-delay:${(title.end - 0.35).toFixed(2)}s">${esc(card.sub)}</p>
  </main>
  <section class="term rise" style="animation-delay:0.25s">
    <header><i></i><i></i><i></i><span class="mono">terminal</span></header>
    <div class="body mono">${terminalLines(card.lines, 0.75)}</div>
  </section>${colophon(root, card.n)}`, `
  .term { position: absolute; left: 860px; top: 300px; width: 960px; min-height: 480px; background: #fff; border: 1.5px solid ${C.rule}; border-radius: 16px; box-shadow: 0 30px 80px rgba(20,17,13,.10); overflow: hidden; }
  .term header { height: 52px; background: ${C.bar}; display: flex; align-items: center; gap: 10px; padding: 0 24px; }
  .term header i { width: 13px; height: 13px; border-radius: 99px; background: ${C.dot}; }
  .term header span { margin-left: 16px; font-size: 26px; color: ${C.muted}; }
  .term .body { padding: 30px 34px; font-size: 26px; line-height: 1.68; white-space: pre; color: ${C.ink}; }
  .term .p { color: ${C.seal}; }
  .term .o, .term .c { color: ${C.soft}; }
  .term .okk { color: ${C.ok}; }`)
}

function hood(root: string, card: Extract<Card, { type: 'hood' }>): string {
  const title = revealWords(card.title, 0.1)
  const items = card.items.map((item, i) => `<li class="rise" style="animation-delay:${(0.9 + i * 0.8).toFixed(2)}s">${esc(item)}</li>`).join('')
  return page(root, `
  <main style="position:absolute;inset:0 0 120px 0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:56px">
    <h1 class="serif" style="margin:0;font-size:150px;line-height:1">${title.html}</h1>
    <ul class="mono">${items}</ul>
  </main>${colophon(root)}`, `
  ul { margin: 0; padding: 0; list-style: none; text-align: center; font-size: 32px; line-height: 1.9; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.soft}; }`)
}

function pdf(root: string, card: Extract<Card, { type: 'pdf' }>, pages: string[]): string {
  const imgs = pages.map((file, i) => {
    const rot = [-6, 0, 5][i] ?? 0
    const x = [-470, 0, 470][i] ?? 0
    const y = [40, -10, 50][i] ?? 0
    return `<img class="pg" src="${pathToFileURL(file).href}" style="--x:${x}px;--y:${y}px;--r:${rot}deg;z-index:${i === 1 ? 3 : 2 - Math.abs(i - 1)};animation-delay:${(0.05 + i * 0.12).toFixed(2)}s" alt="">`
  }).join('')
  return page(root, `
  <div class="stage">${imgs}</div>
  <p class="cap mono fade" style="animation-delay:0.6s">${esc(card.caption)}</p>`, `
  .stage { position: absolute; left: 50%; top: 470px; width: 0; height: 0; }
  .pg { position: absolute; width: 520px; left: -260px; top: -370px; background: #fff; box-shadow: 0 24px 60px rgba(20,17,13,.16); transform: translate(var(--x), var(--y)) rotate(var(--r)); animation: deal 0.8s cubic-bezier(.2,.7,.2,1) both; }
  @keyframes deal { from { opacity: 0; transform: translate(0, 140px) rotate(0deg) scale(.94); } to { opacity: 1; transform: translate(var(--x), var(--y)) rotate(var(--r)); } }
  .cap { position: absolute; left: 0; right: 0; top: 930px; margin: 0; text-align: center; font-size: 26px; letter-spacing: 0.16em; text-transform: uppercase; color: ${C.soft}; }`)
}

function claim(root: string, card: Extract<Card, { type: 'claim' }>): string {
  const title = revealWords(card.title, 0.2, 0.18)
  return page(root, `
  <main style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px">
    <h1 class="serif" style="margin:0;font-size:132px;line-height:1">${title.html}</h1>
    <p class="sub rise" style="margin:0;animation-delay:${(title.end - 0.2).toFixed(2)}s">${esc(card.sub)}</p>
  </main>`)
}

function end(root: string, card: Extract<Card, { type: 'end' }>): string {
  const logo = pathToFileURL(join(root, 'public/markoto-logos/primary-lockup-light.svg')).href
  const title = revealWords(card.title, 0.55, 0.16)
  return page(root, `
  <main style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
    <img class="fade" src="${logo}" style="height:96px;margin-bottom:64px" alt="">
    <h1 class="serif" style="margin:0;font-size:132px;line-height:1">${title.html}</h1>
    <p class="sub rise" style="margin:34px 0 0;animation-delay:${(title.end - 0.2).toFixed(2)}s">${esc(card.sub)}</p>
    <p class="mono rise" style="margin:56px 0 0;font-size:27px;letter-spacing:0.12em;text-transform:uppercase;color:${C.soft};animation-delay:${(title.end + 0.25).toFixed(2)}s">${esc(card.footer)}</p>
  </main>`)
}

/** A card page. `pdfPages`: the exported PDF's page images (pdf cards). */
export function cardHtml(root: string, card: Card, pdfPages: string[] = []): string {
  switch (card.type) {
    case 'chapter': return chapter(root, card)
    case 'terminal': return terminal(root, card)
    case 'hood': return hood(root, card)
    case 'pdf': return pdf(root, card, pdfPages)
    case 'claim': return claim(root, card)
    case 'end': return end(root, card)
  }
}

const WINDOW_CSS = `
  .win { position: absolute; left: ${SCREEN.x}px; top: ${SCREEN.y - 40}px; width: ${SCREEN.w}px; height: ${SCREEN.h + 40}px; border-radius: 14px; background: #fff; box-shadow: 0 40px 100px rgba(20,17,13,.13), 0 2px 6px rgba(20,17,13,.06); overflow: hidden; }
  .win header { height: 40px; background: ${C.bar}; display: flex; align-items: center; gap: 9px; padding: 0 20px; position: relative; }
  .win header i { width: 12px; height: 12px; border-radius: 99px; background: ${C.dot}; }
  .win header span { position: absolute; left: 50%; top: 7px; transform: translateX(-50%); height: 26px; padding: 0 34px; border-radius: 99px; background: ${C.bg}; font-size: 16px; line-height: 26px; color: ${C.soft}; }`

/** The browser window the footage plays in (the screen area stays white). */
export function windowHtml(root: string): string {
  return page(root, `<div class="win"><header><i></i><i></i><i></i><span class="mono">markoto.app</span></header></div>`, WINDOW_CSS)
}

/** The poster: claim + "watch" button beside the finished report in its window. */
export function posterHtml(root: string, poster: { title: string, body: string, action: string }, shot: string, minutes: number): string {
  const logo = pathToFileURL(join(root, 'public/markoto-logos/primary-lockup-light.svg')).href
  const title = poster.title.replace(/\*([^*]+)\*/g, (_m, w: string) => `<em>${esc(w)}</em>`)
  return page(root, `
  <main style="position:absolute;left:120px;top:0;bottom:0;width:640px;display:flex;flex-direction:column;justify-content:center;gap:44px">
    <img src="${logo}" style="height:60px;align-self:flex-start;margin-left:4px" alt="">
    <h1 class="serif" style="margin:0;font-size:118px;line-height:1.02">${title}</h1>
    <p class="sub" style="margin:0;width:540px;font-size:34px;line-height:1.45">${esc(poster.body)}</p>
    <div style="display:flex;align-items:center;gap:26px;margin-top:8px">
      <span style="width:84px;height:84px;border-radius:99px;background:${C.ink};display:grid;place-items:center">
        <svg width="30" height="34" viewBox="0 0 30 34"><path d="M2 2 L28 17 L2 32 Z" fill="${C.bg}"/></svg>
      </span>
      <span class="mono" style="font-size:25px;letter-spacing:0.12em;text-transform:uppercase">${esc(poster.action)} <span style="color:${C.soft}">· ${minutes} min</span></span>
    </div>
  </main>
  <div class="win" style="left:820px;top:130px;width:1440px;height:940px">
    <header><i></i><i></i><i></i><span class="mono">markoto.app</span></header>
    <img src="${pathToFileURL(shot).href}" style="display:block;width:1440px" alt="">
  </div>`, WINDOW_CSS)
}
