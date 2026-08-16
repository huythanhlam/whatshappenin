import type { EventSignals, RawEvent } from './types'

// SeatGeek API — Austin events with performer images. Free client_id at
// https://seatgeek.com/account/develop. Returns [] when no key is configured.
type SgPerformer = {
  name?: string | null
  score?: number | null
  num_upcoming_events?: number | null
  image?: string | null
  images?: { huge?: string; large?: string }
}

type SgStats = {
  lowest_price?: number | null
  highest_price?: number | null
  listing_count?: number | null
}

function performerImage(performers: SgPerformer[] | undefined): string | null {
  const p = performers?.[0]
  return p?.image ?? p?.images?.huge ?? p?.images?.large ?? null
}

// SeatGeek's `score` is already a 0–1 demand index across their whole catalog,
// so it needs no rescaling — only clamping, since the API isn't contractually
// bound to that range. The event's own score is preferred; the headliner's is
// the fallback for events SeatGeek hasn't scored individually yet.
function popularity(eventScore: unknown, headliner: SgPerformer | undefined): number | undefined {
  const raw = typeof eventScore === 'number' ? eventScore : headliner?.score
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  return Math.min(1, Math.max(0, raw))
}

// Everything SeatGeek knows about this event's pull, kept out of the RawEvent
// body proper. Returns null rather than an empty object so an event with no
// popularity evidence stores no signals blob at all.
function buildSignals(ev: Record<string, unknown>, stats: SgStats | undefined): EventSignals | null {
  const performers = (ev.performers as SgPerformer[] | undefined) ?? []
  const headliner = performers[0]
  const names = performers.map(p => p.name).filter((n): n is string => !!n)

  const signals: EventSignals = {}
  if (names.length) signals.performers = names
  const pop = popularity(ev.score, headliner)
  if (pop !== undefined) signals.externalPopularity = pop
  if (typeof headliner?.num_upcoming_events === 'number') {
    signals.performerUpcomingEvents = headliner.num_upcoming_events
  }
  if (typeof stats?.listing_count === 'number') signals.listingCount = stats.listing_count

  return Object.keys(signals).length > 0 ? signals : null
}

export async function fetchSeatGeekEvents(city: { name: string }): Promise<RawEvent[]> {
  const clientId = process.env.SEATGEEK_CLIENT_ID
  if (!clientId) {
    console.warn('SEATGEEK_CLIENT_ID not set — skipping SeatGeek')
    return []
  }

  const results: RawEvent[] = []

  for (let page = 1; page <= 3; page++) {
    const url = new URL('https://api.seatgeek.com/2/events')
    url.searchParams.set('venue.city', city.name)
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('per_page', '100')
    url.searchParams.set('page', String(page))
    url.searchParams.set('sort', 'datetime_utc.asc')

    let data: Record<string, unknown>
    try {
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(20000) })
      if (!res.ok) break
      data = await res.json()
    } catch (e) {
      console.error('SeatGeek fetch failed:', e)
      break
    }

    const events = (data.events as Record<string, unknown>[] | undefined) ?? []
    if (events.length === 0) break

    for (const ev of events) {
      const start = (ev.datetime_utc as string | null) ?? (ev.datetime_local as string | null)
      if (!start) continue

      const venue = ev.venue as { name?: string; display_location?: string; capacity?: number } | undefined
      const stats = ev.stats as SgStats | undefined

      const signals = buildSignals(ev, stats)
      if (signals && typeof venue?.capacity === 'number' && venue.capacity > 0) {
        signals.venueCapacity = venue.capacity
      }

      results.push({
        title: (ev.title as string) ?? 'Untitled',
        description: (ev.description as string) || null,
        start_time: new Date(start.endsWith('Z') ? start : `${start}Z`).toISOString(),
        end_time: null,
        venue_name: venue?.name ?? null,
        venue_address: venue?.display_location ?? null,
        image_url: performerImage(ev.performers as SgPerformer[] | undefined),
        ticket_url: (ev.url as string) ?? null,
        source: 'seatgeek',
        source_id: String(ev.id),
        is_free: false,
        price_min: stats?.lowest_price ?? null,
        price_max: stats?.highest_price ?? null,
        signals,
      })
    }
  }

  return results
}
