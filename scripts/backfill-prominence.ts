// Backfill events.prominence for the existing catalog.
//
// Without this, prominence only lands on events as they're re-ingested, so for
// the first day or two the ranking would treat most of the catalog as "unknown"
// (NEUTRAL_PROMINENCE) while newly-seen events carried real scores — which is
// worse than either state on its own, because the two aren't comparable.
//
// Reads the stored provenance (event_sources.raw is the RawEvent as ingested,
// signals included) rather than re-fetching any source, so it costs no ingest
// API quota. It does spend artist-fame lookups for events that name a performer,
// though the artist cache collapses a whole tour into one request. No
// credentials needed — the default provider (Deezer) is keyless.
//
// Idempotent — re-running just recomputes, so it's safe to re-run after
// hand-seeding more venue capacities.
//
//   npx tsx scripts/backfill-prominence.ts
import { getEventsForProminenceBackfill, getVenueCapacity, setEventProminence } from '@/lib/db'
import { computeProminence } from '@/lib/recs/prominence'
import { normalizeArtist, resolveArtistFame, titleArtistCandidates } from '@/lib/recs/artists'
import { editorialStrength } from '@/lib/recs/config'
import { capacityForVenue } from '@/lib/recs/venue-capacity'
import type { EventSignals } from '@/lib/sources/types'

const BATCH_SIZE = 200

// Merge the signal blobs from every source that described this event. Sources
// disagree on what they carry (SeatGeek has a popularity index, Ticketmaster has
// the attractions), so the union is strictly better than any single one. Later
// sources win only where earlier ones said nothing.
function mergeSignals(raws: unknown[]): EventSignals | null {
  const merged: EventSignals = {}
  let any = false
  for (const raw of raws) {
    const signals = (raw as { signals?: EventSignals | null } | null)?.signals
    if (!signals) continue
    for (const [key, value] of Object.entries(signals)) {
      if (value === undefined || value === null) continue
      if (merged[key as keyof EventSignals] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(merged as any)[key] = value
        any = true
      }
    }
  }
  return any ? merged : null
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — this backfills the shared prod database only.')
    process.exit(1)
  }

  const capacityByVenue = new Map<string, number | null>()
  let afterId: string | null = null
  let total = 0
  let scored = 0

  for (;;) {
    const batch = await getEventsForProminenceBackfill(BATCH_SIZE, afterId)
    if (batch.length === 0) break

    for (const row of batch) {
      const signals = mergeSignals(row.raws ?? [])
      const headliner = signals?.performers?.[0] ?? null

      let capacity: number | null = capacityForVenue(row.venue_norm)
      if (capacity === null && row.venue_norm) {
        if (!capacityByVenue.has(row.venue_norm)) {
          capacityByVenue.set(row.venue_norm, await getVenueCapacity(row.city_id, row.venue_norm))
        }
        capacity = capacityByVenue.get(row.venue_norm) ?? null
      }

      // Most of the existing catalog was ingested before signals capture, so it
      // stores no performers at all. Fall back to names derived from the title;
      // the provider's exact-match requirement discards the ones that aren't
      // really artists.
      const candidates = signals?.performers?.length
        ? signals.performers
        : titleArtistCandidates(row.title)

      const prominence = computeProminence({
        signals,
        artist: await resolveArtistFame(candidates),
        venueCapacity: capacity,
        sourceCount: (row.sources ?? []).length,
        editorialStrength: editorialStrength(row.sources ?? []),
        priceMin: row.price_min,
        startTime: row.start_time,
      })

      const ok = await setEventProminence(
        row.id,
        prominence,
        headliner ? normalizeArtist(headliner) : null
      )
      if (!ok) {
        console.error('events.prominence is missing — has migration 046 been applied?')
        process.exit(1)
      }
      scored++
    }

    total += batch.length
    afterId = batch[batch.length - 1].id
    console.log(`  scored ${scored}/${total} event(s)...`)
  }

  console.log(`Done: ${scored} event(s) scored.`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
