import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A deterministic, book-length German Markdown document for measuring what the
// in-editor AI loop costs on large documents (tests/bench/ai/). The text is an
// operations handbook ("Betriebshandbuch") of an invented utility; every
// organisation, person, system and place name in it is made up.
//
// The prose is assembled from hand-written sentence templates with slots
// (roles, systems, sites, numbers), so paragraphs vary without an external
// dependency. Swiss spelling: "ss", never the sharp s. The document carries
// every construct a real handbook uses and a large-document tool must survive:
// a preamble before the first heading, numbered H1/H2/H3 headings (some with
// `{#id}`), tables, fenced code (one Mermaid block, one block with lines that
// start with `#`), inline code, inline and block math, upload images, footnotes,
// internal and external links, alerts, page breaks, a task list, a definition
// list and abbreviations. The words "Kunde / Kunden / Kundin / Kundinnen" occur
// about 40 times in about 19 sections (a terminology task can target them) and
// nowhere else, also not in compounds.
//
// `bun tests/fixtures/largeDocument/generate.ts` rewrites the committed copy in
// tests/e2e/fixtures/content/large-handbook/; the unit test fails when that
// copy and the generator disagree.

export interface LargeDocumentOptions {
  /** PRNG seed; the same seed always yields the same document. */
  seed?: number
  /** Approximate number of whitespace-separated words. */
  targetWords?: number
}

/** The fake document id the image URLs use (`/api/files/<docId>/<fileId>.png`). */
export const LARGE_DOC_FAKE_DOC_ID = 'BenchHandbook01'

export const LARGE_DOC_TITLE = 'Betriebshandbuch IT- und Netzbetrieb'

const DEFAULT_SEED = 20261117
const DEFAULT_TARGET_WORDS = 80_000

// Deterministic PRNG (mulberry32).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Rng {
  private readonly next: () => number
  constructor(seed: number) {
    this.next = mulberry32(seed)
  }

  float(): number {
    return this.next()
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)]
    if (item === undefined) throw new Error('pick from an empty list')
    return item
  }
}

// Slot values

interface Role { nom: string, dat: string, acc: string }

const ROLES: readonly Role[] = [
  { nom: 'die Schichtleitung', dat: 'der Schichtleitung', acc: 'die Schichtleitung' },
  { nom: 'der Pikettdienst', dat: 'dem Pikettdienst', acc: 'den Pikettdienst' },
  { nom: 'das Betriebsteam', dat: 'dem Betriebsteam', acc: 'das Betriebsteam' },
  { nom: 'die Netzleitstelle', dat: 'der Netzleitstelle', acc: 'die Netzleitstelle' },
  { nom: 'der Systemverantwortliche', dat: 'dem Systemverantwortlichen', acc: 'den Systemverantwortlichen' },
  { nom: 'die Leiterin Betrieb', dat: 'der Leiterin Betrieb', acc: 'die Leiterin Betrieb' },
  { nom: 'das Sicherheitsteam', dat: 'dem Sicherheitsteam', acc: 'das Sicherheitsteam' },
  { nom: 'die Fachstelle Qualität', dat: 'der Fachstelle Qualität', acc: 'die Fachstelle Qualität' }
]

const PERSONS = [
  'Martina Studer', 'Reto Hänggi', 'Lea Bachmann', 'Samuel Gerber', 'Nadia Imhof', 'Jonas Wyss',
  'Corinne Aebischer', 'Fabian Zollinger', 'Seraina Caflisch', 'Dario Bernasconi', 'Ursina Lötscher', 'Pascal Rüegsegger'
] as const

const SYSTEMS = [
  { nom: 'das Leitsystem Aquila', short: 'Aquila' },
  { nom: 'die Überwachungsplattform Lumen', short: 'Lumen' },
  { nom: 'das Ticketsystem Kairos', short: 'Kairos' },
  { nom: 'die Konfigurationsdatenbank Tessera', short: 'Tessera' },
  { nom: 'die Sicherungsumgebung Boreas', short: 'Boreas' },
  { nom: 'der Verzeichnisdienst Nimbus', short: 'Nimbus' }
] as const

const SITES = ['Birkenmatt', 'Hohwacht', 'Aarenfeld Ost', 'Seewil', 'Lindenbühl', 'Rotach'] as const
const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'] as const
const CODES = ['`CHG-2026-0412`', '`INC-2026-1187`', '`AA-BET-017`', '`AA-NET-004`', '`RZ-WA-12`', '`QS-AUD-03`'] as const
const COMMANDS = ['`kairos ticket list --offen`', '`lumen status --zone rz1`', '`aquila schaltzustand --uw birkenmatt`', '`tessera ci show`', '`boreas job status`'] as const
const PATHS = ['`betrieb/skripte`', '`betrieb/vorlagen`', '`netz/arbeitsanweisungen`', '`rz/konfiguration`'] as const
const CHF = ['5000', '10 000', '20 000', '50 000'] as const

