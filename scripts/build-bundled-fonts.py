"""Build the bundled web fonts in fonts/<slug>/ from the CTAN originals.

Families that are not on Fontsource (TeX Gyre, Latin Modern; GUST Font
License) are committed to the repo as WOFF2 subsets and served like every
other theme font under /vendor/fonts/ (see shared/utils/themeFonts.ts,
scripts/lib/vendorAssets.ts). This script is how those files were made;
run it again only to refresh them:

    curl -sSLO https://mirrors.ctan.org/fonts/tex-gyre.zip
    curl -sSLO https://mirrors.ctan.org/fonts/lm.zip
    unzip -q tex-gyre.zip -d ctan && unzip -q lm.zip -d ctan
    uv run --with fonttools --with brotli scripts/build-bundled-fonts.py ctan

Each file is the original OpenType font cut down to Latin + Latin
Extended + punctuation, currency, arrows and the common math operators,
with the layout features a document uses, and its CFF outlines converted
to TrueType quadratics (Chromium's PDF backend embeds CFF fonts as Type 3
glyph procedures; TrueType outlines embed as real fonts — the server PDF
comes from Chromium). The GUST Font License asks (not requires) that
derived files get new names, so the files are renamed and the name table
says "(markoto subset)".
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


def main(ctan: str, out: str) -> None:
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = FEATURES
    options.name_IDs = ['*']
    options.notdef_outline = True
    options.desubroutinize = True
    unicodes = subset.parse_unicodes(UNICODES)
    for slug, (src_dir, files) in FAMILIES.items():
        dest = os.path.join(out, slug)
        os.makedirs(dest, exist_ok=True)
        for src, target in files:
            font = TTFont(os.path.join(ctan, src_dir, src))
            subsetter = subset.Subsetter(options)
            subsetter.populate(unicodes=unicodes)
            subsetter.subset(font)
            cff_to_truetype(font)
            rename(font)
            font.flavor = 'woff2'
            font.save(os.path.join(dest, target))
            print(slug, target, os.path.getsize(os.path.join(dest, target)))


if __name__ == '__main__':
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    main(sys.argv[1], os.path.join(root, 'fonts'))
