"""Tests for the BFL provider's submission retries (custom_handlers.py).

Run inside the pinned LiteLLM image, which has litellm + httpx (CI job
`litellm-handler-tests`):

    docker run --rm --network none --entrypoint python \
      -e LITELLM_LOCAL_MODEL_COST_MAP=True \
      -v "$PWD/deploy/config/litellm:/t:ro" -w /t \
      ghcr.io/berriai/litellm:<pinned> -B -m unittest -v test_custom_handlers

No network: every BFL answer comes from an httpx.MockTransport and the
backoff sleeps are recorded instead of slept.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import unittest
from collections.abc import Callable
from unittest import mock

import custom_handlers as ch
import httpx

SUBMIT_URL = "https://api.eu.bfl.ai/v1/flux-3-image-klein"
POLL_URL = "https://api.eu2.bfl.ai/v1/get_result?id=job-1"
SAMPLE_URL = "https://delivery-eu1.bfl.ai/sample.jpg"
IMAGE = b"\xff\xd8\xff-fake-jpeg"


class FakeBfl:
    """Scripted BFL: one answer per submission, then a ready job."""

    def __init__(self, submit_answers: list[httpx.Response]) -> None:
        self.submit_answers = list(submit_answers)
        self.submits = 0
        self.polls = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if request.method == "POST" and url == SUBMIT_URL:
            self.submits += 1
            return self.submit_answers.pop(0)
        if request.method == "GET" and url == POLL_URL:
            self.polls += 1
            return httpx.Response(200, json={"status": "Ready", "result": {"sample": SAMPLE_URL}})
        if request.method == "GET" and url == SAMPLE_URL:
            return httpx.Response(200, content=IMAGE)
        return httpx.Response(404)


def accepted() -> httpx.Response:
    return httpx.Response(200, json={"id": "job-1", "polling_url": POLL_URL, "cost": 0.9})


def refused(status: int, retry_after: str | None = None) -> httpx.Response:
    headers = {"retry-after": retry_after} if retry_after is not None else {}
    return httpx.Response(status, json={"detail": "busy"}, headers=headers)


class BflSubmitRetryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sleeps: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            self.sleeps.append(seconds)

        patches = [
            mock.patch.object(ch, "_sleep", fake_sleep),
            mock.patch.object(ch, "_BFL_POLL_INTERVAL", 0),
            mock.patch.dict(os.environ, {"BFL_API_KEY": "bfl-test-key"}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def run_provider(self, bfl: FakeBfl) -> dict:
        provider = ch.BFLFluxProvider()
        provider.transport = httpx.MockTransport(bfl.handler)
        resp = asyncio.run(
            provider.acompletion(
                model="bfl-flux/flux-3-image-klein",
                messages=[{"role": "user", "content": json.dumps({"prompt": "a lighthouse"})}],
            )
        )
        return json.loads(resp.choices[0].message.content)  # type: ignore[union-attr]

    def assert_raises_status(self, status: int, fn: Callable[[], object]) -> None:
        with self.assertRaises(httpx.HTTPStatusError) as ctx:
            fn()
        self.assertEqual(ctx.exception.response.status_code, status)

    def test_retries_429_then_succeeds(self) -> None:
        bfl = FakeBfl([refused(429), refused(429), accepted()])
        body = self.run_provider(bfl)
        self.assertEqual(bfl.submits, 3)
        self.assertEqual(bfl.polls, 1)
        self.assertEqual(base64.b64decode(body["b64_json"]), IMAGE)
        self.assertEqual(len(self.sleeps), 2)
        # Equal jitter on 4 s then 8 s: half fixed, half random.
        self.assertTrue(2.0 <= self.sleeps[0] <= 4.0, self.sleeps)
        self.assertTrue(4.0 <= self.sleeps[1] <= 8.0, self.sleeps)

    def test_retries_503(self) -> None:
        bfl = FakeBfl([refused(503), accepted()])
        self.run_provider(bfl)
        self.assertEqual(bfl.submits, 2)

    def test_honours_retry_after_seconds(self) -> None:
        bfl = FakeBfl([refused(429, "7"), accepted()])
        self.run_provider(bfl)
        self.assertEqual(len(self.sleeps), 1)
        self.assertTrue(7.0 <= self.sleeps[0] <= 8.0, self.sleeps)

    def test_gives_up_after_the_attempt_limit(self) -> None:
        bfl = FakeBfl([refused(429)] * ch._BFL_SUBMIT_ATTEMPTS)
        self.assert_raises_status(429, lambda: self.run_provider(bfl))
        self.assertEqual(bfl.submits, ch._BFL_SUBMIT_ATTEMPTS)
        self.assertEqual(len(self.sleeps), ch._BFL_SUBMIT_ATTEMPTS - 1)
        self.assertEqual(bfl.polls, 0)

    def test_stops_when_retry_after_exceeds_the_budget(self) -> None:
        bfl = FakeBfl([refused(429, str(int(ch._BFL_SUBMIT_RETRY_BUDGET) + 5)), accepted()])
        self.assert_raises_status(429, lambda: self.run_provider(bfl))
        self.assertEqual(bfl.submits, 1)
        self.assertEqual(self.sleeps, [])

    def test_total_wait_stays_within_the_budget(self) -> None:
        bfl = FakeBfl([refused(429, "15")] * ch._BFL_SUBMIT_ATTEMPTS)
        self.assert_raises_status(429, lambda: self.run_provider(bfl))
        self.assertLessEqual(sum(self.sleeps), ch._BFL_SUBMIT_RETRY_BUDGET)
        self.assertEqual(bfl.submits, len(self.sleeps) + 1)

    def test_other_errors_are_not_retried(self) -> None:
        for status in (400, 401, 402, 422, 500, 502):
            with self.subTest(status=status):
                self.sleeps.clear()
                bfl = FakeBfl([refused(status), accepted()])
                self.assert_raises_status(status, lambda bfl=bfl: self.run_provider(bfl))
                self.assertEqual(bfl.submits, 1)
                self.assertEqual(self.sleeps, [])

    def test_a_failed_poll_never_resubmits(self) -> None:
        bfl = FakeBfl([accepted(), accepted()])
        original = bfl.handler

        def handler(request: httpx.Request) -> httpx.Response:
            if str(request.url) == POLL_URL:
                bfl.polls += 1
                return httpx.Response(429)
            return original(request)

        provider = ch.BFLFluxProvider()
        provider.transport = httpx.MockTransport(handler)
        with self.assertRaises(httpx.HTTPStatusError):
            asyncio.run(
                provider.acompletion(
                    model="bfl-flux/flux-3-image-klein",
                    messages=[{"role": "user", "content": json.dumps({"prompt": "x"})}],
                )
            )
        self.assertEqual(bfl.submits, 1)
        self.assertEqual(bfl.polls, 1)

    def test_retry_after_http_date(self) -> None:
        self.assertEqual(ch._retry_after_seconds("Wed, 21 Oct 2015 07:28:00 GMT"), 0.0)
        self.assertIsNone(ch._retry_after_seconds("soon"))
        self.assertIsNone(ch._retry_after_seconds(None))
        self.assertEqual(ch._retry_after_seconds(" 3 "), 3.0)


class RedirectHardeningTest(unittest.TestCase):
    def test_litellm_clients_do_not_follow_redirects(self) -> None:
        self.assertFalse(ch.litellm.aclient_session.follow_redirects)  # type: ignore[union-attr]
        self.assertFalse(ch.litellm.client_session.follow_redirects)  # type: ignore[union-attr]


if __name__ == "__main__":
    unittest.main()