// Generic sentence templates. None of them may contain "Kund" (the
// terminology task counts those words exactly).
const GENERIC_SENTENCES: readonly string[] = [
  'Im Bereich {topic} gilt der Grundsatz, dass jede Tätigkeit nachvollziehbar dokumentiert wird.',
  '{ROLE} prüft die Angaben vor der Freigabe und hält Abweichungen im Ticketsystem Kairos fest.',
  'Die Verantwortung für den Bereich {topic} liegt im Normalbetrieb bei {role.dat}.',
  'Erfahrungsgemäss entstehen die meisten Verzögerungen nicht bei der Ausführung, sondern bei der Abstimmung zwischen den beteiligten Teams.',
  'Massnahmen, die den laufenden Betrieb beeinträchtigen können, werden mindestens {n} Arbeitstage im Voraus angekündigt.',
  'Für Arbeiten am Standort {site} ist zusätzlich die Zustimmung der lokalen Betriebsleitung erforderlich.',
  'Die Überwachungsplattform Lumen meldet Grenzwertverletzungen automatisch an {role.acc}.',
  'Eine Abweichung von mehr als {pct2} Prozent gegenüber dem Vormonat wird im nächsten Betriebsrapport begründet.',
  'Wer eine Störung entdeckt, eröffnet sofort ein Ticket und ordnet es der passenden Kategorie zu.',
  'Das Vier-Augen-Prinzip gilt für alle Eingriffe, die Konfigurationen produktiver Systeme verändern.',
  'Die Zuständigkeiten sind in der Rollenbeschreibung festgehalten und werden jährlich überprüft.',
  'Zwischen sechs und zweiundzwanzig Uhr ist die Netzleitstelle mit mindestens zwei Personen besetzt.',
  'Ausserhalb der regulären Arbeitszeit übernimmt der Pikettdienst die Erstbeurteilung.',
  'Für den Bereich {topic} steht eine Checkliste zur Verfügung, die vor jedem Einsatz durchgegangen wird.',
  'Die Erfahrungen der letzten Jahre zeigen, dass klare Übergaben zwischen den Schichten Fehler deutlich reduzieren.',
  'Jede Änderung erhält eine eindeutige Kennung, zum Beispiel {code}, damit sie später auffindbar bleibt.',
  'Die Messwerte werden alle {sec} Sekunden erfasst und während {n} Monaten aufbewahrt.',
  'Sobald ein Schwellwert überschritten ist, löst Lumen einen Alarm der Stufe {level} aus.',
  '{PERSON} koordiniert als Ansprechperson die Arbeiten im Bereich {topic}.',
  'Bei Unklarheiten entscheidet {role.nom} und informiert anschliessend alle Betroffenen.',
  'Diese Regel hat sich bewährt, weil sie auch unter Zeitdruck einfach anzuwenden ist.',
  'Ein Verstoss gegen die Vorgaben wird nicht als persönliches Versagen behandelt, sondern als Anlass, den Prozess zu verbessern.',
  'Das Protokoll enthält mindestens Datum, Uhrzeit, beteiligte Personen, betroffene Anlagen und das Ergebnis.',
  'Provisorische Lösungen sind zulässig, müssen aber innerhalb von {n} Wochen durch eine dauerhafte Lösung ersetzt werden.',
  'Die Dokumentation in Tessera, der Konfigurationsdatenbank, ist für alle Komponenten verbindlich.',
  'Fehlen Angaben in Tessera, gilt die Komponente als nicht inventarisiert und darf nicht verändert werden.',
  'Im Zweifelsfall hat die Versorgungssicherheit Vorrang vor Termin- und Kostenzielen.',
  'Der Befehl {cmd} zeigt den aktuellen Zustand und eignet sich für eine erste Einschätzung.',
  'Für wiederkehrende Aufgaben sind Vorlagen hinterlegt, die Schreibarbeit sparen und Lücken vermeiden.',
  'Die Kennzahlen werden monatlich ausgewertet und der Geschäftsleitung in einer kurzen Übersicht vorgelegt.',
  'Wichtige Entscheide werden schriftlich bestätigt, auch wenn sie zuvor mündlich besprochen wurden.',
  'Neue Mitarbeitende arbeiten in den ersten {n} Wochen nur zusammen mit einer erfahrenen Fachperson.',
  'Die Schulungsunterlagen dazu liegen im Intranet und werden nach jeder grösseren Änderung aktualisiert.',
  'Eine Eskalation an die nächste Stufe erfolgt spätestens nach {min} Minuten ohne erkennbaren Fortschritt.',
  'Die Kommunikation nach aussen läuft ausschliesslich über die dafür bestimmte Stelle.',
  'Die Zielvorgabe für die Verfügbarkeit liegt bei {pct} Prozent pro Kalenderjahr.',
  'Auch kleine Eingriffe können unerwartete Folgen haben, deshalb wird jeder Schritt vorher geplant.',
  'Am Standort {site} gelten wegen der älteren Anlagen teilweise abweichende Wartungsintervalle.',
  'Die Ergebnisse fliessen in die jährliche Risikobeurteilung ein.',
  'Rückfragen werden innerhalb eines Arbeitstags beantwortet, dringende Fälle sofort.',
  'Das Betriebsteam pflegt eine Liste offener Punkte, die in der Wochenbesprechung durchgegangen wird.',
  'Abhängigkeiten zu anderen Systemen sind im Voraus zu klären, insbesondere zu {sys}.',
  '{SYS} ist redundant aufgebaut und läuft an zwei getrennten Standorten.',
  'Ein Ausfall von {sys} hat keinen direkten Einfluss auf die Versorgung, erschwert aber die Arbeit erheblich.',
  'Zugangsdaten werden nie per E-Mail verschickt, sondern ausschliesslich über den Passworttresor geteilt.',
  'Für jedes Wartungsfenster wird ein Rückfallplan erstellt, der ohne Rücksprache ausgeführt werden kann.',
  'Die Freigabe erteilt {role.nom}, sobald alle Tests erfolgreich abgeschlossen sind.',
  'Wird ein Test nicht bestanden, bleibt die Änderung gesperrt, bis die Ursache geklärt ist.',
  'Die Erfahrung zeigt, dass gut vorbereitete Einsätze im Durchschnitt um {pct2} Prozent kürzer dauern.',
  'Alle Vorgaben in diesem Abschnitt gelten sinngemäss auch für externe Dienstleister.',
  'Fremdpersonal wird vor Arbeitsbeginn instruiert und erhält nur die Berechtigungen, die es tatsächlich benötigt.',
  'Berechtigungen werden quartalsweise überprüft, nicht mehr benötigte Rechte werden entzogen.',
  'Die Daten werden ausschliesslich in Rechenzentren in der Schweiz gespeichert.',
  'Kurze, regelmässige Übungen sind wirksamer als eine einzige grosse Übung pro Jahr.',
  'Jede Übung endet mit einer Nachbesprechung, deren Erkenntnisse in die nächste Planung einfliessen.',
  'Die Zahl der offenen Tickets soll Ende Monat {n2} nicht überschreiten.',
  'Für den Bereich {topic} wird ein einfaches Ampelsystem verwendet.',
  'Grün bedeutet Normalbetrieb, Gelb erhöhte Aufmerksamkeit und Rot unmittelbaren Handlungsbedarf.',
  'Bei Stufe Rot wird die Leiterin Betrieb in jedem Fall persönlich informiert.',
  '{PERSON} hat diesen Ablauf {year} eingeführt, seither ist die Zahl der Rückfragen deutlich gesunken.',
  'Der Ablauf ist bewusst schlank gehalten, damit er auch in hektischen Situationen eingehalten wird.',
  'Ausnahmen sind möglich, müssen aber begründet und befristet werden.',
  'Eine befristete Ausnahme läuft nach {n} Monaten automatisch aus, wenn sie nicht verlängert wird.',
  'Das Monitoring unterscheidet zwischen technischen Alarmen und fachlichen Hinweisen.',
  'Technische Alarme betreffen den Zustand einer Anlage, fachliche Hinweise den Ablauf eines Prozesses.',
  'Die Priorität eines Ereignisses ergibt sich aus seiner Auswirkung und seiner Dringlichkeit.',
  'Wer unsicher ist, wählt die höhere Priorität; eine spätere Herabstufung ist jederzeit möglich.',
  'Der Schichtrapport wird bei jeder Übergabe gemeinsam durchgegangen und von beiden Seiten visiert.',
  'Die Aufbewahrungsfrist für Protokolle beträgt {n} Jahre, sofern das Gesetz keine längere Frist verlangt.',
  'In der Netzleitstelle hängt eine gedruckte Liste der wichtigsten Telefonnummern, falls die elektronischen Systeme ausfallen.',
  'Gerade bei seltenen Tätigkeiten lohnt sich ein kurzer Blick in die Arbeitsanweisung, bevor man beginnt.',
  'Die Arbeitsanweisungen sind fortlaufend nummeriert, etwa {code}, und im Dokumentenverzeichnis abgelegt.',
  'Rückmeldungen zu diesem Kapitel nimmt {PERSON} entgegen.',
  'Änderungen am Handbuch werden einmal pro Quartal gesammelt und gemeinsam freigegeben.',
  'Die Lastspitzen treten typischerweise am {day}morgen zwischen sieben und neun Uhr auf.',
  'Für die Planung wird mit einer jährlichen Zunahme von rund {pct2} Prozent gerechnet.',
  'Ersatzteile für kritische Komponenten werden am Standort {site} gelagert.',
  'Der Lagerbestand wird zweimal pro Jahr mit den Einträgen in Tessera abgeglichen.',
  'Lieferzeiten von mehr als {n} Wochen werden in der Ersatzteilplanung ausdrücklich berücksichtigt.',
  'Vor jedem Eingriff wird geprüft, ob gleichzeitig andere Arbeiten geplant sind, die sich gegenseitig stören könnten.',
  'Der Wartungskalender in Kairos zeigt alle geplanten Arbeiten der nächsten {n} Wochen.',
  'Bei Überschneidungen wird die Arbeit mit dem geringeren Risiko verschoben.',
  'Die Erreichbarkeit des Pikettdienstes wird jeden {day} mit einem Testanruf geprüft.',
  'Ein nicht beantworteter Testanruf wird wie eine Störung behandelt und nachverfolgt.',
  'Im Bereich {topic} arbeiten derzeit {n2} Fachpersonen, verteilt auf mehrere Teams.',
  'Die Teams treffen sich alle zwei Wochen zu einem kurzen Austausch über aktuelle Themen.',
  'Messgeräte werden jährlich kalibriert, das Kalibrierprotokoll wird in Tessera hinterlegt.',
  'Wo Automatisierung möglich ist, wird sie manuellen Abläufen vorgezogen, sofern sie überwacht wird.',
  'Ein Skript, das produktive Systeme verändert, wird wie jede andere Änderung behandelt.',
  'Die Skripte liegen versioniert im internen Repository unter {path}.',
  'Das Prinzip der minimalen Berechtigung gilt auch für technische Konten.',
  'Jedes technische Konto hat eine verantwortliche Person, die in Tessera eingetragen ist.',
  'Neue Werkzeuge werden zuerst in der Testumgebung erprobt, bevor sie im Betrieb eingesetzt werden.',
  'Externe Prüfstellen erhalten nur begleiteten Zugang zu den technischen Räumen.',
  'Besuche werden im Besucherprotokoll mit Ein- und Austrittszeit erfasst.',
  'Die Prozessbeschreibung wird bei Bedarf, mindestens aber alle {n} Jahre überarbeitet.',
  'Dabei werden die Personen einbezogen, die den Prozess täglich anwenden.',
  'Ein guter Prozess ist einer, den man nicht nachschlagen muss, weil er sich selbst erklärt.',
  'Wo nötig, verweisen die Abschnitte auf weiterführende Arbeitsanweisungen.',
  'Für Fragen zum Bereich {topic} ist {PERSON} die erste Anlaufstelle.',
  'Die Kosten für den Bereich {topic} werden im Budget der Abteilung Betrieb geführt.',
  'Mehrkosten über {chf} Franken müssen vorgängig bewilligt werden.',
  'Die Netzleitstelle führt ein Ereignisjournal, in dem alle relevanten Vorkommnisse chronologisch erfasst sind.',
  'Einträge im Ereignisjournal werden nicht gelöscht, sondern bei Bedarf mit einem Nachtrag korrigiert.',
  'Das Journal ist im Nachhinein die wichtigste Quelle für die Analyse von Störungen.',
  'Was nicht dokumentiert ist, gilt im Betrieb als nicht geschehen.',
  'Ein kurzer Hinweis im Schichtrapport genügt, wenn keine weiteren Schritte nötig sind.',
  'Längere Arbeiten werden in Etappen geplant, damit jederzeit ein stabiler Zwischenstand erreicht ist.',
  'Für die Zusammenarbeit mit den Gemeinden im Versorgungsgebiet gibt es feste Ansprechpersonen.',
  'Die Geschäftsleitung wird bei Ereignissen der Stufe {level} innerhalb einer Stunde informiert.',
  'Die Erfahrungen aus dem Ereignis vom Februar {year} haben zu dieser Vorgabe geführt.',
  'Damals fehlte eine klare Zuständigkeit, und wichtige Informationen erreichten die Netzleitstelle zu spät.',
  'Seither ist für jede Rolle festgelegt, wer sie im Fall einer Abwesenheit vertritt.',
  'Die Stellvertretung ist im Dienstplan sichtbar und wird bei jeder Änderung neu bestätigt.',
  'Die Werte aus {sys} dienen als Grundlage für die Kapazitätsplanung der kommenden Jahre.',
  'Die Auswertung erfolgt automatisch, wird aber vor der Veröffentlichung von einer Fachperson plausibilisiert.',
  'Offensichtliche Messfehler werden markiert und nicht stillschweigend korrigiert.',
  'Abweichungen von dieser Vorgabe sind mit {PERSON} abzusprechen.',
  'Bei Arbeiten in Unterwerken gilt immer die Regel, dass niemand allein vor Ort ist.',
  'Persönliche Schutzausrüstung wird vor jedem Einsatz kontrolliert und bei Mängeln sofort ersetzt.',
  'Die Sicherheit der Mitarbeitenden geht jeder betrieblichen Überlegung vor.',
  'Eine gute Vorbereitung beginnt mit der Frage, was im schlimmsten Fall passieren kann.',
  'Wer eine Arbeit übernimmt, bestätigt dies im Ticket, damit niemand doppelt arbeitet.',
  'Offene Fragen werden am Ende jeder Schicht notiert und an die nächste Schicht übergeben.',
  'Die meisten Abläufe in diesem Bereich lassen sich in weniger als einer Stunde erlernen.',
  'Schwieriger ist es, sie auch nachts und unter Druck zuverlässig einzuhalten.',
  'Deshalb werden sie regelmässig geübt, auch wenn sie im Alltag selten gebraucht werden.',
  'Für den Bereich {topic} ist ein jährlicher Überprüfungstermin im Kalender der Fachstelle Qualität eingetragen.',
  'Die Netzleitstelle kann jederzeit verlangen, dass eine laufende Arbeit unterbrochen wird.',
  'Eine solche Unterbrechung wird nicht diskutiert, sondern sofort umgesetzt und erst danach besprochen.',
  'Wer Zweifel an der Sicherheit eines Ablaufs hat, darf und soll die Arbeit stoppen.',
  'Die eingesetzten Werkzeuge werden zentral beschafft, damit Schulung und Wartung einheitlich bleiben.',
  'Private Geräte sind für betriebliche Aufgaben nicht zugelassen.',
  'Mobile Geräte des Pikettdienstes sind verschlüsselt und können aus der Ferne gesperrt werden.',
  'Jedes Jahr im Herbst werden die Erfahrungen aus dem Sommerbetrieb ausgewertet.',
  'Im Winter verschieben sich die Schwerpunkte, weil Lastspitzen und Witterung andere Risiken bringen.',
  'Für Arbeiten bei Schnee und Eis gelten zusätzliche Sicherheitsvorgaben.',
  'Die Fahrzeuge des Pikettdienstes sind mit einer Grundausrüstung für die häufigsten Einsätze ausgestattet.',
  'Die Ausrüstung wird nach jedem Einsatz kontrolliert und ergänzt.',
  'Fehlende Teile werden im Ticket vermerkt und innerhalb einer Woche nachbeschafft.',
  'Die Abteilung Betrieb arbeitet eng mit der Abteilung Netzbau zusammen, die neue Anlagen erstellt.',
  'Vor der Übernahme einer neuen Anlage in den Betrieb findet eine gemeinsame Abnahme statt.',
  'Erst nach der Abnahme ist {role.nom} für die Anlage verantwortlich.',
  'Mängel, die bei der Abnahme festgestellt werden, behebt der Netzbau vor der Übergabe.',
  'Kleinere Mängel dürfen mit einer Frist auch nach der Übergabe behoben werden.',
  'Im Bereich {topic} zeigt sich immer wieder, wie wichtig eine saubere Dokumentation ist.',
  'Eine halbe Stunde Dokumentation spart im Ereignisfall oft mehrere Stunden Suche.',
  'Die Vorgaben dieses Kapitels wurden mit den betroffenen Teams erarbeitet und mehrfach angepasst.',
  'Sie sind ein Kompromiss zwischen Sicherheit, Aufwand und Verständlichkeit.',
  'Wer eine bessere Lösung kennt, ist ausdrücklich eingeladen, sie vorzuschlagen.'
]

