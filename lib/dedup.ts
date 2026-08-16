import { normalizeTitle, normalizeVenue } from './normalize'
import type { RawEvent, SourceKind } from './sources/types'

// Source-trust ranking for merge tiebreaks (PRODUCT-SPEC §2.2.3): api > ical >
// jsonld > rss/crawl. This is now a FALLBACK ONLY: real ingest (via
// lib/sources/registry.ts's PARSERS dispatch) stamps every RawEvent with
// `source_kind`, the authoritative `sources.kind` column for that instance, and
// sourceTrust() prefers it over this map (see below). This map still matters
// for callers that never flow through the registry and so never get a real
// kind — 'seed' data, public 'submission's, and any bare-name test fixture —
// plus it's what makes literal legacy names keep working unchanged.
const KIND_BY_SOURCE: Record<string, SourceKind> = {
  ticketmaster: 'api',
  seatgeek: 'api',
  youtube: 'api',
  ical: 'ical',
  eventbrite: 'jsonld',
  newspapers: 'rss',
  social: 'crawl',
  crawl: 'crawl',
  seed: 'seed',
  'ticketmaster:houston': 'api',
  'seatgeek:houston': 'api',
  submission: 'crawl',
}

// rss sits at the crawl tier: newspaper RSS is Gemini-extracted, not structured.
const TRUST_BY_KIND: Record<string, number> = { api: 4, ical: 3, jsonld: 2, rss: 1, crawl: 1, seed: 1 }

// `kind`, when given, is the authoritative `sources.kind` for this source
// instance (threaded through RawEvent.source_kind / ExistingEvent.source_kind).
// It takes priority over the name-based map so instance-named sources (e.g.
// 'crawl:mohawkaustin-com', 'newspaper:kut') score at their real kind's tier
// instead of falling through to 0 just because their exact name isn't a
// literal key below. Falls back to the static map when no kind is available
// (kind omitted/null), which keeps every existing caller working unchanged.
export function sourceTrust(source: string, kind?: SourceKind | null): number {
  const resolvedKind = kind ?? KIND_BY_SOURCE[source]
  return resolvedKind ? TRUST_BY_KIND[resolvedKind] ?? 0 : 0
}

// A blocked candidate, scored in SQL: `sim` = pg_trgm similarity(title_norm),
// `venueAgree` = both venues non-null and equal.
export type Candidate = { id: string; sim: number; venueAgree: boolean }

// The match threshold policy (PRODUCT-SPEC §2.2.2): >= 0.55 with venue agreement,
// or >= 0.85 without. Candidates may arrive in any order, so we scan all of them
// and keep the highest-sim passing candidate rather than the first one found.
export function chooseMatch(candidates: Candidate[]): string | null {
  let best: Candidate | null = null
  for (const c of candidates) {
    const passes = (c.sim >= 0.55 && c.venueAgree) || c.sim >= 0.85
    if (passes && (!best || c.sim > best.sim)) best = c
  }
  return best ? best.id : null
}

// The canonical event's mergeable fields (a row already in `events`).
export type ExistingEvent = {
  source: string
  source_id: string | null
  // The real kind of the canonical event's CURRENT source, resolved by
  // lib/db's getEventRow() via a join to `sources.name` (there is no
  // `source_kind` column on `events` itself). Null when that source name has
  // no matching `sources` row (legacy/ad-hoc sources) — sourceTrust() then
  // falls back to its static map, same as for RawEvent.
  source_kind?: SourceKind | null
  title: string
  // The normalized match keys. Null on rows written before these columns
  // existed, which makes the row invisible to findDedupCandidates — blocking is
  // done ON them, so a null can never match anything and the event silently
  // duplicates against every other source forever. persistOne repairs a null on
  // the next ingest; see repairNorms there.
  title_norm: string | null
  venue_norm: string | null
  description: string | null
  image_url: string | null
  venue_name: string | null
  venue_address: string | null
  end_time: string | null
  ticket_url: string | null
  is_free: boolean
  price_min: number | null
  price_max: number | null
}

// A whitelisted patch of columns to UPDATE on the canonical event. All keys are
// column names; `updateEventFields` only writes these.
export type FieldPatch = Partial<{
  title: string
  title_norm: string
  source: string
  source_id: string | null
  description: string | null
  image_url: string | null
  venue_name: string | null
  venue_norm: string | null
  venue_address: string | null
  end_time: string | null
  ticket_url: string | null
  is_free: boolean
  price_min: number | null
  price_max: number | null
}>

// Field-wise "richest wins" (PRODUCT-SPEC §2.2.3), tie-broken by source trust.
// Returns null when the incoming record adds nothing.
export function mergeFields(existing: ExistingEvent, incoming: RawEvent): FieldPatch | null {
  const patch: FieldPatch = {}

  // Longest description wins.
  if ((incoming.description?.length ?? 0) > (existing.description?.length ?? 0)) {
    patch.description = incoming.description
  }
  // Any image over none. A trust-based *upgrade* of an existing image happens
  // below, alongside title/ticket_url — the current image_url may itself be a
  // low-trust source's fallback (persist.ts stamps a venue/category stock
  // photo onto raw.image_url before insertion when the source had none), so
  // it shouldn't permanently block a later, more-trusted source's real image.
  if (!existing.image_url && incoming.image_url) patch.image_url = incoming.image_url
  // Fill missing nullable fields.
  if (!existing.venue_name && incoming.venue_name) patch.venue_name = incoming.venue_name
  // Keep venue_norm in lockstep with venue_name so the dedup block index stays fresh.
  if (patch.venue_name) patch.venue_norm = normalizeVenue(patch.venue_name)
  if (!existing.venue_address && incoming.venue_address) patch.venue_address = incoming.venue_address
  if (!existing.end_time && incoming.end_time) patch.end_time = incoming.end_time
  // Widen the price range.
  if (incoming.price_min != null && (existing.price_min == null || incoming.price_min < existing.price_min)) {
    patch.price_min = incoming.price_min
  }
  if (incoming.price_max != null && (existing.price_max == null || incoming.price_max > existing.price_max)) {
    patch.price_max = incoming.price_max
  }
  // Free is sticky: once any source says free, stay free.
  if (incoming.is_free && !existing.is_free) patch.is_free = true

  // A more-trusted source owns the canonical title, ticket link, and primary source.
  if (sourceTrust(incoming.source, incoming.source_kind) > sourceTrust(existing.source, existing.source_kind)) {
    patch.source = incoming.source
    patch.source_id = incoming.source_id
    if (incoming.ticket_url) patch.ticket_url = incoming.ticket_url
    if (incoming.title) {
      patch.title = incoming.title
      patch.title_norm = normalizeTitle(incoming.title, incoming.venue_name)
    }
    // Upgrade the image too: a higher-trust source's own image is more
    // likely to be the event's real photo than whatever the previous,
    // lower-trust source supplied.
    if (incoming.image_url) patch.image_url = incoming.image_url
  }

  return Object.keys(patch).length > 0 ? patch : null
}
