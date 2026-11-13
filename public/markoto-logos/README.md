# Markoto logos · v0.2

Bundle of canonical logo assets. Each variant is delivered as both SVG (vector, production-ready, text outlined to paths) and PNG (high-resolution raster, for use in slides, social media, and other contexts where SVG is not supported).

## Contents

| Asset | Use |
|---|---|
| `master-sheet.svg` / `.png` | Brand sheet showing all variants in context. Open this first. |
| `primary-lockup-light.*` | Default lockup — sumi wordmark + shu seal, transparent bg |
| `primary-lockup-dark.*` | Dark lockup — cream wordmark + brighter shu seal, sumi bg |
| `lockup-mono-light.*` | Single-ink, all sumi |
| `lockup-mono-dark.*` | Single-ink inverse, all cream on sumi |
| `seal-master-light.*` | The seal alone, 1024×1024, shu-500 |
| `seal-master-dark.*` | The seal alone, 1024×1024, shu-400 (for dark contexts) |
| `app-icon-light.*` | iOS/Android app icon, bone frame |
| `app-icon-dark.*` | iOS/Android app icon, sumi frame |
| `favicon-{16,32,64,128,256,512}.*` | Pre-rendered favicons at common sizes |

## Notes

- All SVGs are self-contained — no font dependency. Wordmark text is outlined to paths.
- Light-variant lockups have transparent backgrounds (composite onto any warm light surface).
- Dark-variant lockups have explicit sumi-950 backgrounds (cream text needs explicit dark to remain legible).
- The seal in `seal-master-*.svg` has sharp corners. Tiny in-product instances (favicons under 32px, in-product status dots) may soften corners by 1px to reduce aliasing.
- For iOS app icon submission, use `app-icon-{light,dark}.svg` exported as a 1024×1024 PNG with square corners; the OS applies its own squircle mask.