// Sentences with exactly one of Kunde / Kunden / Kundin / Kundinnen (one has two).
const CUSTOMER_SENTENCES: readonly string[] = [
  'Meldet eine Kundin eine Störung telefonisch, wird ihre Rückrufnummer im Ticket erfasst.',
  'Jeder Kunde erhält nach der Erfassung eine automatische Bestätigung mit der Ticketnummer.',
  'Die Anliegen der Kunden werden nach Dringlichkeit und nicht nach Eingangszeit bearbeitet.',
  'Für Kundinnen mit medizinischen Geräten zu Hause gilt bei Versorgungsunterbrüchen eine bevorzugte Behandlung.',
  'Bei geplanten Unterbrüchen werden die betroffenen Kunden mindestens fünf Tage vorher schriftlich informiert.',
  'Ein Kunde, der wiederholt von Störungen betroffen ist, wird von der zuständigen Fachperson persönlich kontaktiert.',
  'Die Zufriedenheit der Kundinnen wird einmal pro Jahr mit einer kurzen Umfrage erhoben.',
  'Rückmeldungen einer Kundin werden ernst genommen, auch wenn sie sich auf den ersten Blick als unbegründet erweisen.',
  'Gegenüber Kunden wird keine Ursache genannt, bevor sie gesichert ist.',
  'Muss ein Kunde den Zutritt zu einer Anlage ermöglichen, wird der Termin vorgängig mit ihm abgesprochen.',
  'Die Daten der Kunden werden nur für die Erbringung der vereinbarten Leistung verwendet.',
  'Eine Kundin hat jederzeit das Recht, Auskunft über die zu ihr gespeicherten Daten zu verlangen.',
  'Grosse Kunden aus Industrie und Gewerbe haben eine feste Ansprechperson im Betrieb.',
  'Die Kundinnen und Kunden werden über die Website und per SMS über grössere Störungen informiert.',
  'Ein Kunde kann eine Unterbrechung auch online melden; das Formular ist rund um die Uhr verfügbar.',
  'Beschwerden von Kunden werden innerhalb von zehn Arbeitstagen schriftlich beantwortet.',
  'Hat eine Kundin einen Schaden erlitten, wird der Fall an die Rechtsabteilung weitergeleitet.',
  'Die Kunden im Versorgungsgebiet Seewil sind wegen der Freileitungen häufiger von Sturmschäden betroffen.',
  'Wartungsarbeiten, die Kundinnen direkt betreffen, werden möglichst ausserhalb der Hauptzeiten geplant.',
  'Für jeden Kunden mit Sondervertrag ist die vereinbarte Wiederherstellungszeit in Tessera hinterlegt.'
]

const SUBSECTION_TITLES = [
  'Zweck und Geltungsbereich', 'Ablauf im Normalbetrieb', 'Rollen und Stellvertretung', 'Kontrollen',
  'Sonderfälle', 'Dokumentation', 'Kennzahlen', 'Schnittstellen zu anderen Prozessen', 'Werkzeuge',
  'Übergangsregelungen', 'Häufige Fehler', 'Schulung und Einarbeitung', 'Risiken', 'Praxisbeispiel'
] as const

