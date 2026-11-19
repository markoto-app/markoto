import { useUmamiPool } from '../db/umami'
import type { SystemActor } from './proofs'

// Retention of Umami's visitor data (docs/SELF-HOSTING.md#analytics-optional): Umami
// keeps every event forever, the privacy policy promises 13 months. Rows
// are deleted children first; a table an older or newer Umami doesn't have
// is skipped. Table names are this fixed list, never input.
const VISITOR_TABLES = [
  'event_data',
  'revenue',
  'heatmap_event',
  'session_replay',
  'website_event',
  'session_data',
  'session'
] as const

export async function deleteUmamiDataBefore(_by: SystemActor, cutoff: Date): Promise<Record<string, number>> {
  const client = await useUmamiPool().connect()
  const deleted: Record<string, number> = {}
  try {
    for (const table of VISITOR_TABLES) {
      const exists = await client.query<{ t: string | null }>('SELECT to_regclass($1) AS t', [`public.${table}`])
      if (!exists.rows[0]?.t) continue
      const res = await client.query(`DELETE FROM public."${table}" WHERE created_at < $1`, [cutoff])
      if (res.rowCount) deleted[table] = res.rowCount
    }
  } finally {
    client.release()
  }
  return deleted
}
