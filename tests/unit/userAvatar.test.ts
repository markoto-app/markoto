import { describe, it, expect } from 'vitest'
import { Avatar, Style } from '@dicebear/core'
import moods from '@dicebear/styles/moods.json'
import {
  ANON_AVATAR_STORAGE_KEY,
  AVATAR_INK,
  POSITIVE_EYES,
  POSITIVE_MOUTHS,
  avatarColors,
  avatarOptions,
  avatarSeedFor,
  getAnonAvatarToken
} from '../../app/utils/userAvatar'
import { renderAvatarDataUri } from '../../app/utils/userAvatarRender'
import { AWARENESS_PALETTE } from '../../app/utils/colors'

function svgOf(uri: string): string {
  return decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''))
}

/** Which variant of a component the rendered SVG uses (ids look like
 *  `eyes-wink-<hash>`). */
function variantIn(svg: string, component: string): string | undefined {
  return new RegExp(`id="${component}-([A-Za-z]+)-`).exec(svg)?.[1]
}

class MemoryStorage {
  store = new Map<string, string>()
  getItem(k: string) {
    return this.store.get(k) ?? null
  }

  setItem(k: string, v: string) {
    this.store.set(k, v)
  }
}

describe('avatar seeds', () => {
  it('seeds signed-in users by id and anonymous visitors by their token, never colliding', () => {
    expect(avatarSeedFor({ id: 7 })).toBe('u-7')
    expect(avatarSeedFor({ id: null, avatarSeed: 'Ab3dEf6hIj9kLm2n' })).toBe('a-Ab3dEf6hIj9kLm2n')
    // An anonymous peer can't pick a token that renders as user 7.
    expect(avatarSeedFor({ avatarSeed: '7' })).not.toBe(avatarSeedFor({ id: 7 }))
    expect(avatarSeedFor({ id: null, fallback: 123 })).toBe('x-123')
    expect(avatarSeedFor({})).toBe('x-anonymous')
    // The id wins over a token.
    expect(avatarSeedFor({ id: 3, avatarSeed: 'zzz' })).toBe('u-3')
  })
})

describe('rendering', () => {
  it('is deterministic: same seed, same SVG', () => {
    expect(renderAvatarDataUri('u-42')).toBe(renderAvatarDataUri('u-42'))
    // Without the memo cache: two independent renders (as server and
    // another client would do) agree byte for byte.
    const fresh = () => new Avatar(new Style(moods), avatarOptions('u-42')).toDataUri()
    expect(fresh()).toBe(fresh())
    expect(fresh()).toBe(renderAvatarDataUri('u-42'))
    // Different seeds, different faces.
    expect(renderAvatarDataUri('u-1001')).not.toBe(renderAvatarDataUri('u-1002'))
    expect(svgOf(renderAvatarDataUri('u-1001')).startsWith('<svg')).toBe(true)
  })

  it('renders a self-contained data URI — no external references', () => {
    const svg = svgOf(renderAvatarDataUri('u-5'))
    expect(renderAvatarDataUri('u-5')).toMatch(/^data:image\/svg\+xml/)
    // Only same-document fragment hrefs (`#id`), no http(s) image loads.
    expect(svg).not.toMatch(/href="https?:/)
    expect(svg).not.toMatch(/url\((?!#)/)
  })

  it('uses only positive moods across many seeds', () => {
    const allEyes = Object.keys(moods.components.eyes.variants)
    const allMouths = Object.keys(moods.components.mouth.variants)
    // The allow-list only names variants the style actually has.
    for (const e of POSITIVE_EYES) expect(allEyes).toContain(e)
    for (const m of POSITIVE_MOUTHS) expect(allMouths).toContain(m)
    expect(POSITIVE_EYES).not.toContain('angry')
    expect(POSITIVE_MOUTHS).not.toContain('frown')

    const seenEyes = new Set<string>()
    for (let i = 0; i < 300; i++) {
      const svg = svgOf(renderAvatarDataUri(`u-${i}`))
      const eyes = variantIn(svg, 'eyes')
      const mouth = variantIn(svg, 'mouth')
      expect(POSITIVE_EYES as readonly string[]).toContain(eyes)
      expect(POSITIVE_MOUTHS as readonly string[]).toContain(mouth)
      if (eyes) seenEyes.add(eyes)
    }
    // Varied, not one face for everybody.
    expect(seenEyes.size).toBeGreaterThan(5)
  })

  it('animates, but the SVG switches the animation off under prefers-reduced-motion', () => {
    const svg = svgOf(renderAvatarDataUri('u-9'))
    const style = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] ?? ''
    const query = style.indexOf('@media (prefers-reduced-motion: no-preference){')
    expect(query).toBeGreaterThanOrEqual(0)
    // The keyframes and the animation declaration only exist inside it.
    expect(style.indexOf('@keyframes')).toBeGreaterThan(query)
    expect(style.indexOf('animation:')).toBeGreaterThan(query)
  })
})

describe('colours', () => {
  it('takes backgrounds from the paper palette, with dark sumi ink', () => {
    for (let i = 0; i < 50; i++) {
      const { background, face } = avatarColors(`u-${i}`)
      expect(AWARENESS_PALETTE).toContain(background)
      expect(face).toMatch(/^#[0-9a-f]{6}$/)
    }
    const opts = avatarOptions('u-1')
    expect(opts.inkColor).toBe(AVATAR_INK)
    expect(opts.backgroundColor).toBe(avatarColors('u-1').background)
  })

  it('never uses shu (the AI red)', () => {
    const shu = ['#b5371f', '#d14828']
    for (let i = 0; i < 200; i++) {
      const svg = svgOf(renderAvatarDataUri(`a-${i}`)).toLowerCase()
      for (const c of shu) expect(svg).not.toContain(c)
    }
  })
})

describe('anonymous avatar token', () => {
  it('is random, and stable for the rest of the session once stored', () => {
    const storage = new MemoryStorage()
    const first = getAnonAvatarToken(storage)
    expect(first).toMatch(/^[A-Za-z0-9]{16}$/)
    expect(storage.getItem(ANON_AVATAR_STORAGE_KEY)).toBe(first)
    expect(getAnonAvatarToken(storage)).toBe(first)
    // Another session (fresh storage) gets a different face.
    expect(getAnonAvatarToken(new MemoryStorage())).not.toBe(first)
  })

  it('replaces a malformed stored value', () => {
    const storage = new MemoryStorage()
    storage.setItem(ANON_AVATAR_STORAGE_KEY, '<script>')
    const token = getAnonAvatarToken(storage)
    expect(token).toMatch(/^[A-Za-z0-9]{16}$/)
    expect(storage.getItem(ANON_AVATAR_STORAGE_KEY)).toBe(token)
  })

  it('still works when storage throws or is unavailable', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    }
    expect(getAnonAvatarToken(broken)).toMatch(/^[A-Za-z0-9]{16}$/)
    expect(getAnonAvatarToken(null)).toMatch(/^[A-Za-z0-9]{16}$/)
  })
})