interface SectionSpec {
  title: string
  id?: string
  /** Relative size of the section (1 = average). */
  weight?: number
}

interface ChapterSpec {
  title: string
  id: string
  topics: readonly string[]
  sentences: readonly string[]
  sections: readonly SectionSpec[]
}

const CHAPTERS: readonly ChapterSpec[] = [
  {
    title: 'Einleitung',
    id: 'einleitung',
    topics: ['Betriebsorganisation', 'Handbuchpflege', 'Dokumentenlenkung'],
    sentences: [
      'Dieses Handbuch beschreibt, wie die Stadtwerke Aarenfeld AG ihre Netze und ihre Informatik im Alltag betreiben.',
      'Es richtet sich an alle Mitarbeitenden der Abteilung Betrieb sowie an externe Partner, die regelmässig für uns arbeiten.',
      'Das Handbuch ersetzt keine gesetzlichen Vorgaben, sondern konkretisiert sie für unsere Organisation.',
      'Wo dieses Handbuch und eine Arbeitsanweisung sich widersprechen, gilt bis zur Klärung die strengere Regel.',
      'Die aktuelle Fassung ist immer die elektronische; gedruckte Exemplare sind nur am Tag des Ausdrucks gültig.',
      'Die Stadtwerke versorgen rund 48 000 Haushalte und 2300 Betriebe mit Strom, Wasser und Glasfaser.'
    ],
    sections: [
      { title: 'Zweck dieses Handbuchs', id: 'zweck', weight: 0.8 },
      { title: 'Aufbau und Lesehilfe', weight: 0.6 },
      { title: 'Gültigkeit und Änderungen', id: 'gueltigkeit', weight: 0.7 },
      { title: 'Begriffe und Abkürzungen', weight: 0.5 }
    ]
  },
  {
    title: 'Organisation und Verantwortlichkeiten',
    id: 'organisation',
    topics: ['Linienorganisation', 'Stellvertretungen', 'Schichtplanung', 'Pikettorganisation'],
    sentences: [
      'Die Abteilung Betrieb ist in die Teams Netzleitstelle, Rechenzentrum, Netzwerk und Servicedesk gegliedert.',
      'Die Leiterin Betrieb berichtet direkt an den Geschäftsführer und vertritt die Abteilung in der Geschäftsleitung.',
      'Jedes Team hat eine Teamleitung, die für Personalplanung, Ausbildung und die Einhaltung der Prozesse zuständig ist.',
      'Der Pikettdienst wird im Wochenrhythmus von Freitag zu Freitag übergeben.',
      'Pikettleistende müssen innerhalb von dreissig Minuten am Standort Birkenmatt eintreffen können.',
      'Die Rollen sind bewusst unabhängig von Personen beschrieben, damit Vertretungen reibungslos funktionieren.'
    ],
    sections: [
      { title: 'Organigramm der Abteilung Betrieb', id: 'organigramm' },
      { title: 'Rollen und Aufgaben', id: 'rollen', weight: 1.2 },
      { title: 'Schichtbetrieb', weight: 0.9 },
      { title: 'Pikettdienst', id: 'pikett', weight: 1.1 },
      { title: 'Zusammenarbeit mit anderen Abteilungen', weight: 0.8 }
    ]
  },
  {
    title: 'Netzbetrieb',
    id: 'netzbetrieb',
    topics: ['Netzführung', 'Schaltbetrieb', 'Lastverteilung', 'Netzschutz', 'Fernwirktechnik', 'Spannungshaltung'],
    sentences: [
      'Die Netzleitstelle überwacht rund um die Uhr das Mittelspannungsnetz mit seinen {n2} Transformatorenstationen.',
      'Schalthandlungen im Mittelspannungsnetz werden nur auf Anweisung der Netzleitstelle ausgeführt.',
      'Vor jeder Schalthandlung wird der Schaltauftrag laut vorgelesen und von der ausführenden Person wiederholt.',
      'Das Leitsystem Aquila zeigt den Schaltzustand aller fernsteuerbaren Schalter in Echtzeit.',
      'Die Spannung im Niederspannungsnetz soll innerhalb von zehn Prozent um den Nennwert bleiben.',
      'Bei Gewitterwarnungen wird die Besetzung der Netzleitstelle vorsorglich verstärkt.',
      'Eine Freischaltung gilt erst als abgeschlossen, wenn die Erdung vor Ort sichtbar angebracht ist.',
      'Die fünf Sicherheitsregeln werden vor jeder Arbeit an elektrischen Anlagen in der vorgeschriebenen Reihenfolge angewendet.'
    ],
    sections: [
      { title: 'Netzführung und Netzleitstelle', id: 'netzfuehrung', weight: 1.3 },
      { title: 'Schalthandlungen', id: 'schalthandlungen', weight: 1.2 },
      { title: 'Lastmanagement', weight: 1.0 },
      { title: 'Netzschutz und Selektivität', weight: 0.9 },
      { title: 'Arbeiten an elektrischen Anlagen', weight: 1.0 }
    ]
  },
  {
    title: 'Rechenzentrum und Infrastruktur',
    id: 'rechenzentrum',
    topics: ['Rechenzentrumsbetrieb', 'Stromversorgung', 'Klimatisierung', 'Virtualisierung', 'Speichersysteme'],
    sentences: [
      'Das Rechenzentrum Hohwacht und der Ausweichstandort Lindenbühl sind über zwei getrennte Glasfasertrassen verbunden.',
      'Der Zustand der unterbrechungsfreien Stromversorgung wird täglich automatisch geprüft.',
      'Die Batterien der USV werden nach {n} Jahren ersetzt, unabhängig vom gemessenen Zustand.',
      'Die Kühlleistung ist so ausgelegt, dass der Ausfall eines Klimageräts ohne Einschränkung überbrückt wird.',
      'Steigt die Raumtemperatur über {temp} Grad, alarmiert Lumen den Pikettdienst.',
      'Virtuelle Server werden aus genehmigten Vorlagen erstellt und nie von Hand aufgesetzt.',
      'Der Notstromgenerator wird jeden ersten {day} im Monat unter Last getestet.'
    ],
    sections: [
      { title: 'Standorte und Räume', weight: 0.9 },
      { title: 'Stromversorgung und Kühlung', id: 'strom-kuehlung', weight: 1.2 },
      { title: 'Server und Virtualisierung', weight: 1.1 },
      { title: 'Speicher und Netzwerk im Rechenzentrum', weight: 1.0 },
      { title: 'Zutritt und physische Sicherheit', weight: 0.8 }
    ]
  },
  {
    title: 'Störungsmanagement',
    id: 'stoerungen',
    topics: ['Störungsbearbeitung', 'Erstbeurteilung', 'Eskalation', 'Ursachenanalyse'],
    sentences: [
      'Eine Störung ist jede ungeplante Unterbrechung oder Beeinträchtigung eines Dienstes.',
      'Störungen werden in vier Prioritäten eingeteilt, wobei Priorität 1 einen Versorgungsunterbruch für mehr als hundert Anschlüsse bedeutet.',
      'Bei Priorität 1 übernimmt die Netzleitstelle die Gesamtkoordination, bis die Störung behoben ist.',
      'Jede Störung der Priorität 1 oder 2 wird innerhalb von fünf Arbeitstagen nachbesprochen.',
      'Ziel der Nachbesprechung ist nicht die Suche nach Schuldigen, sondern das Verständnis der Ursachen.',
      'Wiederkehrende Störungen werden als Problem erfasst und von einer benannten Person verfolgt.'
    ],
    sections: [
      { title: 'Erfassung und Erstbeurteilung', id: 'erfassung', weight: 1.1 },
      { title: 'Prioritäten', id: 'prioritaeten', weight: 0.9 },
      { title: 'Eskalation', id: 'eskalation', weight: 1.2 },
      { title: 'Nachbearbeitung und Problemmanagement', weight: 1.0 },
      { title: 'Information der Betroffenen', id: 'information', weight: 0.9 }
    ]
  },
  {
    title: 'Änderungsmanagement',
    id: 'aenderungen',
    topics: ['Änderungsplanung', 'Freigabeverfahren', 'Wartungsfenster', 'Rückfallplanung'],
    sentences: [
      'Jede Änderung an produktiven Systemen durchläuft das Änderungsverfahren, auch wenn sie klein erscheint.',
      'Standardänderungen sind vorab genehmigt und dürfen ohne Sitzung des Änderungsausschusses ausgeführt werden.',
      'Der Änderungsausschuss tagt jeden {day} um zehn Uhr und behandelt alle offenen Anträge.',
      'Notfalländerungen werden nachträglich innerhalb von zwei Arbeitstagen dokumentiert.',
      'Ein Antrag ohne Rückfallplan wird nicht behandelt.',
      'Das reguläre Wartungsfenster liegt in der Nacht von Dienstag auf Mittwoch zwischen 22 und 4 Uhr.'
    ],
    sections: [
      { title: 'Arten von Änderungen', weight: 0.9 },
      { title: 'Antrag und Bewertung', id: 'antrag', weight: 1.1 },
      { title: 'Freigabe durch den Änderungsausschuss', weight: 1.0 },
      { title: 'Umsetzung im Wartungsfenster', id: 'wartungsfenster', weight: 1.4 },
      { title: 'Abschluss und Kontrolle', weight: 0.8 }
    ]
  },
  {
    title: 'Informationssicherheit',
    id: 'sicherheit',
    topics: ['Zugriffskontrolle', 'Schwachstellenmanagement', 'Netzwerksegmentierung', 'Sicherheitsvorfälle'],
    sentences: [
      'Die Netze für Leittechnik und Büroinformatik sind strikt voneinander getrennt.',
      'Fernzugriffe auf die Leittechnik sind nur über die gesicherte Zwischenstation in der Netzleitstelle erlaubt.',
      'Sicherheitsupdates mit hoher Dringlichkeit werden innerhalb von {n} Tagen eingespielt.',
      'Jeder Verdacht auf einen Sicherheitsvorfall wird sofort dem Sicherheitsteam gemeldet.',
      'Passwörter für administrative Konten werden nach jeder Verwendung automatisch neu gesetzt.',
      'Die Mitarbeitenden absolvieren jährlich eine kurze Schulung zu Phishing und sicherem Verhalten.'
    ],
    sections: [
      { title: 'Grundsätze', id: 'grundsaetze-sicherheit', weight: 0.8 },
      { title: 'Zugriffe und Berechtigungen', id: 'berechtigungen', weight: 1.2 },
      { title: 'Schwachstellen und Updates', weight: 1.0 },
      { title: 'Umgang mit Sicherheitsvorfällen', id: 'sicherheitsvorfaelle', weight: 1.3 },
      { title: 'Sensibilisierung', weight: 0.7 }
    ]
  },
  {
    title: 'Datensicherung und Wiederherstellung',
    id: 'datensicherung',
    topics: ['Datensicherung', 'Wiederherstellung', 'Archivierung', 'Aufbewahrung'],
    sentences: [
      'Alle produktiven Systeme werden täglich gesichert, die Datenbanken zusätzlich stündlich.',
      'Eine Kopie jeder Sicherung liegt unveränderbar am Ausweichstandort Lindenbühl.',
      'Eine Sicherung gilt erst als vorhanden, wenn ihre Wiederherstellung erfolgreich getestet wurde.',
      'Die Sicherungsumgebung Boreas meldet fehlgeschlagene Sicherungen direkt an den Pikettdienst.',
      'Wiederherstellungstests werden für jedes kritische System mindestens zweimal pro Jahr durchgeführt.',
      'Sicherungsbänder werden verschlüsselt und nur mit Begleitprotokoll transportiert.'
    ],
    sections: [
      { title: 'Sicherungskonzept', id: 'sicherungskonzept', weight: 1.1 },
      { title: 'Täglicher Sicherungsbetrieb', weight: 1.0 },
      { title: 'Wiederherstellung', id: 'wiederherstellung', weight: 1.2 },
      { title: 'Archivierung und Aufbewahrungsfristen', weight: 0.8 }
    ]
  },
  {
    title: 'Überwachung und Kennzahlen',
    id: 'ueberwachung',
    topics: ['Überwachung', 'Alarmierung', 'Kennzahlen', 'Berichtswesen'],
    sentences: [
      'Die Überwachungsplattform Lumen erfasst rund 14 000 Messpunkte aus Netz und Informatik.',
      'Jeder Alarm hat eine verantwortliche Stelle und eine dokumentierte Erstmassnahme.',
      'Alarme, die regelmässig ohne Handlungsbedarf auslösen, werden überprüft und angepasst.',
      'Die wichtigsten Kennzahlen sind Verfügbarkeit, mittlere Wiederherstellungszeit und Anzahl Störungen pro Monat.',
      'Der Monatsbericht wird bis zum fünften Arbeitstag des Folgemonats erstellt.',
      'Trends sind aussagekräftiger als Einzelwerte, deshalb zeigen alle Berichte die letzten zwölf Monate.'
    ],
    sections: [
      { title: 'Überwachungsplattform Lumen', id: 'lumen', weight: 1.0 },
      { title: 'Alarmierung', weight: 1.1 },
      { title: 'Kennzahlen und Berechnung', id: 'kennzahlen', weight: 1.3 },
      { title: 'Berichte', weight: 0.8 }
    ]
  },
  {
    title: 'Servicezeiten und Anfragen',
    id: 'service',
    topics: ['Servicedesk', 'Anfragebearbeitung', 'Servicezeiten', 'Beschwerdemanagement'],
    sentences: [
      'Der Servicedesk ist werktags von sieben bis achtzehn Uhr telefonisch erreichbar.',
      'Ausserhalb dieser Zeiten nimmt der Pikettdienst dringende Meldungen über die Störungsnummer entgegen.',
      'Anfragen werden im Ticketsystem Kairos erfasst und innerhalb eines Arbeitstags beantwortet.',
      'Die Servicezeiten für Sonderverträge können von den Standardzeiten abweichen.',
      'Telefonische Anfragen werden kurz zusammengefasst und im Ticket festgehalten.',
      'Der Servicedesk misst monatlich, wie viele Anfragen beim ersten Kontakt gelöst werden.'
    ],
    sections: [
      { title: 'Servicedesk', id: 'servicedesk', weight: 1.0 },
      { title: 'Servicezeiten und Erreichbarkeit', weight: 0.9 },
      { title: 'Bearbeitung von Anfragen', weight: 1.1 },
      { title: 'Beschwerden und Rückmeldungen', id: 'beschwerden', weight: 1.0 }
    ]
  },
  {
    title: 'Lieferanten und Verträge',
    id: 'lieferanten',
    topics: ['Lieferantenmanagement', 'Wartungsverträge', 'Vertragsüberwachung', 'Beschaffung'],
    sentences: [
      'Für alle kritischen Komponenten bestehen Wartungsverträge mit festgelegten Reaktionszeiten.',
      'Die Einhaltung der vereinbarten Reaktionszeiten wird quartalsweise ausgewertet.',
      'Neue Lieferanten werden vor Vertragsabschluss auf ihre Informationssicherheit geprüft.',
      'Verträge mit einer Laufzeit über drei Jahre benötigen die Zustimmung der Geschäftsleitung.',
      'Lieferanten erhalten Zugang zu unseren Systemen nur über individuelle, befristete Konten.',
      'Eine Liste aller Verträge mit Ablaufdatum wird in Tessera geführt.'
    ],
    sections: [
      { title: 'Auswahl und Bewertung', weight: 1.0 },
      { title: 'Wartungsverträge und Reaktionszeiten', id: 'reaktionszeiten', weight: 1.1 },
      { title: 'Zusammenarbeit im Betrieb', weight: 0.9 },
      { title: 'Vertragsende und Wechsel', weight: 0.8 }
    ]
  },
  {
    title: 'Notfall- und Krisenorganisation',
    id: 'notfall',
    topics: ['Notfallplanung', 'Krisenstab', 'Notbetrieb', 'Wiederanlauf'],
    sentences: [
      'Ein Notfall liegt vor, wenn der normale Störungsprozess zur Bewältigung nicht mehr ausreicht.',
      'Der Krisenstab wird durch die Leiterin Betrieb oder ihre Stellvertretung einberufen.',
      'Der Krisenstab tritt im Raum K2 am Standort Birkenmatt zusammen, alternativ in Lindenbühl.',
      'Für einen grossflächigen Stromausfall gibt es einen separaten Wiederaufbauplan.',
      'Die Notfallpläne werden jährlich in einer realitätsnahen Übung erprobt.',
      'Im Notbetrieb gilt eine verkürzte Entscheidungskette, die im Notfallplan beschrieben ist.'
    ],
    sections: [
      { title: 'Notfallstufen', id: 'notfallstufen', weight: 1.0 },
      { title: 'Krisenstab', weight: 1.1 },
      { title: 'Notbetrieb und Wiederanlauf', id: 'wiederanlauf', weight: 1.2 },
      { title: 'Übungen', weight: 0.9 }
    ]
  },
  {
    title: 'Qualitätssicherung und Audits',
    id: 'qualitaet',
    topics: ['Qualitätssicherung', 'interne Audits', 'Prozessverbesserung', 'Nachweisführung'],
    sentences: [
      'Die Fachstelle Qualität plant die internen Audits für jeweils ein Kalenderjahr im Voraus.',
      'Jeder Prozess dieses Handbuchs wird mindestens alle drei Jahre auditiert.',
      'Feststellungen aus Audits erhalten eine verantwortliche Person und eine verbindliche Frist.',
      'Externe Audits nach ISO 27001 finden jährlich statt, die Rezertifizierung alle drei Jahre.',
      'Verbesserungsvorschläge können alle Mitarbeitenden jederzeit über ein einfaches Formular einreichen.',
      'Der Stand der offenen Massnahmen wird der Geschäftsleitung quartalsweise berichtet.'
    ],
    sections: [
      { title: 'Qualitätsziele', id: 'qualitaetsziele', weight: 0.9 },
      { title: 'Interne Audits', id: 'interne-audits', weight: 1.1 },
      { title: 'Externe Prüfungen', weight: 0.9 },
      { title: 'Kontinuierliche Verbesserung', weight: 1.0 }
    ]
  },
  {
    title: 'Anhang',
    id: 'anhang',
    topics: ['Glossar', 'Vorlagen', 'Kontaktlisten'],
    sentences: [
      'Die Vorlagen in diesem Anhang stehen auch im Dokumentenverzeichnis zum Herunterladen bereit.',
      'Kontaktlisten werden wegen des Datenschutzes nicht im Handbuch geführt, sondern im Verzeichnisdienst Nimbus.',
      'Die Begriffe im Glossar sind so erklärt, wie sie in diesem Handbuch verwendet werden.'
    ],
    sections: [
      { title: 'Glossar', id: 'glossar', weight: 0.6 },
      { title: 'Vorlagen', weight: 0.5 },
      { title: 'Änderungsverzeichnis', id: 'aenderungsverzeichnis', weight: 0.4 }
    ]
  }
]

