# AI models

Which models power markoto's AI features, why, and which models we recommend if you bring your own key. Last reviewed: 2026-10-26. All prices are public list prices in USD from the provider, and they change; check the provider before budgeting.

markoto routes every AI call through one gateway (LiteLLM), so each model below is a configuration choice, not a code dependency. The data path stays inside the EU: Mistral AI (Paris), Jina AI (Berlin), Staan (European Search Perspective SAS) and Black Forest Labs (EU-pinned endpoint).

## Models in use

| Feature | Model | List price | Notes |
|---|---|---|---|
| AI writing assistant (tool calling, vision) | Mistral Small 4 (`mistral-small-2603`) | $0.15 in / $0.60 out per M tokens (cached input $0.015) | 262K context, function calling, vision |
| Fallback when the primary is rate-limited | Ministral 3 8B (`ministral-8b-2512`) | $0.15 in / $0.15 out per M tokens | 262K context, function calling, vision |
| Voice prompt (one-shot transcription) | Voxtral Mini Transcribe 2 (`voxtral-mini-2602`) | $0.003 per audio minute | GA |
| Live dictation | Voxtral Mini Transcribe Realtime (`voxtral-mini-transcribe-realtime-2602`) | $0.006 per audio minute | GA, WebSocket streaming |
| Knowledge-base embeddings | Jina `jina-embeddings-v5-text-nano` | about $0.02-0.05 per M tokens (verify) | 768 dimensions, 8K context |
| Web page extraction | Jina Reader | billed in output tokens from a shared Jina balance | |
| Web search | Staan | no public rate card found | |
| Image generation | Black Forest Labs FLUX.2 [pro], EU endpoint | about $0.03 per 1024x1024 image | |

## Review findings and decisions

### Chat / agent model: keep Mistral Small 4

