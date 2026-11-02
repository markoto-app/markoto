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
 * Categorical palette led by the accent colour, for chart series and pie
 * slices. A report should look like its brand, not like a rainbow, so
 * the palette stays close to the accent: the accent itself, the heading
 * ink (when it is distinguishable from the accent), lighter and darker
 * steps of the accent, then neighbouring hues at the accent's lightness
 * and chroma, and the theme's neutral. Adjacent entries always differ in
 * lightness or hue enough to tell slices apart; entries too close to an
 * earlier one or to the page background are skipped.
 */
export function categoricalPalette(opts: {
  accent: string
  heading: string
  neutral: string
  background: string
  size?: number
  /** Cap every entry's OKLCH lightness (e.g. so white labels stay readable on it). */
  maxLightness?: number
}): string[] {
  const size = opts.size ?? 12
  const maxL = opts.maxLightness ?? 1
  const capped = (hex: string) => {
    const c = hexToOklch(hex)
    return c.l <= maxL ? hex : oklchToHex({ ...c, l: maxL })
  }
  const base = hexToOklch(opts.accent)
  // Keep generated hues in a lightness/chroma band that prints well on
  // white AND on dark paper.
  const l = Math.min(0.68, Math.max(0.42, base.l))
  const c = Math.min(0.16, Math.max(0.06, base.c))
  const shade = (dl: number, dh = 0, cScale = 1) =>
    oklchToHex({ l: Math.min(0.9, Math.max(0.25, l + dl)), c: c * cScale, h: (base.h + dh + 360) % 360 })
  const candidates = [
    opts.accent,
    opts.heading,
    shade(0.2, 0, 0.75),
    shade(0.02, 55),
    opts.neutral,
    shade(0.1, -55),
    shade(-0.12, 0),
    shade(0.18, 55, 0.8),
    shade(0.05, 150),
    shade(0.22, -55, 0.75),
    shade(-0.08, 100),
    shade(0.15, 150, 0.8),
    shade(-0.05, -110),
    shade(0.24, 100, 0.7)
  ]
  const out: string[] = []
  for (const raw of candidates) {
    if (out.length >= size) break
    const cand = capped(raw)
    if (oklabDistance(cand, opts.background) < 0.08) continue
    if (out.some(prev => oklabDistance(prev, cand) < 0.07)) continue
    out.push(cand)
  }
  // Pathological inputs (all colours equal): fill with lightness steps.
  for (let i = 0; out.length < size; i++) out.push(capped(shade(((i % 5) - 2) * 0.08, i * 30)))
  return out
}
