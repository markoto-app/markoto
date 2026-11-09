"""
Builds the DOCX fixtures for "Create a design from a document" by hand
(plain OOXML in a zip — no python-docx), so they are small, deterministic
and contain only invented content.

    python3 tests/fixtures/design-import/make_docx.py

Writes letter-serif.docx (a serif brand letter template with a dark green
brand colour, letterhead header and "Page X of Y" footer) and
memo-office.docx (an Office-default look: Calibri Light / Calibri, blue
accent, Letter paper, numbered footer).
"""

import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>"""


def theme(major: str, minor: str, colors: dict[str, str]) -> str:
    slots = "".join(
        f'<a:{name}><a:srgbClr val="{value}"/></a:{name}>' for name, value in colors.items()
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme {A_NS} name="Fixture">
  <a:themeElements>
    <a:clrScheme name="Fixture">{slots}</a:clrScheme>
    <a:fontScheme name="Fixture">
      <a:majorFont><a:latin typeface="{major}"/></a:majorFont>
      <a:minorFont><a:latin typeface="{minor}"/></a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>"""


def style(style_id: str, name: str, rpr: str = "", ppr: str = "", based: str = "Normal") -> str:
    based_el = f'<w:basedOn w:val="{based}"/>' if based else ""
    return (f'<w:style w:type="paragraph" w:styleId="{style_id}"><w:name w:val="{name}"/>{based_el}'
            f'<w:pPr>{ppr}</w:pPr><w:rPr>{rpr}</w:rPr></w:style>')


def styles(defaults_rpr: str, defaults_ppr: str, entries: list[str]) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles {W_NS}>
  <w:docDefaults>
    <w:rPrDefault><w:rPr>{defaults_rpr}</w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr>{defaults_ppr}</w:pPr></w:pPrDefault>
  </w:docDefaults>
  {''.join(entries)}
  <w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1" w:themeColor="hyperlink"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>"""


def para(text: str, style_id: str | None = None) -> str:
    ppr = f'<w:pPr><w:pStyle w:val="{style_id}"/></w:pPr>' if style_id else ""
    return f'<w:p>{ppr}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def document(body: list[str], page: tuple[int, int], margins: dict[str, int]) -> str:
    mar = " ".join(f'w:{k}="{v}"' for k, v in margins.items())
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {W_NS}>
  <w:body>
    {''.join(body)}
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rId3"/>
      <w:footerReference w:type="default" r:id="rId4"/>
      <w:pgSz w:w="{page[0]}" w:h="{page[1]}"/>
      <w:pgMar {mar}/>
      <w:cols w:space="708"/>
    </w:sectPr>
  </w:body>
</w:document>"""


def header(text: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr {W_NS}><w:p><w:pPr><w:pStyle w:val="Header"/><w:jc w:val="right"/></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p></w:hdr>"""


