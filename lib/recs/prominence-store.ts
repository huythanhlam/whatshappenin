// Prominence, from a persisted event to a stored score.
//
// lib/recs/prominence.ts decides what evidence is *worth*; this module gathers
// the evidence — some of it off the RawEvent, some of it only knowable after the
// event has a canonical id (how many sources corroborate it) or from other
// tables (room capacity, artist fame).
//
// Every step degrades: migration 046 sits above the legacy migration ceiling, so
// on a PGlite dev database the columns and tables here simply don't exist. The
// scoring still runs, the write no-ops, and ranking falls back to
// NEUTRAL_PROMINENCE — exactly the behaviour that predated this feature.

import type { RawEvent } from '../sources/types'
import { countEventSources, getVenueCapacity, setEventProminence } from '../db'
import { computeProminence } from './prominence'
import { normalizeArtist, resolveArtistFame } from './artists'
import { capacityForVenue } from './venue-capacity'
import { isEditorialSource } from './config'

// Per-batch caches. Venues repeat heavily within one ingest run (many events at
// the same handful of rooms), so capacity is looked up once per venue rather
// than once per event — the same reason persistEvents caches geocodes and venue
// images across a batch.
export type ProminenceBatch = {
  capacityByVenue: Map<string, number | null>
  // Set once the store discovers the columns are absent, so a legacy-ceiling
  // database costs one failed UPDATE per ingest run instead of one per event.
  unavailable: boolean
}

export function newProminenceBatch(): ProminenceBatch {
  return { capacityByVenue: new Map(), unavailable: false }
}

// Code map first, database column second. The map is the reliable source (see
// lib/recs/venue-capacity.ts for why the column alone was unreachable); the
// column is an override for rooms the map doesn't list, and returns null on any
// database where the venues table is empty or the column absent.
async function capacityFor(
  batch: ProminenceBatch,
  cityId: number,
  venueNorm: string | null
): Promise<number | null> {
  if (!venueNorm) return null
  const known = capacityForVenue(venueNorm)
  if (known !== null) return known

  if (!batch.capacityByVenue.has(venueNorm)) {
    batch.capacityByVenue.set(venueNorm, await getVenueCapacity(cityId, venueNorm))
  }
  return batch.capacityByVenue.get(venueNorm) ?? null
}

// Score one persisted event and store the result. Never throws — an ingest must
// not fail because a popularity lookup did.
export async function scoreAndStoreProminence(
  eventId: string,
  raw: RawEvent,
  ctx: { cityId: number; venueNorm: string | null; batch: ProminenceBatch }
): Promise<number | null> {
  const { batch } = ctx
  if (batch.unavailable) return null

  try {
    const signals = raw.signals ?? null
    const headliner = signals?.performers?.[0] ?? null

    // The artist lookup is the only network call here, and it only fires for
    // events that actually name a performer — i.e. the ticketing sources. Its
    // own cache collapses a whole tour into one Spotify request.
    const [artist, sourceCount, venueCapacity] = await Promise.all([
      resolveArtistFame(signals?.performers),
      countEventSources(eventId),
      capacityFor(batch, ctx.cityId, ctx.venueNorm),
    ])

    const prominence = computeProminence({
      signals,
      artist,
      venueCapacity,
      sourceCount,
      editorialPick: isEditorialSource(raw.source),
      priceMin: raw.price_min,
      startTime: raw.start_time,
    })

    const stored = await setEventProminence(
      eventId,
      prominence,
      headliner ? normalizeArtist(headliner) : null
    )
    if (!stored) batch.unavailable = true

    return prominence
  } catch {
    return null
  }
}
