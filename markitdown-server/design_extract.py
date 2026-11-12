"""
Design facts of an uploaded PDF / DOCX for "Create a design from a document".

Runs inside the markitdown container only (a forked, memory- and
time-capped child, see server.py): the file is untrusted and must never be
parsed by the app process. Returns plain data, no file content beyond a
short text sample:

  DOCX: read deterministically from the package XML: theme fonts and
          colours (`word/theme/theme1.xml`), the resolved paragraph styles
          that matter for a document design (Normal, Title, Subtitle,
          Heading 1-4, Quote, Caption, Hyperlink) from `word/styles.xml`,
          page size / margins / columns and the default header + footer
          text from the body's `sectPr`, and which fonts / sizes / colours
          the body text uses. No page pictures: rendering Word layout
          would need LibreOffice (≈ 600 MB), and the styles describe the
          design more exactly than a picture.
  PDF: the first pages rendered to PNG (pypdfium2, already shipped by
          markitdown[all]) for the vision model, plus measured facts from
          pdfplumber: page size, text margins, the fonts / sizes / colours
          of the text, filled shapes (colour bands, rules), and the text
          lines with their font so headings and running heads can be told
          apart.

XML is parsed with defusedxml (no entity expansion, no external
entities). Zip archives pass server.check_archive before they get here.
"""

from __future__ import annotations

import base64
import io
import re
import zipfile
from collections import Counter, defaultdict
from typing import Any

from defusedxml import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"

MAX_PAGES = 4
# Rendered page width in pixels: enough for a vision model to read type
# and spacing, small enough to keep the request cheap (~1 MP per page).
PAGE_PX_WIDTH = 900
TEXT_SAMPLE_CHARS = 3000
MAX_LINES = 80
MAX_PARAGRAPHS = 80

# Styles that describe a document design. Keys are lower-cased style names.
DOCX_STYLE_NAMES = {
    "normal": "normal",
    "title": "title",
    "subtitle": "subtitle",
    "heading 1": "heading1",
    "heading 2": "heading2",
    "heading 3": "heading3",
    "heading 4": "heading4",
    "quote": "quote",
    "intense quote": "intenseQuote",
    "caption": "caption",
    "hyperlink": "hyperlink",
    "header": "header",
    "footer": "footer",
    "list paragraph": "listParagraph",
}

THEME_COLOR_ALIASES = {
    "text1": "dk1",
    "background1": "lt1",
    "text2": "dk2",
    "background2": "lt2",
    "dark1": "dk1",
    "light1": "lt1",
    "dark2": "dk2",
    "light2": "lt2",
    "hyperlink": "hlink",
    "followedHyperlink": "folHlink",
}


class ExtractError(Exception):
    """The file can't be read as the claimed format (user-facing, short)."""


# helpers


def _hex(value: str | None) -> str | None:
    if not value or not re.fullmatch(r"[0-9A-Fa-f]{6}", value):
        return None
    return "#" + value.upper()


