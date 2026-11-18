# AI loop benchmark: final-tools

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
| T6-formal-tone (step5) | Formal tone across the whole document | 21 | 40 | 2190k | 7885k | 105k | $0.4190 | $0.3330 | 719 s | error:turnLimit | no (turns: no, time: no) | 30 % / 11 % |
| T7-add-table (step5) | Add a table to chapter 2 | 3 | 2 | 107k | 384k | 127 | $0.0177 | $0.0054 | 4 s | done:done | yes | 100 % / 100 % |
| T4-translate-section (step8) | Translate section 9.2 (~1500 words) to French, delegated | 4 | 3 | 128k | 461k | 112 | $0.0212 | $0.0048 | 5 s | done:done | yes | 100 % / 100 % |
| T6-formal-tone (step8) | Formal tone across the whole document, delegated | 5 | 4 | 186k | 668k | 126 | $0.0307 | $0.0102 | 6 s | done:done | yes | 100 % / 100 % |
| **Total** | | 53 | 80 | 3365k | 12114k | 114k | $0.6182 | $0.4012 | | | | |

## Delegated jobs: modelled worker calls

The planner session above only previews, starts and reports a job; the job's worker calls run outside it. They are modelled with the pure job modules (`buildJobUnits`, `maskText`, `buildWorkerPrompt`: input = the exact worker prompt per unit, output = the unit's masked text) on the `markoto-worker` alias price (GLM-5.3 Flash: $0.165 / $0.033 cached / $0.55 per M), the system prompt and job part cached after a job's first call. Preview calls included.

| Task | Worker calls | Input tokens | Output tokens | Cost uncached | Cost cached prefix | Server estimate | Planner + worker (cached) |
|---|--:|--:|--:|--:|--:|---|--:|
| T4-translate-section (step8) | 3 | 10k | 4,851 | $0.0044 | $0.0039 | 2 units, $0.0034, 0.1 min | $0.0087 |
| T6-formal-tone (step8) | 99 | 353k | 174k | $0.1542 | $0.1331 | 97 units, $0.1794, 7.6 min | $0.1433 |

## Method and assumptions

- Tokens = characters / 3.6 (German prose on current BPE tokenizers; JSON and line-numbered tool output counted the same way). Characters are the message contents and tool-call names + JSON arguments of the OpenAI-shape request the loop would send (`internalToOpenAIMessages`), plus the tool declarations JSON (`internalToOpenAITools`); no per-message framing tokens.
- Input tokens are summed over every model call of the session (each call resends the whole history).
- Output tokens = characters of the emitted tool calls (name + JSON arguments) / 3.6. Reasoning tokens (GLM-5.3 Flash at `reasoning_effort: low`: 0 to ~130 per edit turn) and the closing turn's text are not counted.
- Prices: Z.ai GLM-5.3 Flash on Mistral's EU endpoint, the hosted chat default: $0.165 input, $0.033 cached input, $0.55 output per million tokens (`docs/AI-MODELS.md`, model table).
- "Cost cached prefix": the static prefix (system prompt + tools) of every call billed at the cached input price, everything else uncached. That matches the measured behaviour in `docs/AI-MODELS.md` (hits only on the prefix every user shares; the growing session history is rarely reused). Uncached = no hit at all (about a third of calls in production).
- Time: 1 s per model call plus output at 150 tokens/s; prefill time of the large input is NOT included, so real sessions take longer.
- Feasible = the script finished within MAX_TURNS (20) AND the estimated time is within the 5-minute session deadline. Progress = share of the task done when the session ended / by the deadline (T6: share of the document's characters rewritten).
- Scripts play a competent model with today's tools: read the whole document with `view_document`, then edit with `replace_text` (old_str copied from the view) / `insert_text` / `create_comment`. Rewrites (translation, tone) are same-length stand-ins.
