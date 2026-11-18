"""
Archive pre-flight tests for server.py. Run inside the service image:

    docker run --rm --entrypoint python -v "$PWD/markitdown-server:/t:ro" -w /t \
        <image> -B -m unittest -v test_server
"""

import importlib.util
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
        with (
            mock.patch.object(server, "MAX_ARCHIVE_UNCOMPRESSED_BYTES", 1 * MIB),
            mock.patch.object(server, "RATIO_FLOOR_BYTES", 1 * MIB),
            self.assertRaises(server.ArchiveRejected) as raised,
        ):
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


class SecretTest(unittest.TestCase):
    def test_matching_secret_passes(self):
        self.assertTrue(server.secret_matches("s3cret-value", "s3cret-value"))

    def test_wrong_or_missing_secret_fails(self):
        self.assertFalse(server.secret_matches("wrong", "s3cret-value"))
        self.assertFalse(server.secret_matches(None, "s3cret-value"))
        self.assertFalse(server.secret_matches("", "s3cret-value"))

    def test_empty_expected_secret_never_matches(self):
        self.assertFalse(server.secret_matches("", ""))
        self.assertFalse(server.secret_matches("anything", ""))


# A 1x1 PNG, the smallest picture a DOCX can embed.
PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d4944415478da636460f85f0f0002870180eb47ba92"
    "0000000049454e44ae426082"
)


def make_docx_with_picture(text: str) -> bytes:
    """A one-paragraph DOCX with an embedded PNG: only the parts Word needs."""
    rels_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    return make_zip(
        {
            "[Content_Types].xml": (
                b'<?xml version="1.0" encoding="UTF-8"?>'
                b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                b'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                b'<Default Extension="xml" ContentType="application/xml"/>'
                b'<Default Extension="png" ContentType="image/png"/>'
                b'<Override PartName="/word/document.xml" ContentType="application/'
                b'vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
            ),
            "_rels/.rels": (
                f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{rels_ns}">'
                f'<Relationship Id="rId1" Type="{office}/officeDocument" Target="word/document.xml"/>'
                "</Relationships>"
            ).encode(),
            "word/_rels/document.xml.rels": (
                f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{rels_ns}">'
                f'<Relationship Id="rId5" Type="{office}/image" Target="media/image1.png"/>'
                "</Relationships>"
            ).encode(),
            "word/media/image1.png": PNG_1X1,
            "word/document.xml": (
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
                f' xmlns:r="{office}"'
                ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
                ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
                ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>'
                f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"
                '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="95250" cy="95250"/>'
                '<wp:docPr id="1" name="Picture 1" descr="a dot"/><a:graphic>'
                '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
                '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>'
                '<pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill><pic:spPr/></pic:pic>'
                "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
                "</w:body></w:document>"
            ).encode(),
        }
    )


class FakeConn:
    def __init__(self):
        self.sent = []

    def send(self, message):
        self.sent.append(message)

    def close(self):
        pass


class ConvertImagesTest(unittest.TestCase):
    """`/convert?images=1` keeps embedded pictures as data: URIs (the bulk
    import stores them as the document's images); without it they are cut."""

    def convert(self, body: bytes, keep_images: bool) -> str:
        conn = FakeConn()
        # The child's memory cap would apply to the test process itself.
        with mock.patch.object(server, "_cap_child_memory"):
            server._child_convert(conn, body, "docx", keep_images)
        self.assertEqual(conn.sent[0][0], "ok", conn.sent)
        return conn.sent[0][1]

    def test_keeps_pictures_when_asked(self):
        markdown = self.convert(make_docx_with_picture("Quarterly report"), keep_images=True)
        self.assertIn("Quarterly report", markdown)
        self.assertIn("data:image/png;base64,", markdown)

    def test_cuts_pictures_by_default(self):
        markdown = self.convert(make_docx_with_picture("Quarterly report"), keep_images=False)
        self.assertIn("Quarterly report", markdown)
        self.assertNotIn("data:image/png;base64,iVBOR", markdown)


# httpx (needed by fastapi.testclient) is not part of the service image.
HAS_HTTPX = importlib.util.find_spec("httpx") is not None


@unittest.skipUnless(HAS_HTTPX, "fastapi.testclient needs httpx")
class AuthMiddlewareTest(unittest.TestCase):
    def setUp(self):
        from fastapi.testclient import TestClient

        patcher = mock.patch.dict(os.environ, {"MARKITDOWN_API_SECRET": "test-secret"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(server.app)

    def test_health_needs_no_secret(self):
        self.assertEqual(self.client.get("/health").status_code, 200)

    def test_convert_without_secret_is_refused_before_parsing(self):
        res = self.client.post("/convert?ext=txt", content=b"hello")
        self.assertEqual(res.status_code, 401)

    def test_design_extract_with_wrong_secret_is_refused(self):
        res = self.client.post(
            "/design/extract?ext=pdf", content=b"x", headers={"X-Markitdown-Secret": "nope"}
        )
        self.assertEqual(res.status_code, 401)

    def test_convert_with_secret_reaches_the_handler(self):
        res = self.client.post(
            "/convert?ext=txt", content=b"", headers={"X-Markitdown-Secret": "test-secret"}
        )
        self.assertEqual(res.status_code, 400)  # empty body: the handler ran


if __name__ == "__main__":
    unittest.main()