def _num(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _on(el) -> bool | None:
    """A WordprocessingML toggle property (`<w:b/>`, `<w:b w:val="0"/>`)."""
    if el is None:
        return None
    val = el.get(W + "val")
    return val not in ("0", "false", "off")


def _twips_to_mm(twips: float) -> float:
    return round(twips / 1440 * 25.4, 1)


def _top(counter: Counter, n: int) -> list[dict[str, Any]]:
    total = sum(counter.values()) or 1
    return [{"value": k, "share": round(v / total, 3)} for k, v in counter.most_common(n)]


def _read_xml(archive: zipfile.ZipFile, name: str):
    try:
        with archive.open(name) as stream:
            return ET.fromstring(stream.read())
    except KeyError:
        return None
    except ET.ParseError as e:
        raise ExtractError(f"{name} is not valid XML") from e


def _rels(archive: zipfile.ZipFile, part: str) -> dict[str, str]:
    """Relationship id → target part name for `part` (e.g. word/document.xml)."""
    folder, _, file = part.rpartition("/")
    root = _read_xml(archive, f"{folder}/_rels/{file}.rels")
    out: dict[str, str] = {}
    if root is None:
        return out
    for rel in root.iter(PKG_REL + "Relationship"):
        target = rel.get("Target") or ""
        if rel.get("TargetMode") == "External" or not target:
            continue
        out[rel.get("Id", "")] = (
            target.lstrip("/") if target.startswith("/") else f"{folder}/{target}"
        )
    return out


# DOCX


def _theme(archive: zipfile.ZipFile) -> dict[str, Any]:
    names = sorted(n for n in archive.namelist() if re.fullmatch(r"word/theme/theme\d*\.xml", n))
    root = _read_xml(archive, names[0]) if names else None
    out: dict[str, Any] = {"fonts": {}, "colors": {}}
    if root is None:
        return out
    for kind in ("majorFont", "minorFont"):
        latin = root.find(f".//{A}{kind}/{A}latin")
        if latin is not None and latin.get("typeface"):
            out["fonts"]["major" if kind == "majorFont" else "minor"] = latin.get("typeface")
    scheme = root.find(f".//{A}clrScheme")
    if scheme is not None:
        for slot in scheme:
            name = slot.tag.replace(A, "")
            srgb = slot.find(A + "srgbClr")
            sys_clr = slot.find(A + "sysClr")
            color = (
                _hex(srgb.get("val"))
                if srgb is not None
                else _hex(sys_clr.get("lastClr"))
                if sys_clr is not None
                else None
            )
            if color:
                out["colors"][name] = color
    return out


class _DocxResolver:
    def __init__(self, theme: dict[str, Any]):
        self.theme = theme

    def font(self, rfonts) -> str | None:
        if rfonts is None:
            return None
        for attr in ("ascii", "hAnsi"):
            if rfonts.get(W + attr):
                return rfonts.get(W + attr)
        for attr in ("asciiTheme", "hAnsiTheme"):
            ref = rfonts.get(W + attr) or ""
            if ref.startswith("major"):
                return self.theme["fonts"].get("major")
            if ref.startswith("minor"):
                return self.theme["fonts"].get("minor")
        return None

    def color(self, el) -> str | None:
        if el is None:
            return None
        # Word writes the resolved colour (tint / shade applied) into
        # w:val next to w:themeColor; the theme slot is the fallback.
        explicit = _hex(el.get(W + "val"))
        if explicit:
            return explicit
        theme_ref = el.get(W + "themeColor")
        if theme_ref:
            slot = THEME_COLOR_ALIASES.get(theme_ref, theme_ref)
            resolved = self.theme["colors"].get(slot)
            if resolved:
                return resolved
        return None

    def run_props(self, rpr) -> dict[str, Any]:
        if rpr is None:
            return {}
        props: dict[str, Any] = {}
        font = self.font(rpr.find(W + "rFonts"))
        if font:
            props["font"] = font
        size = _num(rpr.find(W + "sz").get(W + "val") if rpr.find(W + "sz") is not None else None)
        if size:
            props["sizePt"] = size / 2
        for tag, key in (
            ("b", "bold"),
            ("i", "italic"),
            ("caps", "allCaps"),
            ("smallCaps", "smallCaps"),
            ("u", "underline"),
        ):
            el = rpr.find(W + tag)
            if el is not None:
                props[key] = el.get(W + "val") not in ("none",) if tag == "u" else _on(el)
        color = self.color(rpr.find(W + "color"))
        if color:
            props["color"] = color
        spacing = (
            _num(rpr.find(W + "spacing").get(W + "val"))
            if rpr.find(W + "spacing") is not None
            else None
        )
        if spacing:
            props["letterSpacingPt"] = round(spacing / 20, 2)
        shd = rpr.find(W + "shd")
        if shd is not None and _hex(shd.get(W + "fill")):
            props["highlight"] = _hex(shd.get(W + "fill"))
        return props

    def para_props(self, ppr) -> dict[str, Any]:
        if ppr is None:
            return {}
        props: dict[str, Any] = {}
        spacing = ppr.find(W + "spacing")
        if spacing is not None:
            before, after, line = (_num(spacing.get(W + k)) for k in ("before", "after", "line"))
            if before is not None:
                props["spaceBeforePt"] = before / 20
            if after is not None:
                props["spaceAfterPt"] = after / 20
            if line is not None and spacing.get(W + "lineRule", "auto") == "auto":
                props["lineSpacing"] = round(line / 240, 2)
        jc = ppr.find(W + "jc")
        if jc is not None and jc.get(W + "val"):
            props["align"] = jc.get(W + "val")
        ind = ppr.find(W + "ind")
        if ind is not None:
            left = _num(ind.get(W + "left") or ind.get(W + "start"))
            first = _num(ind.get(W + "firstLine"))
            if left:
                props["indentLeftPt"] = left / 20
            if first:
                props["firstLineIndentPt"] = first / 20
        borders = ppr.find(W + "pBdr")
        if borders is not None:
            for side in ("top", "bottom", "left"):
                b = borders.find(W + side)
                if b is not None and b.get(W + "val") not in (None, "nil", "none"):
                    props[f"border{side.capitalize()}"] = {
                        "color": _hex(b.get(W + "color")) or "auto",
                        "widthPt": (_num(b.get(W + "sz")) or 4) / 8,
                    }
        shd = ppr.find(W + "shd")
        if shd is not None and _hex(shd.get(W + "fill")):
            props["background"] = _hex(shd.get(W + "fill"))
        return props


def _styles(archive: zipfile.ZipFile, res: _DocxResolver) -> tuple[dict[str, Any], dict[str, str]]:
    """(design styles by our key, styleId → style name for every style)."""
    root = _read_xml(archive, "word/styles.xml")
    if root is None:
        return {}, {}
    defaults: dict[str, Any] = {}
    doc_defaults = root.find(W + "docDefaults")
    if doc_defaults is not None:
        defaults.update(res.run_props(doc_defaults.find(f"{W}rPrDefault/{W}rPr")))
        defaults.update(res.para_props(doc_defaults.find(f"{W}pPrDefault/{W}pPr")))

    raw: dict[str, dict[str, Any]] = {}
    names: dict[str, str] = {}
    for style in root.iter(W + "style"):
        style_id = style.get(W + "styleId") or ""
        name_el = style.find(W + "name")
        name = (name_el.get(W + "val") if name_el is not None else style_id) or style_id
        names[style_id] = name
        based = style.find(W + "basedOn")
        props = {}
        props.update(res.para_props(style.find(W + "pPr")))
        props.update(res.run_props(style.find(W + "rPr")))
        raw[style_id] = {
            "name": name,
            "basedOn": based.get(W + "val") if based is not None else None,
            "props": props,
        }

    def resolved(style_id: str, depth: int = 0) -> dict[str, Any]:
        entry = raw.get(style_id)
        if entry is None or depth > 10:
            return dict(defaults)
        base = resolved(entry["basedOn"], depth + 1) if entry["basedOn"] else dict(defaults)
        base.update(entry["props"])
        return base

    out: dict[str, Any] = {"defaults": defaults}
    for style_id, entry in raw.items():
        key = DOCX_STYLE_NAMES.get(entry["name"].lower())
        if key and key not in out:
            out[key] = resolved(style_id)
    return out, names


def _part_text(archive: zipfile.ZipFile, part: str) -> dict[str, Any]:
    """Text of a header/footer part, page fields as {page} / {pages}, tabs as ' | '."""
    root = _read_xml(archive, part)
    if root is None:
        return {"text": "", "hasImage": False}
    out: list[str] = []
    for para in root.iter(W + "p"):
        line: list[str] = []
        # A fldSimple's own runs hold its cached result ("3"): skipped.
        cached = {id(t) for f in para.iter(W + "fldSimple") for t in f.iter(W + "t")}
        in_field = False
        in_result = False
        instr = ""
        for el in para.iter():
            tag = el.tag
            if tag == W + "fldSimple":
                line.append(_field_token(el.get(W + "instr", "")))
            elif tag == W + "fldChar":
                kind = el.get(W + "fldCharType")
                if kind == "begin":
                    in_field, in_result, instr = True, False, ""
                elif kind == "separate":
                    in_result = True
                elif kind == "end":
                    line.append(_field_token(instr))
                    in_field = in_result = False
            elif tag == W + "instrText" and in_field:
                instr += el.text or ""
            elif tag == W + "t" and not in_result and id(el) not in cached:
                line.append(el.text or "")
            elif tag == W + "tab":
                line.append(" | ")
        text = re.sub(r"\s+", " ", "".join(line)).strip(" |")
        if text:
            out.append(text)
    has_image = any(True for _ in root.iter(W + "drawing")) or any(
        True for _ in root.iter("{urn:schemas-microsoft-com:vml}imagedata")
    )
    return {"text": " / ".join(out)[:300], "hasImage": has_image}


def _field_token(instr: str) -> str:
    word = instr.strip().split(" ")[0].upper() if instr.strip() else ""
    return {
        "PAGE": "{page}",
        "NUMPAGES": "{pages}",
        "SECTIONPAGES": "{pages}",
        "TITLE": "{title}",
        "DATE": "{date}",
        "AUTHOR": "{author}",
    }.get(word, "")


def _section(archive: zipfile.ZipFile, body, rels: dict[str, str]) -> dict[str, Any]:
    sect = body.find(W + "sectPr") if body is not None else None
    if sect is None and body is not None:
        found = list(body.iter(W + "sectPr"))
        sect = found[-1] if found else None
    out: dict[str, Any] = {}
    if sect is None:
        return out
    size = sect.find(W + "pgSz")
    if size is not None:
        w, h = _num(size.get(W + "w")), _num(size.get(W + "h"))
        if w and h:
            out["pageWidthMm"], out["pageHeightMm"] = _twips_to_mm(w), _twips_to_mm(h)
        out["orientation"] = size.get(W + "orient") or (
            "landscape" if (w or 0) > (h or 0) else "portrait"
        )
    margins = sect.find(W + "pgMar")
    if margins is not None:
        out["marginsMm"] = {
            k: _twips_to_mm(_num(margins.get(W + k)) or 0)
            for k in ("top", "right", "bottom", "left", "header", "footer")
        }
    cols = sect.find(W + "cols")
    if cols is not None and _num(cols.get(W + "num")):
        out["columns"] = int(_num(cols.get(W + "num")) or 1)
    out["differentFirstPage"] = (
        sect.find(W + "titlePg") is not None and _on(sect.find(W + "titlePg")) is not False
    )
    for kind in ("header", "footer"):
        refs = {
            ref.get(W + "type", "default"): ref.get(R + "id")
            for ref in sect.iter(W + f"{kind}Reference")
        }
        for which in ("default", "first"):
            part = rels.get(refs.get(which) or "")
            if part:
                out[f"{kind}{'' if which == 'default' else 'First'}"] = _part_text(archive, part)
    return out


def extract_docx(body: bytes) -> dict[str, Any]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(body))
    except zipfile.BadZipFile as e:
        raise ExtractError("not a Word document") from e
    with archive:
        if "word/document.xml" not in archive.namelist():
            raise ExtractError("not a Word document")
        theme = _theme(archive)
        res = _DocxResolver(theme)
        styles, style_names = _styles(archive, res)
        doc = _read_xml(archive, "word/document.xml")
        body_el = doc.find(W + "body") if doc is not None else None
        section = _section(archive, body_el, _rels(archive, "word/document.xml"))

        fonts: Counter = Counter()
        sizes: Counter = Counter()
        colors: Counter = Counter()
        fills: Counter = Counter()
        paragraphs: list[str] = []
        text_len = 0
        tables = 0
        title_seen = False
        title_page_break: bool | None = None
        if body_el is not None:
            tables = sum(1 for _ in body_el.iter(W + "tbl"))
            for shd in body_el.iter(W + "shd"):
                fill = _hex(shd.get(W + "fill"))
                if fill and fill != "#FFFFFF":
                    fills[fill] += 1
            for para in body_el.iter(W + "p"):
                ppr = para.find(W + "pPr")
                style_el = ppr.find(W + "pStyle") if ppr is not None else None
                style = (
                    style_names.get(style_el.get(W + "val", ""), style_el.get(W + "val", ""))
                    if style_el is not None
                    else "Normal"
                )
                text = "".join(t.text or "" for t in para.iter(W + "t")).strip()
                # Is the Title a title PAGE (a page break follows soon) or a
                # title at the top of the first text page?
                breaks = any(b.get(W + "type") == "page" for b in para.iter(W + "br")) or (
                    ppr is not None
                    and (
                        ppr.find(W + "pageBreakBefore") is not None
                        or ppr.find(W + "sectPr") is not None
                    )
                )
                if title_seen and title_page_break is None and breaks:
                    title_page_break = True
                if style.lower() == "title":
                    title_seen = True
                for run in para.iter(W + "r"):
                    props = res.run_props(run.find(W + "rPr"))
                    n = sum(len(t.text or "") for t in run.iter(W + "t"))
                    if not n:
                        continue
                    fonts[props.get("font", "(style)")] += n
                    if "sizePt" in props:
                        sizes[props["sizePt"]] += n
                    if "color" in props:
                        colors[props["color"]] += n
                if text and len(paragraphs) < MAX_PARAGRAPHS and text_len < TEXT_SAMPLE_CHARS:
                    snippet = text[:200]
                    paragraphs.append(f"[{style}] {snippet}")
                    text_len += len(snippet)

        return {
            "format": "docx",
            "pageCount": None,
            "pages": [],
            "docx": {
                "themeFonts": theme["fonts"],
                "themeColors": theme["colors"],
                "styles": styles,
                "section": section,
                "directFormatting": {
                    "fonts": _top(fonts, 6),
                    "sizesPt": _top(sizes, 6),
                    "colors": _top(colors, 8),
                    "cellFills": _top(fills, 6),
                },
                "tables": tables,
                # None: no Title-style paragraph. False: the title sits on
                # the first text page (no separate title page).
                "titleOnOwnPage": (title_page_break is True) if title_seen else None,
                "imageCount": sum(1 for n in archive.namelist() if n.startswith("word/media/")),
            },
            "textSample": "\n".join(paragraphs),
        }


