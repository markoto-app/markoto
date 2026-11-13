"""
Tests for design_extract.py ("Create a design from a document"). Run inside
the service image with the fixtures mounted:

    docker run --rm --entrypoint python -v "$PWD/markitdown-server:/t:ro" \
        -v "$PWD/tests/fixtures/design-import:/fixtures:ro" -w /t \
        <image> -B -m unittest -v test_design_extract

The fixtures (invented content) are built by
tests/fixtures/design-import/make_docx.py and make_pdf.ts.
"""

import base64
import io
import os
import unittest
import zipfile

import design_extract

FIXTURES = os.environ.get("DESIGN_FIXTURES", "/fixtures")


def fixture(name: str) -> bytes:
    with open(os.path.join(FIXTURES, name), "rb") as f:
        return f.read()


class DocxExtractTest(unittest.TestCase):
    def test_letter_styles_theme_and_section(self):
        out = design_extract.extract_design(fixture("letter-serif.docx"), "docx")
        self.assertEqual(out["format"], "docx")
        self.assertEqual(out["pages"], [])
        docx = out["docx"]
        self.assertEqual(docx["themeFonts"], {"major": "EB Garamond", "minor": "Georgia"})
        self.assertEqual(docx["themeColors"]["accent1"], "#1F4D3A")
        styles = docx["styles"]
        # Theme font references resolve; sizes are half-points → pt.
        self.assertEqual(styles["normal"]["font"], "Georgia")
        self.assertEqual(styles["normal"]["sizePt"], 11.0)
        self.assertEqual(styles["normal"]["lineSpacing"], 1.25)
        self.assertEqual(styles["heading1"]["font"], "EB Garamond")
        self.assertEqual(styles["heading1"]["color"], "#1F4D3A")
        self.assertEqual(styles["heading1"]["spaceBeforePt"], 18.0)
        self.assertTrue(styles["heading2"]["smallCaps"])
        self.assertEqual(styles["title"]["borderBottom"]["color"], "#B08D57")
        self.assertEqual(styles["quote"]["borderLeft"]["color"], "#B08D57")
        self.assertTrue(styles["header"]["allCaps"])
        section = docx["section"]
        self.assertEqual((section["pageWidthMm"], section["pageHeightMm"]), (210.0, 297.0))
        self.assertEqual(section["marginsMm"]["top"], 30.0)
        self.assertEqual(section["header"]["text"], "Hollowmere Estates · Est. 1898")
        # Complex PAGE field + simple NUMPAGES field → tokens, cached results dropped.
        self.assertEqual(section["footer"]["text"], "Page {page} of {pages}")
        self.assertIn("[Title] Hollowmere Estates", out["textSample"])
        # Title on the first text page, no page break after it.
        self.assertIs(docx["titleOnOwnPage"], False)

    def test_explicit_colour_wins_over_theme_slot(self):
        # Word writes the shaded colour next to the theme reference.
        styles = design_extract.extract_design(fixture("memo-office.docx"), "docx")["docx"][
            "styles"
        ]
        self.assertEqual(styles["heading1"]["color"], "#2F5597")
        self.assertEqual(styles["heading1"]["font"], "Calibri Light")

    def test_letter_paper(self):
        section = design_extract.extract_design(fixture("memo-office.docx"), "docx")["docx"][
            "section"
        ]
        self.assertEqual((section["pageWidthMm"], section["pageHeightMm"]), (215.9, 279.4))

    def test_not_a_word_document(self):
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as archive:
            archive.writestr("hello.txt", "hi")
        with self.assertRaises(design_extract.ExtractError):
            design_extract.extract_design(out.getvalue(), "docx")
        with self.assertRaises(design_extract.ExtractError):
            design_extract.extract_design(b"plain bytes", "docx")

    def test_external_entities_are_refused(self):
        evil = (
            '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&e;</w:t></w:r></w:p></w:body></w:document>'
        )
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as archive:
            archive.writestr("word/document.xml", evil)
        with self.assertRaises(Exception) as raised:
            design_extract.extract_design(out.getvalue(), "docx")
        self.assertNotIn("root:", str(raised.exception))


class PdfExtractTest(unittest.TestCase):
    def test_report_pages_fonts_colours(self):
        out = design_extract.extract_design(fixture("report-cover.pdf"), "pdf", 4)
        self.assertEqual(out["format"], "pdf")
        self.assertEqual(out["pageCount"], 2)
        self.assertEqual(len(out["pages"]), 2)
        png = base64.b64decode(out["pages"][0]["png"])
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertEqual(out["pages"][0]["width"], design_extract.PAGE_PX_WIDTH)
        pdf = out["pdf"]
        self.assertAlmostEqual(pdf["pageSize"]["heightMm"], 297.0, delta=0.5)
        self.assertEqual(pdf["fonts"][0]["value"], "LiberationSans")
        self.assertEqual(pdf["filledShapes"][0]["value"], "#0B2545")
        self.assertIn("#F28C28", [f["value"] for f in pdf["filledShapes"]])
        heading = next(line for line in pdf["lines"] if line["text"] == "A year of steady growth")
        self.assertEqual(
            (heading["font"], heading["sizePt"], heading["page"]), ("LiberationSans-Bold", 18.0, 2)
        )
        self.assertEqual(len(pdf["textExtentMm"]), 2)

    def test_page_limit(self):
        out = design_extract.extract_design(fixture("report-cover.pdf"), "pdf", 1)
        self.assertEqual(len(out["pages"]), 1)
        self.assertEqual(out["pageCount"], 2)

    def test_subset_prefix_is_stripped(self):
        self.assertEqual(design_extract._font_name("ABCDEF+WorkSans-SemiBold"), "WorkSans-SemiBold")
        self.assertEqual(design_extract._font_name("Helvetica"), "Helvetica")

    def test_colour_spaces(self):
        self.assertEqual(design_extract._color_hex((0,)), "#000000")
        self.assertEqual(design_extract._color_hex((1, 0, 0)), "#FF0000")
        self.assertEqual(design_extract._color_hex((0, 0, 0, 1)), "#000000")
        self.assertIsNone(design_extract._color_hex("pattern"))

    def test_garbage_is_refused(self):
        with self.assertRaises(design_extract.ExtractError):
            design_extract.extract_design(b"%PDF-1.7 not really", "pdf")


if __name__ == "__main__":
    unittest.main()