// Cross-references and external links sprinkled into paragraphs.
const INTERNAL_LINK_SENTENCES: readonly string[] = [
  'Die Eskalationsstufen sind in [Abschnitt 5.3](#eskalation) beschrieben.',
  'Wie Änderungen in einem Wartungsfenster umgesetzt werden, zeigt [Abschnitt 6.4](#wartungsfenster).',
  'Die Rollen sind in [Abschnitt 2.2](#rollen) im Einzelnen festgelegt.',
  'Für die Berechnung der Verfügbarkeit siehe [Abschnitt 9.3](#kennzahlen).',
  'Das Vorgehen bei Sicherheitsvorfällen folgt [Abschnitt 7.4](#sicherheitsvorfaelle).',
  'Die Wiederherstellung aus Sicherungen ist in [Abschnitt 8.3](#wiederherstellung) erklärt.',
  'Begriffe, die hier nicht erklärt werden, stehen im [Glossar](#glossar).',
  'Wer den Pikettdienst leistet, regelt [Abschnitt 2.4](#pikett).',
  'Die Prioritäten sind in [Abschnitt 5.2](#prioritaeten) definiert.',
  'Zum Wiederanlauf nach einem Notfall siehe [Abschnitt 12.3](#wiederanlauf).'
]

const EXTERNAL_LINK_SENTENCES: readonly string[] = [
  'Ergänzende Hinweise enthält der [Leitfaden des Branchenverbands](https://www.example.org/leitfaden/netzbetrieb).',
  'Die Vorgaben stützen sich auf die [Empfehlungen zur Informationssicherheit](https://www.example.com/sicherheit/empfehlungen).',
  'Eine gute Einführung bietet das [Merkblatt zur Arbeitssicherheit](https://www.example.org/merkblatt/arbeitssicherheit).',
  'Aktuelle Warnungen veröffentlicht das [nationale Zentrum für Cybersicherheit](https://www.example.net/warnungen).'
]