def footer_page_of_pages(prefix: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr {W_NS}><w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="center"/></w:pPr>
<w:r><w:t xml:space="preserve">{prefix}</w:t></w:r>
<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
<w:r><w:t xml:space="preserve"> of </w:t></w:r>
<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>2</w:t></w:r></w:fldSimple>
</w:p></w:ftr>"""


def write(name: str, parts: dict[str, str]) -> None:
    path = os.path.join(HERE, name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        # [Content_Types].xml first, like Word writes it (file-type sniffs it).
        for part in ["[Content_Types].xml", *[p for p in parts if p != "[Content_Types].xml"]]:
            info = zipfile.ZipInfo(part, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, parts[part])
    print(f"wrote {path}")


def letter_serif() -> None:
    green = "1F4D3A"
    body = [
        para("Hollowmere Estates", "Title"),
        para("Quarterly letter to our partners", "Subtitle"),
        para("Dear partners,"),
        para("The autumn harvest closed two weeks early this year. The yields on the north terraces were the best since we began keeping records, and the cellar is full for the first time in three seasons."),
        para("What changed this quarter", "Heading1"),
        para("We replaced the irrigation on the lower slopes and moved the pressing to the new hall. Both changes cut the time from vine to vat by a day."),
        para("Next steps", "Heading2"),
        para("The tasting room opens in March. We would be glad to welcome you there."),
        para("We grow slowly, and we grow well.", "Quote"),
        para("With warm regards,"),
        para("Ada Lindqvist, Estate Manager"),
    ]
    write("letter-serif.docx", {
        "[Content_Types].xml": CONTENT_TYPES,
        "_rels/.rels": ROOT_RELS,
        "word/_rels/document.xml.rels": DOC_RELS,
        "word/theme/theme1.xml": theme("EB Garamond", "Georgia", {
            "dk1": "1A1A1A", "lt1": "FFFFFF", "dk2": green, "lt2": "F4F1EA",
            "accent1": green, "accent2": "B08D57", "accent3": "6B7F73", "accent4": "8C3B2E",
            "accent5": "4A6A8A", "accent6": "A7A28F", "hlink": green, "folHlink": "6B7F73",
        }),
        "word/styles.xml": styles(
            '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/><w:color w:val="1A1A1A"/>',
            '<w:spacing w:after="160" w:line="300" w:lineRule="auto"/>',
            [
                style("Normal", "Normal", based=""),
                style("Title", "Title", '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:sz w:val="56"/><w:color w:val="1F4D3A" w:themeColor="accent1"/>',
                      '<w:spacing w:after="60"/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="B08D57"/></w:pBdr>'),
                style("Subtitle", "Subtitle", '<w:i/><w:sz w:val="28"/><w:color w:val="6B7F73"/>', '<w:spacing w:after="360"/>'),
                style("Heading1", "heading 1", '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:sz w:val="32"/><w:color w:val="1F4D3A" w:themeColor="accent1"/>',
                      '<w:keepNext/><w:spacing w:before="360" w:after="120"/>'),
                style("Heading2", "heading 2", '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:smallCaps/><w:sz w:val="26"/><w:color w:val="B08D57"/>',
                      '<w:keepNext/><w:spacing w:before="240" w:after="80"/>'),
                style("Quote", "Quote", '<w:i/><w:color w:val="1F4D3A"/>', '<w:ind w:left="720"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="B08D57"/></w:pBdr>'),
                style("Header", "header", '<w:rFonts w:ascii="EB Garamond" w:hAnsi="EB Garamond"/><w:caps/><w:spacing w:val="40"/><w:sz w:val="18"/><w:color w:val="1F4D3A"/>'),
                style("Footer", "footer", '<w:sz w:val="16"/><w:color w:val="6B7F73"/>'),
            ],
        ),
        "word/document.xml": document(body, (11906, 16838), {"top": 1701, "right": 1417, "bottom": 1417, "left": 1417, "header": 709, "footer": 709}),
        "word/header1.xml": header("Hollowmere Estates · Est. 1898"),
        "word/footer1.xml": footer_page_of_pages("Page "),
    })


def memo_office() -> None:
    blue = "2F5597"
    body = [
        para("Platform migration plan", "Title"),
        para("Internal memo · Engineering", "Subtitle"),
        para("Summary", "Heading1"),
        para("We will move the billing service to the new cluster in three steps over six weeks. Each step can be rolled back within an hour."),
        para("Timeline", "Heading1"),
        para("Week 1 to 2", "Heading2"),
        para("Shadow traffic on the new cluster; compare responses and latency."),
        para("Week 3 to 6", "Heading2"),
        para("Shift traffic in 10 % steps, then retire the old hosts."),
        para("Risks", "Heading1"),
        para("The batch exports depend on the old file share. They move first."),
    ]
    write("memo-office.docx", {
        "[Content_Types].xml": CONTENT_TYPES,
        "_rels/.rels": ROOT_RELS,
        "word/_rels/document.xml.rels": DOC_RELS,
        "word/theme/theme1.xml": theme("Calibri Light", "Calibri", {
            "dk1": "000000", "lt1": "FFFFFF", "dk2": "44546A", "lt2": "E7E6E6",
            "accent1": "4472C4", "accent2": "ED7D31", "accent3": "A5A5A5", "accent4": "FFC000",
            "accent5": "5B9BD5", "accent6": "70AD47", "hlink": "0563C1", "folHlink": "954F72",
        }),
        "word/styles.xml": styles(
            '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/>',
            '<w:spacing w:after="160" w:line="259" w:lineRule="auto"/>',
            [
                style("Normal", "Normal", based=""),
                style("Title", "Title", '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:spacing w:val="-10"/><w:sz w:val="56"/>', '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>'),
                style("Subtitle", "Subtitle", f'<w:color w:val="5A5A5A"/><w:spacing w:val="15"/>', '<w:spacing w:after="160"/>'),
                style("Heading1", "heading 1", f'<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:sz w:val="32"/><w:color w:val="{blue}" w:themeColor="accent1" w:themeShade="BF"/>', '<w:keepNext/><w:spacing w:before="240" w:after="0"/>'),
                style("Heading2", "heading 2", f'<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:sz w:val="26"/><w:color w:val="{blue}" w:themeColor="accent1" w:themeShade="BF"/>', '<w:keepNext/><w:spacing w:before="40" w:after="0"/>'),
                style("Header", "header"),
                style("Footer", "footer", '<w:sz w:val="18"/>'),
            ],
        ),
        "word/document.xml": document(body, (12240, 15840), {"top": 1440, "right": 1440, "bottom": 1440, "left": 1440, "header": 720, "footer": 720}),
        "word/header1.xml": header("Confidential"),
        "word/footer1.xml": footer_page_of_pages(""),
    })


if __name__ == "__main__":
    letter_serif()
    memo_office()
