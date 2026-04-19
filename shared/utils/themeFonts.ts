/**
 * Curated Google Fonts list shown in the theme editor's font pickers.
 * Kept small on purpose — every choice should look good as either body
 * or heading text in a paged document. Themes stored in the DB can
 * still reference any other Google Font name (the picker is just the UX
 * shortcut), but `themeValidation.isFontName` clamps it to safe chars.
 */

export type FontCategory = 'sans' | 'serif' | 'mono'

export interface ThemeFont {
  name: string
  category: FontCategory
}

export const THEME_FONTS: ThemeFont[] = [
  // Sans-serif — modern, neutral
  { name: 'Inter', category: 'sans' },
  { name: 'Roboto', category: 'sans' },
  { name: 'Open Sans', category: 'sans' },
  { name: 'Lato', category: 'sans' },
  { name: 'Source Sans 3', category: 'sans' },
  { name: 'IBM Plex Sans', category: 'sans' },
  { name: 'Work Sans', category: 'sans' },
  { name: 'Nunito', category: 'sans' },
  { name: 'DM Sans', category: 'sans' },
  { name: 'Karla', category: 'sans' },

  // Serif — readable for long-form
  { name: 'Source Serif 4', category: 'serif' },
  { name: 'Merriweather', category: 'serif' },
  { name: 'Playfair Display', category: 'serif' },
  { name: 'Lora', category: 'serif' },
  { name: 'PT Serif', category: 'serif' },
  { name: 'Crimson Text', category: 'serif' },
  { name: 'Libre Baskerville', category: 'serif' },
  { name: 'EB Garamond', category: 'serif' },
  { name: 'Cormorant Garamond', category: 'serif' },
  { name: 'IBM Plex Serif', category: 'serif' }
]
