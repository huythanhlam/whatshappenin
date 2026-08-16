// Event prominence — "how big a deal is this in the world?", independent of
// anything our own users have done.
//
// The rest of the recommender is a closed loop: `event_engagement` only knows
// what our audience clicked, and our audience only sees what the recommender
// ranked. That loop can't cold-start — a sold-out arena show and a coffee-shop
// open mic both enter it at DEFAULT_CITY_ENGAGEMENT_RATE. Prominence breaks the
// loop by scoring an event from evidence that exists outside our traffic: who is
// playing, how famous they are, how big the room is, how many outlets covered
// it, whether tickets are already gone.
//
// Pure and DB-free, like score.ts and affinity.ts — the caller gathers the
// inputs, this decides what they're worth.

import type { EventSignals } from '../sources/types'

// What a canonical-artist lookup yields (lib/recs/artists.ts). Null when the
// event has no resolvable performer, which is the common case off the ticketing
// sources.
export type ArtistFame = {
  // A 0–100 recency-aware popularity index. Null on providers that publish no
  // such number (Deezer), where follower count alone carries the signal.
  popularity: number | null
  // Followers/fans. Cumulative and monotonic, so it's the coarser of the two —
  // a long-retired act keeps its followers — but it's universally available.
  followers: number
}

// Everything the scorer considers. `signals` comes off the RawEvent; the rest is
// context the persist layer assembles from other tables.
export type ProminenceInput = {
  signals: EventSignals | null
  artist: ArtistFame | null
  // Room size from the `venues` table, when the source didn't state one.
  venueCapacity?: number | null
  // How many distinct sources describe this event (rows in `event_sources`).
  // Five outlets covering one show is itself evidence of significance.
  sourceCount?: number | null
  // Whether a human curator picked it (Chronicle Staff Pick, CultureMap, etc.).
  editorialPick?: boolean
  // Ticket price floor — a demand proxy, since promoters price to expected pull.
  priceMin?: number | null
  // Event start, needed to read `ticketStatus`: 'offsale' means sold out only if
  // the event hasn't already happened.
  startTime?: string | null
  // Current time, passed in rather than read from the clock — same convention as
  // computeFeatures in score.ts, so scoring stays deterministic and testable.
  // Only consulted alongside `startTime`; defaults to the real clock.
  nowMs?: number
}

// The prominence a event with NO usable evidence gets. Deliberately not zero:
// most of the long tail supplies nothing here, and "we know nothing about this"
// must not be scored as "this is unpopular". Sits at the low end because the
// typical catalog event genuinely is small, and the confidence blend below pulls
// toward it from both directions.
export const NEUTRAL_PROMINENCE = 0.15

// Weight per sub-signal — how much each is worth *relative to the others that
// are also present*. Artist fame dominates because it is the only signal that
// knows a household name is a household name before anyone clicks anything.
const WEIGHTS = {
  artistFame: 3.0,
  externalPopularity: 2.5,
  venueCapacity: 1.5,
  soldOut: 1.5,
  touringScale: 1.0,
  corroboration: 1.0,
  editorial: 1.0,
  priceFloor: 0.7,
  attendance: 1.2,
} as const

// Total weight at which the score is trusted outright. Reaching it takes two or
// three real signals, not all nine — an event with a resolved Spotify artist and
// a known room size should not be hedged toward neutral just because SeatGeek
// never listed it.
const FULL_CONFIDENCE_WEIGHT = 4.5

// Map a value onto [0,1] logarithmically between two anchors. Log rather than
// linear because every quantity here is heavy-tailed: the gap between a 200-cap
// room and a 2,000-cap room matters far more than the gap between 18,000 and
// 20,000.
function logNorm(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value) || value <= lo) return 0
  if (value >= hi) return 1
  return Math.log(value / lo) / Math.log(hi / lo)
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

// One sub-signal's contribution: its normalized value plus the weight backing it.
type Part = { key: keyof typeof WEIGHTS; value: number; weight: number }

