export type RawEvent = {
  title: string
  description: string | null
  start_time: string
  end_time: string | null
  venue_name: string | null
  venue_address: string | null
  image_url: string | null
  ticket_url: string | null
  source: string
  source_id: string
  // The authoritative kind of the `sources` row this event came from (its
  // `kind` column), stamped on by lib/sources/registry.ts's PARSERS dispatch
  // at fetch time. Optional/nullable because plenty of RawEvents never flow
  // through the registry (seed data, public submissions, ad-hoc /api/import
  // crawls, test fixtures) — sourceTrust() falls back to its static
  // name-based map when this is absent, so omitting it is always safe.
  source_kind?: SourceKind | null
  is_free: boolean
  price_min: number | null
  price_max: number | null
  // Popularity evidence the source happened to carry — the raw material for
  // `events.prominence` (see lib/recs/prominence.ts). Optional/nullable for the
  // same reason `source_kind` is: seed data, submissions, and every crawl source
  // supply none of it, and computeProminence treats an absent sub-signal as
  // "unknown", never as "unpopular".
  signals?: EventSignals | null
}

// Cross-source popularity evidence, normalized to a shape the prominence scorer
// understands. Every field is optional: sources fill in whatever they have.
export type EventSignals = {
  // Names as the source spells them; resolved to canonical artists downstream.
  performers?: string[]
  // The source's own demand index, rescaled to [0,1] by the parser (SeatGeek
  // ships this natively; Ticketmaster has no equivalent).
  externalPopularity?: number
  // How many other dated events this event's headliner has on the books — a
  // proxy for touring scale (a national tour vs. a one-off local booking).
  performerUpcomingEvents?: number
  // Live resale supply. A falling count over successive polls is a sellout.
  listingCount?: number
  // Ticketing lifecycle. NOTE `offsale` is ambiguous on its own: Ticketmaster
  // reports it both for "sold out" and for "not yet on sale". Reading it as a
  // sellout requires salesStartTime below to prove the sale already opened.
  ticketStatus?: 'onsale' | 'offsale' | 'cancelled'
  // When public sale opened (ISO). Disambiguates `offsale`.
  salesStartTime?: string
  // RSVP/guest counts from the non-ticketed sources.
  attendeeCount?: number
  // Room size, when the source states it (otherwise read from venues.capacity).
  venueCapacity?: number
}

// `city` carries enough of the `cities` row for structured APIs (Ticketmaster,
// SeatGeek) to query the right geography — previously a bare 'austin' string
// that nothing actually read.
export type SourceContext = {
  city: { id: number; slug: string; name: string; state: string; lat: number | null; lng: number | null }
  since: Date
  logger: Pick<Console, 'log' | 'warn' | 'error'>
}

// The kind of pipeline a source runs through — used for grouping in the health
// view and (later) cost accounting: 'crawl' sources spend Gemini tokens, the
// structured API/ical sources don't.
export type SourceKind = 'api' | 'ical' | 'rss' | 'jsonld' | 'crawl' | 'seed'

// A configured source instance (one row of the `sources` table). The code holds
// parser MECHANISMS; the database holds these INSTANCES. `name` is the exact
// RawEvent.source string the row's parser emits, so provenance links back by name.
export type SourceRow = {
  id: number
  city_id: number
  name: string
  kind: SourceKind
  url: string | null
  parser: string
  cadence: 'daily' | 'weekly'
  enabled: boolean
  last_success: string | null
  content_hash: string | null
  notes: string | null
  // Per-source override for 'crawl-paginated''s page count, for sources whose
  // full listing is far bigger than 2 pages (e.g. a calendar with hundreds of
  // pages) where 2 pages would silently be a small, unlabeled sample rather
  // than the "complete coverage" 2 pages gives Chronicle's Staff Pick view.
  // Null means the parser's own built-in default; ignored by every other parser.
  max_pages: number | null
}

// A parser MECHANISM. Instances live in the DB (`SourceRow`); the code registry
// maps `SourceRow.parser` → one of these. `available()` replaces the old
// per-source enabled() API-key check: enabled(DB) AND available(code) must both
// hold or the run is recorded as `skipped`. `crawl` returns a skip flag so the
// orchestrator can distinguish "unchanged, didn't spend Gemini" from "found
// nothing".
export interface SourceParser {
  available(): boolean
  fetch(source: SourceRow, ctx: SourceContext): Promise<{ events: RawEvent[]; skipped: boolean }>
}

