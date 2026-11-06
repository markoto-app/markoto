<!--
  Fixture: structure — engine document structure, any template.
  Stresses: sections at heading level 2 (numbers start at 1, not 0.1); Pandoc
  table captions after ("Table:") and below (":"); numbers with units and
  SEV-1 codes in narrow cells; a captioned figure; a References section as
  a numbered list. The patch turns on numbering, caption and figure labels,
  [1] references and the {section} running head.
-->

[[toc]]

## Scope

This report covers the third quarter. Sections start at the second heading level: the numbers start at 1, not 0.1.

### Data sources

Revenue comes from the ledger, traffic from the web analytics export. Table 1 lists the key figures and Figure 1 the sales trend.

Table: Key figures, third quarter (CHF million)

| Metric | Q3 2026 | Q3 2025 | Change |
|---|--:|--:|--:|
| Net revenue | 48.6 | 42.6 | +14.1 % |
| Gross margin | 54.8 % | 52.7 % | +2.1 pp |
| EBIT | 6.9 | 5.1 | +35.3 % |
| Latency p99 | 180 ms | 240 ms | −25 % |

### Incident classes

| Class | Meaning | Response |
|---|---|---|
| SEV-1 | Customers cannot pay | Page IC within 5 min |
| SEV-2 | One provider failing | Channel, IC optional |
| SEV-3 | No customer impact yet | Ticket |

: Incident severity classes

## Results

![Sales by month, 2026.](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAAB4EAAAAAA97ky/AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRP//FKsxzQAAAAd0SU1FB+oLBg0KB0XjEvMAAAGESURBVHja7dexbQMxFAXBf8YVIPVfpNUBHShRAVoTIGaSO2YvWBDgtdbA9wmL7/td9/uzewgneV4z9/v3sXsLx3jNzMzP7hmcSVgk7s/Dde2e0/NY+R9uLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiIhLBLCIiEsEsIiISwSwiJxfx7W2j2HU7ixSAiLxD0z87x2z+A011qv3Rs4zmP+AMLJEO8foJI5AAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTExLTA2VDEzOjEwOjA3KzAwOjAwu5WCfgAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0xMS0wNlQxMzoxMDowNyswMDowMMrIOsIAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMTEtMDZUMTM6MTA6MDcrMDA6MDCd3RsdAAAAAElFTkSuQmCC)

Sales grew in every month of the quarter. The direct channel grew fastest; wholesale fell after a warm September.

## References

1. G. Kour and R. Saabne, "Real-time segmentation of on-line handwritten arabic script," in *Proc. ICFHR*, 2014, pp. 417–422.
2. R. Keshet, A. Maor, and G. Kour, "Prediction-based, prioritized market-share insight extraction," in *Proc. ADMA*, 2016, pp. 81–94.
3. G. Kour and R. Saabne, "Fast classification of handwritten on-line arabic characters," in *Proc. SoCPaR*, 2014, pp. 312–318.
