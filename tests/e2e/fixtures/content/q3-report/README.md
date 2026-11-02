# Demo document: Quaybridge Q3 2026 quarterly report

A realistic, publication-length markoto document (15 rendered A4 pages) for
the product page, docs walkthroughs and flow tests. It is written as a real
finance team would write it. Markdown features appear only where such a report
would use them: tables (including one wide income statement), three charts,
footnotes, three alerts, page breaks, a cover and a table of contents.

| File | What it is |
|---|---|
| `quaybridge-q3-2026.md` | The document body. The document title is set separately: **Q3 2026 Quarterly Report**. |
| `theme.json` | A complete `DocTheme` (passes `isValidTheme`): the cover page, running header/footer, IBM Plex Sans + Source Serif 4, and a few lines of custom CSS for tabular figures and the wide table. |

The cover shows the render date (markoto has no per-document date field), so
render it with the clock set to **29 October 2026** if the cover should match
the report's publication date.

## The company (keep edits consistent with this)

**Quaybridge Software GmbH**, Hamburg. Founded 2017, Series B in 2024. It
makes B2B SaaS for scheduling truck arrivals at warehouse loading docks
("dock appointments"), plus a carrier network that charges carriers a small
fee per booked appointment. The customers are grocery wholesalers, 3PLs,
building-materials distributors and retailers in Europe. The company and
every person named in the report are invented.

- **Segments:** Subscription (per site, ~79% of revenue), Carrier network
  (~EUR 0.30 per appointment, ~13%), Professional services (~8%, shrinking
  on purpose; partners do small implementations).
- **People:** 123 FTE at Q3 2026 end. Hamburg 71, Rotterdam 24, Kraków 22,
  remote 6. CEO Johanna Severin, CFO Tomasz Wierzba, CTO Ilse van Doorn,
  CRO Benedikt Aurach, Chief Customer Officer Sanne Kuipers (joined 1 July
  2026).
- **Product:** dock scheduling core, Slot Forecast (arrival prediction, GA on
  19 Aug 2026, add-on at 15% of base), carrier app 3.0, WMS connectors.
  Next up: yard management beta, capacity pooling, PL/CZ localisation.
- **Fiscal year** = calendar year. Figures are in EUR k, HGB, unaudited.
  Negative numbers use the true minus sign (−).

### Numbers that must stay consistent

All totals, shares and changes in the report are computed from these. If you
change one, recompute everything derived from it (income statement in
Appendix B, ARR bridge in Appendix C, operating metrics in Appendix D, the key
figures table, the executive summary and the highlights).

| EUR k | Q3 25 | Q4 25 | Q1 26 | Q2 26 | Q3 26 |
|---|--:|--:|--:|--:|--:|
| Subscription | 4,120 | 4,380 | 4,610 | 4,870 | 5,160 |
| Carrier network | 640 | 710 | 690 | 780 | 860 |
| Professional services | 520 | 580 | 470 | 510 | 490 |
| Cost of revenue | 1,670 | 1,740 | 1,730 | 1,750 | 1,750 |
| R&D / S&M / G&A | 2,050 / 1,480 / 760 | 2,120 / 1,620 / 840 | 2,260 / 1,590 / 790 | 2,310 / 1,640 / 800 | 2,380 / 1,690 / 810 |
| D&A | 210 | 220 | 230 | 240 | 250 |
| Closing ARR | 17,100 | 18,000 | 19,000 | 20,100 | 21,300 |
| Customers | 268 | 281 | 296 | 305 | 322 |
| Cash (end) | 16,900 | 15,850 | 14,670 | 14,070 | 14,200 |

Q1 25 and Q2 25 (needed only for the 9-month columns): revenue 4,710 / 4,980
(subscription 3,720 / 3,920, network 520 / 580, services 470 / 480), cost of
revenue 1,560 / 1,610, R&D 1,890 / 1,960, S&M 1,350 / 1,420, G&A 720 / 740,
D&A 190 / 200. FY 2025 revenue was 20,640. FY 2026 guidance: revenue 25.0–25.4 m,
year-end ARR 22.4–22.8 m, EBITDA −0.1 to +0.2 m.

## Rendering notes

- Page breaks are placed so that no heading is stranded at the bottom of a
  page. markoto (paged.js 0.4.3) does not honour `break-after: avoid` on
  headings, so after any edit that changes the text length, re-check the
  page ends.
- A table cannot carry a `{.class}` attribute (the line after a table becomes
  an extra table row). The custom CSS therefore targets the wide income
  statement as `table:has(th:nth-child(9))`.
- Charts are Mermaid `xychart-beta`, `pie` and `flowchart`. They render as
  images, so they do not use the theme fonts or colours (they use the
  `neutral` Mermaid theme).
