/**
 * Small colour toolkit for deriving document-matched palettes from a
 * theme's hex colours (Mermaid charts, see `mermaidConfig.ts`). Works in
 * OKLCH so lightness steps look even across hues; results are clamped
 * back into sRGB and always returned as `#rrggbb`.
 *
 * Pure and dependency-free: used by the browser (preview, print, server
 * render page) and by unit tests.
 */

interface Rgb { r: number, g: number, b: number }
export interface Oklch { l: number, c: number, h: number }

/** `#abc` / `#aabbcc` → 0..1 channels. Invalid input → black. */
export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m?.[1]) return { r: 0, g: 0, b: 0 }
  const full = m[1].length === 3 ? [...m[1]].map(ch => ch + ch).join('') : m[1]
  const n = Number.parseInt(full, 16)
  return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 }
}

function toHexByte(v: number): string {
  const n = Math.round(Math.min(1, Math.max(0, v)) * 255)
  return n.toString(16).padStart(2, '0')
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

export function hexToOklch(hex: string): Oklch {
  const { r, g, b } = hexToRgb(hex)
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const h = (Math.atan2(B, A) * 180) / Math.PI
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h }
}

function oklchToLinearRgb({ l: L, c, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180
  const A = c * Math.cos(hr)
  const B = c * Math.sin(hr)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  }
}

const inGamut = ({ r, g, b }: Rgb) => [r, g, b].every(v => v >= -1e-4 && v <= 1 + 1e-4)

/** OKLCH → hex, reducing chroma until the colour fits sRGB. */
export function oklchToHex(color: Oklch): string {
  let c = color.c
  let lin = oklchToLinearRgb({ ...color, c })
  for (let i = 0; i < 24 && !inGamut(lin); i++) {
    c *= 0.9
    lin = oklchToLinearRgb({ ...color, c })
  }
  return rgbToHex({ r: fromLinear(lin.r), g: fromLinear(lin.g), b: fromLinear(lin.b) })
}

/** Linear sRGB mix of `a` toward `b` (`t` = share of `b`, 0..1). */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  return rgbToHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t })
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/** WCAG contrast ratio between two colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `#fff` or the dark ink colour, whichever reads better on `bg`. */
export function readableOn(bg: string, dark: string): string {
  return contrastRatio(bg, '#ffffff') >= contrastRatio(bg, dark) ? '#ffffff' : dark
}

/** Perceptual distance in OKLab (≈0.02 is a just-noticeable step). */
export function oklabDistance(a: string, b: string): number {
  const x = hexToOklch(a)
  const y = hexToOklch(b)
  const ax = x.c * Math.cos((x.h * Math.PI) / 180)
  const ay = x.c * Math.sin((x.h * Math.PI) / 180)
  const bx = y.c * Math.cos((y.h * Math.PI) / 180)
  const by = y.c * Math.sin((y.h * Math.PI) / 180)
  return Math.hypot(x.l - y.l, ax - bx, ay - by)
}

/**
 * Lightness of `hex` once printed in greyscale: the OKLab lightness of
 * the grey with the same luminance (`cbrt(Y)`), 0 = black, 1 = white.
 * Two colours with the same value print as the same grey.
 */
export function greyLightness(hex: string): number {
  return Math.cbrt(relativeLuminance(hex))
}

/** The colour of hue `h` / chroma `c` whose greyscale lightness is `target` (OKLCH lightness found by bisection). */
export function colorAtGreyLightness(h: number, c: number, target: number): string {
  let lo = 0
  let hi = 1
  let best = oklchToHex({ l: target, c, h })
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    best = oklchToHex({ l: mid, c, h })
    if (greyLightness(best) < target) lo = mid
    else hi = mid
  }
  return best
}

/** Darkest generated chart colour (greyscale lightness); anchors (accent, heading ink) may sit lower. */
const PALETTE_MIN_GREY = 0.24
/** Anchors darker than this are too close to black to tell apart from the text. */
const ANCHOR_MIN_GREY = 0.18
/** Lightest generated colour when the caller sets no cap. */
const PALETTE_MAX_GREY = 0.8
/** Lightness levels the palette cycles through (a pie rarely has more slices). */
const LEVELS = 6
/** Neighbouring entries closer than this in greyscale don't count as "different" for anchoring the heading ink. */
const MIN_NEIGHBOUR_STEP = 0.12

/** Smallest greyscale gap between neighbours when the first `n` entries are drawn as a pie (the last slice touches the first). */
function minCyclicGap(levels: readonly number[], n: number): number {
  let min = Infinity
  for (let i = 0; i < n; i++) {
    const a = levels[i] ?? 0
    const b = levels[(i + 1) % n] ?? 0
    if (n > 2 || i === 0) min = Math.min(min, Math.abs(a - b))
  }
  return min
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]))
}

/** Lexicographic comparison of two score vectors (higher wins). */
function better(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (Math.abs(x - y) > 1e-9) return x > y
  }
  return false
}

/**
 * Order lightness levels so neighbouring slices differ as much as
 * possible for every slice count from 2 to `levels.length` (a chart with
 * n series uses the first n entries; in a pie the last touches the
 * first). `fixed` leading entries keep their place. First the smallest
 * gap over all counts (in 0.01 steps), then the counts in order — few
 * series are the common case — up to a gap that reads clearly (0.12).
 */
