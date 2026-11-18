# AI loop benchmark: final

Scripted-planner benchmark (`bun run bench:ai`, `tests/bench/ai/`): the real `runAgenticLoop` with a fake model whose tool calls are scripted per task, the real tool handlers on a Y.Doc holding the large fixture (`tests/e2e/fixtures/content/large-handbook/`). Every request the loop sends is measured.

Document: 81,757 words, 622,052 chars, 3,457 lines, about 172,792 tokens.

## Static prefix (sent with every request)

| Part | Chars | Tokens (est.) |
|---|--:|--:|
| System prompt (PROMPT_SYSTEM_PROMPT; the document context opens the first user message) | 25,493 | 7,081 |
| Tool declarations (40 tools, OpenAI JSON) | 86,188 | 23,941 |
| Total | 111,681 | 31,022 |

## Tasks

| Task | What | Model calls | Tool calls | Input tokens | Input chars | Output tokens | Cost uncached | Cost cached prefix | Est. time | Outcome | Feasible | Progress (end / at 5 min) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|---|---|---|
| T1-review-chapter (step5) | Review chapter 13, five comments | 4 | 11 | 168k | 605k | 538 | $0.0280 | $0.0117 | 8 s | done:done | yes | 100 % / 100 % |
| T2-swap-chapters (final) | Swap chapters 4 and 5 | 5 | 6 | 184k | 662k | 154 | $0.0304 | $0.0100 | 6 s | done:done | yes | 100 % / 100 % |
| T3-shorten-intro (step5) | Shorten the introduction (chapter 1) | 4 | 7 | 162k | 584k | 2,223 | $0.0280 | $0.0116 | 19 s | done:done | yes | 100 % / 100 % |
| T4-translate-section (step5) | Translate section 9.2 (~1500 words) to French | 3 | 2 | 107k | 385k | 6,346 | $0.0212 | $0.0089 | 45 s | done:done | yes | 100 % / 100 % |
| T5-rename-term (step5) | Rename Kunde to Klient in all forms (40x) | 4 | 5 | 133k | 480k | 152 | $0.0221 | $0.0057 | 5 s | done:done | yes | 100 % / 100 % |
| T6-formal-tone (step5) | Formal tone across the whole document | 21 | 40 | 1768k | 6365k | 105k | $0.3493 | $0.2633 | 719 s | error:turnLimit | no (turns: no, time: no) | 30 % / 11 % |
| T7-add-table (step5) | Add a table to chapter 2 | 3 | 2 | 107k | 384k | 127 | $0.0177 | $0.0054 | 4 s | done:done | yes | 100 % / 100 % |
| T4-translate-section (step8) | Translate section 9.2 (~1500 words) to French, delegated | 4 | 3 | 128k | 461k | 112 | $0.0212 | $0.0048 | 5 s | done:done | yes | 100 % / 100 % |
| T6-formal-tone (step8) | Formal tone across the whole document, delegated | 5 | 4 | 186k | 668k | 126 | $0.0307 | $0.0102 | 6 s | done:done | yes | 100 % / 100 % |
| **Total** | | 53 | 80 | 2943k | 10594k | 114k | $0.5485 | $0.3315 | | | | |

## Delegated jobs: modelled worker calls

The planner session above only previews, starts and reports a job; the job's worker calls run outside it. They are modelled with the pure job modules (`buildJobUnits`, `maskText`, `buildWorkerPrompt`: input = the exact worker prompt per unit, output = the unit's masked text) on the `markoto-worker` alias price (GLM-5.3 Flash: $0.165 / $0.033 cached / $0.55 per M), the system prompt and job part cached after a job's first call. Preview calls included.

| Task | Worker calls | Input tokens | Output tokens | Cost uncached | Cost cached prefix | Server estimate | Planner + worker (cached) |
|---|--:|--:|--:|--:|--:|---|--:|
| T4-translate-section (step8) | 3 | 10k | 4,851 | $0.0044 | $0.0039 | 2 units, $0.0034, 0.1 min | $0.0087 |
| T6-formal-tone (step8) | 99 | 353k | 174k | $0.1542 | $0.1331 | 97 units, $0.1794, 7.6 min | $0.1433 |

## Before and after (baseline → this run)

