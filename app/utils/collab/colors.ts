/**
 * Awareness color palette for live-collaboration cursors and presence
 * rings. Calibrated for the paper aesthetic — muted, low-chroma
 * pastels that sit naturally on the bone (sumi-50) page surface
 * without competing with the seal red.
 *
 * Each entry is a desaturated tone in the rough vicinity of a
 * recognizable hue family — sage, slate, rose, ochre, lavender, etc.
 * — so collaborators are still distinguishable, but the overall
 * surface stays calm. None of these get close to shu (vermillion)
 * since shu is reserved for AI presence; human collaborators must
 * never wear the seal red.
 */
export const AWARENESS_PALETTE: readonly string[] = [
  '#7A8C7E', // sage
  '#8C7E6B', // ochre / khaki
  '#9A7C7C', // dusty rose
  '#7E8B9A', // slate blue
  '#8C8AA0', // muted lavender
  '#A0967E', // sand
  '#7C928D', // celadon
  '#9C8E76', // tan
  '#8E8174', // taupe
  '#7E947C', // moss
  '#967C8C', // mauve
  '#8A998C', // pale moss
  '#A09480', // pale tan
  '#888CA0', // soft indigo
  '#A09480' // pale tan
]

export function pickColor(): string {
  // Non-null assertion is safe: the random index is always a valid palette
  // position. Typescript can't prove that from `array[number]`, hence `!`.
  return AWARENESS_PALETTE[Math.floor(Math.random() * AWARENESS_PALETTE.length)]!
}
