# App design system

The look of the app shell (not of documents: document designs are theme presets, see [TEMPLATE-WORKFLOW.md](TEMPLATE-WORKFLOW.md)). The rules an AI agent must follow are in [`app/AGENTS.md`](../../app/AGENTS.md); this page explains the system behind them.

The product should read as a calm writing instrument on warm paper: few weights, few colours, background shifts instead of shadows.

## The seal is the AI

The small red square (the *seal*) is both the brand mark and the sign of AI presence. The Tailwind `primary` colour and the AI colour are the same: `shu` (vermillion). So `shu` means "markoto's AI is here", never "click this". Default buttons are `neutral` (`app/app.config.ts` sets the button default to `neutral`); `color="primary"` is only for controls that invoke the AI.

Surfaces that carry the seal: the wordmark, the AI prompt bar, the `@markoto` mention pill, the "AI is responding" indicator on comments, AI rows in the activity feed and the presence bar (bone disc + seal), the AI Points line on the pricing page, and `app/components/ai/Thinking.vue`.

The only "AI is working" animation is a one-colour shu pulse (`@keyframes mk-pulse`, used by `app/components/ai/AIPromptBar.vue`). Reuse it rather than adding gradients, rainbows or a sparkles icon.

## Tokens

Defined in `app/assets/css/main.css` (`@theme static`) and mapped in `app/app.config.ts`.

| Token | Values | Role |
|---|---|---|
| `shu-{50…950}` | 500 `#B5371F` (light), 400 `#D14828` (dark) | The seal, AI presence |
| `sumi-{50…950}` | warm grey ramp | Page, chrome, text, dividers |
| `--font-sans` | Inter | Body, UI labels, buttons; weights 400 and 500 only |
| `--font-mono` | JetBrains Mono | Eyebrows, meta labels, counts, timestamps, kbd hints |
| `--font-serif` | Fraunces | Wordmark, display and editorial titles, the AI's italic voice |

Use Nuxt UI's surface utilities rather than raw colours: `bg-default` for cards and working surfaces, `bg-muted` for the page and chrome (toolbar, sidebars, status bar, preview surround), `bg-elevated` for sub-fields and hover, `text-default` for body text, `text-muted` for captions. In dark mode `bg-muted` / `bg-elevated` resolve to flat sumi-950 because the dark lockup SVG has a sumi-950 background baked in; cards (`bg-default`) stay one step lighter so they remain visible.

## Typography

| Role | Font | Weight |
|---|---|---|
| Display headline (home, docs hero) | Fraunces | 300 / 400 |
| Editorial title (workspace name, doc title, panel headers) | Fraunces | 400 |
| Named object (cards, list rows, member names) | Fraunces | 400 |
| Body | Inter | 400 |
| UI label | Inter | 500 |
| Eyebrow / caption / colophon | JetBrains Mono, small, tracked | 400 |
| AI voice (`<AiThinking>`, the prompt bar input) | Fraunces italic | 400 |

Headings are sentence case. Italic is reserved for the AI voice and display emphasis; use `<strong>` (weight 500) for emphasis in prose.

## Brand components

- `app/components/common/Wordmark.vue` — the lockup. It renders the light and dark SVG variants together and switches them with CSS, so there is no hydration mismatch.
- `app/components/common/Seal.vue` — the square seal (`<CommonSeal :size="9">`).
- `app/components/ai/Thinking.vue` — the in-document AI indicator.

## Avatars

Every person is a DiceBear "Moods" face drawn in the browser (`app/components/common/UserAvatar.vue`, renderer `app/utils/collab/userAvatarRender.ts`, lazy-loaded). Provider profile pictures are never stored or loaded, and nothing is fetched from DiceBear's API. Seeds come from `avatarSeedFor()` (`app/utils/collab/userAvatar.ts`): signed-in users `u-<id>`, anonymous visitors a random per-tab token kept in session storage (`markoto-anon-avatar`) and broadcast through awareness. Colours come from the desaturated palette in `app/utils/collab/colors.ts`, which stays clear of shu. The AI keeps the seal disc.

## Overscroll colour

`html` paints sumi-50 in light mode and shu-400 in dark mode; that colour shows only in the rubber-band overscroll area (`app/assets/css/main.css`).
