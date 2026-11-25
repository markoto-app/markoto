"""
Custom LiteLLM providers, registered via litellm_settings.custom_provider_map.

They wrap non-chat operations (FLUX image generation, Voxtral transcription
and voice ticks, web-tool ticks) as billable calls so LiteLLM's
key / team budget enforcement and spend tags apply to them. Cost flows through
model_info.input_cost_per_token / output_cost_per_token in config.yaml.

Pass-through endpoints with `auth: true` and `cost_per_request` are NOT
Enterprise-only (any more): v1.106.4 registers `user_api_key_auth` for them in
OSS. We still use these providers because each one fixes something a plain
pass-through would not: the usage shape of Voxtral transcription, BFL's submit + poll flow, and, for the ticks, a charge for a
call that never goes through the proxy (live dictation streams straight to
Mistral; the web tools keep one code path that also works on a LiteLLM config
without the tick models, carry the same `metadata.tags` as every other call
and leave the Staan request untouched).
"""

from __future__ import annotations

import asyncio
import base64
import os
import random
import re
import time
from email.utils import parsedate_to_datetime
from uuid import uuid4

import httpx
import litellm
from litellm import CustomLLM
from litellm.types.utils import (
    Choices,
    Message,
    ModelResponse,
    Usage,
)

# Outbound HTTP clients for OpenAI-compatible upstreams: never follow redirects
#
# The `byok/*` deployment (config.yaml) sends requests to a user-supplied
# `api_base`. The app checks that URL (and its DNS answers) before every
# call, but LiteLLM's default OpenAI client follows HTTP redirects
# (`follow_redirects=True` in litellm/llms/openai/common_utils.py), so a
# provider host that passes the check could answer 302/307 and make the
# proxy fetch an internal address the check never saw (verified on
# v1.106.4: chat, streaming chat, image generation and transcription all
# followed the redirect, and transcription returned the redirect target's
# body as the transcript).
#
# LiteLLM uses `litellm.client_session` / `litellm.aclient_session` as the
# HTTP client for every OpenAI-SDK-backed call when they are set, so
# clients with `follow_redirects=False` close this for all of them. A
# redirect now surfaces as a non-2xx upstream error. No real AI API
# redirects its inference endpoints, so the bundled providers are
# unaffected. This module is imported at proxy start (custom_provider_map),
# which is why the setting lives here.
litellm.client_session = httpx.Client(follow_redirects=False)
litellm.aclient_session = httpx.AsyncClient(follow_redirects=False)


# BFL FLUX 3 Image Klein, EU-pinned, polling-based

# BFL's EU endpoint: routing limited to EU clusters. The job itself runs on
# a numbered cluster host (api.eu<N>.bfl.ai) named by `polling_url`.
_BFL_EU = "https://api.eu.bfl.ai"
_BFL_POLL_INTERVAL = 0.5
# A queued job can take well over 30 s; stay under the deployment's
# `timeout` in config.yaml (120 s): the whole call, submission retries
# included, ends within _BFL_TOTAL_TIMEOUT.
_BFL_POLL_TIMEOUT = 100.0
_BFL_TOTAL_TIMEOUT = 115.0

# Submission retries. BFL answers 429 when its EU capacity is short (and 503
# while a cluster is unavailable). Both mean the job was NOT accepted, so the
# submission is sent again after a backoff with jitter (or BFL's
# `Retry-After`), at most _BFL_SUBMIT_ATTEMPTS times and only while the waits
# stay within _BFL_SUBMIT_RETRY_BUDGET seconds, so a user's request can't hang
# for long. Anything else, and every poll of an accepted job, is never
# resubmitted: an accepted job is billed. The deployment sets
# `num_retries: 0` in config.yaml so the router doesn't resubmit either.
_BFL_SUBMIT_RETRY_STATUSES = frozenset({429, 503})
_BFL_SUBMIT_ATTEMPTS = 4
_BFL_SUBMIT_RETRY_BUDGET = 40.0
_BFL_BACKOFF_BASE = 4.0
_BFL_BACKOFF_CAP = 16.0
# BFL bills per credit; 1 credit ≈ $0.01 (Klein at 1k = 0.9 credits = $0.009)
_BFL_CREDIT_USD = 0.01


def _is_bfl_eu_url(url: str) -> bool:
    """https://api.eu.bfl.ai or a numbered EU cluster (api.eu9.bfl.ai)."""
    return re.fullmatch(r"https://api\.eu\d*\.bfl\.ai(/.*)?", url) is not None