interface Images { alt: string, fileId: string }

const IMAGES: readonly Images[] = [
  { alt: 'Organigramm der Abteilung Betrieb', fileId: 'q7Lm2xPa9TkR4vBn8cWzd' },
  { alt: 'Übersicht der Netzleitstelle Birkenmatt mit Arbeitsplätzen', fileId: 'Hc3vN8kQ1rTz6Ym0pLwXs' },
  { alt: 'Grundriss des Rechenzentrums Hohwacht', fileId: 'Zp5Kt9sW2nVb7Qe4mRxJa' },
  { alt: 'Ablauf der Störungsbearbeitung', fileId: 'Lr8Yd1fG6hJk3Ns0TqWvb' },
  { alt: 'Monatsbericht mit Verfügbarkeit und Störungen', fileId: 'Ue2Wn7cX5bM9Ar4Ks1PoZ' },
  { alt: 'Raum K2 des Krisenstabs in Birkenmatt', fileId: 'Gx6Qv3tB8mL1Zc9Ny5RdH' }
]

/** Chapters (1-based) that get an image and in which section index. */
const IMAGE_PLACEMENT: ReadonlyArray<[chapter: number, section: number, image: number]> = [
  [2, 0, 0], [3, 0, 1], [4, 0, 2], [5, 0, 3], [9, 2, 4], [12, 1, 5]
]

/** Sections ([chapter, section], 1-based chapter, 0-based section) that get a paragraph mentioning customers. */
const CUSTOMER_SECTIONS: ReadonlyArray<[number, number]> = [
  [1, 0], [2, 4], [3, 2], [3, 4], [4, 4], [5, 0], [5, 4], [6, 3], [7, 1], [8, 2],
  [9, 3], [10, 0], [10, 1], [10, 2], [10, 3], [11, 1], [12, 2], [13, 0], [13, 3]
]

// Slot filling

