// Prints the worker units and checks the mask round trip (no API calls).
import { largeDocument } from './fixtures'
import { mask, sectionUnits, termUnits, unmask } from './worker'

const d = largeDocument()
const s = sectionUnits(d)
const t = termUnits(d)
let tot = 0
for (const u of [...s, ...t]) {
  const m = mask(u.text)
  tot += u.text.length
  if (unmask(m.masked, m.slots) !== u.text) console.log('ROUNDTRIP FAIL', u.id)
  console.log(u.id, u.headingPath.slice(0, 60), u.text.split(/\s+/).length, 'w', m.slots.length, 'slots')
}
console.log('sections', s.length, 'terms', t.length, 'kund', t.reduce((a, u) => a + (u.text.match(/Kund/g) ?? []).length, 0), 'chars', tot)
if (process.argv[2]) console.log(mask(s[Number(process.argv[2])]!.text).masked)

// Units as JSON for the offline analysis (paragraph-count drift).
await Bun.write(`${process.env.EVAL_OUT_DIR ?? 'tests/bench/model-eval/results'}/units.json`, JSON.stringify({ sections: s, terms: t }))
