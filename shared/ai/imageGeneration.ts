// Image generation sizes and the price of a platform-paid image, shared by
// the server (`generate_image`, `POST /api/docs/:docId/images/generate`,
// `GET /api/ai/availability`) and the editor's "Generate image with AI"
// dialog.

/**
 * The sizes the dialog offers. Each stays within the `generate_image`
 * bounds (512-1536 px, multiples of 32) and at or below one megapixel, so
 * every size costs the same on the bundled FLUX deployment.
 */
export const IMAGE_SIZES = {
  square: { width: 1024, height: 1024 },
  landscape: { width: 1344, height: 768 },
  portrait: { width: 768, height: 1344 }
} as const

export const IMAGE_SIZE_NAMES = ['square', 'landscape', 'portrait'] as const satisfies ReadonlyArray<keyof typeof IMAGE_SIZES>
export type ImageSize = typeof IMAGE_SIZE_NAMES[number]

/** Longest prompt the tools accept. */
export const IMAGE_PROMPT_MAX_LENGTH = 2000

const ONE_MEGAPIXEL = 1024 * 1024

/**
 * USD per image of the image model aliases `deploy/config/litellm/config.yaml`
 * ships, by output size. BFL bills by size tier and reports the cost per
 * job; the proxy debits exactly that (`output_cost_per_token` × the
 * reported tokens). FLUX 3 Image Klein: $0.009 up to 1 MP, $0.014 above
 * (docs/AI-MODELS.md). An alias not listed here has no known price.
 */
const BUNDLED_IMAGE_PRICES_USD: Readonly<Record<string, (width: number, height: number) => number>> = {
  'flux-3-image-klein': (width, height) => (width * height <= ONE_MEGAPIXEL ? 0.009 : 0.014)
}

/** The image model aliases with a known price (pinned against the LiteLLM config by a unit test). */
export const PRICED_IMAGE_MODELS: readonly string[] = Object.keys(BUNDLED_IMAGE_PRICES_USD)

/**
 * What one platform-paid image of `width` × `height` costs on `model`
 * (a LiteLLM alias), in USD, or null when the price is not known.
 */
export function platformImagePriceUsd(model: string, width: number, height: number): number | null {
  const price = Object.hasOwn(BUNDLED_IMAGE_PRICES_USD, model) ? BUNDLED_IMAGE_PRICES_USD[model] : undefined
  return price ? price(width, height) : null
}
