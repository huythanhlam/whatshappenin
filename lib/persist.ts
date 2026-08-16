import { tagEvents } from '@/lib/tagger'
import { imageForCategories } from '@/lib/images'
import { ensureVenueImage } from '@/lib/venueImage'
import {
  getCategoryIdBySlug, setEventCategories,
  findEventBySource, findDedupCandidates, insertEvent,
  getEventRow, updateEventFields, recordProvenance,
  getCityById, type City,
} from '@/lib/db'
import { normalizeTitle, normalizeVenue } from '@/lib/normalize'
import { chooseMatch, mergeFields, type ExistingEvent, type FieldPatch } from '@/lib/dedup'
import { ensureVenueGeocoded } from '@/lib/geocode'
import { httpOrNull } from '@/lib/html'
import { newProminenceBatch, scoreAndStoreProminence } from '@/lib/recs/prominence-store'
import type { RawEvent } from '@/lib/sources/types'
import type { CategorySlug } from '@/lib/categories'

// The single validation gate. A fabricated or nonsensical date is worse than no
// event — it actively misleads users — so an event is rejected when its
// start_time is missing/unparseable, its title is empty, or it starts more than
// 18 months out. Every source flows through persistEvents, so this bans
// fabricated dates repo-wide rather than per-scraper.
const MAX_FUTURE_MS = 18 * 30 * 24 * 60 * 60 * 1000 // ~18 months

export function isValidEvent(raw: RawEvent): boolean {
  if (!raw.title || raw.title.trim().length === 0) return false
  if (!raw.start_time) return false
  const t = new Date(raw.start_time).getTime()
  if (!Number.isFinite(t)) return false
  if (t > Date.now() + MAX_FUTURE_MS) return false
  return true
}

export type EventStatus = 'approved' | 'pending'

// Shared persistence pipeline used by the scheduled ingest, the on-demand
// importer, and public submissions. `cityId` defaults to Austin (1) so
// existing tests/call sites that don't pass it keep working; `status`
// defaults to 'approved' (pipeline-trusted sources) — public submissions pass
// 'pending' explicitly (see persistOne's merge-skip rule below).
export async function persistEvents(
  input: RawEvent[],
  opts: { cityId?: number; status?: EventStatus } = {}
): Promise<{ inserted: number; skipped: number; rejected: number; total: number }> {
  const cityId = opts.cityId ?? 1
  const status = opts.status ?? 'approved'

  const total = input.length
  if (total === 0) return { inserted: 0, skipped: 0, rejected: 0, total: 0 }

  // Sanitize before anything else touches these fields: every source (API,
  // RSS/iCal, JSON-LD scraping, the Gemini crawler/importer, public
  // submissions) funnels through this one function, so this is the single
  // choke point that guarantees a non-http(s) URL (javascript:, data:, etc.)
  // from a scraped or submitted page can never reach the DB — and, from
  // there, an unescaped href/src on the public site (stored XSS).
  const sanitized = input.map(e => ({
    ...e,
    ticket_url: httpOrNull(e.ticket_url),
    image_url: httpOrNull(e.image_url),
  }))
  const events = sanitized.filter(isValidEvent)
  const rejected = total - events.length
  if (events.length === 0) return { inserted: 0, skipped: 0, rejected, total }

  const categoryIdBySlug = await getCategoryIdBySlug()
  const slugs = await tagEvents(events.map(e => ({ title: e.title, description: e.description })))

  // Fetched once per batch (not per event) for ensureVenueGeocoded's city-name
  // fallback query — cityId is constant across the whole call.
  const city = await getCityById(cityId)

  // Venues repeat heavily within a batch (many events at the same handful of
  // venues); this Set skips the geocode-cache lookup entirely for a venueNorm
  // already checked earlier in THIS run, instead of re-querying the venues
  // table once per event. venueImageCache does the same for the venue-image
  // lookaside below.
  const checkedVenues = new Set<string>()
  const venueImageCache = new Map<string, string | null>()
  // Same batch-scoped-cache idea for the world-popularity scoring below: venue
  // capacities are read once per venue, not once per event.
  const prominenceBatch = newProminenceBatch()

  let inserted = 0
  let skipped = 0

  // Dedup mutates shared candidate state (an event inserted by one item can match
  // the next), so persist sequentially rather than with a concurrency pool.
  // Ingest already runs sources concurrently; within a source, order matters.
  for (let i = 0; i < events.length; i++) {
    try {
      const eventId = await persistOne(events[i], cityId, status, city, checkedVenues, venueImageCache, slugs[i])
      const categoryIds = slugs[i].map(s => categoryIdBySlug[s]).filter(Boolean)
      await setEventCategories(eventId, categoryIds)
      // Scored after persistOne has recorded provenance, so the corroboration
      // count includes this source. Never throws: a popularity lookup failing
      // must not cost us the event.
      await scoreAndStoreProminence(eventId, events[i], {
        cityId,
        venueNorm: normalizeVenue(events[i].venue_name),
        batch: prominenceBatch,
      })
      inserted++
    } catch {
      skipped++
    }
  }

  return { inserted, skipped, rejected, total }
}

