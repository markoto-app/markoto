"""
Custom LiteLLM providers — Phase 0 spike.

Two custom providers proving we can extend LiteLLM in OSS to solve:
  1. FLUX.2 [pro] image generation (LiteLLM's BFL provider doesn't list it
     and flux-pro-1.1 itself is broken in v1.83.14).
  2. Voxtral Realtime voice-tick metering (pass-through cost_per_request is
     Enterprise-only; this fakes a billable LLM call so OSS budget enforcement
     applies to non-LLM ops too).

Both register via litellm_settings.custom_provider_map. Cost flows through
model_info.input_cost_per_token / output_cost_per_token in config.yaml.
"""

from __future__ import annotations

import asyncio
import base64
import os
import time
from typing import Any
from uuid import uuid4

import httpx
import litellm
from litellm import CustomLLM
from litellm.types.utils import (
    Choices,
    EmbeddingResponse,
    ImageResponse,
    ImageObject,
    Message,
    ModelResponse,
    Usage,
)


# -----------------------------------------------------------------------------
# Provider 1 — BFL FLUX.2 [pro], EU-pinned, polling-based
# -----------------------------------------------------------------------------

_BFL_EU = "https://api.eu2.bfl.ai"
_BFL_POLL_INTERVAL = 0.5
_BFL_POLL_TIMEOUT = 90.0
# BFL bills per credit; 1 credit ≈ $0.01 (FLUX.2 [pro] 1024² = 3 credits = $0.03)
_BFL_CREDIT_USD = 0.01


