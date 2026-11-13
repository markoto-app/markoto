import { THEME_FONTS } from '~~/shared/utils/theme/themeFonts'

// Font names the system prompts offer to the model, derived from the font
// registry so the prompts follow it when fonts are added or removed.
export const SERIF_FONTS = THEME_FONTS.filter(f => f.category === 'serif').map(f => f.name).join(', ')
export const SANS_FONTS = THEME_FONTS.filter(f => f.category === 'sans').map(f => f.name).join(', ')
