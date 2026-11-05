import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SCENE_HEIGHT_VH,
  TOUR_SCENE_IDS,
  coverRange,
  loopFrameAt,
  restOffsetVh,
  srcsetFor,
  stageSideKeyframes,
  windowToCover,
  type TourManifest
} from '../../shared/tour/manifest'
import { parseTourManifest } from '../../shared/tour/schema'

// Product tour (WP11): the asset contract (posters + looping videos per
// scene, light/dark, desktop/phone) and the scroll math behind the CSS.

const root = fileURLToPath(new URL('../../', import.meta.url))
const manifestPath = `${root}public/tour/manifest.json`

function committed(): TourManifest {
  const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return parseTourManifest(raw)
}

const img = (src: string) => ({ src, width: 1920, height: 1200 })
const vid = (base: string) => ({ av1: `${base}.av1.mp4`, h264: `${base}.h264.mp4`, width: 1728, height: 1080 })

function minimal(): TourManifest {
  return {
    version: 2,
    viewport: { w: 1440, h: 900 },
    scenes: [
      {
        id: 'write',
        poster: { light: img('/tour/light/write/poster-1920.webp'), dark: img('/tour/dark/write/poster-1920.webp') },
        video: { light: vid('/tour/light/write/video'), dark: vid('/tour/dark/write/video') },
        duration: 16,
        focus: { x: 720, y: 120, w: 720, h: 600 },
        phone: {
          poster: { light: img('/tour/light/write/phone-poster-1080.webp'), dark: img('/tour/dark/write/phone-poster-1080.webp') },
          video: { light: vid('/tour/light/write/phone'), dark: vid('/tour/dark/write/phone') }
        }
      },
      { id: 'cta' }
    ]
  }
}

describe('tour manifest validation', () => {
  it('accepts the committed public/tour/manifest.json, scenes in page order', () => {
    expect(committed().scenes.map(s => s.id)).toEqual([...TOUR_SCENE_IDS])
  })

  it('every asset the committed manifest names exists under public/', () => {
    const m = committed()
    const paths = m.scenes.flatMap(s => [
      ...(s.poster ? [s.poster.light, s.poster.dark].flatMap(i => [i.src, ...(i.srcset ?? []).map(v => v.src)]) : []),
      ...(s.video ? [s.video.light, s.video.dark].flatMap(v => [v.h264, ...(v.av1 ? [v.av1] : [])]) : []),
      ...(s.phone?.video ? [s.phone.video.light, s.phone.video.dark].flatMap(v => [v.h264, ...(v.av1 ? [v.av1] : [])]) : []),
      ...(s.beats ?? []).flatMap(b => b.pages.map(p => p.src))
    ])
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) expect(existsSync(`${root}public${p}`), p).toBe(true)
  })

  it('accepts a well-formed manifest', () => {
    expect(() => parseTourManifest(minimal())).not.toThrow()
  })

  it('rejects remote or traversing asset paths', () => {
    for (const src of ['https://evil.example/x.mp4', '//evil.example/x.mp4', '/tour/../../etc/passwd', 'tour/x.mp4']) {
      const m = minimal()
      const scene = m.scenes[0]
      if (!scene?.video) throw new Error('fixture')
      scene.video.light.h264 = src
      expect(() => parseTourManifest(m), src).toThrow(/Invalid tour manifest/)
    }
  })

  it('rejects structural mistakes', () => {
    const noPoster = minimal()
    if (noPoster.scenes[0]) delete noPoster.scenes[0].poster
    expect(() => parseTourManifest(noPoster)).toThrow(/poster/)

    const noDuration = minimal()
    if (noDuration.scenes[0]) delete noDuration.scenes[0].duration
    expect(() => parseTourManifest(noDuration)).toThrow(/duration/)

    const outside = minimal()
    if (outside.scenes[0]) outside.scenes[0].focus = { x: 1400, y: 0, w: 100, h: 10 }
    expect(() => parseTourManifest(outside)).toThrow(/outside/)

    const dup = minimal()
    dup.scenes.push({ id: 'cta' })
    expect(() => parseTourManifest(dup)).toThrow(/duplicate/)

    expect(() => parseTourManifest({ ...minimal(), scenes: [{ id: 'nope' }] })).toThrow()
    expect(() => parseTourManifest({ ...minimal(), version: 1 })).toThrow()
  })

  it('a pages beat needs pages and a time range', () => {
    const m = minimal()
    const scene = m.scenes[0]
    if (!scene?.poster) throw new Error('fixture')
    scene.beats = [{ id: 'sharePdf', t: [0.5, 1], pages: [scene.poster.light, scene.poster.dark] }]
    expect(() => parseTourManifest(m)).not.toThrow()
    scene.beats = [{ id: 'sharePdf', t: [0.9, 0.5], pages: [scene.poster.light, scene.poster.dark] }]
    expect(() => parseTourManifest(m)).toThrow(/empty time range/)
  })
})

