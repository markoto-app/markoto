/**
 * Text of the AI session error shown when the image provider is down
 * (`ai/image-provider-unavailable`). The loop ends the session with exactly
 * this message, the prompt bar exposes it as `data-last-outcome-message`
 * (the flow suite keys on it) and the client swaps it for the translated
 * registry text. `tests/unit/aiProviderOutage.test.ts` pins it to the English
 * text in `i18n/locales/errors/en.json`.
 */
export const IMAGE_PROVIDER_UNAVAILABLE_MESSAGE
  = 'The image provider is not available right now. Try again later.'