function orderLevels(fixed: readonly number[], free: readonly number[]): number[] {
  let best: number[] = [...fixed, ...free]
  let bestScore: number[] = []
  for (const perm of permutations(free)) {
    const order = [...fixed, ...perm]
    const gaps: number[] = []
    for (let n = 2; n <= order.length; n++) gaps.push(minCyclicGap(order, n))
    const score = [Math.floor(Math.min(...gaps) * 100), ...gaps.map(g => Math.min(g, 0.12)), gaps.reduce((x, y) => x + y, 0)]
    if (bestScore.length === 0 || better(score, bestScore)) {
      best = order
      bestScore = score
    }
  }
  return best
}

/** `count` more levels in [lo, hi], each placed in the widest remaining gap (1-D maximin). */
function fillLevels(taken: readonly number[], lo: number, hi: number, count: number): number[] {
  const added: number[] = []
  for (let k = 0; k < count; k++) {
    const pts = [...taken, ...added].map(v => Math.min(hi, Math.max(lo, v))).sort((a, b) => a - b)
    let bestAt = (lo + hi) / 2
    let bestGap = -1
    const consider = (at: number, gap: number) => {
      if (gap > bestGap + 1e-9) {
        bestGap = gap
        bestAt = at
      }
    }
    if (pts.length === 0) consider((lo + hi) / 2, hi - lo)
    else {
      consider(lo, (pts[0] ?? lo) - lo)
      consider(hi, hi - (pts[pts.length - 1] ?? hi))
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i] ?? lo
        const b = pts[i + 1] ?? hi
        consider((a + b) / 2, (b - a) / 2)
      }
    }
    added.push(bestAt)
  }
  return added
}

/**
 * Categorical palette led by the accent colour, for chart series and pie
 * slices. A report should look like its brand, not like a rainbow, so
 * the palette stays close to the accent: the accent itself, the heading
 * ink, the accent's hue lighter or darker, neighbouring hues and the
 * theme's neutral.
 *
 * Reports get printed in black and white, so entries differ in
 * LIGHTNESS as well as hue: the first six sit on six greyscale levels
 * spread over the usable range, ordered so neighbouring entries (and,
 * for a pie, the last and the first slice) are far apart for any number
 * of series. Entries 7–12 repeat the levels in further hues. The accent
 * keeps its exact colour; the heading ink too when it is clearly lighter
 * or darker than the accent, otherwise its hue is placed on a free level.
 */
export function categoricalPalette(opts: {
  accent: string
  heading: string
  neutral: string
  background: string
  size?: number
  /** Cap every entry's greyscale lightness (e.g. so white labels stay readable on it). */
  maxLightness?: number
}): string[] {
  const size = opts.size ?? 12
  const hi = Math.min(PALETTE_MAX_GREY, opts.maxLightness ?? 1)
  const lo = Math.min(PALETTE_MIN_GREY, hi - 0.1)
  const base = hexToOklch(opts.accent)
  // Generated hues keep a chroma that prints well on white and on dark paper.
  const c = Math.min(0.16, Math.max(0.06, base.c))
  const hueOf = (hex: string, fallback: number) => {
    const o = hexToOklch(hex)
    return o.c < 0.02 ? { h: fallback, c: o.c } : { h: o.h, c: Math.min(0.16, o.c) }
  }

  // Anchors: the accent (always first; re-lit only when it is too light
  // or too dark), then the heading ink when it stands apart from it.
  const accentGrey = greyLightness(opts.accent)
  const accentLevel = Math.min(hi, Math.max(ANCHOR_MIN_GREY, accentGrey))
  const accent = Math.abs(accentLevel - accentGrey) < 1e-3 ? rgbToHex(hexToRgb(opts.accent)) : colorAtGreyLightness(base.h, base.c, accentLevel)
  const headingGrey = greyLightness(opts.heading)
  const headingAnchored = headingGrey >= ANCHOR_MIN_GREY && headingGrey <= hi
    && Math.abs(headingGrey - accentLevel) >= MIN_NEIGHBOUR_STEP
    && oklabDistance(opts.heading, opts.background) >= 0.08
  const fixed = headingAnchored ? [accentLevel, headingGrey] : [accentLevel]
  // The levels span from the darkest anchor (or PALETTE_MIN_GREY) to the cap.
  const levels = orderLevels(fixed, fillLevels(fixed, Math.min(lo, ...fixed), hi, LEVELS - fixed.length))

  const heading = hueOf(opts.heading, (base.h + 30) % 360)
  const neutral = hueOf(opts.neutral, base.h)
  // Hue + chroma per slot after the anchors; lightness comes from `levels`.
  const slots: Array<{ h: number, c: number }> = [
    ...(headingAnchored ? [] : [heading]),
    { h: base.h, c: c * 0.75 },
    { h: (base.h + 55) % 360, c },
    { h: neutral.h, c: neutral.c },
    { h: (base.h + 305) % 360, c },
    { h: (base.h + 150) % 360, c },
    { h: (base.h + 100) % 360, c: c * 0.9 },
    { h: (base.h + 250) % 360, c },
    { h: (base.h + 55) % 360, c: c * 0.6 },
    { h: (base.h + 200) % 360, c: c * 0.8 },
    { h: base.h, c: c * 0.45 },
    { h: (base.h + 305) % 360, c: c * 0.6 },
    { h: (base.h + 150) % 360, c: c * 0.6 }
  ]
  const out: string[] = [accent]
  if (headingAnchored) out.push(rgbToHex(hexToRgb(opts.heading)))
  for (let i = 0; out.length < size; i++) {
    const slot = slots[i % slots.length] ?? { h: base.h, c }
    const level = levels[out.length % LEVELS] ?? (lo + hi) / 2
    out.push(colorAtGreyLightness(slot.h, slot.c, level))
  }
  return out
}
