// Ticket-demand telemetry — polling what the resale market is doing.
//
// Every other signal in the recommender is a snapshot. This one is a series: the
// same events are re-checked on a cron so the *slope* is observable. Listings
// draining and average price climbing is the cleanest evidence of demand there
// is, and it's entirely independent of our own traffic — which is exactly what
// makes it worth the API calls.
//
// SeatGeek is the only source polled: its /events endpoint returns live
// `stats.listing_count` and `stats.average_price` per event, which Ticketmaster
// has no equivalent of (TM's lifecycle is visible only as the coarse
// onsale/offsale flip already captured at ingest).

import { listTicketedEventIds, recordEventDemand } from '../db'

// How far ahead to poll. Beyond this the resale market is too thin for the slope
// to mean anything, and it's wasted quota.
const POLL_WINDOW_DAYS = 45

// Cap per run, so one city can't exhaust the API budget. SeatGeek's free tier is
// generous but not unlimited, and the events nearest in time are the ones whose
// supply is actually moving.
const MAX_EVENTS_PER_RUN = 200

type SgEvent = {
  id: number | string
  stats?: { listing_count?: number | null; average_price?: number | null }
}

export function seatgeekAvailable(): boolean {
  return !!process.env.SEATGEEK_CLIENT_ID
}

// Fetch current stats for a batch of SeatGeek event ids in one request.
async function fetchStats(externalIds: string[]): Promise<Map<string, SgEvent>> {
  const out = new Map<string, SgEvent>()
  const clientId = process.env.SEATGEEK_CLIENT_ID
  if (!clientId || externalIds.length === 0) return out

  const url = new URL('https://api.seatgeek.com/2/events')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('per_page', String(externalIds.length))
  // The API accepts repeated id params, which keeps this to one request per
  // batch instead of one per event.
  for (const id of externalIds) url.searchParams.append('id', id)

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return out
    const data = (await res.json()) as { events?: SgEvent[] }
    for (const ev of data.events ?? []) out.set(String(ev.id), ev)
  } catch {
    // A failed poll just means no observation this run; the series tolerates gaps
    // because the slope is computed between whatever two points exist.
  }
  return out
}

// Append one observation per upcoming ticketed event in a city. Returns how many
// observations were recorded (0 when the key is unset or the tables are absent).
export async function pollCityDemand(cityId: number): Promise<number> {
  if (!seatgeekAvailable()) return 0

  const events = await listTicketedEventIds(cityId, {
    source: 'seatgeek',
    withinDays: POLL_WINDOW_DAYS,
    limit: MAX_EVENTS_PER_RUN,
  })
  if (events.length === 0) return 0

  let recorded = 0
  // Batched so a city's worth of events is a handful of requests, not hundreds.
  for (let i = 0; i < events.length; i += 50) {
    const batch = events.slice(i, i + 50)
    const stats = await fetchStats(batch.map(e => e.externalId))

    for (const ev of batch) {
      const hit = stats.get(ev.externalId)
      if (!hit) continue
      await recordEventDemand({
        eventId: ev.eventId,
        listingCount: hit.stats?.listing_count ?? null,
        avgPrice: hit.stats?.average_price ?? null,
        status: null, // SeatGeek has no lifecycle field; TM's is captured at ingest
      })
      recorded++
    }
  }

  return recorded
}