Sources: [Mistral models overview](https://docs.mistral.ai/getting-started/models/models_overview/), [Mistral pricing](https://docs.mistral.ai/inference/pricing), [Mistral changelog](https://docs.mistral.ai/getting-started/changelog/).

- Mistral Small 4 (v26.03) is still the current Small model and is not deprecated. Its predecessors (3.0, 3.1, 3.2) have all been retired.
- Alternatives from the same provider: Mistral Medium 3.5 ($1.50 / $7.50 per M tokens, 10x the input and 12.5x the output price) and Mistral Large 4 (Public Preview since 2026-10-06, $1.36 / $4.18, 1M context, reasoning output).
- We ran the same six-case, nine-tool function-calling check at temperature 0 against Small 4, Medium 3.5, Ministral 3 8B, 14B and 3B. All five picked the right tool with valid JSON arguments in every case. The one "miss" was the same on every model, and it was reasonable behaviour (read the document before editing). That check is small and is not a benchmark, but it gives no evidence that the 8-12x more expensive models would improve tool selection for our workload.
- Decision: keep Small 4. Revisit Medium 3.5 only if real-world agent quality (not price) becomes the bottleneck.
- Mistral Large 4 behaves differently: `temperature: 0` is rejected unless `top_p` is 1 (error 3054 "top_p must be 1 when using greedy sampling"), and message content comes back as a list of thinking and text blocks instead of a string. Our agent loop would need changes before using it.

### Fallback model: pin Ministral 3 8B

`ministral-8b-latest` is a moving alias. We now pin the dated id `ministral-8b-2512`. Price and capabilities are unchanged ($0.15 / $0.15). The older Ministral 8B (24.10) has been retired.

### One-shot transcription: pin Voxtral Mini Transcribe 2

- The id we used, `voxtral-mini-2507`, was retired on 2026-05-31. The API currently still accepts it but silently serves `voxtral-mini-latest` (we observed this live: the response reports `model: voxtral-mini-latest`). We now pin `voxtral-mini-2602` (Voxtral Mini Transcribe 2, GA, $0.003/min, identical price and response shape, `usage.prompt_audio_seconds` unchanged), so a future change to the alias cannot change our behaviour or billing.
- Newer: on 2026-10-20 Mistral released the Voxtral 3 family in Public Preview: Voxtral Mini Transcribe 3 ($0.0035/min), Voxtral Small Transcribe 3 ($0.004/min) and Voxtral Mini Transcribe Realtime 3 ($0.008/min, latency configurable from 80 ms to 2.4 s). All four ids answer on `/v1/audio/transcriptions` with the same response shape as Transcribe 2. On our one short English test clip all produced identical text, so there is no evidence of a quality gain for dictating prose, while the price is 17-33% higher and the models are 6 days old and in preview. Decision: stay on the GA Transcribe 2 models and re-evaluate once Voxtral 3 is GA.

### Live dictation: keep Voxtral Realtime (26-02)

We already use `voxtral-mini-transcribe-realtime-2602` through the Mistral SDK realtime client. Realtime 3 costs 33% more ($0.008 vs $0.006 per minute), is in preview, and Mistral does not document a protocol change. Decision: keep. The billing tick (`voxtral-realtime-tick`, $0.006 per 60 s) still matches the list price. If Realtime 3 is adopted later, update the tick price and verify the SDK accepts the new id.

### Embeddings: keep Jina v5 text nano

Source: [Jina embeddings](https://jina.ai/embeddings/). The v5 family is current. May 2026 added v5-omni models (multimodal: images, audio, video, PDF). `v5-omni-nano` is also 768-dimensional, but multimodal input is not used by markoto and switching models forces a re-embed of every stored chunk, so there is no reason to change. No deprecations are announced. The price in our config ($0.02 per M) could not be confirmed from Jina's own pages (third-party sources quote about $0.05 per M on paid top-ups), so treat spend estimates for embeddings as approximate.

### Page extraction and search: unchanged

Jina Reader and Staan are unchanged. We found no deprecation notices. Staan publishes no public rate card that we could find.

### Image generation: keep FLUX.2 [pro]

Source: [BFL pricing docs](https://docs.bfl.ai/quick_start/pricing). BFL has released FLUX 3 Image (around 2026-10-01) plus a Klein variant, with output up to 4K and multi-reference editing. We did not switch: the launch is three weeks old, prices we found came from secondary sources and include a temporary launch discount, and we could not confirm that FLUX 3 is served from the EU regional endpoint (`api.eu2.bfl.ai`), which is a hard requirement. FLUX.2 [pro] is still listed and not announced as retired. Revisit once BFL documents EU availability and a stable price.

## Recommended models for bring-your-own-key

markoto's agent exposes about 23 tools (document editing, theme, web, image, comments, knowledge search), so the model needs reliable multi-tool function calling at low temperature, ideally with vision. Context needs are modest (documents plus tool results, typically under 100K tokens).

Only the Mistral rows below were tested by us (six tool-selection prompts against nine tool definitions at `temperature: 0`). Everything else is based on provider listings and should be tried before you rely on it. Prices are approximate public list prices per million input / output tokens.

| Provider | Model | Tools | Vision | Context | Approx. price | Notes |
|---|---|---|---|---|---|---|
| Mistral | `mistral-small-2603` (Small 4) | Tested | Yes | 262K | $0.15 / $0.60 | Our default. Best value. |
| Mistral | `ministral-14b-2512` | Tested | Yes | 262K | $0.20 / $0.20 | Cheaper output, simpler answers |
| Mistral | `ministral-8b-2512` | Tested | Yes | 262K | $0.15 / $0.15 | Fallback tier |
| Mistral | `mistral-medium-3-5` | Tested | Yes | 262K | $1.50 / $7.50 | For harder writing/editing tasks |
| Mistral | `mistral-large-4` (preview) | Not usable at temperature 0 without `top_p: 1` | Yes | 1M | $1.36 / $4.18 | Returns reasoning blocks |
| OpenAI | GPT-5.5 | Listed | Yes | 1M | $5 / $30 | Per third-party pricing summary; verify |
| OpenAI | GPT-5.4 mini | Listed | Yes | not verified | $0.75 / $4.50 | Per third-party pricing summary; verify |
| OpenAI | GPT-5.4 nano | Listed | Yes | not verified | $0.20 / $1.25 | Per third-party pricing summary; verify |
| OpenRouter | `moonshotai/kimi-k3.1-pro` | Advertised for agent use | Yes | 1.05M | $2 / $10 | Not tested |
| OpenRouter | `minimax/minimax-m3.1-flash` | Advertised for agent use | Yes | 1.05M | $0.10 / $0.55 | Not tested |
| OpenRouter | `deepseek/deepseek-v4.1-flash-1017` | Advertised for agent use | Yes | 1.05M | $0.02 / $1 | Not tested |
| Local (Ollama / vLLM) | Mistral Small 4 (open weights, Apache 2.0) | Yes | Yes | 262K | free, needs a large GPU | Same behaviour as the hosted default |
| Local (Ollama / vLLM) | Ministral 3 14B / 8B (Apache 2.0) | Yes | Yes | 262K | free, fits a single consumer GPU | Quantised builds may weaken tool use |
| Local (Ollama / vLLM) | Qwen 3.6 family, GLM-5.1, Kimi K2.6 | Advertised | Varies | up to 262K | free, large GPU for the bigger ones | Not tested; check your server's tool-call parser |

Practical tips:

- Set temperature to 0 for the agent model. Some reasoning models reject it or require extra parameters.
- Local servers must expose an OpenAI-compatible `/v1/chat/completions` with tool calling enabled (for example vLLM's `--enable-auto-tool-choice` with the right parser). Without it the agent cannot call any tool.
- Models that return their reasoning as structured blocks instead of a plain string may need adapter support.
- Embeddings must stay at 768 dimensions unless the knowledge base is re-embedded; bring-your-own-key applies to the chat model only.

## Embeddings

Embeddings power the workspace knowledge base (uploaded files are chunked, embedded and searched with pgvector plus full-text search). They always go through the LiteLLM proxy.

- **Hosted markoto:** we provide the embeddings (Jina `jina-embeddings-v5-text-nano`, 768 dimensions), at no charge to users, and they cannot be changed by users. Nothing in this section applies to the hosted service.
- **Self-hosted:** the operator of the instance can choose any embedding model and its dimension with environment variables. Same code, only configuration differs. Embeddings are an operator-level setting, billed to whatever key you configure; they are unrelated to per-user bring-your-own-key for chat.

### Configuration

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `NUXT_LITELLM_EMBEDDINGS_MODEL` | app | `jina-embeddings-v5-text-nano` | LiteLLM model name the app asks for. Set to `custom-embeddings` to use your own provider. |
| `NUXT_LITELLM_EMBEDDINGS_DIMS` | app | `768` | Output size of the model. Integer, at most **2000**. |
| `EMBEDDINGS_UPSTREAM_MODEL` | LiteLLM | `openai/text-embedding-3-small` | Any LiteLLM model id: `openai/<name>` for OpenAI-compatible servers, `mistral/mistral-embed`, `ollama/nomic-embed-text`, ... Only used by `custom-embeddings`. |
| `EMBEDDINGS_UPSTREAM_API_BASE` | LiteLLM | `https://api.openai.com/v1` | Endpoint of the provider. |
| `EMBEDDINGS_UPSTREAM_API_KEY` | LiteLLM | empty | Provider key (empty for keyless local servers). |
| `NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS` | app | `auto` | `auto` / `true` / `false`. Whether to send the OpenAI `dimensions` parameter. `auto` = only for Jina models. |
| `NUXT_LITELLM_EMBEDDINGS_TASK_HINTS` | app | `auto` | `auto` / `true` / `false`. Whether to send Jina's `task` parameter. `auto` = only for Jina models. |

The three `EMBEDDINGS_UPSTREAM_*` variables are consumed by the LiteLLM container through `infra/litellm/config.yaml` (`custom-embeddings` entry, `os.environ/...` references), so no Python or YAML needs editing. The compose files give them placeholder defaults because the proxy refuses to start if a referenced variable is undefined. The compose files also forward `EMBEDDINGS_UPSTREAM_MODEL` to the app, where it only labels the stored version tag (`custom/openai/text-embedding-3-small:1536`) so that a later model change is detectable.

`dimensions` is off by default for non-Jina models on purpose: most models reject it (LiteLLM answers 400 for OpenAI-compatible models other than `text-embedding-3-*`). Turn it on only to shrink a model that supports reduced sizes, for example `text-embedding-3-large` at 1536. If the model's native output size already equals `NUXT_LITELLM_EMBEDDINGS_DIMS`, leave it off. In every case the app checks that the returned vector has exactly `NUXT_LITELLM_EMBEDDINGS_DIMS` entries and fails with a message naming the variable if not.

The 2000 limit is pgvector's maximum for an HNSW index on a `vector` column. Models with larger native output (for example `text-embedding-3-large` at 3072) need a reduced size via `SEND_DIMENSIONS=true` or are not usable.

### Examples

All go in `.env` (then restart the stack).

OpenAI `text-embedding-3-small`, native 1536 dimensions:

```
NUXT_LITELLM_EMBEDDINGS_MODEL=custom-embeddings
NUXT_LITELLM_EMBEDDINGS_DIMS=1536
EMBEDDINGS_UPSTREAM_MODEL=openai/text-embedding-3-small
EMBEDDINGS_UPSTREAM_API_KEY=sk-...
```

OpenAI `text-embedding-3-large` reduced to 1536:

```
NUXT_LITELLM_EMBEDDINGS_MODEL=custom-embeddings
NUXT_LITELLM_EMBEDDINGS_DIMS=1536
NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS=true
EMBEDDINGS_UPSTREAM_MODEL=openai/text-embedding-3-large
EMBEDDINGS_UPSTREAM_API_KEY=sk-...
```

Mistral `mistral-embed`, 1024 dimensions:

```
NUXT_LITELLM_EMBEDDINGS_MODEL=custom-embeddings
NUXT_LITELLM_EMBEDDINGS_DIMS=1024
EMBEDDINGS_UPSTREAM_MODEL=mistral/mistral-embed
EMBEDDINGS_UPSTREAM_API_BASE=https://api.mistral.ai/v1
EMBEDDINGS_UPSTREAM_API_KEY=...
```

Local Ollama `nomic-embed-text`, 768 dimensions, Ollama running on the Docker host:

```
NUXT_LITELLM_EMBEDDINGS_MODEL=custom-embeddings
NUXT_LITELLM_EMBEDDINGS_DIMS=768
EMBEDDINGS_UPSTREAM_MODEL=ollama/nomic-embed-text
EMBEDDINGS_UPSTREAM_API_BASE=http://host.docker.internal:11434
```

On Linux the LiteLLM service needs `extra_hosts: ["host.docker.internal:host-gateway"]` for that hostname to resolve. Any other OpenAI-compatible server (vLLM, llama.cpp, LocalAI) works with `openai/<served-name>` and its `/v1` base URL.

Jina (the default): leave all of the above unset, or set `NUXT_LITELLM_EMBEDDINGS_MODEL=jina-embeddings-v5-text-nano` explicitly. `JINA_AI_API_KEY` is required either way, because `fetch_url` uses Jina Reader.

The verified path: LiteLLM v1.106.4 resolves `os.environ/...` for `model`, `api_base` and `api_key`, forwards `dimensions` for `text-embedding-3-*`, and does not send it when the app leaves it out.

### What happens when you change the model or dimension

At startup, after migrations, the app compares the dimension of the knowledge vector column (default `vector(768)`) with `NUXT_LITELLM_EMBEDDINGS_DIMS`, under a Postgres advisory lock so several instances cannot race:

- **Same size:** nothing happens.
- **No vectors stored yet** (fresh install, or nothing was uploaded): the column is retyped and the HNSW index recreated in one transaction. A fresh self-hosted install just sets the variables and starts.
- **Vectors of another size are stored:** the app refuses to touch them. Only the knowledge features are disabled (uploads fail with the reason, `search_knowledge` reports it); the editor, sync, auth and AI keep working. The reason is logged, sent to Sentry and shown as `checks.embeddings` in `/api/health/deep`. It does not change `/api/health` or the overall status, so the instance is not taken out of rotation. The check re-runs about every ten seconds, so no restart is needed after the re-embed below.

Changing to a different model with the **same** dimension (say 768 to a different 768-d model) is not detected as a mismatch, because the column type is identical. Run the re-embed command anyway: vectors from different models are not comparable and search quality would be wrong. Each file stores a version tag (`provider/model:dims`); a changed model changes the tag, so the command re-embeds every file. The one case the tag cannot see is two different `custom-embeddings` models without `EMBEDDINGS_UPSTREAM_MODEL` reaching the app (the compose files forward it; a bare `bun run dev` does not). Then pass `--force` once.

### Re-embedding

After editing `.env` to the new model (and restarting so the app picks it up), run from a checkout of the repository on a machine that can reach Postgres and the LiteLLM proxy:

```
bun install
bun run knowledge:reembed -- --dry-run   # report what would change
bun run knowledge:reembed
```

The script reads the same variables as the app from the repo-root `.env` (`POSTGRES_*`, `NUXT_LITELLM_URL`, `NUXT_LITELLM_MASTER_KEY`, `NUXT_LITELLM_EMBEDDINGS_*`). In a typical compose deployment Postgres and LiteLLM are only reachable on the internal Docker network, so run it in a throwaway container attached to it:

```
docker run --rm --network <compose-project>_internal -v "$PWD":/app -w /app \
  --env-file .env -e POSTGRES_HOST=postgres -e NUXT_LITELLM_URL=http://litellm:4000 \
  oven/bun:1.4.4 sh -c "bun install --frozen-lockfile && bun run knowledge:reembed"
```

It takes the same advisory lock as the boot reconciliation, drops the HNSW index, retypes the column if the dimension changed (discarding the old vectors), re-embeds every chunk from its stored text file by file, and recreates the index at the end. It is resumable: if it stops (provider rate limit, network), run it again and it continues with the files still stale. Options: `--batch-size` (chunks per request group, default 50), `--concurrency` (parallel requests, default 5), `--pause-ms` (pause between groups, to stay under rate limits), `--force` (re-embed even files whose tag already matches; pass it once, never when resuming), `--dry-run`.

Expect one embeddings request per chunk (a chunk is about 800 characters, roughly 200 tokens). A knowledge base of 10,000 chunks is about 2 million tokens, which costs a few cents with hosted models (OpenAI `text-embedding-3-small` is $0.02 per million tokens at the time of writing, check your provider) and takes roughly 10 to 30 minutes at 5 parallel requests. Local models are free but bounded by your hardware. While it runs, knowledge search is degraded: files that are not re-embedded yet have no vectors (or vectors from the old model), and the index is missing until the end. Do not run it while a user is relying on knowledge search; the editor itself is unaffected.

## Sources

- Mistral models overview: https://docs.mistral.ai/getting-started/models/models_overview/
- Mistral pricing: https://docs.mistral.ai/inference/pricing
- Mistral changelog: https://docs.mistral.ai/getting-started/changelog/
- Voxtral Mini Transcribe 3: https://docs.mistral.ai/models/voxtral-mini-transcribe-3-0
- Voxtral Mini Transcribe Realtime 3: https://docs.mistral.ai/models/voxtral-mini-transcribe-realtime-3-0
- Mistral `/v1/models` (queried live 2026-10-26 for ids, context, capabilities)
- Jina embeddings: https://jina.ai/embeddings/
- Jina API pricing: https://jina.ai/api-dashboard/pricing
- BFL pricing docs: https://docs.bfl.ai/quick_start/pricing
- OpenRouter tool-calling listing: https://openrouter.ai/models?supported_parameters=tools&order=top-weekly
- Third-party OpenAI price summary: https://morphllm.com/openai-api-pricing
