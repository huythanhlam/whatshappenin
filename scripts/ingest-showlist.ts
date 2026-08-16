// End-to-end ingest of austin.showlists.net through the app's real pipeline:
// the 'showlist' source parser (obtain) → persistEvents (dedupe, tag, geocode,
// insert). Run against the app's own data layer so it exercises the same code
// the site uses.
//
//   npx tsx scripts/ingest-showlist.ts
//
// With no DATABASE_URL it targets the embedded PGlite (seeded with the baseline
// Austin events), exactly like `npm run dev`; set DATABASE_URL to ingest into a
// real Postgres instead. This script is also how the source is proven locally:
// its `sources` row lives in migration 044, which is past the legacy PGlite
// runner's ceiling (33), so the dev DB never sees it via /api/ingest.
//
// It persists twice so the second pass demonstrates the dedup: a re-ingest of
// the same events inserts nothing.
import { fetchShowlistEvents } from '@/lib/sources/showlist'
import { persistEvents } from '@/lib/persist'
import { isLocal } from '@/lib/db'
import { getPgliteDb } from '@/lib/db/pglite'
import { getPgDb } from '@/lib/db/pg'
import type { Db } from '@/lib/db/driver'

const SOURCE = 'crawl:austin-showlists-net'
const URL = 'https://austin.showlists.net/'
const CITY_ID = 1 // Austin

async function db(): Promise<Db> {
  return isLocal() ? getPgliteDb() : getPgDb()
}

async function countFromSource(): Promise<number> {
  const rows = await (await db()).query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM events WHERE source = $1`,
    [SOURCE],
  )
  return parseInt(rows[0]?.count ?? '0', 10)
}

async function main() {
  console.log(`Mode: ${isLocal() ? 'local (PGlite, seeded)' : 'Postgres (DATABASE_URL)'}`)

  console.log(`\n[1/4] Obtaining events from ${URL} (one request, whole listing)...`)
  const events = await fetchShowlistEvents(URL, SOURCE)
  console.log(`  Obtained ${events.length} events (deduped by show id).`)
  if (events.length === 0) {
    console.error('  No events obtained — aborting.')
    process.exit(1)
  }
  const days = new Set(events.map(e => e.start_time.slice(0, 10)))
  const withVenue = events.filter(e => e.venue_name).length
  const withAddress = events.filter(e => e.venue_address).length
  const withTickets = events.filter(e => e.ticket_url).length
  console.log(
    `  ${withVenue}/${events.length} have a venue, ${withAddress} an address, ${withTickets} a ticket link;` +
    ` ${days.size} distinct days, ${[...days].sort()[0]} → ${[...days].sort().at(-1)}.`,
  )
  console.log('  Sample:')
  for (const e of events.slice(0, 5)) {
    console.log(`    • ${e.start_time.slice(0, 16).replace('T', ' ')}Z  ${e.title}  @ ${e.venue_name ?? '—'}`)
  }

  const before = await countFromSource()

  // persistEvents' `inserted` counts events successfully processed (created OR
  // merged into an existing canonical event), so the authoritative proof of
  // dedup is the actual row count in the DB before/after each pass.
  console.log(`\n[2/4] Persisting (dedupe + tag + insert) into the application...`)
  const first = await persistEvents(events, { cityId: CITY_ID, status: 'approved' })
  const afterFirst = await countFromSource()
  console.log(`  persist result: ${JSON.stringify(first)}`)
  console.log(`  new canonical rows: ${afterFirst - before} (from ${events.length} obtained → ${events.length - (afterFirst - before)} collapsed by title+venue dedup)`)

  console.log(`\n[3/4] Re-persisting the SAME events to demonstrate idempotent dedup...`)
  const second = await persistEvents(events, { cityId: CITY_ID, status: 'approved' })
  const afterSecond = await countFromSource()
  const grew = afterSecond - afterFirst
  console.log(`  persist result: ${JSON.stringify(second)}`)
  console.log(
    grew === 0
      ? `  ✓ Re-ingest added 0 new rows (count steady at ${afterSecond}) — dedup holds.`
      : `  ✗ Re-ingest added ${grew} rows — expected 0.`,
  )

  console.log(`\n[4/4] Verification`)
  console.log(`  events with source=${SOURCE}: ${before} → ${afterFirst} → ${afterSecond}`)
  console.log(
    `  first pass: processed ${first.inserted}, rejected ${first.rejected} (bad/undated) of ${first.total} obtained`,
  )

  const sample = await (await db()).query<{ title: string; start_time: string; venue_name: string | null; venue_address: string | null }>(
    `SELECT title, start_time, venue_name, venue_address FROM events WHERE source = $1 ORDER BY start_time LIMIT 8`,
    [SOURCE],
  )
  console.log('  Persisted sample (from DB):')
  for (const r of sample) {
    console.log(`    • ${new Date(r.start_time).toISOString().slice(0, 16).replace('T', ' ')}Z  ${r.title}  @ ${r.venue_name ?? '—'} (${r.venue_address ?? '—'})`)
  }

  process.exit(0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
