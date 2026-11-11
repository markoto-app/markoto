"""Build the bundled web fonts in fonts/<slug>/ from the CTAN originals.

Families that are not on Fontsource (TeX Gyre, Latin Modern; GUST Font
License) are committed to the repo as WOFF2 subsets and served like every
other theme font under /vendor/fonts/ (see shared/utils/theme/themeFonts.ts,
scripts/lib/vendorAssets.ts). This script is how those files were made;
run it again only to refresh them:

    curl -sSLO https://mirrors.ctan.org/fonts/tex-gyre.zip
    curl -sSLO https://mirrors.ctan.org/fonts/lm.zip
    curl -sSLO https://mirrors.ctan.org/fonts/cm-unicode.zip
    unzip -q tex-gyre.zip -d ctan && unzip -q lm.zip -d ctan && unzip -q cm-unicode.zip -d ctan
    uv run --with fonttools --with brotli scripts/build-bundled-fonts.py ctan

Each file is the original OpenType font cut down to Latin + Latin
Extended + punctuation, currency, arrows and the common math operators
(+ Greek for TeX Gyre, which has the monotonic alphabet), with the
layout features a document uses, and its CFF outlines converted
to TrueType quadratics (Chromium's PDF backend embeds CFF fonts as Type 3
glyph procedures; TrueType outlines embed as real fonts — the server PDF
comes from Chromium). The GUST Font License asks (not requires) that
derived files get new names, so the files are renamed and the name table
says "(markoto subset)".

Latin Modern has only the capital Greek letters (no "μ" in "3 μm"), so
the Latin Modern families get a Greek companion cut from CM Unicode
(Computer Modern Unicode, SIL Open Font License, same Computer Modern
design): Greek + Greek Extended only, served under the Latin Modern
family name with a Greek `unicode-range` (themeFonts.ts), vertical
metrics copied from the matching Latin Modern font so a Greek word
doesn't change the line height. "Computer Modern Unicode fonts" is a
Reserved Font Name, so those files are renamed "markoto Greek Serif" /
"markoto Greek Mono" and say what they were cut from.
"""
import os
import sys
from fontTools import subset
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable

UNICODES = (
    'U+0000-024F, U+02B0-02FF, U+0300-036F, U+1E00-1EFF, U+2000-206F, '
    'U+2070-209F, U+20A0-20CF, U+2100-214F, U+2150-218F, U+2190-21FF, '
    'U+2200-22FF, U+25A0-25FF, U+FB00-FB06, U+FEFF, U+FFFD'
)
FEATURES = ['kern', 'liga', 'clig', 'ccmp', 'locl', 'mark', 'mkmk', 'smcp', 'c2sc',
            'onum', 'lnum', 'tnum', 'pnum', 'frac', 'sups', 'subs']

GREEK_UNICODES = 'U+0370-03FF, U+1F00-1FFF'
# Families whose own files keep their Greek (TeX Gyre: the monotonic alphabet).
WITH_GREEK = {'tex-gyre-termes', 'tex-gyre-heros'}

# slug -> (source dir inside the CTAN tree, [(source file, output file)])
FAMILIES = {
    'tex-gyre-termes': ('tex-gyre/opentype', [
        ('texgyretermes-regular.otf', 'termes-regular.woff2'),
        ('texgyretermes-italic.otf', 'termes-italic.woff2'),
        ('texgyretermes-bold.otf', 'termes-bold.woff2'),
        ('texgyretermes-bolditalic.otf', 'termes-bolditalic.woff2'),
    ]),
    'tex-gyre-heros': ('tex-gyre/opentype', [
        ('texgyreheros-regular.otf', 'heros-regular.woff2'),
        ('texgyreheros-italic.otf', 'heros-italic.woff2'),
        ('texgyreheros-bold.otf', 'heros-bold.woff2'),
        ('texgyreheros-bolditalic.otf', 'heros-bolditalic.woff2'),
    ]),
    'latin-modern-mono': ('lm/fonts/opentype/public/lm', [
        ('lmmono10-regular.otf', 'lmmono-regular.woff2'),
        ('lmmono10-italic.otf', 'lmmono-italic.woff2'),
        # Latin Modern's bold typewriter lives in the "light" cut.
        ('lmmonolt10-bold.otf', 'lmmono-bold.woff2'),
    ]),
    'latin-modern-roman': ('lm/fonts/opentype/public/lm', [
        ('lmroman10-regular.otf', 'lmroman-regular.woff2'),
        ('lmroman10-italic.otf', 'lmroman-italic.woff2'),
        ('lmroman10-bold.otf', 'lmroman-bold.woff2'),
        ('lmroman10-bolditalic.otf', 'lmroman-bolditalic.woff2'),
    ]),
}


LM_DIR = 'lm/fonts/opentype/public/lm'

