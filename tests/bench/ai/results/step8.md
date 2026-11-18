# AI loop benchmark: step8

Scripted-planner benchmark (`bun run bench:ai`, `tests/bench/ai/`): the real `runAgenticLoop` with a fake model whose tool calls are scripted per task, the real tool handlers on a Y.Doc holding the large fixture (`tests/e2e/fixtures/content/large-handbook/`). Every request the loop sends is measured.

Document: 81,757 words, 622,052 chars, 3,457 lines, about 172,792 tokens.

## Static prefix (sent with every request)

| Part | Chars | Tokens (est.) |
|---|--:|--:|
| System prompt (PROMPT_SYSTEM_PROMPT; the document context opens the first user message) | 25,330 | 7,036 |
| Tool declarations (39 tools, OpenAI JSON) | 84,750 | 23,542 |
| Total | 110,080 | 30,578 |

## Tasks

| Task | What | Model calls | Tool calls | Input tokens | Input chars | Output tokens | Cost uncached | Cost cached prefix | Est. time | Outcome | Feasible | Progress (end / at 5 min) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|---|---|---|
| T1-review-chapter (step5) | Review chapter 13, five comments | 4 | 11 | 166k | 598k | 538 | $0.0277 | $0.0116 | 8 s | done:done | yes | 100 % / 100 % |
| T2-swap-chapters (step5) | Swap chapters 4 and 5 | 5 | 6 | 181k | 653k | 157 | $0.0300 | $0.0098 | 6 s | done:done | yes | 100 % / 100 % |
| T3-shorten-intro (step5) | Shorten the introduction (chapter 1) | 4 | 7 | 160k | 577k | 2,223 | $0.0277 | $0.0115 | 19 s | done:done | yes | 100 % / 100 % |
| T4-translate-section (step5) | Translate section 9.2 (~1500 words) to French | 3 | 2 | 106k | 381k | 6,346 | $0.0209 | $0.0088 | 45 s | done:done | yes | 100 % / 100 % |
| T5-rename-term (step5) | Rename Kunde to Klient in all forms (40x) | 4 | 5 | 131k | 473k | 152 | $0.0218 | $0.0056 | 5 s | done:done | yes | 100 % / 100 % |
| T6-formal-tone (step5) | Formal tone across the whole document | 21 | 40 | 2180k | 7848k | 105k | $0.4173 | $0.3325 | 719 s | error:turnLimit | no (turns: no, time: no) | 30 % / 11 % |
| T7-add-table (step5) | Add a table to chapter 2 | 3 | 2 | 105k | 378k | 127 | $0.0174 | $0.0053 | 4 s | done:done | yes | 100 % / 100 % |
| T4-translate-section (step8) | Translate section 9.2 (~1500 words) to French, delegated | 4 | 3 | 126k | 455k | 112 | $0.0209 | $0.0048 | 5 s | done:done | yes | 100 % / 100 % |
| T6-formal-tone (step8) | Formal tone across the whole document, delegated | 5 | 4 | 183k | 659k | 126 | $0.0303 | $0.0101 | 6 s | done:done | yes | 100 % / 100 % |
| **Total** | | 53 | 80 | 3339k | 12022k | 114k | $0.6140 | $0.4001 | | | | |

## Delegated jobs: modelled worker calls

The planner session above only previews, starts and reports a job; the job's worker calls run outside it. They are modelled with the pure job modules (`buildJobUnits`, `maskText`, `buildWorkerPrompt`: input = the exact worker prompt per unit, output = the unit's masked text) on the `markoto-worker` alias price (GLM-5.3 Flash: $0.165 / $0.033 cached / $0.55 per M), the system prompt and job part cached after a job's first call. Preview calls included.

| Task | Worker calls | Input tokens | Output tokens | Cost uncached | Cost cached prefix | Server estimate | Planner + worker (cached) |
|---|--:|--:|--:|--:|--:|---|--:|
| T4-translate-section (step8) | 5 | 13k | 3,779 | $0.0042 | $0.0033 | 4 units, $0.0041, 0.2 min | $0.0081 |
| T6-formal-tone (step8) | 218 | 561k | 173k | $0.1879 | $0.1420 | 216 units, $0.2241, 8.5 min | $0.1522 |

## Method and assumptions

- Tokens = characters / 3.6 (German prose on current BPE tokenizers; JSON and line-numbered tool output counted the same way). Characters are the message contents and tool-call names + JSON arguments of the OpenAI-shape request the loop would send (`internalToOpenAIMessages`), plus the tool declarations JSON (`internalToOpenAITools`); no per-message framing tokens.
- Input tokens are summed over every model call of the session (each call resends the whole history).
- Output tokens = characters of the emitted tool calls (name + JSON arguments) / 3.6. Reasoning tokens (GLM-5.3 Flash at `reasoning_effort: low`: 0 to ~130 per edit turn) and the closing turn's text are not counted.
- Prices: Z.ai GLM-5.3 Flash on Mistral's EU endpoint, the hosted chat default: $0.165 input, $0.033 cached input, $0.55 output per million tokens (`docs/AI-MODELS.md`, model table).
- "Cost cached prefix": the static prefix (system prompt + tools) of every call billed at the cached input price, everything else uncached. That matches the measured behaviour in `docs/AI-MODELS.md` (hits only on the prefix every user shares; the growing session history is rarely reused). Uncached = no hit at all (about a third of calls in production).
- Time: 1 s per model call plus output at 150 tokens/s; prefill time of the large input is NOT included, so real sessions take longer.
- Feasible = the script finished within MAX_TURNS (20) AND the estimated time is within the 5-minute session deadline. Progress = share of the task done when the session ended / by the deadline (T6: share of the document's characters rewritten).
- Scripts play a competent model with today's tools: read the whole document with `view_document`, then edit with `replace_text` (old_str copied from the view) / `insert_text` / `create_comment`. Rewrites (translation, tone) are same-length stand-ins.
