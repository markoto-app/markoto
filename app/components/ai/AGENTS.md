# AI presence primitives + AIPromptBar

Seven components, two roles:

| Component | Role |
|---|---|
| `Cursor.vue` | The 2px shu caret — drops inline anywhere the AI's edit position is rendered OUTSIDE CodeMirror (status bar, awareness dot, comment thread). The in-document yCollab cursor is themed separately in the editor extension. |
| `Tag.vue` | The hot-stamp pill with the AI's name. Companion to `Cursor` for awareness UI. White-on-shu in both modes — the "hot stamp" feel is intentional. |
| `GutterMark.vue` | The shu vertical hairline rendered in the editor gutter for lines the AI has touched. Wired up via a CM6 line decoration that reads from awareness. |
| `Thinking.vue` | The italic-serif observational line. **The only place in the product Fraunces italic appears** — burning that scarcity is what makes the AI's voice land. |
| `AIPromptBar.vue` | The bottom-of-editor input. Renders the `is-active` shu pulse, the count chip from `useBilling`, voice-input toggle, send affordance. The whole state-machine for "AI is responding" lives here + in `useAI` (awareness for the public phase, the initiator's session channel for status text / answers / confirmations). |
| `AIConfirmPanel.vue` | The inline "markoto wants to read 'Q3 plan' — Allow / Deny" card above the prompt bar (taint gate, `server/utils/agentic/crossBoundary.ts`). Initiator only. The question is the AI voice (Fraunces italic, seal), the target is the exact title / query / URL, buttons are neutral, the border is shu. No answer within the server timeout = deny. |
| `WaveformVisualizer.vue` | The voice-input visualizer (live dictation + voice-prompt input). Pure SVG — no canvas, no audio analyser node leaking across teardown. |

## The "the seal IS the AI" contract — operational version

Every component above wears shu. Every component represents AI. There is no AI-related component in this repo that isn't shu, and no shu surface anywhere else in the app (with the explicit exception of the brand mark itself, which is the same seal). When tempted to introduce a new AI primitive:

1. Re-use one of these six. Multiple variants of the same primitive in different contexts always look incoherent.
2. If a new primitive is genuinely needed, add it HERE (not under another folder) and make it shu-by-default with no color prop. Compositional flexibility is for layout, not for "is this AI or not."

Lucide `i-lucide-sparkles` is **banned in user-facing AI chrome**. If you reach for it, you're missing one of the primitives above. Push back in code review.

## How they compose with awareness

The four in-document primitives (`Cursor`, `Tag`, `GutterMark`, `Thinking`) are driven by Y.js awareness state, NOT by props passed top-down through the editor tree. The contract:

- The AI joins the doc as a real Y.js client (see `server/utils/agentic/AGENTS.md`). Its awareness state has `{ user: { name, color, isAI: true }, aiSession: { sessionId, initiatorName, initiatorUserId, commentThreadId? }, aiStatus: { phase, message: null } }` — public fields only, because awareness reaches every participant. The prompt, the live status text, `message_to_user` answers and confirmation requests reach only the initiator, via `GET /api/ai/sessions/:id` polled by `useAI`. Never add session details to awareness.
- The editor's awareness watcher resolves `isAI === true` clients into shu rendering + the primitive components. Human collaborators (any `isAI !== true` awareness entry) render via the standard cool-slate yCollab path.
- `Thinking.vue` renders a text prop; for the initiator that text comes from their private channel, for everyone else only a generic "markoto is working…" (`ai.workingGeneric`) is available.

A consequence: a "fake AI cursor" can't be plumbed in by setting a prop. It has to come from a real awareness entry. This is intentional — it forces the awareness state to be the single source of truth for "where is the AI right now."

## AIPromptBar — the active-state animation

There is exactly ONE "AI is working" animation in the app: the `@keyframes mk-pulse` family on a fixed shadow. `AIPromptBar.vue` `.is-active` shell uses it. `CommentThread.vue` `.comment-thread-card.is-ai-active` uses the same keyframe (mirrored in `app/components/comments/`). If you need a third "AI is alive on this surface" indicator, reuse the same keyframes — don't introduce a violet/blue rainbow gradient. Earlier iterations all wore rainbows; they were ripped out for violating the seal-only rule.

## Voice-input + dictation

`AIPromptBar` is also the voice-input host. Two voice modes:

- **Voice prompt** (`useVoicePrompt`) — push-to-talk record → MediaRecorder → POST `/api/ai/transcribe` → text drops into the prompt input. One-shot.
- **Live dictation** (`useVoiceDictation`) — sustained streaming session → `WS /api/ai/dictate` → ghost text appears in CM6 via `dictationExtensions.ts`.

The two modes share the WaveformVisualizer + the same voice-mute affordance, but their state machines are separate and they cannot be active simultaneously. See `useVoiceDictation.ts` for the session-cap + Safari-incompatibility notes; the broader server-side context lives in `server/utils/agentic/AGENTS.md`.

## Cross-references

- Agentic loop, tool definitions, AI awareness joining: `server/utils/agentic/AGENTS.md`.
- Brand vocabulary + active-state rules: `app/AGENTS.md` (the parent design-system doc).
- Comment-thread AI integration (`@ai` mention trigger, `is-ai-active` pulse): `app/components/comments/`.