// The individual sub-scores behind a prominence number. Exported for tests and
// for the admin view — a bare 0.62 is unfalsifiable, "0.62, mostly artist fame"
// is debuggable.
export function prominenceParts(input: ProminenceInput): Part[] {
  const { signals, artist } = input
  const parts: Part[] = []
  const add = (key: keyof typeof WEIGHTS, value: number) =>
    parts.push({ key, value: clamp01(value), weight: WEIGHTS[key] })

  if (artist) {
    // Follower counts are heavy-tailed across four orders of magnitude between a
    // local act and a stadium headliner, so they're log-scaled like every other
    // count here.
    const byFollowers = logNorm(artist.followers, 1_000, 10_000_000)
    // A popularity index, where the provider publishes one, is the sharper
    // measure: it's recency-aware, where followers only ever accumulate (a
    // long-retired act keeps them). It leads the blend, with followers breaking
    // ties among the many artists parked on the same popularity integer. With no
    // index available, followers carry the signal alone.
    add(
      'artistFame',
      artist.popularity === null
        ? byFollowers
        : 0.7 * (artist.popularity / 100) + 0.3 * byFollowers
    )
  }

  if (typeof signals?.externalPopularity === 'number') {
    add('externalPopularity', signals.externalPopularity)
  }

  const capacity = signals?.venueCapacity ?? input.venueCapacity
  if (typeof capacity === 'number' && capacity > 0) {
    // 50-cap back room → 0; 20k arena → 1.
    add('venueCapacity', logNorm(capacity, 50, 20_000))
  }

  // Sold out — the strictest signal here, because `offsale` is ambiguous.
  // Ticketmaster reports it for a show whose tickets are gone AND for one whose
  // tickets haven't been released yet, and reading the second as the first
  // scores every unannounced show as a sellout (observed live: eight dates of a
  // touring musical topping the list on this signal alone). Three conditions
  // must ALL hold:
  //   1. the event hasn't already happened — offsale afterwards is bookkeeping
  //   2. public sale is known to have opened...
  //   3. ...and that opening is in the past
  // When the sale time is unknown we decline to call it, rather than guess: a
  // missed sellout costs a little ranking, a false one puts a show nobody can
  // buy tickets for at the top of the rail.
  if (signals?.ticketStatus === 'offsale' && input.startTime && signals.salesStartTime) {
    const nowMs = input.nowMs ?? Date.now()
    const startMs = new Date(input.startTime).getTime()
    const saleMs = new Date(signals.salesStartTime).getTime()
    const upcoming = Number.isFinite(startMs) && startMs > nowMs
    const saleOpened = Number.isFinite(saleMs) && saleMs <= nowMs
    if (upcoming && saleOpened) add('soldOut', 1)
  }

  // Likewise, one booking is the floor rather than a finding — an act with a
  // single date is simply an act we have no touring information about. From two
  // dates up it's a real scale signal; 100 on the books is a national tour.
  if (typeof signals?.performerUpcomingEvents === 'number' && signals.performerUpcomingEvents > 1) {
    add('touringScale', logNorm(signals.performerUpcomingEvents, 1, 100))
  }

  // Corroboration counts only from the SECOND source onward. Every event has at
  // least one by definition, so a lone source is the default state of the
  // catalog, not evidence of obscurity — scoring it as a zero would drag the
  // entire single-sourced long tail below events we know nothing about at all.
  // Same reasoning as `editorialPick: false` below. Six sources is saturation.
  if (typeof input.sourceCount === 'number' && input.sourceCount > 1) {
    add('corroboration', logNorm(input.sourceCount, 1, 6))
  }

  // Only a positive pick counts. `editorialPick: false` means "no curator
  // touched this", which is the default state of nearly everything — scoring it
  // as a zero would punish the entire non-curated catalog.
  if (input.editorialPick) add('editorial', 1)

  if (typeof input.priceMin === 'number' && input.priceMin > 0) {
    add('priceFloor', logNorm(input.priceMin, 10, 200))
  }

  if (typeof signals?.attendeeCount === 'number' && signals.attendeeCount > 0) {
    add('attendance', logNorm(signals.attendeeCount, 10, 2_000))
  }

  return parts
}

// Prominence in [0,1].
//
// The score is the weighted mean of whichever sub-signals are present, then
// blended toward NEUTRAL_PROMINENCE by how much evidence backed it. So:
//   * no evidence          → exactly NEUTRAL_PROMINENCE (unknown, not unpopular)
//   * thin evidence, high  → above neutral, but hedged
//   * strong evidence, high→ the score itself
//   * strong evidence, low → below neutral, which is correct: a SeatGeek-scored
//                            event that scored badly really is a small event.
export function computeProminence(input: ProminenceInput): number {
  const parts = prominenceParts(input)
  if (parts.length === 0) return NEUTRAL_PROMINENCE

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0)
  const weighted = parts.reduce((sum, p) => sum + p.value * p.weight, 0) / totalWeight
  const confidence = Math.min(1, totalWeight / FULL_CONFIDENCE_WEIGHT)

  return clamp01(NEUTRAL_PROMINENCE + (weighted - NEUTRAL_PROMINENCE) * confidence)
}