# PDF


def _color_hex(color: Any) -> str | None:
    """pdfplumber colour (gray / RGB / CMYK tuple, 0-1) → #RRGGBB."""
    if color is None:
        return None
    if isinstance(color, (int, float)):
        color = (color,)
    if not isinstance(color, (list, tuple)) or not all(isinstance(c, (int, float)) for c in color):
        return None
    if len(color) == 1:
        r = g = b = color[0]
    elif len(color) == 3:
        r, g, b = color
    elif len(color) == 4:
        c, m, y, k = color
        r, g, b = (1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)
    else:
        return None
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02X}" for v in (r, g, b))


def _font_name(raw: str) -> str:
    """`ABCDEF+Merriweather-Bold` → `Merriweather-Bold`."""
    return raw.split("+", 1)[1] if re.match(r"^[A-Z]{6}\+", raw or "") else (raw or "")


def _pt_to_mm(pt: float) -> float:
    return round(pt / 72 * 25.4, 1)


def render_pdf_pages(body: bytes, max_pages: int) -> tuple[int, list[dict[str, Any]]]:
    import pypdfium2 as pdfium

    try:
        pdf = pdfium.PdfDocument(body)
    except pdfium.PdfiumError as e:
        raise ExtractError("not a readable PDF (damaged or password-protected)") from e
    try:
        count = len(pdf)
        pages = []
        for i in range(min(count, max_pages)):
            page = pdf[i]
            width = page.get_width() or 1
            scale = min(PAGE_PX_WIDTH / width, 3.0)
            # pypdfium2 documents `scale` as a float; its signature is
            # unannotated, so the checker infers `int` from the default `1`.
            image = page.render(scale=scale).to_pil().convert("RGB")  # pyright: ignore[reportArgumentType]
            buf = io.BytesIO()
            image.save(buf, format="PNG", optimize=True)
            pages.append(
                {
                    "png": base64.b64encode(buf.getvalue()).decode("ascii"),
                    "width": image.width,
                    "height": image.height,
                }
            )
            page.close()
        return count, pages
    finally:
        pdf.close()


