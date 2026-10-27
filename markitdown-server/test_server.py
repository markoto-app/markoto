"""
Archive pre-flight tests for server.py. Run inside the service image:

    docker run --rm --entrypoint python -v "$PWD/markitdown-server:/t:ro" -w /t \
        <image> -B -m unittest -v test_server
"""

import io
import os
import unittest
import zipfile
from unittest import mock

import server

MIB = 1024 * 1024


def make_zip(entries: dict[str, bytes], level: int = 9) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=level) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return out.getvalue()


class ArchiveInflateLimitTest(unittest.TestCase):
    def test_limit_is_ratio_allowance_with_floor_and_absolute_cap(self):
        floor = server.RATIO_FLOOR_BYTES
        self.assertEqual(server.archive_inflate_limit(1), floor)
        self.assertEqual(server.archive_inflate_limit(floor // server.MAX_ARCHIVE_RATIO), floor)
        self.assertEqual(server.archive_inflate_limit(1 * MIB), server.MAX_ARCHIVE_RATIO * MIB)
        self.assertEqual(server.archive_inflate_limit(10**9), server.MAX_ARCHIVE_UNCOMPRESSED_BYTES)


class CheckArchiveTest(unittest.TestCase):
    def test_bomb_is_refused_after_a_bounded_amount_of_inflation(self):
        # 150 MiB declared (under the absolute cap, so the header check passes)
        # in a ~150 KB upload: the ratio limit is the 10 MiB floor.
        body = make_zip({"word/document.xml": b"A" * (150 * MIB)})
        limit = server.archive_inflate_limit(len(body))
        self.assertLess(limit, 20 * MIB)
        with self.assertRaises(server.ArchiveRejected) as raised:
            server.check_archive(body)
        self.assertIn("compression ratio", str(raised.exception))
        self.assertGreater(raised.exception.inflated, limit)
        # Stops within one read chunk of the limit, not at 150 MiB.
        self.assertLessEqual(raised.exception.inflated, limit + server._INFLATE_CHUNK)

    def test_absolute_cap_still_applies_when_ratio_would_allow_more(self):
        body = make_zip({"a.xml": os.urandom(2 * MIB)}, level=0)
        with mock.patch.object(server, "MAX_ARCHIVE_UNCOMPRESSED_BYTES", 1 * MIB), \
                mock.patch.object(server, "RATIO_FLOOR_BYTES", 1 * MIB):
            with self.assertRaises(server.ArchiveRejected) as raised:
                server.check_archive(body)
        # Declared size already exceeds the cap: refused before inflating.
        self.assertEqual(raised.exception.inflated, 0)

    def test_legitimate_documents_pass(self):
        # High ratio but under the floor (a few MB of repetitive XML).
        small = make_zip({"word/document.xml": b"<w:p>hello</w:p>" * 300_000})
        self.assertGreater(server.check_archive(small), 4 * MIB)
        # Above the floor but within the ratio (poorly compressible content).
        large = make_zip({"ppt/media/image1.bin": os.urandom(12 * MIB)})
        self.assertGreater(server.check_archive(large), 11 * MIB)

    def test_non_zip_is_left_to_the_converter(self):
        self.assertEqual(server.check_archive(b"not a zip"), 0)

    def test_time_budget_is_enforced(self):
        body = make_zip({"a.xml": b"A" * (5 * MIB)})
        with self.assertRaises(server.ArchiveCheckTimeout):
            server.check_archive(body, time_budget=-1)


if __name__ == "__main__":
    unittest.main()