def _retry_after_seconds(value: str | None) -> float | None:
    """`Retry-After` as seconds (delta-seconds or an HTTP date); None when absent or unreadable."""
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, when.timestamp() - time.time())


def _bfl_submit_delay(attempt: int, retry_after: str | None) -> float:
    """Wait before submission attempt `attempt + 1` (attempts count from 1).

    BFL's `Retry-After` wins (plus up to 1 s of jitter so parallel requests
    don't come back in lockstep); otherwise exponential backoff with equal
    jitter: of 4 s, 8 s, 16 s (the cap) half is fixed, half random.
    """
    hinted = _retry_after_seconds(retry_after)
    if hinted is not None:
        return hinted + random.random()  # noqa: S311 (jitter, not crypto)
    step = min(_BFL_BACKOFF_CAP, _BFL_BACKOFF_BASE * 2 ** (attempt - 1))
    return step / 2 + random.uniform(0, step / 2)  # noqa: S311 (jitter, not crypto)


# Replaced by the tests so the backoff doesn't really sleep.
_sleep = asyncio.sleep


async def _bfl_submit(
    http: httpx.AsyncClient, url: str, headers: dict[str, str], payload: dict
) -> httpx.Response:
    """POST the job, sending it again on 429 / 503 within the retry budget.

    Returns the accepted (2xx) response. Raises httpx.HTTPStatusError for the
    last refusal once attempts or budget run out, and for any other non-2xx
    answer straight away.
    """
    waited = 0.0
    attempt = 1
    while True:
        resp = await http.post(url, headers=headers, json=payload)
        if resp.status_code not in _BFL_SUBMIT_RETRY_STATUSES or attempt >= _BFL_SUBMIT_ATTEMPTS:
            resp.raise_for_status()
            return resp
        delay = _bfl_submit_delay(attempt, resp.headers.get("retry-after"))
        if waited + delay > _BFL_SUBMIT_RETRY_BUDGET:
            resp.raise_for_status()
            return resp
        await _sleep(delay)
        waited += delay
        attempt += 1


class BFLFluxProvider(CustomLLM):
    """BFL FLUX submission → poll → b64_json + url. EU-pinned to api.eu.bfl.ai.

    Exposed via /v1/chat/completions (NOT /v1/images/generations) because OSS
    LiteLLM's aimage_generation path does not fire spend-logger callbacks, so
    spend never reaches the DB. The chat-completions path tracks spend via
    `usage` token counts × output_cost_per_token in config.

    Convention: caller sends a single user message whose JSON-encoded body is
    `{prompt, width?, height?, size?}`. Either pass `width` + `height`
    directly OR `size: "WxH"`. Default = 1024x1024. FLUX 3 rewrites the
    prompt itself (the model is trained on such captions) and refuses
    unknown request fields, so nothing else is forwarded. The response's
    `choices[0].message.content` is a JSON-encoded `{b64_json, url,
    cost_credits, cost_usd}`. Our app code (aiToolAdapter.ts:generateImageBytes)
    is the only consumer.
    """

    # The tests swap in an httpx.MockTransport; None = the real network.
    transport: httpx.AsyncBaseTransport | None = None

    async def acompletion(  # type: ignore[override]
        self, *args, **kwargs
    ) -> ModelResponse:
        import json as _json

        model: str = kwargs.get("model", "bfl-flux/flux-3-image-klein")
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

        started = time.monotonic()
        async with httpx.AsyncClient(timeout=30.0, transport=self.transport) as http:
            submit = await _bfl_submit(
                http,
                f"{_BFL_EU}/v1/{bfl_model}",
                {"x-key": bfl_key, "Content-Type": "application/json"},
                {"prompt": prompt, "width": w, "height": h},
            )
            sub = submit.json()
            polling_url = sub["polling_url"]
            # The key goes to this URL on every poll: only ever to BFL's EU hosts.
            if not _is_bfl_eu_url(polling_url):
                raise RuntimeError("BFL returned a polling URL outside its EU hosts")
            cost_credits = float(sub.get("cost") or 0.0)

            deadline = min(time.monotonic() + _BFL_POLL_TIMEOUT, started + _BFL_TOTAL_TIMEOUT)
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
                raise RuntimeError("BFL polling timed out before the job was ready")

            img = await http.get(sample_url)
            img.raise_for_status()
            b64 = base64.b64encode(img.content).decode()

        cost_usd = cost_credits * _BFL_CREDIT_USD
        # Map cost to completion_tokens via output_cost_per_token in config:
        #   output_cost_per_token: 0.0001 → tokens = cost_usd / 0.0001
        # Klein at 1k = $0.009 = 90 tokens. Use round so dust doesn't
        # cause off-by-one cents under repeated calls.
        completion_tokens = max(1, round(cost_usd / 0.0001))

        body = _json.dumps(
            {
                "b64_json": b64,
                "url": sample_url,
                "cost_credits": cost_credits,
                "cost_usd": cost_usd,
            }
        )
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