describe('scroll math', () => {
  it('a scroll-snap rest marker puts the scene window at t', () => {
    // Resting on the marker: scroll = sectionTop + offset. The section's
    // cover progress there must equal the CSS window position of t.
    for (const t of [0, 0.25, 0.5, 0.8]) {
      const offset = restOffsetVh(t)
      const progress = (offset + 100) / (SCENE_HEIGHT_VH + 100) * 100
      expect(progress).toBeCloseTo(windowToCover(t), 2)
    }
    expect(restOffsetVh(0.5)).toBe(SCENE_HEIGHT_VH / 2 - 50)
  })

  it('cover ranges: the window starts with the section top at mid-viewport', () => {
    expect(windowToCover(0, 150)).toBeCloseTo(20)
    expect(windowToCover(1, 150)).toBeCloseTo(80)
    expect(windowToCover(-10)).toBe(0)
    expect(windowToCover(10)).toBe(100)
    expect(coverRange(0, 1, 150)).toBe('cover 20% cover 80%')
    expect(coverRange(0, 1)).toBe(`cover ${Math.round((50 / (SCENE_HEIGHT_VH + 100)) * 10000) / 100}% cover ${Math.round(((50 + SCENE_HEIGHT_VH) / (SCENE_HEIGHT_VH + 100)) * 10000) / 100}%`)
  })

  it('stage side keyframes alternate right / left around every scene boundary', () => {
    const css = stageSideKeyframes('mk-sides', 3, 'var(--flip)', { heroVh: 100, sceneVh: 100, glideVh: 10 })
    expect(css.startsWith('@keyframes mk-sides {')).toBe(true)
    const stops = [...css.matchAll(/([\d.]+)% \{ translate: ([^;]+); \}/g)].map(m => ({ at: Number(m[1]), to: m[2] }))
    // 0%, two stops per boundary (2 boundaries), 100%.
    expect(stops).toHaveLength(6)
    expect(stops.map(s => s.to)).toEqual(['0 0', '0 0', 'var(--flip) 0', 'var(--flip) 0', '0 0', '0 0'])
    // Track = 100 + 3 × 100 = 400vh; cover length 500vh; boundary 1 at 200vh → (200 ± 10 + 50) / 500.
    expect(stops[1]?.at).toBeCloseTo(48)
    expect(stops[2]?.at).toBeCloseTo(52)
    for (let i = 1; i < stops.length; i++) expect(stops[i]?.at ?? 0).toBeGreaterThanOrEqual(stops[i - 1]?.at ?? 0)
  })

  it('looping videos: frames advance at the frame rate, then hold the last one', () => {
    expect(loopFrameAt(0, 24, 12, 2000)).toBe(0)
    expect(loopFrameAt(500, 24, 12, 2000)).toBe(6)
    expect(loopFrameAt(1999, 24, 12, 2000)).toBe(23)
    expect(loopFrameAt(3000, 24, 12, 2000)).toBe(23)
    expect(loopFrameAt(4000, 24, 12, 2000)).toBe(0)
    expect(loopFrameAt(100, 1, 12, 0)).toBe(0)
  })
})

describe('images', () => {
  it('srcset lists every width once, smallest first', () => {
    expect(srcsetFor({ src: '/a-2x.webp', width: 2880, height: 1800, srcset: [{ src: '/a-m.webp', width: 960 }, { src: '/a-1x.webp', width: 1440 }] }))
      .toBe('/a-m.webp 960w, /a-1x.webp 1440w, /a-2x.webp 2880w')
  })
})

describe('tour alt text', () => {
  it('every scene with a picture and every beat has translated alt text in every locale', () => {
    const m = committed()
    const keys = [
      ...m.scenes.filter(s => s.poster).map(s => s.id),
      ...m.scenes.flatMap(s => s.beats?.map(b => b.id) ?? [])
    ]
    expect(keys.length).toBeGreaterThan(0)
    for (const locale of ['en', 'de', 'fr', 'es', 'ja', 'zh']) {
      const messages: unknown = JSON.parse(readFileSync(`${root}i18n/locales/${locale}.json`, 'utf8'))
      const tour: unknown = typeof messages === 'object' && messages !== null ? Reflect.get(messages, 'tour') : null
      const alt: unknown = typeof tour === 'object' && tour !== null ? Reflect.get(tour, 'alt') : null
      for (const key of keys) {
        const text: unknown = typeof alt === 'object' && alt !== null ? Reflect.get(alt, key) : null
        expect(typeof text === 'string' && text.length > 10, `${locale}: tour.alt.${key}`).toBe(true)
      }
    }
  })
})