Each task of this run against the same task in `results/baseline.json` (the tools before this branch: whole-document `view_document`, `replace_text` only). Worker = the modelled worker calls of a delegated job (uncached / cached prefix, section below); Total = planner (cached prefix) + worker (cached).

| Task | Model calls | Tool calls | Input tokens | Output tokens | Cost uncached | Cost cached prefix | Worker | Total (cached) | Feasible |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|
| T1-review-chapter (step5) | 3 → 4 | 6 → 11 | 428k → 168k | 464 → 538 | $0.0708 → $0.0280 | $0.0615 → $0.0117 | - | $0.0615 → $0.0117 | yes |
| T2-swap-chapters (final) | 3 → 5 | 3 → 6 | 486k → 184k | 59k → 154 | $0.1128 → $0.0304 | $0.1035 → $0.0100 | - | $0.1035 → $0.0100 | no → yes |
| T3-shorten-intro (step5) | 3 → 4 | 2 → 7 | 437k → 162k | 9,888 → 2,223 | $0.0775 → $0.0280 | $0.0682 → $0.0116 | - | $0.0682 → $0.0116 | yes |
| T4-translate-section (step5) | 3 | 2 | 433k → 107k | 6,337 → 6,346 | $0.0750 → $0.0212 | $0.0657 → $0.0089 | - | $0.0657 → $0.0089 | yes |
| T5-rename-term (step5) | 6 → 4 | 39 → 5 | 1059k → 133k | 1,933 → 152 | $0.1757 → $0.0221 | $0.1571 → $0.0057 | - | $0.1571 → $0.0057 | yes |
| T6-formal-tone (step5) | 20 → 21 | 20 → 40 | 4751k → 1768k | 104k → 105k | $0.8413 → $0.3493 | $0.7793 → $0.2633 | - | $0.7793 → $0.2633 | no |
| T7-add-table (step5) | 3 | 2 | 427k → 107k | 124 → 127 | $0.0706 → $0.0177 | $0.0613 → $0.0054 | - | $0.0613 → $0.0054 | yes |
| T4-translate-section (step8) | 3 → 4 | 2 → 3 | 433k → 128k | 6,337 → 112 | $0.0750 → $0.0212 | $0.0657 → $0.0048 | $0.0044 / $0.0039 | $0.0657 → $0.0087 | yes |
| T6-formal-tone (step8) | 20 → 5 | 20 → 4 | 4751k → 186k | 104k → 126 | $0.8413 → $0.0307 | $0.7793 → $0.0102 | $0.1542 / $0.1331 | $0.7793 → $0.1433 | no → yes |

## Method and assumptions

- Tokens = characters / 3.6 (German prose on current BPE tokenizers; JSON and line-numbered tool output counted the same way). Characters are the message contents and tool-call names + JSON arguments of the OpenAI-shape request the loop would send (`internalToOpenAIMessages`), plus the tool declarations JSON (`internalToOpenAITools`); no per-message framing tokens.
- Input tokens are summed over every model call of the session (each call resends the whole history).
- Output tokens = characters of the emitted tool calls (name + JSON arguments) / 3.6. Reasoning tokens (GLM-5.3 Flash at `reasoning_effort: low`: 0 to ~130 per edit turn) and the closing turn's text are not counted.
- Prices: Z.ai GLM-5.3 Flash on Mistral's EU endpoint, the hosted chat default: $0.165 input, $0.033 cached input, $0.55 output per million tokens (`docs/AI-MODELS.md`, model table).
- "Cost cached prefix": the static prefix (system prompt + tools) of every call billed at the cached input price, everything else uncached. That matches the measured behaviour in `docs/AI-MODELS.md` (hits only on the prefix every user shares; the growing session history is rarely reused). Uncached = no hit at all (about a third of calls in production).
- Time: 1 s per model call plus output at 150 tokens/s; prefill time of the large input is NOT included, so real sessions take longer.
- Feasible = the script finished within MAX_TURNS (20) AND the estimated time is within the 5-minute session deadline. Progress = share of the task done when the session ended / by the deadline (T6: share of the document's characters rewritten).
- Scripts play a competent model with today's tools: read the whole document with `view_document`, then edit with `replace_text` (old_str copied from the view) / `insert_text` / `create_comment`. Rewrites (translation, tone) are same-length stand-ins.