# Voxtral Realtime voice-tick (billing-only stub)
# Strategy: report exactly 60 completion_tokens per call. Set
#   model_info.output_cost_per_token: 0.00011
# in config.yaml so each tick costs 60 × $0.00011 = $0.0066 (1 minute of Voxtral
# Realtime on Mistral's EU endpoint, 1.1x list). The dictate orchestrator hits this once per minute of audio.
# Direct upstream call to Voxtral Realtime stays in our app's WS handler.

# Mistral Voxtral Mini Transcribe 2 (batch STT) with proper cost
# LiteLLM's native /v1/audio/transcriptions path can't extract Voxtral's
# duration field (`usage.prompt_audio_seconds`): its cost calculator looks
# for `duration` like OpenAI Whisper returns. Mistral doesn't, so spend
# lands at $0.00.
#
# We work around this the same way as BFL FLUX: expose Voxtral as a fake
# chat completion, internally call Mistral's transcribe endpoint, return
# the text in `choices[0].message.content`. The wrapper reports
# `usage.completion_tokens = audio_duration_seconds`; combined with
# model_info.output_cost_per_token in config.yaml, each second of audio
# bills exactly Mistral's per-minute price.
#
# Caller convention (mirrors BFL pattern): single user message whose JSON-
# encoded body is `{audio_base64, mime, language}`. Response's
# `choices[0].message.content` is the plain transcript. server/api/ai/
# transcribe.post.ts is the only consumer.

# EU regional endpoint: inference in EU / EFTA data centres (the default
# api.mistral.ai makes no location commitment). Billed at 1.1x list.
_MISTRAL_TRANSCRIBE_API = "https://api.eu.mistral.ai/v1/audio/transcriptions"


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
        except _json.JSONDecodeError as e:
            raise ValueError("Voxtral transcribe message content must be JSON") from e

        audio_b64 = req.get("audio_base64")
        mime = req.get("mime", "audio/webm")
        language = req.get("language", "en")
        if not audio_b64:
            raise ValueError("audio_base64 required")

        # Decode audio + post as multipart form.
        audio_bytes = base64.b64decode(audio_b64)
        ext = (
            "webm"
            if "webm" in mime
            else "ogg"
            if "ogg" in mime
            else "wav"
            if "wav" in mime
            else "mp4"
        )
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
        # output_cost_per_token prices one token per second of audio.
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
    requesting key. Cost = output_cost_per_token (config) × 60 tokens = $0.0066
    per call = 1 minute of Voxtral Realtime (EU endpoint price)."""

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


# Web-tool ticks (billing-only stub)
# `web_search` (Staan search) and `fetch_url` (Staan Fetch) are plain HTTP calls the
# app makes with the operator's keys. Before each one the app sends ONE chat
# completion on `web-search-tick` / `web-fetch-tick` with the caller's virtual
# key, so the call is priced into the same per-key (and team) budget as every
# other AI call, and refused by the proxy when that budget is used up. The
# stub reports exactly one completion token; the price of one call is the
# deployment's output_cost_per_token in config.yaml.

_WEB_TOOL_TICK_TOKENS = 1  # × output_cost_per_token in config = price per call


class WebToolTickProvider(CustomLLM):
    """Billing-only stub for the web tools. Returns instantly and reports one
    completion token, so LiteLLM bills the requesting key the configured
    per-call price. Makes no outbound request."""

    async def acompletion(  # type: ignore[override]
        self, *args, **kwargs
    ) -> ModelResponse:
        model = kwargs.get("model") or "web-tool-tick"
        resp = ModelResponse()
        resp.id = f"web-tool-tick-{uuid4().hex[:12]}"
        resp.created = int(time.time())
        resp.model = model
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
            completion_tokens=_WEB_TOOL_TICK_TOKENS,
            total_tokens=_WEB_TOOL_TICK_TOKENS,
        )
        return resp


web_tool_tick_provider = WebToolTickProvider()