class BFLFluxProvider(CustomLLM):
    """BFL FLUX submission → poll → b64_json + url. EU-pinned to api.eu2.bfl.ai.

    Exposed via /v1/chat/completions (NOT /v1/images/generations) because OSS
    LiteLLM's aimage_generation path does not fire spend-logger callbacks, so
    spend never reaches the DB. The chat-completions path tracks spend via
    `usage` token counts × output_cost_per_token in config.

    Convention: caller sends a single user message whose JSON-encoded body is
    `{prompt, width?, height?, size?, prompt_upsampling?}`. Either pass
    `width` + `height` directly OR `size: "WxH"`. Default = 1024x1024.
    `prompt_upsampling` defaults to false because the prompt is AI-written
    and re-LLM-ing it adds latency without benefit. The response's
    `choices[0].message.content` is a JSON-encoded `{b64_json, url,
    cost_credits, cost_usd}`. Our app code (aiToolAdapter.ts:generateImageBytes)
    is the only consumer.
    """

    async def acompletion(  # type: ignore[override]
        self, *args, **kwargs
    ) -> ModelResponse:
        import json as _json

        model: str = kwargs.get("model", "bfl-flux/flux-2-pro")
        bfl_model = model.split("/", 1)[1] if "/" in model else model
        bfl_key = kwargs.get("api_key") or os.environ["BFL_API_KEY"]

        # Parse the request: single user message with JSON body.
        messages = kwargs.get("messages") or []
        if not messages:
            raise ValueError("BFL chat-style call requires at least one message")
        last = messages[-1]
        content = last.get("content", "")
        try:
            req = _json.loads(content) if isinstance(content, str) else content
        except _json.JSONDecodeError:
            req = {"prompt": content}
        prompt = req["prompt"]

        # Width / height resolution. Caller may pass them directly OR as
        # `size: "WxH"`. Direct fields win over `size`. Default 1024x1024.
        w = req.get("width")
        h = req.get("height")
        if w is None or h is None:
            size = req.get("size", "1024x1024")
            try:
                sw, sh = (int(x) for x in size.lower().split("x"))
                w = w if w is not None else sw
                h = h if h is not None else sh
            except Exception:
                w = w if w is not None else 1024
                h = h if h is not None else 1024
        w, h = int(w), int(h)

        # prompt_upsampling: default false. The prompt is AI-written, so
        # an LLM-side rewrite would add latency for no benefit. Caller can
        # override (mostly for ad-hoc admin / testing).
        prompt_upsampling = bool(req.get("prompt_upsampling", False))

        async with httpx.AsyncClient(timeout=30.0) as http:
            submit = await http.post(
                f"{_BFL_EU}/v1/{bfl_model}",
                headers={"x-key": bfl_key, "Content-Type": "application/json"},
                json={
                    "prompt": prompt,
                    "width": w,
                    "height": h,
                    "prompt_upsampling": prompt_upsampling,
                },
            )
            submit.raise_for_status()
            sub = submit.json()
            polling_url = sub["polling_url"]
            cost_credits = float(sub.get("cost") or 0.0)

            deadline = time.monotonic() + _BFL_POLL_TIMEOUT
            sample_url = None
            while time.monotonic() < deadline:
                pr = await http.get(polling_url, headers={"x-key": bfl_key})
                pr.raise_for_status()
                p = pr.json()
                status = p.get("status")
                if status == "Ready":
                    sample_url = p["result"]["sample"]
                    break
                if status in ("Error", "Content Moderated", "Failed"):
                    raise RuntimeError(f"BFL job ended with status={status}: {p}")
                await asyncio.sleep(_BFL_POLL_INTERVAL)
            if not sample_url:
                raise RuntimeError("BFL polling timed out after 90s")

            img = await http.get(sample_url)
            img.raise_for_status()
            b64 = base64.b64encode(img.content).decode()

        cost_usd = cost_credits * _BFL_CREDIT_USD
        # Map cost to completion_tokens via output_cost_per_token in config:
        #   output_cost_per_token: 0.0001 → tokens = cost_usd / 0.0001
        # FLUX.2 [pro] 1024² = $0.030 = 300 tokens. Use round so dust doesn't
        # cause off-by-one cents under repeated calls.
        completion_tokens = max(1, round(cost_usd / 0.0001))

        body = _json.dumps({
            "b64_json": b64,
            "url": sample_url,
            "cost_credits": cost_credits,
            "cost_usd": cost_usd,
        })
        resp = ModelResponse()
        resp.id = f"bfl-{uuid4().hex[:12]}"
        resp.created = int(time.time())
        resp.model = model
        resp.object = "chat.completion"
        resp.choices = [
            Choices(
                finish_reason="stop",
                index=0,
                message=Message(role="assistant", content=body),
            )
        ]
        resp.usage = Usage(
            prompt_tokens=0,
            completion_tokens=completion_tokens,
            total_tokens=completion_tokens,
        )
        return resp


bfl_flux_provider = BFLFluxProvider()


# -----------------------------------------------------------------------------
# Provider 2 — Voxtral Realtime voice-tick (billing-only stub)
# -----------------------------------------------------------------------------
# Strategy: report exactly 60 completion_tokens per call. Set
#   model_info.output_cost_per_token: 0.0001
# in config.yaml so each tick costs 60 × $0.0001 = $0.006 (1 minute of Voxtral
# Realtime). The dictate orchestrator hits this once per minute of audio.
# Direct upstream call to Voxtral Realtime stays in our app's WS handler.

# -----------------------------------------------------------------------------
# Provider — Jina embeddings with proper spend tracking
# -----------------------------------------------------------------------------
# LiteLLM's native Jina provider works for routing but its spend math is
# broken: Jina returns `usage.total_tokens` only (no `prompt_tokens`),
# while LiteLLM's embeddings-cost computation is `input_cost_per_token ×
# prompt_tokens`. Result: $0.00 spend on every call. This wrapper hits
# Jina directly and reshapes the usage so `prompt_tokens == total_tokens`,
# which makes LiteLLM's existing pricing config (input_cost_per_token in
# model_info) compute correctly.

_JINA_API = "https://api.jina.ai/v1/embeddings"


