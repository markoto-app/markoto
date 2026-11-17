import { generateLargeDocument } from '../../fixtures/largeDocument/generate'

// Documents for the live model evaluation. The large one is the v2 handbook
// generator at a smaller size (~28k words, ~60 A4 pages) so a full
// `view_document` on the current loop stays within the eval budget.

export const EVAL_LARGE_WORDS = 28_000

export function largeDocument(): string {
  return generateLargeDocument({ targetWords: EVAL_LARGE_WORDS })
}

/** A short German report whose heading levels are broken (jumps, two H1s, an H2 under an H4). */
export const BROKEN_HEADINGS_DOC = `# Jahresbericht Werkstatt Nord 2026

Die Werkstatt Nord betreut seit 2019 die Fahrzeuge der Linien 4, 7 und 12. Dieser Bericht fasst das Jahr 2026 zusammen.

### Personal

Im Jahr 2026 arbeiteten 23 Personen in der Werkstatt, davon 4 Lernende. Zwei Stellen blieben bis Oktober unbesetzt.

##### Ausbildung

Alle Mitarbeitenden besuchten den Kurs zur Hochvoltsicherheit. Die Lernenden schlossen das erste Lehrjahr ab.

# Fahrzeuge

Der Bestand umfasste 41 Busse, davon 9 mit Batterieantrieb.

#### Wartung

Die mittlere Standzeit pro Inspektion sank von 6,1 auf 5,4 Stunden.

## Ersatzteile

Die Lieferzeiten für Bremsscheiben stiegen im Frühjahr auf bis zu elf Wochen.

#### Lagerbestand

Der Lagerwert betrug Ende Jahr 318 000 Franken.

###### Ausblick

Für 2027 ist eine zweite Hebebühne für Gelenkbusse geplant.
`

/** A short English paper without an abstract. */
export const PAPER_DOC = `# Battery degradation in urban electric buses: one year of fleet data

## 1 Introduction

Transit operators replace diesel buses with battery-electric ones, but planning still relies on manufacturer estimates of battery life. We report one year of measured degradation from a fleet of 41 buses operated by a mid-sized Swiss transit company.

## 2 Data

Each bus logged state of charge, cell temperature and charging power every 10 seconds from January to December 2026. We removed 3 buses with incomplete logs, which left 38 buses and 4.1 million charging events.

## 3 Method

We estimated usable capacity once a week from full charging cycles between 20 % and 95 % state of charge. We fitted a linear mixed model with route, depot charging power and mean cell temperature as fixed effects and the bus as a random effect.

## 4 Results

Mean usable capacity fell by 2.9 % over the year (95 % CI 2.5 to 3.3 %). Buses charged at 150 kW at the depot lost 1.1 percentage points more capacity than buses charged at 50 kW. Routes with more than 40 % of time in stop-and-go traffic showed no measurable difference. Each additional degree of mean cell temperature above 30 °C added 0.4 percentage points of annual capacity loss.

## 5 Discussion

The measured loss is about half of the 6 % that the manufacturer's planning tool assumes for the first year. Charging power and temperature, not route type, explain most of the difference between buses. Operators can extend battery life by charging at lower power overnight when the timetable allows it. The study covers one year and one manufacturer, so the results may not hold for later years or other cell chemistries.

## 6 Conclusion

Measured first-year degradation was lower than planned. Depot charging power and cell temperature are the variables an operator can control.
`
