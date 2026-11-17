# AI loop benchmark: step2

Scripted-planner benchmark (`bun run bench:ai`, `tests/bench/ai/`): the real `runAgenticLoop` with a fake model whose tool calls are scripted per task, the real tool handlers on a Y.Doc holding the large fixture (`tests/e2e/fixtures/content/large-handbook/`). Every request the loop sends is measured.

Document: 81,757 words, 622,052 chars, 3,457 lines, about 172,792 tokens.

## Static prefix (sent with every request)

| Part | Chars | Tokens (est.) |
|---|--:|--:|
| System prompt (PROMPT_SYSTEM_PROMPT; the document context opens the first user message) | 22,998 | 6,388 |
| Tool declarations (26 tools, OpenAI JSON) | 63,580 | 17,661 |
| Total | 86,578 | 24,049 |

## Tasks

| Task | What | Model calls | Tool calls | Input tokens | Input chars | Output tokens | Cost uncached | Cost cached prefix | Est. time | Outcome | Feasible | Progress (end / at 5 min) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|---|---|---|
| T1-review-chapter (step1) | Review chapter 13, five comments | 4 | 8 | 139k | 502k | 486 | $0.0233 | $0.0106 | 7 s | done:done | yes | 100 % / 100 % |
| T2-swap-chapters (step1) | Swap chapters 4 and 5 | 5 | 12 | 296k | 1065k | 59k | $0.0814 | $0.0655 | 400 s | done:done | no (turns: yes, time: no) | 100 % / 0 % |
| T3-shorten-intro (step1) | Shorten the introduction (chapter 1) | 4 | 3 | 132k | 475k | 9,899 | $0.0272 | $0.0145 | 70 s | done:done | yes | 100 % / 100 % |
| T4-translate-section (step1) | Translate section 9.2 (~1500 words) to French | 4 | 3 | 128k | 462k | 6,348 | $0.0247 | $0.0120 | 46 s | done:done | yes | 100 % / 100 % |
| T5-rename-term (step1) | Rename Kunde to Klient in all forms (40x) | 8 | 84 | 1305k | 4697k | 2,414 | $0.2166 | $0.1912 | 24 s | done:done | yes | 100 % / 100 % |
| T6-formal-tone (step1) | Formal tone across the whole document | 20 | 38 | 1921k | 6915k | 105k | $0.3745 | $0.3110 | 718 s | error:turnLimit | no (turns: no, time: no) | 30 % / 11 % |
| T7-add-table (step1) | Add a table to chapter 2 | 4 | 3 | 118k | 423k | 134 | $0.0195 | $0.0068 | 5 s | done:done | yes | 100 % / 100 % |
| **Total** | | 49 | 151 | 4039k | 14539k | 183k | $0.7671 | $0.6116 | | | | |

## Method and assumptions

- Tokens = characters / 3.6 (German prose on current BPE tokenizers; JSON and line-numbered tool output counted the same way). Characters are the message contents and tool-call names + JSON arguments of the OpenAI-shape request the loop would send (`internalToOpenAIMessages`), plus the tool declarations JSON (`internalToOpenAITools`); no per-message framing tokens.
- Input tokens are summed over every model call of the session (each call resends the whole history).
- Output tokens = characters of the emitted tool calls (name + JSON arguments) / 3.6. Reasoning tokens (GLM-5.3 Flash at `reasoning_effort: low`: 0 to ~130 per edit turn) and the closing turn's text are not counted.
- Prices: Z.ai GLM-5.3 Flash on Mistral's EU endpoint, the hosted chat default: $0.165 input, $0.033 cached input, $0.55 output per million tokens (`docs/AI-MODELS.md`, model table).
- "Cost cached prefix": the static prefix (system prompt + tools) of every call billed at the cached input price, everything else uncached. That matches the measured behaviour in `docs/AI-MODELS.md` (hits only on the prefix every user shares; the growing session history is rarely reused). Uncached = no hit at all (about a third of calls in production).
- Time: 1 s per model call plus output at 150 tokens/s; prefill time of the large input is NOT included, so real sessions take longer.
- Feasible = the script finished within MAX_TURNS (20) AND the estimated time is within the 5-minute session deadline. Progress = share of the task done when the session ended / by the deadline (T6: share of the document's characters rewritten).
- Scripts play a competent model with today's tools: read the whole document with `view_document`, then edit with `replace_text` (old_str copied from the view) / `insert_text` / `create_comment`. Rewrites (translation, tone) are same-length stand-ins.
