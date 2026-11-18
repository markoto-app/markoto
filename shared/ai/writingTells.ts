// Signs of machine-written prose that AI output must not contain: the
// em-dash and a short list of English words and phrases that are rare in
// human writing but frequent in model output. Checks AI-written text in
// tests and flows against the rules in `server/utils/agentic/writingStyle.ts`.
//
// The list keeps to words with few legitimate uses in documents ("robust",
// "landscape" or "leverage" stay out: a technical text may need them), so a
// hit is worth looking at rather than noise.

const EM_DASH = '\u2014'

/** Label returned for an em-dash hit. */
export const EM_DASH_TELL = 'em-dash (U+2014)'

/** Stem → pattern; the stem is what a hit reports. Inflected forms match. */
const AI_VOCABULARY: ReadonlyArray<readonly [string, RegExp]> = [
  ['delve', /\bdelv(?:e|es|ed|ing)\b/i],
  ['tapestry', /\btapestr(?:y|ies)\b/i],
  ['testament', /\btestament to\b/i],
  ['pivotal', /\bpivotal\b/i],
  ['underscore', /\bunderscor(?:e|es|ed|ing)\b/i],
  ['showcase', /\bshowcas(?:e|es|ed|ing)\b/i],
  ['vibrant', /\bvibrant\b/i],
  ['meticulous', /\bmeticulous(?:ly)?\b/i],
  ['intricate', /\bintricate(?:ly)?\b/i],
  ['seamless', /\bseamless(?:ly)?\b/i],
  ['realm', /\brealms?\b/i],
  ['garner', /\bgarner(?:s|ed|ing)?\b/i],
  ['bolster', /\bbolster(?:s|ed|ing)?\b/i],
  ['valuable insights', /\bvaluable insights?\b/i],
  ['in conclusion', /\bin conclusion\b/i],
  ['i hope this helps', /\bi hope this helps\b/i]
]

/**
 * The AI-writing tells found in `text`, each reported once, in list order
 * (the em-dash first). Empty when the text is clean.
 */
export function findAiWritingTells(text: string): string[] {
  const hits: string[] = []
  if (text.includes(EM_DASH)) hits.push(EM_DASH_TELL)
  for (const [stem, pattern] of AI_VOCABULARY) {
    if (pattern.test(text)) hits.push(stem)
  }
  return hits
}