# Greek companions: slug -> (new family name, [(CM Unicode file, output file, Latin Modern file for the vertical metrics)])
GREEK_COMPANIONS = {
    'latin-modern-roman': ('markoto Greek Serif', [
        ('cmunrm.otf', 'cmu-greek-regular.woff2', 'lmroman10-regular.otf'),
        ('cmunti.otf', 'cmu-greek-italic.woff2', 'lmroman10-italic.otf'),
        ('cmunbx.otf', 'cmu-greek-bold.woff2', 'lmroman10-bold.otf'),
        ('cmunbi.otf', 'cmu-greek-bolditalic.woff2', 'lmroman10-bolditalic.otf'),
    ]),
    'latin-modern-mono': ('markoto Greek Mono', [
        ('cmuntt.otf', 'cmu-greek-regular.woff2', 'lmmono10-regular.otf'),
        ('cmunit.otf', 'cmu-greek-italic.woff2', 'lmmono10-italic.otf'),
        ('cmuntb.otf', 'cmu-greek-bold.woff2', 'lmmonolt10-bold.otf'),
    ]),
}
CMU_DIR = 'cm-unicode/fonts/otf'


def cff_to_truetype(font: TTFont) -> None:
    """CFF (cubic) outlines → glyf (quadratic), after fontTools' Snippets/otf2ttf.py."""
    if 'CFF ' not in font:
        return
    glyph_order = font.getGlyphOrder()
    glyph_set = font.getGlyphSet()
    glyf = newTable('glyf')
    glyf.glyphOrder = glyph_order
    glyf.glyphs = {}
    for name in glyph_order:
        pen = TTGlyphPen(glyph_set)
        glyph_set[name].draw(Cu2QuPen(pen, 1.0, reverse_direction=True))
        glyf[name] = pen.glyph()
    font['loca'] = newTable('loca')
    font['glyf'] = glyf
    del font['CFF ']
    if 'VORG' in font:
        del font['VORG']
    font['head'].glyphDataFormat = 0
    post = font['post']
    post.formatType = 2.0
    post.extraNames = []
    post.mapping = {}
    post.glyphOrder = glyph_order
    maxp = font['maxp']
    maxp.tableVersion = 0x00010000
    for field in ('maxZones', 'maxTwilightPoints', 'maxStorage', 'maxFunctionDefs', 'maxInstructionDefs',
                  'maxStackElements', 'maxSizeOfInstructions', 'maxComponentElements'):
        setattr(maxp, field, 0)
    maxp.maxZones = 1
    maxp.maxComponentDepth = 0
    font.sfntVersion = '\x00\x01\x00\x00'


def rename(font: TTFont) -> None:
    for record in font['name'].names:
        if record.nameID in (1, 3, 4, 16):
            record.string = f'{record.toUnicode()} (markoto subset)'
        elif record.nameID == 6:
            record.string = f'{record.toUnicode()}-markotoSubset'


def rename_companion(font: TTFont, family: str, style: str) -> None:
    """New names without the Reserved Font Name; the copyright + licence records stay."""
    names = {
        1: family,
        2: style,
        3: f'{family} {style}; cut from CM Unicode by markoto',
        4: f'{family} {style}',
        6: f'{family.replace(" ", "")}-{style.replace(" ", "")}',
        16: family,
        17: style,
    }
    table = font['name']
    table.names = [r for r in table.names if r.nameID not in names]
    for name_id, value in names.items():
        table.setName(value, name_id, 3, 1, 0x409)


def copy_vertical_metrics(font: TTFont, source: TTFont) -> None:
    for field in ('ascent', 'descent', 'lineGap'):
        setattr(font['hhea'], field, getattr(source['hhea'], field))
    for field in ('sTypoAscender', 'sTypoDescender', 'sTypoLineGap', 'usWinAscent', 'usWinDescent'):
        setattr(font['OS/2'], field, getattr(source['OS/2'], field))


def subset_font(path: str, unicodes: list) -> TTFont:
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = FEATURES
    options.name_IDs = ['*']
    options.notdef_outline = True
    options.desubroutinize = True
    font = TTFont(path)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    cff_to_truetype(font)
    return font


def main(ctan: str, out: str) -> None:
    for slug, (src_dir, files) in FAMILIES.items():
        dest = os.path.join(out, slug)
        os.makedirs(dest, exist_ok=True)
        unicodes = subset.parse_unicodes(UNICODES + (', ' + GREEK_UNICODES if slug in WITH_GREEK else ''))
        for src, target in files:
            font = subset_font(os.path.join(ctan, src_dir, src), unicodes)
            rename(font)
            font.flavor = 'woff2'
            font.save(os.path.join(dest, target))
            print(slug, target, os.path.getsize(os.path.join(dest, target)))
    greek = subset.parse_unicodes(GREEK_UNICODES)
    styles = {'regular': 'Regular', 'italic': 'Italic', 'bold': 'Bold', 'bolditalic': 'Bold Italic'}
    for slug, (family, files) in GREEK_COMPANIONS.items():
        dest = os.path.join(out, slug)
        for src, target, metrics_from in files:
            font = subset_font(os.path.join(ctan, CMU_DIR, src), greek)
            copy_vertical_metrics(font, TTFont(os.path.join(ctan, LM_DIR, metrics_from)))
            rename_companion(font, family, styles[target.removeprefix('cmu-greek-').removesuffix('.woff2')])
            font.flavor = 'woff2'
            font.save(os.path.join(dest, target))
            print(slug, target, os.path.getsize(os.path.join(dest, target)))


if __name__ == '__main__':
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    main(sys.argv[1], os.path.join(root, 'fonts'))
