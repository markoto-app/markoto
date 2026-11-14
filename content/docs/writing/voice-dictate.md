---
title: Speak instead of typing
description: Live dictation streams what you say into the editor as you say it, and lands in the document like typed text.
category: writing
order: 3
featured: true
updated: '2026-11-02'
---

# Speak instead of typing

Click the mic in the toolbar (or the Dictate tab on mobile) and markoto
writes what you say into the document while you speak. Words appear at the
cursor as faint text first and become regular text once a sentence is
recognised. Works on desktop and on mobile.

Live dictation needs a **Mistral** transcription provider: your own Mistral
key under [Settings → AI provider](/docs/ai/provider) (transcription), or an
instance default the operator set up with Mistral. Without it the microphone
button is hidden. (The microphone in the AI prompt bar is different: it turns
a spoken *prompt* into text for the AI and works with any transcription
provider you connect.)

The walkthrough below was recorded with a simulated microphone and a
stand-in speech recogniser that always hears the same two sentences; the
real feature transcribes what you actually say.

::flow{id="speak-instead-of-typing" hide-title}
::

## What just happened

You clicked the toolbar mic and your browser asked for microphone permission
(granted automatically in the walkthrough). Audio then streamed to the
server, which relayed it to the speech model and sent back words as they were
recognised. Final words are inserted into the shared document the same way a
keyboard would, so collaborators see them live and undo works as usual.

## Limits and safety

- **One session per person.** While dictation is running in one tab, starting it in another tab is refused ("Another dictation session is already active"); stop the first one, then start again.
- **A session lasts at most 10 minutes**; start it again to keep going.
- **It stops after 30 seconds of silence**, so you don't burn transcription time on a forgotten microphone.
- Audio is streamed, not stored. On your own Mistral key, Mistral bills your account by the minute; if the operator pays, minutes use [AI Points](/docs/plans/ai-budget).
- Safari can't record in a format the transcription service accepts, so voice input isn't available there yet.

## What's next

- [Ask the AI to extend what you dictated](/docs/ai/prompt-bar): voice in, AI out.
- [Tell the AI who you're writing for](/docs/ai/document-context): the AI's output follows your audience and language settings.
