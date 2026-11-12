import { describe, expect, it } from 'vitest'
import { encodeClip, LEVEL_SAMPLE_COUNT, silentLevels, takeClip } from '../../app/composables/ai/voiceCapture'

// The recorded clip of the prompt bar's voice input, before it is sent for
// transcription.

describe('voice clip', () => {
  it('has nothing to send without chunks', () => {
    expect(takeClip([], 'audio/webm')).toBe('noAudio')
  })

  it('refuses a near-empty recording and empties the chunks', () => {
    const chunks = [new Blob(['x'.repeat(100)])]
    expect(takeClip(chunks, 'audio/webm')).toBe('tooShort')
    expect(chunks).toHaveLength(0)
  })

  it('joins the chunks into one clip of the recorder type and encodes it as base64', async () => {
    const chunks = [new Blob(['a'.repeat(200)]), new Blob(['b'.repeat(200)])]
    const clip = takeClip(chunks, 'audio/webm')
    expect(clip).toBeInstanceOf(Blob)
    if (!(clip instanceof Blob)) return
    expect(clip.type).toBe('audio/webm')
    expect(clip.size).toBe(400)
    expect(chunks).toHaveLength(0)
    expect(atob(await encodeClip(clip) ?? '')).toBe('a'.repeat(200) + 'b'.repeat(200))
  })

  it('starts the waveform silent', () => {
    expect(silentLevels()).toEqual(new Array(LEVEL_SAMPLE_COUNT).fill(0))
  })
})