// Self-heal the normalized match keys on an already-canonical event.
//
// `title_norm`/`venue_norm` are how findDedupCandidates BLOCKS — a row holding
// null for them can never be returned as a candidate, so it duplicates against
// every other source forever and no amount of re-ingesting fixes it. Rows
// written before those columns existed are in exactly that state (observed in
// production: 73 Ticketmaster + 9 Eventbrite events, which is why a Ticketmaster
// arena show sat in the trending rail beside the same show from a crawl source).
//
// mergeFields only sets title_norm when the *title* is being upgraded, so it
// never repairs a pre-existing null. This does, on whichever ingest next touches
// the row. Only fills nulls; it never overwrites a good value.
function repairNorms(
  patch: FieldPatch | null,
  existing: ExistingEvent,
  titleNorm: string,
  venueNorm: string | null
): FieldPatch | null {
  const needsTitle = existing.title_norm === null && patch?.title_norm === undefined
  const needsVenue = existing.venue_norm === null && venueNorm !== null && patch?.venue_norm === undefined
  if (!needsTitle && !needsVenue) return patch

  const repaired: FieldPatch = { ...(patch ?? {}) }
  if (needsTitle) repaired.title_norm = titleNorm
  if (needsVenue) repaired.venue_norm = venueNorm
  return repaired
}

// Resolve one raw event to a canonical event id, creating, matching, or merging
// as needed, and always recording provenance. Returns the canonical event id.
async function persistOne(
  raw: RawEvent, cityId: number, status: EventStatus, city: City | null, checkedVenues: Set<string>,
  venueImageCache: Map<string, string | null>, categorySlugs: CategorySlug[]
): Promise<string> {
  const titleNorm = normalizeTitle(raw.title, raw.venue_name)
  const venueNorm = normalizeVenue(raw.venue_name)

  // Geocode this venue if not already cached — unconditional (not just on the
  // new-insert branch below) so venues that only ever get merged into an
  // existing canonical event still get a pin on the map. Never throws (see
  // ensureVenueGeocoded's own try/catch), so no wrapping catch needed here.
  // checkedVenues skips the DB cache-lookup for a venueNorm already checked
  // earlier in this same persistEvents call.
  if (venueNorm && city && !checkedVenues.has(venueNorm)) {
    checkedVenues.add(venueNorm)
    await ensureVenueGeocoded({ cityId, venueNorm, venueName: raw.venue_name!, venueAddress: raw.venue_address, city })
  }

  // Every event needs an image. Prefer one the source itself supplied; failing
  // that, the venue's own site header image (fetched once per venue, ever —
  // see ensureVenueImage); only fall back to a generic category stock photo
  // when neither is available.
  if (!raw.image_url) {
    if (venueNorm) {
      if (!venueImageCache.has(venueNorm)) {
        venueImageCache.set(
          venueNorm,
          await ensureVenueImage({ cityId, venueNorm, venueName: raw.venue_name!, venueUrl: raw.ticket_url })
        )
      }
      raw.image_url = venueImageCache.get(venueNorm) ?? null
    }
    if (!raw.image_url) raw.image_url = imageForCategories(categorySlugs)
  }

  // 1. Idempotency: already seen this exact (source, external_id)?
  let eventId = await findEventBySource(raw.source, raw.source_id)

  if (eventId) {
    // Same submission/source re-ingested — always safe to merge (same author).
    const existing = await getEventRow(eventId)
    if (existing) {
      const patch = repairNorms(mergeFields(existing, raw), existing, titleNorm, venueNorm)
      if (patch) await updateEventFields(eventId, patch)
    }
  } else {
    // 2. Block + score against existing canonical events.
    const candidates = await findDedupCandidates({ cityId, startTime: raw.start_time, titleNorm, venueNorm })
    const matchId = chooseMatch(candidates)

    if (matchId) {
      // 3a. Matched a different source's event — merge into it.
      eventId = matchId
      // An unmoderated ('pending') submission that cross-source-matches an
      // existing canonical event must NOT overwrite its fields — only
      // pipeline-trusted sources merge into a match. The submission still gets
      // its provenance row recorded below (visible to admins as "also
      // submitted"), it just can't mutate the matched event.
      if (status !== 'pending') {
        const existing = await getEventRow(eventId)
        if (existing) {
          const patch = repairNorms(mergeFields(existing, raw), existing, titleNorm, venueNorm)
          if (patch) await updateEventFields(eventId, patch)
        }
      }
    } else {
      // 3b. No match — new canonical event.
      eventId = await insertEvent(raw, { cityId, titleNorm, venueNorm, status })
    }
  }

  // 4. Provenance always (PRODUCT-SPEC §2.2.4).
  await recordProvenance({ eventId, source: raw.source, externalId: raw.source_id, url: raw.ticket_url, raw })

  return eventId
}