interface FillContext { rng: Rng, topics: readonly string[] }

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function fill(template: string, ctx: FillContext): string {
  const { rng } = ctx
  const role = rng.pick(ROLES)
  const sys = rng.pick(SYSTEMS)
  return template.replace(/\{([A-Za-z0-9.]+)\}/g, (_m, key: string) => {
    switch (key) {
      case 'topic': return rng.pick(ctx.topics)
      case 'ROLE': return capitalize(role.nom)
      case 'role.nom': return role.nom
      case 'role.dat': return role.dat
      case 'role.acc': return role.acc
      case 'PERSON': return rng.pick(PERSONS)
      case 'SYS': return capitalize(sys.nom)
      case 'sys': return sys.short
      case 'site': return rng.pick(SITES)
      case 'day': return rng.pick(DAYS)
      case 'code': return rng.pick(CODES)
      case 'cmd': return rng.pick(COMMANDS)
      case 'path': return rng.pick(PATHS)
      case 'chf': return rng.pick(CHF)
      case 'n': return String(rng.int(2, 12))
      case 'n2': return String(rng.int(20, 80))
      case 'sec': return String(rng.pick([10, 15, 30, 60]))
      case 'min': return String(rng.pick([15, 30, 45, 60, 90]))
      case 'pct': return rng.pick(['99,5', '99,8', '99,9', '99,95'])
      case 'pct2': return String(rng.int(5, 25))
      case 'level': return String(rng.int(1, 3))
      case 'temp': return String(rng.int(26, 30))
      case 'year': return String(rng.int(2019, 2025))
      default: throw new Error(`unknown slot {${key}}`)
    }
  })
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

class ParagraphWriter {
  /** Recently used templates, kept out of the next picks so neighbouring paragraphs differ. */
  private readonly recent: string[] = []

  constructor(private readonly rng: Rng) {}

  private remember(template: string, windowSize: number): void {
    this.recent.push(template)
    if (this.recent.length > windowSize) this.recent.shift()
  }

  private pickGeneric(): string {
    for (;;) {
      const template = this.rng.pick(GENERIC_SENTENCES)
      if (this.recent.includes(template)) continue
      this.remember(template, 70)
      return template
    }
  }

  /** A chapter-specific sentence not used recently, or null when all are. */
  private pickSpecific(chapter: ChapterSpec): string | null {
    const fresh = chapter.sentences.filter(s => !this.recent.includes(s))
    if (fresh.length === 0) return null
    const template = this.rng.pick(fresh)
    this.remember(template, 70)
    return template
  }

  paragraph(chapter: ChapterSpec, extra: readonly string[] = []): string {
    const ctx = { rng: this.rng, topics: chapter.topics }
    const count = this.rng.int(4, 6)
    const sentences: string[] = []
    for (let i = 0; i < count; i++) {
      const specific = this.rng.float() < 0.15 ? this.pickSpecific(chapter) : null
      sentences.push(fill(specific ?? this.pickGeneric(), ctx))
    }
    // Extra sentences (customer mentions, links) go in at random positions.
    for (const e of extra) sentences.splice(this.rng.int(1, sentences.length), 0, e)
    return sentences.join(' ')
  }
}

// Fixed blocks

function tableFor(chapterNo: number, rng: Rng): string {
  switch (chapterNo % 5) {
    case 0:
      return [
        'Table: Eskalationsstufen und Reaktionszeiten',
        '',
        '| Stufe | Auslöser | Informiert wird | Reaktionszeit |',
        '|:--|:--|:--|--:|',
        '| 1 | Einzelner Dienst beeinträchtigt | Schichtleitung | 30 min |',
        '| 2 | Mehrere Dienste oder über 100 Anschlüsse | Leiterin Betrieb | 15 min |',
        '| 3 | Versorgung grossflächig unterbrochen | Geschäftsleitung, Krisenstab | sofort |',
        '| 4 | Gefahr für Personen | Blaulichtorganisationen, Geschäftsleitung | sofort |'
      ].join('\n')
    case 1:
      return [
        'Table: Rollen und Verantwortlichkeiten (V = verantwortlich, M = mitwirkend, I = informiert)',
        '',
        '| Aufgabe | Netzleitstelle | Rechenzentrum | Servicedesk | Leitung Betrieb |',
        '|:--|:-:|:-:|:-:|:-:|',
        '| Erstbeurteilung | V | M | I | I |',
        '| Schalthandlung | V | | | I |',
        '| Wiederherstellung Server | I | V | I | |',
        '| Information Öffentlichkeit | M | | M | V |',
        '| Nachbesprechung | M | M | M | V |'
      ].join('\n')
    case 2: {
      const rows = SITES.map(s => `| ${s} | ${rng.int(2, 9)} | ${rng.pick(DAYS)} | ${rng.pick(['22:00 bis 04:00', '20:00 bis 02:00', '23:00 bis 05:00'])} |`)
      return ['Table: Wartungsfenster nach Standort', '', '| Standort | Anlagen | Wochentag | Zeitfenster |', '|:--|--:|:--|:--|', ...rows].join('\n')
    }
    case 3: {
      const months = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni']
      const rows = months.map(m => `| ${m} | ${(rng.int(9990, 9999) / 100).toFixed(2).replace('.', ',')} % | ${rng.int(12, 48)} | ${rng.int(25, 95)} min |`)
      return ['Table: Kennzahlen des ersten Halbjahres', '', '| Monat | Verfügbarkeit | Störungen | Mittlere Wiederherstellungszeit |', '|:--|--:|--:|--:|', ...rows].join('\n')
    }
    default:
      return [
        'Table: Sicherungszyklen',
        '',
        '| Daten | Häufigkeit | Aufbewahrung | Speicherort |',
        '|:--|:--|:--|:--|',
        '| Datenbanken Leittechnik | stündlich | 30 Tage | Hohwacht, Lindenbühl |',
        '| Dateiablagen | täglich | 90 Tage | Hohwacht, Lindenbühl |',
        '| Konfigurationen | bei jeder Änderung | 2 Jahre | Tessera, Boreas |',
        '| Jahresabschluss | jährlich | 10 Jahre | Band, Tresor Seewil |'
      ].join('\n')
  }
}

const FENCE = '```'

const CODE_BLOCKS: Readonly<Record<number, string>> = {
  3: [
    `${FENCE}bash`,
    'aquila schaltzustand --uw birkenmatt --format kurz',
    'aquila auftrag anzeigen --nummer SA-2026-0331',
    'aquila auftrag quittieren --nummer SA-2026-0331 --person "Reto Hänggi"',
    FENCE
  ].join('\n'),
  4: [
    `${FENCE}yaml`,
    'vorlage: linux-standard-2026',
    'cpu: 4',
    'speicher_gb: 16',
    'netz:',
    '  segment: rz1-intern',
    '  dns: [10.20.0.10, 10.20.0.11]',
    'ueberwachung:',
    '  lumen_agent: true',
    '  profil: server-basis',
    FENCE
  ].join('\n'),
  5: [
    `${FENCE}bash`,
    '# Erstbeurteilung: Zustand der wichtigsten Dienste abfragen',
    'lumen status --zone rz1 --nur-alarme',
    '# Offene Tickets der Priorität 1 und 2 anzeigen',
    'kairos ticket list --offen --prio 1,2',
    '#Ende der Erstbeurteilung',
    FENCE
  ].join('\n'),
  6: [
    `${FENCE}mermaid`,
    'flowchart LR',
    '  A[Antrag erfassen] --> B{Standardänderung?}',
    '  B -- ja --> D[Umsetzung planen]',
    '  B -- nein --> C[Änderungsausschuss]',
    '  C -- freigegeben --> D',
    '  C -- abgelehnt --> E[Antrag überarbeiten]',
    '  D --> F[Umsetzung im Wartungsfenster]',
    '  F --> G[Kontrolle und Abschluss]',
    FENCE
  ].join('\n'),
  8: [
    `${FENCE}bash`,
    '#!/bin/sh',
    '# Wiederherstellungstest einer Datenbank in die Testumgebung',
    'boreas restore --system leittechnik-db --ziel test-rz2 --stand gestern',
    'boreas verify --system leittechnik-db --ziel test-rz2',
    FENCE
  ].join('\n'),
  9: [
    `${FENCE}sql`,
    'SELECT dienst,',
    '       round(100.0 * sum(verfuegbar_sekunden) / sum(soll_sekunden), 3) AS verfuegbarkeit',
    'FROM lumen_messwerte',
    'WHERE monat = \'2026-06\'',
    'GROUP BY dienst',
    'ORDER BY verfuegbarkeit;',
    FENCE
  ].join('\n'),
  11: [
    `${FENCE}json`,
    '{',
    '  "lieferant": "Muster Netztechnik AG",',
    '  "vertrag": "WV-2024-017",',
    '  "reaktionszeit_minuten": 120,',
    '  "gueltig_bis": "2027-12-31"',
    '}',
    FENCE
  ].join('\n')
}

const ALERTS: Readonly<Record<number, string>> = {
  1: '> [!NOTE]\n> Dieses Handbuch wird laufend weiterentwickelt. Die Version und das Datum der letzten Änderung stehen im Änderungsverzeichnis im Anhang.',
  3: '> [!WARNING]\n> Schalthandlungen ohne gültigen Schaltauftrag sind verboten. Das gilt auch bei Zeitdruck und auch für erfahrene Fachpersonen.',
  5: '> [!TIP]\n> Im Zweifel lieber früh eskalieren. Eine unnötige Eskalation kostet wenige Minuten, eine verpasste unter Umständen Stunden.',
  7: '> [!IMPORTANT]\n> Ein vermuteter Sicherheitsvorfall wird nie auf eigene Faust untersucht. Zuerst melden, dann gemeinsam mit dem Sicherheitsteam handeln.',
  8: '> [!NOTE]\n> Eine Sicherung, deren Wiederherstellung nie geprüft wurde, ist keine Sicherung.',
  12: '> [!CAUTION]\n> Im Notbetrieb gilt die verkürzte Entscheidungskette. Wer nicht zum Krisenstab gehört, trifft keine Entscheide mit Aussenwirkung.'
}

const MATH: Readonly<Record<number, string>> = {
  3: 'Für überschlägige Rechnungen genügt die Wirkleistung $P = U \\cdot I \\cdot \\cos\\varphi$, wobei für das Mittelspannungsnetz $U = 16\\,\\text{kV}$ eingesetzt wird.',
  9: [
    'Die Verfügbarkeit eines Dienstes wird aus der mittleren Betriebszeit zwischen Ausfällen (MTBF) und der mittleren Wiederherstellungszeit (MTTR) berechnet:',
    '',
    '$$',
    'A = \\frac{\\mathrm{MTBF}}{\\mathrm{MTBF} + \\mathrm{MTTR}}',
    '$$',
    '',
    'Bei einer MTBF von 2000 Stunden und einer MTTR von 2 Stunden ergibt sich $A \\approx 99{,}9\\,\\%$. Für die Jahresverfügbarkeit gilt entsprechend $A_\\text{Jahr} = 1 - \\frac{t_\\text{Ausfall}}{8760\\,\\text{h}}$.'
  ].join('\n')
}

function preamble(): string {
  return [
    `**${LARGE_DOC_TITLE}**`,
    '',
    'Stadtwerke Aarenfeld AG · Abteilung Betrieb · Ausgabe 2026, Version 4.2',
    '',
    'Verantwortlich für den Inhalt: Martina Studer, Leiterin Betrieb. Freigegeben durch die Geschäftsleitung am 3. März 2026. Dieses Dokument ist intern und darf nicht an Dritte weitergegeben werden, ausser an Lieferanten mit gültiger Geheimhaltungsvereinbarung.',
    '',
    '[[toc]]',
    '',
    '<!-- pagebreak -->'
  ].join('\n')
}

function glossary(): string {
  return [
    'Leitsystem',
    ': Software, mit der die Netzleitstelle das Netz überwacht und fernsteuert, bei uns Aquila.',
    '',
    'Pikettdienst',
    ': Bereitschaftsdienst ausserhalb der regulären Arbeitszeit.',
    '',
    'Schaltauftrag',
    ': Schriftlich festgelegte Abfolge von Schalthandlungen mit eindeutiger Nummer.',
    '',
    'Wartungsfenster',
    ': Vereinbarter Zeitraum, in dem geplante Arbeiten mit möglicher Auswirkung ausgeführt werden.',
    '',
    '*[USV]: Unterbrechungsfreie Stromversorgung',
    '*[MTBF]: Mean Time Between Failures',
    '*[MTTR]: Mean Time To Repair'
  ].join('\n')
}

function checklist(): string {
  return [
    'Checkliste für die Einberufung des Krisenstabs:',
    '',
    '- [ ] Lage kurz schriftlich zusammenfassen',
    '- [ ] Leiterin Betrieb oder Stellvertretung erreichen',
    '- [ ] Raum K2 in Birkenmatt öffnen, sonst Lindenbühl',
    '- [ ] Ereignisjournal für den Krisenstab eröffnen',
    '- [x] Telefonliste des Krisenstabs liegt im Raum K2 bereit'
  ].join('\n')
}

const FOOTNOTES: readonly string[] = [
  'Gemäss Beschluss der Geschäftsleitung vom 12. Januar 2026.',
  'Die Werte gelten für das Versorgungsgebiet ohne die Gemeinde Rotach, die über ein eigenes Netz verfügt.',
  'Die Liste der Standardänderungen wird vom Änderungsausschuss geführt.',
  'Massgebend ist die Zeit zwischen Eingang der Meldung und dem ersten Eingriff vor Ort.',
  'Ausgenommen sind Systeme, die vom Hersteller nur mit Verzögerung aktualisiert werden dürfen.',
  'Die Bänder werden im Tresor der Zweigstelle Seewil gelagert.',
  'Messpunkte ohne Alarmregel werden nur aufgezeichnet.',
  'Die Rezertifizierung erfolgte zuletzt im Herbst 2025.'
]

/** Chapters with one footnote each (first paragraph of section x.2.1). */
const FOOTNOTE_CHAPTERS: readonly number[] = [1, 3, 5, 6, 7, 8, 9, 13]

// Assembly

export function generateLargeDocument(opts: LargeDocumentOptions = {}): string {
  const rng = new Rng(opts.seed ?? DEFAULT_SEED)
  const writer = new ParagraphWriter(rng)
  const targetWords = opts.targetWords ?? DEFAULT_TARGET_WORDS

  const sectionCount = CHAPTERS.reduce((sum, c) => sum + c.sections.length, 0)
  const totalWeight = CHAPTERS.reduce((sum, c) => sum + c.sections.reduce((s, sec) => s + (sec.weight ?? 1), 0), 0)
  // Fixed blocks and headings take a share; the rest is prose.
  const proseWords = targetWords - sectionCount * 40

  const customerPool = [...CUSTOMER_SENTENCES]
  let customerCursor = 0
  let internalCursor = 0
  let externalCursor = 0
  let footnoteNo = 0

  const blocks: string[] = [preamble()]

  CHAPTERS.forEach((chapter, ci) => {
    const chapterNo = ci + 1
    if (ci > 0) blocks.push('<!-- pagebreak -->')
    blocks.push(`# ${chapterNo} ${chapter.title} {#${chapter.id}}`)
    blocks.push(writer.paragraph(chapter))
    const chapterFootnotes: string[] = []

    chapter.sections.forEach((section, si) => {
      const sectionNo = `${chapterNo}.${si + 1}`
      blocks.push(section.id ? `## ${sectionNo} ${section.title} {#${section.id}}` : `## ${sectionNo} ${section.title}`)
      const budget = Math.round(proseWords * (section.weight ?? 1) / totalWeight)
      let written = 0
      const emit = (block: string): void => {
        blocks.push(block)
        written += countWords(block)
      }

      emit(writer.paragraph(chapter))

      const image = IMAGE_PLACEMENT.find(([c, s]) => c === chapterNo && s === si)
      if (image) {
        const img = IMAGES[image[2]]!
        emit(`![${img.alt}](/api/files/${LARGE_DOC_FAKE_DOC_ID}/${img.fileId}.png)`)
      }
      if (CUSTOMER_SECTIONS.some(([c, s]) => c === chapterNo && s === si)) {
        const extra = [customerPool[customerCursor % customerPool.length]!, customerPool[(customerCursor + 1) % customerPool.length]!]
        customerCursor += 2
        emit(writer.paragraph(chapter, extra))
      }
      if (si === 0 && ALERTS[chapterNo]) emit(ALERTS[chapterNo])
      if (si === 1) emit(tableFor(chapterNo, rng))
      if (si === 1 && MATH[chapterNo]) emit(MATH[chapterNo])
      if (si === 2 && CODE_BLOCKS[chapterNo]) emit(CODE_BLOCKS[chapterNo])

      const subCount = Math.max(2, Math.min(4, Math.round(budget / 330)))
      const titles = [...SUBSECTION_TITLES]
      for (let sub = 0; sub < subCount; sub++) {
        const title = titles.splice(rng.int(0, titles.length - 1), 1)[0]!
        blocks.push(`### ${sectionNo}.${sub + 1} ${title}`)
        const subBudget = (budget - written) / (subCount - sub)
        let subWritten = 0
        while (subWritten < subBudget) {
          const extra: string[] = []
          if (rng.float() < 0.08) extra.push(INTERNAL_LINK_SENTENCES[internalCursor++ % INTERNAL_LINK_SENTENCES.length]!)
          else if (rng.float() < 0.03) extra.push(EXTERNAL_LINK_SENTENCES[externalCursor++ % EXTERNAL_LINK_SENTENCES.length]!)
          let para = writer.paragraph(chapter, extra)
          if (FOOTNOTE_CHAPTERS.includes(chapterNo) && si === 1 && sub === 0 && subWritten === 0) {
            footnoteNo += 1
            para = para.replace(/\.$/, `.[^${footnoteNo}]`)
            chapterFootnotes.push(`[^${footnoteNo}]: ${FOOTNOTES[footnoteNo - 1]}`)
          }
          blocks.push(para)
          const w = countWords(para)
          subWritten += w
          written += w
        }
      }
      if (chapterNo === 12 && si === 3) blocks.push(checklist())
      if (chapterNo === 14 && si === 0) blocks.push(glossary())
    })

    if (chapterFootnotes.length > 0) blocks.push(chapterFootnotes.join('\n'))
  })

  return `${blocks.join('\n\n')}\n`
}

/** Where the committed copy of the default document lives. */
export const LARGE_DOC_FIXTURE_PATH = fileURLToPath(new URL('../../e2e/fixtures/content/large-handbook/betriebshandbuch.md', import.meta.url))

// `bun tests/fixtures/largeDocument/generate.ts` rewrites the committed copy.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = generateLargeDocument()
  writeFileSync(LARGE_DOC_FIXTURE_PATH, text)
  process.stdout.write(`wrote ${LARGE_DOC_FIXTURE_PATH}: ${countWords(text)} words, ${text.length} chars\n`)
}