class JinaEmbeddingsProvider(CustomLLM):
    """Drop-in replacement for LiteLLM's Jina embeddings provider that
    fixes the prompt_tokens=0 spend-tracking bug. Identical request/
    response shape — callers don't see the difference."""

    async def aembedding(  # type: ignore[override]
        self, *args, **kwargs
    ) -> EmbeddingResponse:
        model: str = kwargs.get("model", "jina-embeddings-v5-text-nano")
        # Strip the "jina-embed/" provider prefix.
        jina_model = model.split("/", 1)[1] if "/" in model else model
        api_key = kwargs.get("api_key") or os.environ["JINA_AI_API_KEY"]

        # `input` is required; OpenAI shape allows string OR array. Jina
        # accepts an array of strings and returns one vector per element.
        inp = kwargs.get("input")
        if isinstance(inp, str):
            inputs = [inp]
        elif isinstance(inp, list):
            inputs = [str(x) for x in inp]
        else:
            raise ValueError("Jina embeddings requires `input` (string or list)")

        # Jina-specific: task hint propagates as a top-level field.
        # `dimensions` triggers MRL truncation. Both come through the
        # OpenAI SDK as kwargs.
        body: dict = {
            "model": jina_model,
            "input": inputs,
        }
        if "dimensions" in kwargs and kwargs["dimensions"] is not None:
            body["dimensions"] = kwargs["dimensions"]
        if "task" in kwargs and kwargs["task"]:
            body["task"] = kwargs["task"]

        async with httpx.AsyncClient(timeout=30.0) as http:
            r = await http.post(
                _JINA_API,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
            r.raise_for_status()
            payload = r.json()

        data = payload.get("data") or []
        if not data:
            raise RuntimeError(f"Jina returned no embeddings: {payload}")

        # Reshape usage so LiteLLM's spend math works. Jina's
        # `usage.total_tokens` is the only count we get; mirror it into
        # `prompt_tokens` so `input_cost_per_token × prompt_tokens` lands
        # at the right number.
        usage_in = payload.get("usage") or {}
        total = int(usage_in.get("total_tokens") or 0)

        resp = EmbeddingResponse()
        resp.model = model
        resp.object = "list"
        resp.data = [
            {"object": "embedding", "index": i, "embedding": d.get("embedding") or []}
            for i, d in enumerate(data)
        ]
        resp.usage = Usage(
            prompt_tokens=total,
            completion_tokens=0,
            total_tokens=total,
        )
        return resp


jina_embeddings_provider = JinaEmbeddingsProvider()


# -----------------------------------------------------------------------------
# Provider — Mistral Voxtral Mini Transcribe 2 (batch STT) with proper cost
# -----------------------------------------------------------------------------
# LiteLLM's native /v1/audio/transcriptions path can't extract Voxtral's
# duration field (`usage.prompt_audio_seconds`) — its cost calculator looks
# for `duration` like OpenAI Whisper returns. Mistral doesn't, so spend
# lands at $0.00.
#
# We work around this the same way as BFL FLUX: expose Voxtral as a fake
# chat completion, internally call Mistral's transcribe endpoint, return
# the text in `choices[0].message.content`. The wrapper reports
# `usage.completion_tokens = audio_duration_seconds`; combined with
# model_info.output_cost_per_token = $0.00005 in config.yaml, each second
# of audio bills exactly $0.003/min = Mistral's stated price.
#
# Caller convention (mirrors BFL pattern): single user message whose JSON-
# encoded body is `{audio_base64, mime, language}`. Response's
# `choices[0].message.content` is the plain transcript. server/api/ai/
# transcribe.post.ts is the only consumer.

_MISTRAL_TRANSCRIBE_API = "https://api.mistral.ai/v1/audio/transcriptions"


class MistralTranscribeProvider(CustomLLM):
    """Wraps Mistral Voxtral batch transcribe so LiteLLM's spend math
    works. Exposed as chat-completions because CustomLLM has no
    transcription hook."""

    async def acompletion(  # type: ignore[override]
        self, *args, **kwargs
    ) -> ModelResponse:
        import json as _json

        model: str = kwargs.get("model", "mistral-transcribe/voxtral-mini-2602")
        # Strip the "mistral-transcribe/" provider prefix.
        mistral_model = model.split("/", 1)[1] if "/" in model else model
        api_key = kwargs.get("api_key") or os.environ["MISTRAL_API_KEY"]

        # Parse request: single user message with JSON {audio_base64, mime, language}.
        messages = kwargs.get("messages") or []
        if not messages:
            raise ValueError("Voxtral transcribe requires one user message")
        last = messages[-1]
        content = last.get("content", "")
        try:
            req = _json.loads(content) if isinstance(content, str) else content
        except _json.JSONDecodeError:
            raise ValueError("Voxtral transcribe message content must be JSON")

        audio_b64 = req.get("audio_base64")
        mime = req.get("mime", "audio/webm")
        language = req.get("language", "en")
        if not audio_b64:
            raise ValueError("audio_base64 required")

        # Decode audio + post as multipart form.
        audio_bytes = base64.b64decode(audio_b64)
        ext = "webm" if "webm" in mime else "ogg" if "ogg" in mime else "wav" if "wav" in mime else "mp4"
        files = {"file": (f"audio.{ext}", audio_bytes, mime)}
        data = {"model": mistral_model, "language": language}

        async with httpx.AsyncClient(timeout=60.0) as http:
            r = await http.post(
                _MISTRAL_TRANSCRIBE_API,
                headers={"Authorization": f"Bearer {api_key}"},
                files=files,
                data=data,
            )
            r.raise_for_status()
            payload = r.json()

        # Extract text + duration. Mistral puts the seconds in
        # `usage.prompt_audio_seconds`. Use ceil(seconds) so a 0.4s clip
        # still bills (we already enforce a minimum at the caller layer).
        text = payload.get("text") or ""
        usage_in = payload.get("usage") or {}
        duration_sec = int(usage_in.get("prompt_audio_seconds") or 0)
        if duration_sec < 1:
            duration_sec = 1

        # Map duration → completion_tokens 1:1; config.yaml sets
        # output_cost_per_token: 0.00005 → $0.003/min audio.
        resp = ModelResponse()
        resp.id = f"voxtral-tx-{uuid4().hex[:12]}"
        resp.created = int(time.time())
        resp.model = model
        resp.object = "chat.completion"
        resp.choices = [
            Choices(
                finish_reason="stop",
                index=0,
                message=Message(role="assistant", content=text),
            )
        ]
        resp.usage = Usage(
            prompt_tokens=0,
            completion_tokens=duration_sec,
            total_tokens=duration_sec,
        )
        return resp


mistral_transcribe_provider = MistralTranscribeProvider()


_VOXTRAL_TICK_TOKENS = 60  # × output_cost_per_token in config = per-tick cost


class VoxtralTickProvider(CustomLLM):
    """Billing-only stub. Returns instantly. Reports usage so LiteLLM bills the
    requesting key. Cost = output_cost_per_token (config) × 60 tokens = $0.006
    per call = 1 minute of Voxtral Realtime."""

    async def acompletion(  # type: ignore[override]
        self, *args, **kwargs
    ) -> ModelResponse:
        # Build a ModelResponse manually with explicit usage so LiteLLM bills
        # the configured per-token cost × the tokens we report.
        resp = ModelResponse()
        resp.id = f"voxtral-tick-{uuid4().hex[:12]}"
        resp.created = int(time.time())
        resp.model = kwargs.get("model", "voxtral-realtime-tick")
        resp.object = "chat.completion"
        resp.choices = [
            Choices(
                finish_reason="stop",
                index=0,
                message=Message(role="assistant", content="tick"),
            )
        ]
        resp.usage = Usage(
            prompt_tokens=0,
            completion_tokens=_VOXTRAL_TICK_TOKENS,
            total_tokens=_VOXTRAL_TICK_TOKENS,
        )
        return resp


voxtral_tick_provider = VoxtralTickProvider()
