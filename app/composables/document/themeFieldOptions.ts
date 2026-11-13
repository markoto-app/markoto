import type { DateFormat, DocTheme } from '~~/shared/types/theme'
import { isIsoDate } from '~~/shared/utils/documents/documentLocale'
import { coverDateFormat } from '~~/shared/utils/theme/themeOptions'

/**
 * Field bindings and option lists more than one section of the theme panel
 * uses. Optional theme fields are read through their defaults and written
 * only when the user changes them: opening the panel must not rewrite the
 * document's theme.
 */

// Weight names are words ("Light"), the number is the CSS value.
const WEIGHT_KEYS = {
  100: 'theme.fontWeight.thin',
  200: 'theme.fontWeight.extraLight',
  300: 'theme.fontWeight.light',
  400: 'theme.fontWeight.regular',
  500: 'theme.fontWeight.medium',
  600: 'theme.fontWeight.semibold',
  700: 'theme.fontWeight.bold',
  800: 'theme.fontWeight.extraBold',
  900: 'theme.fontWeight.black'
} as const

/** Font-weight items labelled "Light (300)"; `values` defaults to every weight. */
export function useFontWeightItems(values: ReadonlyArray<keyof typeof WEIGHT_KEYS> = [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
  const { t } = useI18n()
  return computed(() => values.map((value): { label: string, value: number } => ({ label: `${t(WEIGHT_KEYS[value])} (${value})`, value })))
}

/** Cover publication date (`YYYY-MM-DD`, '' = the render date). A native date input already speaks that format. */
export function useCoverDate(theme: Ref<DocTheme>) {
  return computed({
    get: () => theme.value.cover.date ?? '',
    set: (v: string) => {
      theme.value.cover.date = isIsoDate(v) ? v : ''
    }
  })
}

export function useCoverDateFormat(theme: Ref<DocTheme>) {
  const { t } = useI18n()
  const model = computed({
    get: () => coverDateFormat(theme.value),
    set: (v: DateFormat) => { theme.value.cover.dateFormat = v }
  })
  const items = computed<Array<{ label: string, value: DateFormat }>>(() => [
    { label: t('theme.cover.dateFormatLocale'), value: 'locale' },
    { label: t('theme.cover.dateFormatUs'), value: 'us' },
    { label: t('theme.cover.dateFormatIso'), value: 'iso' }
  ])
  return { model, items }
}
