# AI loop benchmark: baseline

Scripted-planner benchmark (`bun run bench:ai`, `tests/bench/ai/`): the real `runAgenticLoop` with a fake model whose tool calls are scripted per task, the real tool handlers on a Y.Doc holding the large fixture (`tests/e2e/fixtures/content/large-handbook/`). Every request the loop sends is measured.

Document: 81,757 words, 622,052 chars, 3,457 lines, about 172,792 tokens.

## Static prefix (sent with every request)

| Part | Chars | Tokens (est.) |
|---|--:|--:|
| System prompt (PROMPT_SYSTEM_PROMPT + document context) | 22,160 | 6,156 |
| Tool declarations (26 tools, OpenAI JSON) | 62,387 | 17,330 |
| Total | 84,547 | 23,486 |

## Tasks

| Task | What | Model calls | Tool calls | Input tokens | Input chars | Output tokens | Cost uncached | Cost cached prefix | Est. time | Outcome | Feasible | Progress (end / at 5 min) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|---|---|---|
| T1-review-chapter (baseline) | Review chapter 13, five comments | 3 | 6 | 428k | 1539k | 464 | $0.0708 | $0.0615 | 6 s | done:done | yes | 100 % / 100 % |
| T2-swap-chapters (baseline) | Swap chapters 4 and 5 | 3 | 3 | 486k | 1751k | 59k | $0.1128 | $0.1035 | 397 s | done:done | no (turns: yes, time: no) | 100 % / 0 % |
| T3-shorten-intro (baseline) | Shorten the introduction (chapter 1) | 3 | 2 | 437k | 1573k | 9,888 | $0.0775 | $0.0682 | 69 s | done:done | yes | 100 % / 100 % |
| T4-translate-section (baseline) | Translate section 9.2 (~1500 words) to French | 3 | 2 | 433k | 1560k | 6,337 | $0.0750 | $0.0657 | 45 s | done:done | yes | 100 % / 100 % |
| T5-rename-term (baseline) | Rename Kunde to Klient in all forms (40x) | 6 | 39 | 1059k | 3811k | 1,933 | $0.1757 | $0.1571 | 19 s | done:done | yes | 100 % / 100 % |
| T6-formal-tone (baseline) | Formal tone across the whole document | 20 | 20 | 4751k | 17102k | 104k | $0.8413 | $0.7793 | 716 s | error:turnLimit | no (turns: no, time: no) | 30 % / 11 % |
| T7-add-table (baseline) | Add a table to chapter 2 | 3 | 2 | 427k | 1539k | 124 | $0.0706 | $0.0613 | 4 s | done:done | yes | 100 % / 100 % |
| **Total** | | 41 | 74 | 8021k | 28875k | 182k | $1.4237 | $1.2966 | | | | |

## Method and assumptions

- Tokens = characters / 3.6 (German prose on current BPE tokenizers; JSON and line-numbered tool output counted the same way). Characters are the message contents and tool-call names + JSON arguments of the OpenAI-shape request the loop would send (`internalToOpenAIMessages`), plus the tool declarations JSON (`internalToOpenAITools`); no per-message framing tokens.
- Input tokens are summed over every model call of the session (each call resends the whole history).
- Output tokens = characters of the emitted tool calls (name + JSON arguments) / 3.6. Reasoning tokens (GLM-5.3 Flash at `reasoning_effort: low`: 0 to ~130 per edit turn) and the closing turn's text are not counted.
- Prices: Z.ai GLM-5.3 Flash on Mistral's EU endpoint, the hosted chat default: $0.165 input, $0.033 cached input, $0.55 output per million tokens (`docs/AI-MODELS.md`, model table).
- "Cost cached prefix": the static prefix (system prompt + tools) of every call billed at the cached input price, everything else uncached. That matches the measured behaviour in `docs/AI-MODELS.md` (hits only on the prefix every user shares; the growing session history is rarely reused). Uncached = no hit at all (about a third of calls in production).
- Time: 1 s per model call plus output at 150 tokens/s; prefill time of the large input is NOT included, so real sessions take longer.
- Feasible = the script finished within MAX_TURNS (20) AND the estimated time is within the 5-minute session deadline. Progress = share of the task done when the session ended / by the deadline (T6: share of the document's characters rewritten).
- Scripts play a competent model with today's tools: read the whole document with `view_document`, then edit with `replace_text` (old_str copied from the view) / `insert_text` / `create_comment`. Rewrites (translation, tone) are same-length stand-ins.
