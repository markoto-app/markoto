// Blind judge for the worker outputs: per (mode, unit) one call that sees the
// source and every model's output under shuffled letters, and rates each 1-5.
//
//   bun tests/bench/model-eval/judge.ts <judge-model> <models,comma> <modes,comma>

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { largeDocument } from './fixtures'
import { sectionUnits, termUnits } from './worker'
import { assertBudget, costUsd, recordSpend } from './pricing'

const URL_BASE = process.env.EVAL_LITELLM_URL ?? 'http://127.0.0.1:4400/v1'
const KEY = process.env.EVAL_LITELLM_KEY ?? 'sk-eval-local'
const OUT = (process.env.EVAL_OUT_DIR ?? 'tests/bench/model-eval/results')

const CRITERIA: Record<string, string> = {
  translate: 'German to British English translation of a section of an operations handbook. Rate accuracy (nothing added, nothing lost, numbers and names exact), fluency and idiomatic English, consistent technical terminology, and preserved Markdown structure. Penalise untranslated text, literal calques that read unnaturally, and changed meaning.',
  formal: 'Rewrite of a German (Swiss) handbook section into a more formal, binding register ("ist zu", "muss"). Rate: is the register clearly more formal and consistent; is the content fully kept (no facts dropped or added, numbers and names exact); is the German correct and natural (no sharp s required); is the structure kept. Penalise text that barely changed, text that lost content, and stilted or ungrammatical German.',
  terminology: 'Replace "Kunde/Kunden/Kundin/Kundinnen" with "Klient/Klienten/Klientin/Klientinnen" and adjust only the words that must agree grammatically; nothing else may change. Rate: every occurrence replaced with the correct inflected form, grammar correct, and no other change to the text (any other edit is a serious fault).'
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr]
  let s = seed
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

if (import.meta.main) {
  const [judge = 'mistral-large-4', models = '', modes = 'translate,formal,terminology'] = process.argv.slice(2)
  const doc = largeDocument()
  const unitsByMode = { translate: sectionUnits(doc), formal: sectionUnits(doc), terminology: termUnits(doc) } as const
  const modelList = models.split(',')
  for (const mode of modes.split(',') as Array<keyof typeof unitsByMode>) {
    // EVAL_JUDGE_EVERY=2 judges every second unit; EVAL_JUDGE_CONCURRENCY parallel calls.
    const every = Number(process.env.EVAL_JUDGE_EVERY ?? '1')
    const entries = [...unitsByMode[mode].entries()].filter(([i]) => i % every === 0)
    let next = 0
    await Promise.all(Array.from({ length: Number(process.env.EVAL_JUDGE_CONCURRENCY ?? '1') }, async () => {
      while (next < entries.length) {
        const [ui, u] = entries[next++]!
        const outs = modelList.map(m => ({ m, path: `${OUT}/worker-outputs/${m}/${mode}/${u.id}.md` })).filter(o => existsSync(o.path))
        const shuffled = seededShuffle(outs, ui * 31 + mode.length)
        const letters = 'ABCDEFGH'
        const candidates = shuffled.map((o, i) => `<candidate id="${letters[i]}">\n${readFileSync(o.path, 'utf8')}\n</candidate>`).join('\n\n')
        const prompt = `You are a strict professional editor and translator. Task given to each candidate: ${CRITERIA[mode]}

Rate each candidate independently on a 1-5 scale (5 = publishable without edits, 4 = minor issues, 3 = several issues an editor must fix, 2 = major errors, 1 = unusable). Then name the single most important problem of each (or "none").

<source>
${u.text}
</source>

${candidates}

Answer with JSON only: {"ratings": [{"id": "A", "score": 4, "problem": "..."}, ...]}`
        assertBudget()
        const res = await fetch(`${URL_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: judge, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 16000, response_format: { type: 'json_object' } })
        })
        if (!res.ok) {
          console.error(mode, u.id, res.status, (await res.text()).slice(0, 200))
          continue
        }
        const j = await res.json() as { choices: Array<{ message: { content: string } }>, usage: { prompt_tokens: number, completion_tokens: number, prompt_tokens_details?: { cached_tokens?: number }, completion_tokens_details?: { reasoning_tokens?: number } } }
        const usage = { prompt: j.usage.prompt_tokens, cached: j.usage.prompt_tokens_details?.cached_tokens ?? 0, output: j.usage.completion_tokens, reasoning: j.usage.completion_tokens_details?.reasoning_tokens ?? 0 }
        recordSpend({ experiment: 'judge', model: judge, usage, usd: costUsd(judge, usage), tag: `${mode}/${u.id}` })
        let parsed: { ratings: Array<{ id: string, score: number, problem: string }> }
        try {
          const txt = j.choices[0]!.message.content.replace(/^```(json)?|```$/g, '').trim()
          parsed = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1))
        } catch {
          console.error('unparsable', mode, u.id)
          continue
        }
        for (const r of parsed.ratings) {
          const idx = letters.indexOf(r.id)
          const model = shuffled[idx]?.m
          if (model) appendFileSync(`${OUT}/judge.jsonl`, `${JSON.stringify({ judge, mode, unit: u.id, model, score: r.score, problem: r.problem })}\n`)
        }
        console.log(mode, u.id, 'judged', parsed.ratings.length)
      }
    }))
  }
}
