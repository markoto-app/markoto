---
title: Speak instead of typing
description: Live dictation streams what you say into the editor as you say it — same Y.js path as a typed character.
category: writing
order: 4
featured: true
---

# Speak instead of typing

Click the mic in the toolbar (or the Dictate tab on mobile) and markoto
streams what you say into the doc. Words land at the caret as you
speak — interim partials render as ghost text, finals commit as real
document content the moment the speech recognizer is confident.

This walkthrough uses a synthetic microphone fed into the test stack's
mock STT — the real flow uses Mistral Voxtral Realtime streaming.
Works on desktop and mobile.

::flow{id="speak-instead-of-typing" hide-title}
::

## What just happened

You clicked the toolbar mic. markoto:

1. Asked your browser for microphone permission (granted automatically
   here; the real app shows the system dialog).
2. Opened a WebSocket to `/api/ai/dictate`, authenticated with a 60-second
   JWT minted by `POST /api/ai/dictate/token`.
3. Started a `MediaRecorder` + audio worklet pipeline that captures
   128 ms PCM chunks at 16 kHz and posts them straight to the WS.
4. Voxtral Realtime streamed back interim transcripts (rendered as
   ghost text at your caret) and finals (committed into the Y.js
   document with origin `dictation:{userId}`).

The `dictation:{userId}` origin matters: undo / collaborator awareness
treats those edits the same as keyboard input. Your text is your text,
no matter how it got there.

## Limits + safety

- **30 minutes / day** of audio per user (`NUXT_DICTATE_DAILY_BUDGET_MS`,
  metered as audio-seconds, not request count).
- **One concurrent session per user** — opening the mic in a second tab
  closes the first.
- **30-second idle timeout** — if you stop speaking for 30 s the WS closes
  cleanly so you don't drain the daily budget on silence.
- The passphrase JWT in the first WS message — never on the URL — so the
  short-lived token doesn't leak into access logs.

## What's next

- [Ask the AI to extend what you dictated](/docs/writing/ai-prompt-bar) —
  voice in, AI out.
- [Tell the AI who you're writing for](/docs/writing/document-context) —
  the AI's output picks up your audience + language settings.