def extract_pdf(body: bytes, max_pages: int = MAX_PAGES) -> dict[str, Any]:
    import pdfplumber

    max_pages = max(1, min(max_pages, MAX_PAGES))
    count, pages = render_pdf_pages(body, max_pages)

    fonts: Counter = Counter()
    sizes: Counter = Counter()
    colors: Counter = Counter()
    # Share of the page area each fill colour covers: fractions, so not a Counter (int counts).
    fills: defaultdict[str, float] = defaultdict(float)
    lines: list[dict[str, Any]] = []
    margins: list[dict[str, float]] = []
    page_size: dict[str, float] = {}
    text_parts: list[str] = []
    try:
        with pdfplumber.open(io.BytesIO(body)) as pdf:
            for index, page in enumerate(pdf.pages[:max_pages]):
                if not page_size:
                    page_size = {
                        "widthMm": _pt_to_mm(page.width),
                        "heightMm": _pt_to_mm(page.height),
                    }
                chars = [c for c in page.chars if (c.get("text") or "").strip()]
                for c in chars:
                    font = _font_name(c.get("fontname", ""))
                    fonts[font] += 1
                    sizes[round(float(c.get("size", 0)), 1)] += 1
                    hexc = _color_hex(c.get("non_stroking_color"))
                    if hexc:
                        colors[hexc] += 1
                if chars:
                    margins.append(
                        {
                            "page": index + 1,
                            "top": _pt_to_mm(min(c["top"] for c in chars)),
                            "right": _pt_to_mm(page.width - max(c["x1"] for c in chars)),
                            "bottom": _pt_to_mm(page.height - max(c["bottom"] for c in chars)),
                            "left": _pt_to_mm(min(c["x0"] for c in chars)),
                        }
                    )
                area = float(page.width * page.height) or 1.0
                for shape in list(page.rects) + list(page.curves):
                    if not shape.get("fill"):
                        continue
                    hexc = _color_hex(shape.get("non_stroking_color"))
                    if not hexc or hexc == "#FFFFFF":
                        continue
                    fills[hexc] += (
                        float(shape.get("width", 0)) * float(shape.get("height", 0)) / area
                    )
                words = page.extract_words(
                    extra_attrs=["fontname", "size"], keep_blank_chars=False, use_text_flow=True
                )
                by_line: dict[tuple[int, str, float], list[dict[str, Any]]] = {}
                for w in words:
                    key = (
                        round(w["top"] / 2),
                        _font_name(w["fontname"]),
                        round(float(w["size"]), 1),
                    )
                    by_line.setdefault(key, []).append(w)
                for (_, font, size), ws in sorted(
                    by_line.items(), key=lambda item: (item[1][0]["top"], item[1][0]["x0"])
                ):
                    if len(lines) >= MAX_LINES:
                        break
                    text = " ".join(w["text"] for w in ws)[:160]
                    first = ws[0]
                    lines.append(
                        {
                            "page": index + 1,
                            "yMm": _pt_to_mm(first["top"]),
                            "xMm": _pt_to_mm(first["x0"]),
                            "font": font,
                            "sizePt": size,
                            "text": text,
                        }
                    )
                if sum(len(p) for p in text_parts) < TEXT_SAMPLE_CHARS:
                    text_parts.append((page.extract_text() or "")[:TEXT_SAMPLE_CHARS])
    except ExtractError:
        raise
    except Exception as e:  # pdfplumber raises many types for damaged files
        raise ExtractError("could not read the PDF's text") from e

    # Text colours: the shares tell body ink from accents.
    return {
        "format": "pdf",
        "pageCount": count,
        "pages": pages,
        "pdf": {
            "pageSize": page_size,
            # Per page: a cover or a short last page would skew one average.
            "textExtentMm": margins,
            "fonts": _top(fonts, 8),
            "sizesPt": _top(sizes, 8),
            "textColors": _top(colors, 8),
            "filledShapes": [
                {"value": k, "pageShare": round(v / max(1, len(pages)), 3)}
                for k, v in sorted(fills.items(), key=lambda kv: kv[1], reverse=True)[:6]
            ],
            "lines": lines,
        },
        "textSample": "\n".join(text_parts)[:TEXT_SAMPLE_CHARS],
    }


def extract_design(body: bytes, ext: str, max_pages: int = MAX_PAGES) -> dict[str, Any]:
    if ext == "docx":
        return extract_docx(body)
    if ext == "pdf":
        return extract_pdf(body, max_pages)
    raise ExtractError(f"unsupported format: {ext}")
