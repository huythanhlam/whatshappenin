// Room capacity by venue — the "how big is this stage" half of prominence.
//
// Deliberately a CODE map rather than a database column. Capacity was first
// modelled as `venues.capacity`, seeded by migration, which turned out to be
// unreachable: the `venues` table is populated only as a side effect of
// geocoding, and in production it is empty — so the seed matched zero rows and
// every capacity lookup returned null. Keying off `events.venue_norm` instead
// removes that dependency entirely; the column survives as an optional override
// for venues not listed here.
//
// A static list is the right shape anyway. The set of rooms that distinguishes a
// big night from a small one is small, stable, and changes on the timescale of a
// venue opening or closing — and no free API publishes capacities for the
// independent rooms that make up most of a city's music calendar.
//
// Keys MUST be exactly what normalizeVenue() (lib/normalize.ts) produces:
// lowercased, apostrophes deleted, other punctuation collapsed to spaces. The
// unit test asserts that, because a hand-written key that doesn't round-trip is
// silently dead — which is precisely how the first version of this failed.

import { normalizeVenue } from '../normalize'

// Austin, plus the Houston rooms already in the catalog. Several venues appear
// under more than one spelling across sources (ACL Live has three), and each
// spelling normalizes differently, so each gets its own entry rather than
// relying on dedup to have collapsed them.
export const VENUE_CAPACITY: Readonly<Record<string, number>> = {
  // --- Austin: stadiums + arenas
  'circuit of the americas': 120000,
  'darrell k royal texas memorial stadium': 100119,
  'q2 stadium': 20500,
  'frank erwin center': 16500,
  'moody center atx': 15000,
  'moody center': 15000,
  'germania insurance amphitheater': 14000,
  // --- Austin: mid-size
  'moody amphitheater': 5000,
  'bass concert hall': 2900,
  'acl live at the moody theater': 2750,
  'austin city limits live at the moody theater': 2750,
  'acl live': 2750,
  'the long center': 2400,
  'long center for the performing arts': 2400,
  'stubbs waller creek amphitheater': 2200,
  'stubbs bar b q': 2200,
  'emos austin': 1700,
  'emos': 1700,
  'scoot inn': 1500,
  'historic scoot inn': 1500,
  'the far out lounge': 1200,
  'paramount theatre': 1270,
  // --- Austin: clubs
  'the concourse project': 1000,
  'mohawk austin': 900,
  'mohawk': 900,
  'antones nightclub': 800,
  'antones': 800,
  'empire control room garage': 700,
  'the parish': 450,
  'cheer up charlies': 400,
  'zach theatre': 420,
  '3ten acl live': 350,
  'continental club': 300,
  'meanwhile brewing co': 300,
  'the saxon pub': 200,
  'cactus cafe': 200,
  'the vortex': 200,
  'hyde park theatre': 85,
  'hole in the wall': 150,
  'cap city comedy club': 280,
  'fallout theater': 100,
  // --- Houston
  'cynthia woods mitchell pavilion': 16500,
  'house of blues houston': 1200,
}

// Capacity for an event's venue, or null when the room is unknown — which
// computeProminence reads as "unknown size", never as "small".
export function capacityForVenue(venueNorm: string | null | undefined): number | null {
  if (!venueNorm) return null
  return VENUE_CAPACITY[venueNorm] ?? null
}

// Same lookup from a raw, un-normalized venue name.
export function capacityForVenueName(venueName: string | null | undefined): number | null {
  return capacityForVenue(normalizeVenue(venueName))
}
