/* Layer 2 of Nuxt UI v4's three-layer theming: semantic mapping.
   Raw tokens (shu/sumi ramps, fonts) live in `app/assets/css/main.css`.
   Component slot overrides (button defaults, input/card surfaces) live
   in this file alongside the color mapping. */
export default defineAppConfig({
  ui: {
    colors: {
      // The seal. AI presence. Used by `color="primary"` on Nuxt UI
      // components: but note that buttons override their default
      // color to `neutral` below, so a "click me" button is sumi-950
      // (light) / sumi-50 (dark), NOT shu. Shu means AI, never CTA.
      primary: 'shu',
      neutral: 'sumi'
    },

    // The default Nuxt UI button is `color: 'primary'` which under our
    // mapping would paint every button shu. The brand reserves shu for
    // AI presence, so we flip the default to `neutral`. Components that
    // genuinely want the seal red (the AI tag, AI cursor surfaces) opt
    // in with an explicit `color="primary"`.
    button: {
      slots: {
        base: 'rounded font-medium tracking-tight'
      },
      defaultVariants: {
        size: 'md',
        color: 'neutral'
      }
    },

    input: {
      slots: {
        // Inputs sit one shade *down* from the page bg so they read as
        // recessed surfaces, not as raised cards. Page bg is sumi-50
        // (light) / sumi-950 (dark); input bg is sumi-100 (light) /
        // sumi-900 (dark): same as cards but with a tighter border.
        base: 'rounded'
      }
    },

    card: {
      slots: {
        root: 'rounded-lg'
      }
    },

    // Nuxt UI's page blocks (marketing pages) set their titles in bold
    // sans; the brand's titles are Fraunces at 300 (display) / 400
    // (named objects) and never go above 500.
    pageCTA: {
      slots: {
        title: 'font-serif font-light tracking-[-0.02em] text-default'
      }
    },
    pageCard: {
      slots: {
        title: 'font-serif font-normal tracking-[-0.01em] text-default'
      }
    },

    // Modals and dialogs share `Modal`. The backdrop is a warm sumi-950
    // tint at 45% rather than a cold black. The radius is one step up
    // from cards (rounded-xl = 12px) so they read as a layer above.
    modal: {
      slots: {
        overlay: 'bg-sumi-950/45',
        content: 'rounded-xl'
      }
    }
  }
})
