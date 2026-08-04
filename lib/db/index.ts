import type { Db } from './driver'
import { getPgDb } from './pg'
import { getPgliteDb } from './pglite'
import type { RawEvent, SourceRow } from '@/lib/sources/types'
import type { ExistingEvent, Candidate, FieldPatch } from '@/lib/dedup'
import {
  RECS_WINDOW_DAYS,
  RECS_CANDIDATE_CAP,
  RECS_DEFAULT_LIMIT,
  RECS_EXPLORE_SLOTS,
  type ModelWeights,
} from '@/lib/recs/config'
import {
  rankCandidates,
  type Candidate as RecCandidate,
  type ActorTaste,
  type FeatureVector,
} from '@/lib/recs/score'

// Returns true when no direct Postgres connection is configured — the app then
// runs against an embedded local Postgres (PGlite) so it works with zero
// credentials. `DATABASE_URL` (the Supabase Supavisor pooler) selects prod.
export function isLocal(): boolean {
  return !process.env.DATABASE_URL
}

// Pick the driver once. Both speak the same SQL dialect, so every query below is
// written exactly once — no per-function branch, no PostgREST query-builder.
function getDb(): Promise<Db> {
  return isLocal() ? getPgliteDb() : Promise.resolve(getPgDb())
}

export type City = {
  id: number
  slug: string
  name: string
  state: string
  timezone: string
  enabled: boolean
  lat: number | null
  lng: number | null
}

type EnrichedEvent = Record<string, unknown> & {
  id: string
  categories: { id: number; slug: string; name: string; color: string }[]
  is_featured: boolean
  featured_label: string | null
}

function enrichRow(row: Record<string, unknown>, nowIso: string): EnrichedEvent {
  const cats = (row.categories as EnrichedEvent['categories']) ?? []
  const featuredList = (row.featured_listings as { starts_at: string; ends_at: string; ad_label: string }[] | null) ?? []
  const activeFeatured = featuredList.find(f => f.starts_at <= nowIso && f.ends_at >= nowIso)
  const { featured_listings, ...rest } = row
  void featured_listings
  return {
    ...rest,
    id: row.id as string,
    categories: cats,
    is_featured: !!activeFeatured,
    featured_label: activeFeatured?.ad_label ?? null,
  }
}

// A correlated subquery that aggregates an event's categories into a JSON array.
// Written once; reused by every read path.
const CATEGORIES_JSON = `COALESCE((
  SELECT json_agg(json_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'color', c.color))
  FROM event_categories ec JOIN categories c ON c.id = ec.category_id
  WHERE ec.event_id = e.id
), '[]'::json) AS categories`

const FEATURED_JSON = `COALESCE((
  SELECT json_agg(json_build_object('starts_at', f.starts_at, 'ends_at', f.ends_at, 'ad_label', f.ad_label))
  FROM featured_listings f WHERE f.event_id = e.id
), '[]'::json) AS featured_listings`

// Per-event provenance for the "also listed on …" UI: the distinct sources that
// contributed to this canonical event, with their source-specific links.
const SOURCES_JSON = `COALESCE((
  SELECT json_agg(json_build_object('source', s.source, 'url', s.url) ORDER BY s.source)
  FROM event_sources s WHERE s.event_id = e.id
), '[]'::json) AS sources`

// Full-text search over title + description + venue, matching the expression of
// the GIN index in migration 001 so it uses that index instead of a sequential
// ILIKE scan. websearch_to_tsquery accepts natural query syntax ("live music",
// quoted phrases, -exclusions) and is null-safe on empty input.
const FTS_MATCH = `to_tsvector('english',
  coalesce(e.title,'') || ' ' || coalesce(e.description,'') || ' ' || coalesce(e.venue_name,'')
) @@ websearch_to_tsquery('english', $PARAM)`

// ---------------------------------------------------------------------------
// listEvents
// ---------------------------------------------------------------------------
export async function listEvents(opts: {
  cityId: number
  q?: string
  categories?: string[]
  sources?: string[]
  from?: string
  to?: string
  isFree?: boolean
  limit: number
  offset: number
}): Promise<EnrichedEvent[]> {
  const db = await getDb()
  const nowIso = new Date().toISOString()
  const fromIso = opts.from && opts.from > nowIso ? opts.from : nowIso

  const params: unknown[] = [fromIso]
  let where = "e.start_time >= $1 AND e.status = 'approved'"

  params.push(opts.cityId)
  where += ` AND e.city_id = $${params.length}`

  if (opts.to) {
    params.push(opts.to)
    where += ` AND e.start_time <= $${params.length}`
  }
  if (opts.isFree) {
    where += ` AND e.is_free = true`
  }
  if (opts.q) {
    params.push(opts.q)
    where += ` AND ${FTS_MATCH.replace('$PARAM', `$${params.length}`)}`
  }
  if (opts.categories && opts.categories.length > 0) {
    params.push(opts.categories)
    where += ` AND e.id IN (
      SELECT ec.event_id FROM event_categories ec
      JOIN categories c ON c.id = ec.category_id
      WHERE c.slug = ANY($${params.length}))`
  }
  if (opts.sources && opts.sources.length > 0) {
    params.push(opts.sources)
    where += ` AND e.source = ANY($${params.length})`
  }
  params.push(opts.limit)
  params.push(opts.offset)

  const rows = await db.query<Record<string, unknown>>(
    `SELECT e.*, ${CATEGORIES_JSON}, ${FEATURED_JSON}
     FROM events e
     WHERE ${where}
     ORDER BY e.start_time ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  return rows.map(r => enrichRow(r, nowIso))
}

// ---------------------------------------------------------------------------
// countEvents — total matching the same filters (for "showing X of N")
// ---------------------------------------------------------------------------
export async function countEvents(opts: {
  cityId: number
  q?: string
  categories?: string[]
  sources?: string[]
  from?: string
  to?: string
  isFree?: boolean
}): Promise<number> {
  const db = await getDb()
  const nowIso = new Date().toISOString()
  const fromIso = opts.from && opts.from > nowIso ? opts.from : nowIso

  const params: unknown[] = [fromIso]
  let where = "e.start_time >= $1 AND e.status = 'approved'"
  params.push(opts.cityId)
  where += ` AND e.city_id = $${params.length}`
  if (opts.to) { params.push(opts.to); where += ` AND e.start_time <= $${params.length}` }
  if (opts.isFree) where += ` AND e.is_free = true`
  if (opts.q) { params.push(opts.q); where += ` AND ${FTS_MATCH.replace('$PARAM', `$${params.length}`)}` }
  if (opts.categories && opts.categories.length > 0) {
    params.push(opts.categories)
    where += ` AND e.id IN (SELECT ec.event_id FROM event_categories ec
      JOIN categories c ON c.id = ec.category_id WHERE c.slug = ANY($${params.length}))`
  }
  if (opts.sources && opts.sources.length > 0) {
    params.push(opts.sources)
    where += ` AND e.source = ANY($${params.length})`
  }
  const rows = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM events e WHERE ${where}`,
    params
  )
  return parseInt(rows[0]?.count ?? '0', 10)
}

// ---------------------------------------------------------------------------
// listEventsForMap — same filters as listEvents, minus pagination (the map
// wants every matching pin at once), inner-joined against the venues geocode
// cache so only events with a successfully geocoded venue come back.
// ---------------------------------------------------------------------------
export async function listEventsForMap(opts: {
  cityId: number
  q?: string
  categories?: string[]
  sources?: string[]
  from?: string
  to?: string
  isFree?: boolean
  limit: number
}): Promise<EnrichedEvent[]> {
  const db = await getDb()
  const nowIso = new Date().toISOString()
  const fromIso = opts.from && opts.from > nowIso ? opts.from : nowIso

  const params: unknown[] = [fromIso]
  let where = "e.start_time >= $1 AND e.status = 'approved'"

  params.push(opts.cityId)
  where += ` AND e.city_id = $${params.length}`

  if (opts.to) {
    params.push(opts.to)
    where += ` AND e.start_time <= $${params.length}`
  }
  if (opts.isFree) {
    where += ` AND e.is_free = true`
  }
  if (opts.q) {
    params.push(opts.q)
    where += ` AND ${FTS_MATCH.replace('$PARAM', `$${params.length}`)}`
  }
  if (opts.categories && opts.categories.length > 0) {
    params.push(opts.categories)
    where += ` AND e.id IN (
      SELECT ec.event_id FROM event_categories ec
      JOIN categories c ON c.id = ec.category_id
      WHERE c.slug = ANY($${params.length}))`
  }
  if (opts.sources && opts.sources.length > 0) {
    params.push(opts.sources)
    where += ` AND e.source = ANY($${params.length})`
  }
  params.push(opts.limit)

  const rows = await db.query<Record<string, unknown>>(
    `SELECT e.*, ${CATEGORIES_JSON}, v.lat, v.lng
     FROM events e
     JOIN venues v ON v.city_id = e.city_id AND v.venue_norm = e.venue_norm AND v.status = 'ok'
     WHERE ${where}
     ORDER BY e.start_time ASC
     LIMIT $${params.length}`,
    params
  )
  return rows.map(r => enrichRow(r, nowIso))
}

// ---------------------------------------------------------------------------
// getEvent
// ---------------------------------------------------------------------------
export async function getEvent(id: string): Promise<EnrichedEvent | null> {
  const db = await getDb()
  const nowIso = new Date().toISOString()
  const rows = await db.query<Record<string, unknown>>(
    `SELECT e.*, ${CATEGORIES_JSON}, ${SOURCES_JSON} FROM events e WHERE e.id = $1 AND e.status = 'approved'`,
    [id]
  )
  if (rows.length === 0) return null
  return enrichRow(rows[0], nowIso)
}

// Enriched events for a set of ids, in the given order — for the account page's
// interested / hidden lists. Past events are included (unlike the rail),
// since the profile shows history; the caller orders/greys them.
export async function getEventsByIds(ids: string[]): Promise<EnrichedEvent[]> {
  if (ids.length === 0) return []
  const db = await getDb()
  const nowIso = new Date().toISOString()
  const rows = await db.query<Record<string, unknown>>(
    `SELECT e.*, ${CATEGORIES_JSON}, ${SOURCES_JSON} FROM events e WHERE e.id = ANY($1)`,
    [ids]
  )
  const byId = new Map(rows.map(r => [r.id as string, enrichRow(r, nowIso)]))
  return ids.map(id => byId.get(id)).filter((e): e is EnrichedEvent => !!e)
}

// ---------------------------------------------------------------------------
// Ingestion helpers
// ---------------------------------------------------------------------------
export async function getCategoryIdBySlug(): Promise<Record<string, number>> {
  const db = await getDb()
  const rows = await db.query<{ id: number; slug: string }>(`SELECT id, slug FROM categories`)
  return Object.fromEntries(rows.map(c => [c.slug, c.id]))
}

// Idempotency lookup: has this exact (source, external_id) already been mapped to
// a canonical event? Mirrors the old UNIQUE(source, source_id) fast-path so a
// daily re-ingest updates in place instead of re-running dedup.
export async function findEventBySource(source: string, externalId: string): Promise<string | null> {
  const db = await getDb()
  const rows = await db.query<{ event_id: string }>(
    `SELECT event_id FROM event_sources WHERE source = $1 AND external_id = $2`,
    [source, externalId]
  )
  return rows[0]?.event_id ?? null
}

// Blocking + scoring in one query (PRODUCT-SPEC §2.2.1–2.2.2): candidates share a
// city, start within ±2h, and either agree on venue or have a null venue; scored
// by pg_trgm title similarity. venueAgree = both venues present and equal.
export async function findDedupCandidates(opts: {
  cityId: number
  startTime: string
  titleNorm: string
  venueNorm: string | null
}): Promise<Candidate[]> {
  const db = await getDb()
  const rows = await db.query<{ id: string; sim: number; venue_agree: boolean }>(
    `SELECT e.id,
            similarity(e.title_norm, $1) AS sim,
            (e.venue_norm IS NOT NULL AND $2::text IS NOT NULL AND e.venue_norm = $2) AS venue_agree
     FROM events e
     WHERE e.city_id = $3
       AND e.start_time BETWEEN ($4)::timestamptz - interval '2 hours'
                            AND ($4)::timestamptz + interval '2 hours'
       AND (e.venue_norm = $2 OR e.venue_norm IS NULL OR $2::text IS NULL)
       AND e.title_norm IS NOT NULL
     ORDER BY sim DESC
     LIMIT 10`,
    [opts.titleNorm, opts.venueNorm, opts.cityId, opts.startTime]
  )
  return rows.map(r => ({ id: r.id, sim: Number(r.sim), venueAgree: !!r.venue_agree }))
}

// Insert a brand-new canonical event. Caller supplies the normalized keys.
export async function insertEvent(
  raw: RawEvent,
  keys: { cityId: number; titleNorm: string; venueNorm: string | null; status?: 'approved' | 'pending' | 'rejected' }
): Promise<string> {
  const db = await getDb()
  const rows = await db.query<{ id: string }>(
    `INSERT INTO events (title, description, start_time, end_time, venue_name,
       venue_address, image_url, ticket_url, source, source_id, is_free,
       price_min, price_max, city_id, title_norm, venue_norm, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, NOW())
     RETURNING id`,
    [raw.title, raw.description, raw.start_time, raw.end_time, raw.venue_name,
     raw.venue_address, raw.image_url, raw.ticket_url, raw.source, raw.source_id,
     raw.is_free, raw.price_min, raw.price_max, keys.cityId, keys.titleNorm, keys.venueNorm,
     keys.status ?? 'approved']
  )
  return rows[0].id
}

// Fetch the mergeable columns of a canonical event for mergeFields(). Joins
// `sources` by name to resolve the event's CURRENT source's real `kind` (there
// is no `source_kind` column on `events`) so sourceTrust() can rank
// instance-named sources (e.g. 'crawl:mohawkaustin-com') correctly instead of
// only recognizing its static map's literal names — see lib/dedup.ts.
// `s.kind` is null when `e.source` has no matching `sources` row (legacy/ad-hoc
// sources like 'seed'/'submission'/bare 'crawl' test fixtures), in which case
// sourceTrust() falls back to its name-based map exactly as before.
export async function getEventRow(id: string): Promise<ExistingEvent | null> {
  const db = await getDb()
  const rows = await db.query<ExistingEvent>(
    `SELECT e.source, e.source_id, e.title, e.venue_norm, e.description, e.image_url,
            e.venue_name, e.venue_address, e.end_time, e.ticket_url, e.is_free,
            e.price_min, e.price_max, s.kind AS source_kind
     FROM events e
     LEFT JOIN sources s ON s.name = e.source
     WHERE e.id = $1`,
    [id]
  )
  return rows[0] ?? null
}

// Apply a whitelisted field patch. Column names come only from FieldPatch keys,
// so the dynamic SQL is injection-safe (values are parameterized). PATCHABLE must
// stay a superset of FieldPatch's keys — venue_norm included, so a filled venue's
// normalized key is not silently dropped.
const PATCHABLE = new Set([
  'title', 'title_norm', 'source', 'source_id', 'description', 'image_url',
  'venue_name', 'venue_norm', 'venue_address', 'end_time', 'ticket_url',
  'is_free', 'price_min', 'price_max',
])
export async function updateEventFields(id: string, patch: FieldPatch): Promise<void> {
  const entries = Object.entries(patch).filter(([k]) => PATCHABLE.has(k))
  if (entries.length === 0) return
  const db = await getDb()
  const sets = entries.map(([k], i) => `${k} = $${i + 2}`)
  const values = entries.map(([, v]) => v)
  await db.query(
    `UPDATE events SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`,
    [id, ...values]
  )
}

// Write/refresh the provenance row. ON CONFLICT keeps the pipeline idempotent
// across daily re-ingests of the same (source, external_id).
export async function recordProvenance(p: {
  eventId: string
  source: string
  externalId: string
  url: string | null
  raw: unknown
}): Promise<void> {
  const db = await getDb()
  // source_id resolves from sources.name (Phase 2B) — a subquery so ingest and
  // import share one path; NULL when no matching row (e.g. 'seed'/'import').
  await db.query(
    `INSERT INTO event_sources (event_id, source, source_id, external_id, url, raw, ingested_at)
     VALUES ($1, $2, (SELECT id FROM sources WHERE name = $2), $3, $4, $5, NOW())
     ON CONFLICT (source, external_id) DO UPDATE SET
       event_id = EXCLUDED.event_id, source_id = EXCLUDED.source_id,
       url = EXCLUDED.url, raw = EXCLUDED.raw, ingested_at = NOW()`,
    [p.eventId, p.source, p.externalId, p.url, JSON.stringify(p.raw)]
  )
}

// Provenance for the UI ("also listed on …").
export async function getEventSources(
  eventId: string
): Promise<{ source: string; external_id: string; url: string | null }[]> {
  const db = await getDb()
  return db.query(
    `SELECT source, external_id, url FROM event_sources WHERE event_id = $1 ORDER BY source ASC`,
    [eventId]
  )
}

// ---------------------------------------------------------------------------
// Venue geocode cache (Phase 4: map view) — one row per unique (city_id,
// venue_norm), populated once and never re-queried once cached. See
// lib/geocode.ts's ensureVenueGeocoded for the cache-check/fetch/write flow.
// ---------------------------------------------------------------------------
export type VenueGeocode = {
  city_id: number
  venue_norm: string
  venue_name: string
  lat: number | null
  lng: number | null
  formatted_address: string | null
  neighborhood: string | null
  status: 'ok' | 'zero_results' | 'error'
  used_address: boolean
}

export async function getVenueGeocode(cityId: number, venueNorm: string): Promise<VenueGeocode | null> {
  const db = await getDb()
  const rows = await db.query<VenueGeocode>(
    `SELECT city_id, venue_norm, venue_name, lat, lng, formatted_address, neighborhood, status, used_address
     FROM venues WHERE city_id = $1 AND venue_norm = $2`,
    [cityId, venueNorm]
  )
  return rows[0] ?? null
}

// ON CONFLICT DO NOTHING: once a row exists it is never overwritten by this
// function, so concurrent ingest + backfill writes for the same venue can't
// clobber each other. A name-only ('usedAddress: false') result can later be
// upgraded exactly once via upgradeVenueGeocode below.
export async function upsertVenueGeocode(v: {
  cityId: number
  venueNorm: string
  venueName: string
  status: 'ok' | 'zero_results' | 'error'
  lat?: number | null
  lng?: number | null
  formattedAddress?: string | null
  neighborhood?: string | null
  usedAddress?: boolean
}): Promise<void> {
  const db = await getDb()
  await db.query(
    `INSERT INTO venues (city_id, venue_norm, venue_name, lat, lng, formatted_address, neighborhood, status, used_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (city_id, venue_norm) DO NOTHING`,
    [v.cityId, v.venueNorm, v.venueName, v.lat ?? null, v.lng ?? null, v.formattedAddress ?? null, v.neighborhood ?? null, v.status, v.usedAddress ?? false]
  )
}

// One-time upgrade: replaces a name-only geocode with a better address-based
// result, once, the first time an address becomes available for this venue.
// The `used_address = false` guard makes this idempotent under concurrent
// ingest runs — a second concurrent upgrade attempt just no-ops since the
// first one already flipped the flag.
export async function upgradeVenueGeocode(
  cityId: number, venueNorm: string,
  result: { lat: number; lng: number; formattedAddress: string; neighborhood: string | null }
): Promise<void> {
  const db = await getDb()
  await db.query(
    `UPDATE venues SET lat = $3, lng = $4, formatted_address = $5, neighborhood = $6, status = 'ok',
       used_address = true, geocoded_at = NOW()
     WHERE city_id = $1 AND venue_norm = $2 AND used_address = false`,
    [cityId, venueNorm, result.lat, result.lng, result.formattedAddress, result.neighborhood]
  )
}

export type VenueImage = {
  city_id: number
  venue_norm: string
  image_url: string | null
}

export async function getVenueImage(cityId: number, venueNorm: string): Promise<VenueImage | null> {
  const db = await getDb()
  const rows = await db.query<VenueImage>(
    `SELECT city_id, venue_norm, image_url FROM venue_images WHERE city_id = $1 AND venue_norm = $2`,
    [cityId, venueNorm]
  )
  return rows[0] ?? null
}

// ON CONFLICT DO NOTHING: once a venue's image has been checked (even a null
// "no image found" result), it's never re-fetched — mirrors
// upsertVenueGeocode's "resolved once, ever" cache.
export async function upsertVenueImage(v: {
  cityId: number
  venueNorm: string
  venueName: string
  imageUrl: string | null
}): Promise<void> {
  const db = await getDb()
  await db.query(
    `INSERT INTO venue_images (city_id, venue_norm, venue_name, image_url)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (city_id, venue_norm) DO NOTHING`,
    [v.cityId, v.venueNorm, v.venueName, v.imageUrl]
  )
}

// Distinct neighborhoods with at least one successfully-geocoded venue, for
// the subscribe form's neighborhood picker (Phase 5: personalized digests).
// A city with no geocoded venues yet (no GOOGLE_GEOCODING_API_KEY, or the
// backfill hasn't run) simply returns an empty list. Also called from the
// [city]/subscribe page, which is statically prerendered at build time
// (generateStaticParams on app/[city]/layout.tsx) — the query is guarded so a
// migration that hasn't reached the build-time database yet (README's "a
// branch that adds a migration only previews correctly once its migration is
// on the DB") degrades to "no neighborhood filter" instead of failing the build.
export async function getDistinctNeighborhoods(cityId: number): Promise<string[]> {
  try {
    const db = await getDb()
    const rows = await db.query<{ neighborhood: string }>(
      `SELECT DISTINCT neighborhood FROM venues
       WHERE city_id = $1 AND status = 'ok' AND neighborhood IS NOT NULL
       ORDER BY neighborhood`,
      [cityId]
    )
    return rows.map(r => r.neighborhood)
  } catch (e) {
    console.error('getDistinctNeighborhoods failed (degrading to no neighborhood filter):', e)
    return []
  }
}

// Distinct sources with at least one *upcoming* approved event in the city,
// for the events page's source filter. Scoped to start_time >= now (same
// cutoff listEvents uses) so a source dynamically drops out of the filter
// once it stops producing events a visitor could actually see — no manual
// list to prune when a source goes stale or gets disabled upstream.
// Ordered alphabetically to match the checkbox list rendering in
// components/SourceFilter.tsx.
export async function getDistinctSources(cityId: number): Promise<string[]> {
  const db = await getDb()
  const nowIso = new Date().toISOString()
  const rows = await db.query<{ source: string }>(
    `SELECT DISTINCT source FROM events WHERE city_id = $1 AND status = 'approved' AND start_time >= $2 ORDER BY source`,
    [cityId, nowIso]
  )
  return rows.map(r => r.source)
}

// Distinct venues already present in `events`, for the one-off geocode
// backfill (scripts/backfill-geocode.ts). Most-recently-updated event per
// venue_norm wins the venue_name/venue_address tie-break.
export async function getDistinctVenues(): Promise<{
  city_id: number
  venue_norm: string
  venue_name: string
  venue_address: string | null
}[]> {
  const db = await getDb()
  return db.query(
    `SELECT DISTINCT ON (city_id, venue_norm) city_id, venue_norm, venue_name, venue_address
     FROM events WHERE venue_norm IS NOT NULL
     ORDER BY city_id, venue_norm, updated_at DESC`
  )
}

export async function setEventCategories(eventId: string, categoryIds: number[]): Promise<void> {
  if (categoryIds.length === 0) return
  const db = await getDb()
  for (const cid of categoryIds) {
    await db.query(
      `INSERT INTO event_categories (event_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [eventId, cid]
    )
  }
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------
export async function addSubscription(sub: {
  email: string
  frequency: string
  category_slugs: string[]
  cityId: number
  freeOnly?: boolean
  neighborhoods?: string[]
}): Promise<string | null> {
  const db = await getDb()
  // token is generated by the column default (pgcrypto in Postgres, a shim in
  // PGlite); RETURNING hands it back for the confirmation/unsubscribe links.
  // Re-subscribing does NOT reset `confirmed` — a returning, already-confirmed
  // subscriber shouldn't be forced through the confirm link again just to
  // change their category filters.
  const rows = await db.query<{ token: string }>(
    `INSERT INTO subscriptions (email, frequency, category_slugs, city_id, free_only, neighborhoods)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (email, city_id) DO UPDATE SET frequency = EXCLUDED.frequency,
       category_slugs = EXCLUDED.category_slugs, free_only = EXCLUDED.free_only,
       neighborhoods = EXCLUDED.neighborhoods
     RETURNING token`,
    [sub.email, sub.frequency, sub.category_slugs, sub.cityId, sub.freeOnly ?? false, sub.neighborhoods ?? []]
  )
  return rows[0]?.token ?? null
}

export async function removeSubscription(token: string): Promise<void> {
  const db = await getDb()
  await db.query(`DELETE FROM subscriptions WHERE token = $1`, [token])
}

// Double opt-in (SIMPLIFICATION-SPEC.md §7): the welcome email links here.
// No-op (not an error) if the token doesn't match — mirrors removeSubscription.
export async function confirmSubscription(token: string): Promise<void> {
  const db = await getDb()
  await db.query(`UPDATE subscriptions SET confirmed = true WHERE token = $1`, [token])
}

export async function listSubscriptions(
  frequency: string,
  cityId: number
): Promise<{ email: string; token: string; category_slugs: string[]; free_only: boolean; neighborhoods: string[] }[]> {
  const db = await getDb()
  return db.query<{ email: string; token: string; category_slugs: string[]; free_only: boolean; neighborhoods: string[] }>(
    `SELECT email, token, category_slugs, free_only, neighborhoods FROM subscriptions
     WHERE frequency = $1 AND city_id = $2 AND confirmed = true`,
    [frequency, cityId]
  )
}

// ---------------------------------------------------------------------------
// Featured listings
// ---------------------------------------------------------------------------
export async function addFeatured(f: {
  event_id: string
  starts_at: string
  ends_at: string
  ad_label: string
}): Promise<Record<string, unknown> | null> {
  const db = await getDb()
  const rows = await db.query<Record<string, unknown>>(
    `INSERT INTO featured_listings (event_id, starts_at, ends_at, ad_label, city_id)
     VALUES ($1, $2, $3, $4, (SELECT city_id FROM events WHERE id = $1))
     RETURNING *`,
    [f.event_id, f.starts_at, f.ends_at, f.ad_label]
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Sources — config-driven ingestion instances (Phase 2B)
// ---------------------------------------------------------------------------

// Enabled source rows for a city, oldest-successful first so stale/never-run
// sources are prioritized by the orchestrator. `cadence = 'weekly'` rows are
// filtered down to one UTC day (Monday, matching vercel.json's daily cron
// which itself runs on Mondays like every other day) so a slow-changing page
// isn't re-crawled (and re-billed against the Gemini budget) every day for no
// reason. `now` is injectable so this is deterministic in tests instead of
// depending on which real-world day the suite happens to run.
// `shard` deterministically partitions a city's sources across N cron windows
// (`{ index, total }`, e.g. shard 0 of 2). A city with more sources than one
// 300s invocation can finish concurrently (austin's ~67 vs houston's ~30) would
// otherwise leave the sources still in flight when maxDuration fires orphaned at
// 'running'. Partitioning by `id % total` is stable — every source belongs to
// exactly one shard, so the windows together give full coverage with no
// double-crawl, and new sources balance across shards automatically.
// `ignoreCadence` bypasses the weekly-day gate so an operator can force every
// enabled source to run on demand (e.g. re-crawling weekly sources that were
// orphaned by a mid-week overflow, off their normal Monday schedule).
export async function getEnabledSources(
  cityId: number,
  now: Date = new Date(),
  shard?: { index: number; total: number },
  ignoreCadence = false,
): Promise<SourceRow[]> {
  const db = await getDb()
  const rows = await db.query<SourceRow>(
    `SELECT id, city_id, name, kind, url, parser, cadence, enabled,
            last_success, content_hash, notes, max_pages
     FROM sources
     WHERE city_id = $1 AND enabled = true
     ORDER BY last_success ASC NULLS FIRST, id ASC`,
    [cityId]
  )
  const isWeeklyRunDay = ignoreCadence || now.getUTCDay() === 1 // Monday
  return rows.filter(r =>
    (r.cadence !== 'weekly' || isWeeklyRunDay) &&
    (!shard || shard.total <= 1 || ((r.id % shard.total) === shard.index))
  )
}

export async function getSourceContentHash(id: number): Promise<string | null> {
  const db = await getDb()
  const rows = await db.query<{ content_hash: string | null }>(
    `SELECT content_hash FROM sources WHERE id = $1`,
    [id]
  )
  return rows[0]?.content_hash ?? null
}

export async function setSourceContentHash(id: number, hash: string): Promise<void> {
  const db = await getDb()
  await db.query(`UPDATE sources SET content_hash = $2 WHERE id = $1`, [id, hash])
}

// Record a successful fetch (any events or a valid unchanged skip). Powers the
// oldest-first ordering above and, later, source-staleness alerting.
export async function touchSourceSuccess(id: number): Promise<void> {
  const db = await getDb()
  await db.query(`UPDATE sources SET last_success = NOW() WHERE id = $1`, [id])
}

// ---------------------------------------------------------------------------
// Cities (Phase 3)
// ---------------------------------------------------------------------------
export async function getEnabledCities(): Promise<City[]> {
  const db = await getDb()
  return db.query<City>(
    `SELECT id, slug, name, state, timezone, enabled, lat, lng FROM cities WHERE enabled = true ORDER BY id ASC`
  )
}

export async function getCityBySlug(slug: string): Promise<City | null> {
  const db = await getDb()
  const rows = await db.query<City>(
    `SELECT id, slug, name, state, timezone, enabled, lat, lng FROM cities WHERE slug = $1`,
    [slug]
  )
  return rows[0] ?? null
}

export async function getCityById(id: number): Promise<City | null> {
  const db = await getDb()
  const rows = await db.query<City>(
    `SELECT id, slug, name, state, timezone, enabled, lat, lng FROM cities WHERE id = $1`,
    [id]
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Source runs — the observability ledger (one row per source per ingest run)
// ---------------------------------------------------------------------------
export type SourceRun = {
  id: number
  source: string
  source_id: number | null
  started_at: string
  finished_at: string | null
  status: 'running' | 'ok' | 'error' | 'skipped'
  events_found: number
  events_upserted: number
  events_rejected: number
  gemini_requests: number
  error: string | null
}

// Open a run (status 'running'); returns its id so the orchestrator can close it
// with the final counts. `sourceId` links the run to its `sources` row (Phase
// 2B); null for legacy/ad-hoc callers.
export async function startSourceRun(source: string, sourceId?: number | null): Promise<number> {
  const db = await getDb()
  const rows = await db.query<{ id: number }>(
    `INSERT INTO source_runs (source, source_id, status) VALUES ($1, $2, 'running') RETURNING id`,
    [source, sourceId ?? null]
  )
  return rows[0].id
}

export async function finishSourceRun(
  id: number,
  fields: {
    status: 'ok' | 'error' | 'skipped'
    events_found?: number
    events_upserted?: number
    events_rejected?: number
    gemini_requests?: number
    error?: string | null
  }
): Promise<void> {
  const db = await getDb()
  await db.query(
    `UPDATE source_runs SET
       finished_at = NOW(), status = $2,
       events_found = $3, events_upserted = $4, events_rejected = $5,
       gemini_requests = $6, error = $7
     WHERE id = $1`,
    [id, fields.status, fields.events_found ?? 0, fields.events_upserted ?? 0,
     fields.events_rejected ?? 0, fields.gemini_requests ?? 0, fields.error ?? null]
  )
}

// Finalize runs orphaned at 'running'. When a function is killed by its
// maxDuration (300s) mid-crawl, the sources still in flight never reach
// finishSourceRun, so their rows are stuck 'running' forever — invisible to the
// health ledger (which ignores 'running') yet never actually completed. Any run
// still 'running' well past the max invocation wall-clock can only be orphaned,
// so we mark it 'error'. Called at the top of every ingest so the ledger is
// self-healing. Returns how many rows were reaped.
export async function reapStaleRuns(olderThanMs = 15 * 60 * 1000): Promise<number> {
  const db = await getDb()
  const rows = await db.query<{ id: number }>(
    `UPDATE source_runs
        SET status = 'error', finished_at = NOW(),
            error = 'orphaned: function timed out before finish (reaped)'
      WHERE status = 'running'
        AND started_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
      RETURNING id`,
    [olderThanMs]
  )
  return rows.length
}

// The most recent `perSource` runs for each source, newest first — the raw
// material for /api/admin/health's staleness check. Only runs whose source_id
// joins to a `sources` row in `cityId` are included (an INNER JOIN, so
// legacy/ad-hoc runs with a NULL source_id are naturally excluded — they
// can't be attributed to any city). The city filter is applied to the OUTER
// query, not the window-function partition, so the per-source "last N runs"
// ranking is unaffected by the join.
export async function recentSourceRuns(perSource: number, cityId: number): Promise<SourceRun[]> {
  const db = await getDb()
  return db.query<SourceRun>(
    `SELECT t.* FROM (
       SELECT sr.*, ROW_NUMBER() OVER (PARTITION BY source ORDER BY started_at DESC) AS rn
       FROM source_runs sr
     ) t
     JOIN sources s ON s.id = t.source_id
     WHERE t.rn <= $1 AND s.city_id = $2
     ORDER BY t.source ASC, t.started_at DESC`,
    [perSource, cityId]
  )
}

// ---------------------------------------------------------------------------
// Moderation (Phase 2: public submissions land as 'pending')
// ---------------------------------------------------------------------------
export type PendingEvent = {
  id: string
  title: string
  venue_name: string | null
  start_time: string
  source: string
  created_at: string
}

export async function listPendingEvents(cityId: number): Promise<PendingEvent[]> {
  const db = await getDb()
  return db.query<PendingEvent>(
    `SELECT id, title, venue_name, start_time, source, created_at FROM events
     WHERE city_id = $1 AND status = 'pending' ORDER BY created_at DESC`,
    [cityId]
  )
}

export async function approveEvent(id: string): Promise<void> {
  const db = await getDb()
  await db.query(`UPDATE events SET status = 'approved', updated_at = NOW() WHERE id = $1`, [id])
}

export async function rejectEvent(id: string): Promise<void> {
  const db = await getDb()
  await db.query(`UPDATE events SET status = 'rejected', updated_at = NOW() WHERE id = $1`, [id])
}

// ---------------------------------------------------------------------------
// Digest helper
// ---------------------------------------------------------------------------
export async function getEventsBetween(cityId: number, startIso: string, endIso: string): Promise<EnrichedEvent[]> {
  const db = await getDb()
  const nowIso = new Date().toISOString()
  const rows = await db.query<Record<string, unknown>>(
    `SELECT e.*, ${CATEGORIES_JSON}, v.neighborhood
     FROM events e
     LEFT JOIN venues v ON v.city_id = e.city_id AND v.venue_norm = e.venue_norm AND v.status = 'ok'
     WHERE e.city_id = $1 AND e.status = 'approved'
       AND e.start_time >= $2 AND e.start_time <= $3
     ORDER BY e.start_time ASC`,
    [cityId, startIso, endIso]
  )
  return rows.map(r => enrichRow(r, nowIso))
}

// ---------------------------------------------------------------------------
// Recommendations — signal capture + write-through feature updates
//
// One entry point, recordInteraction, does everything a tracked signal implies:
// append to the interaction log, nudge the actor's per-facet affinities (an EMA,
// so the rail reacts within a session), bump the event's engagement prior (so
// trending is real-time, no cron), and mark the originating recommendation
// impression engaged. All of it is best-effort — callers wrap it so a tracking
// failure never breaks the user's action.
// ---------------------------------------------------------------------------

// The active ranking model. Serving reads exactly one row (status='active'); v1
// is the seeded prior until nightly training promotes a trained successor.
export async function getActiveModel(): Promise<{ id: number; weights: ModelWeights } | null> {
  const db = await getDb()
  const rows = await db.query<{ id: number; weights: ModelWeights }>(
    `SELECT id, weights FROM model_versions WHERE status = 'active' ORDER BY id DESC LIMIT 1`
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Recommendations — serving (the ranking model at request time)
// ---------------------------------------------------------------------------

export type RecImpressionItem = {
  eventId: string
  position: number
  features: FeatureVector
  explored: boolean
}

// Rank upcoming events for an actor with the active model. Returns the ordered
// enriched events (for rendering) alongside the impressions to log (for
// training) and the model version that ranked them. Pure ranking lives in
// lib/recs/score; this function only assembles inputs and maps outputs.
export async function listRecommendedEvents(
  cityId: number,
  taste: ActorTaste,
  state: { hidden: Set<string>; seen: Map<string, number> },
  opts: { limit?: number } = {}
): Promise<{
  events: EnrichedEvent[]
  impressions: RecImpressionItem[]
  modelVersion: number
  personalized: boolean
}> {
  const db = await getDb()
  const limit = opts.limit ?? RECS_DEFAULT_LIMIT
  const nowIso = new Date().toISOString()
  const nowMs = Date.now()
  const toIso = new Date(nowMs + RECS_WINDOW_DAYS * 86_400_000).toISOString()

  const model = await getActiveModel()
  if (!model) return { events: [], impressions: [], modelVersion: 0, personalized: false }

  // Candidate catalog read (public event metadata, on the pg service path). The
  // actor's taste + event-state come from the caller (the RLS-scoped Supabase
  // client), so serving stays a pure assembly + ranking step.
  const rows = await db.query<Record<string, unknown>>(
    `SELECT e.*, ${CATEGORIES_JSON}, ${FEATURED_JSON},
       ee.score AS engagement_score, v.neighborhood
     FROM events e
     LEFT JOIN event_engagement ee ON ee.event_id = e.id
     LEFT JOIN venues v ON v.city_id = e.city_id AND v.venue_norm = e.venue_norm AND v.status = 'ok'
     WHERE e.city_id = $1 AND e.status = 'approved'
       AND e.start_time >= $2 AND e.start_time <= $3
     ORDER BY e.start_time ASC
     LIMIT $4`,
    [cityId, nowIso, toIso, RECS_CANDIDATE_CAP]
  )

  // Split each row into a scoring Candidate and a render row (embedding stripped
  // so a 768-float array never ships to the client).
  const renderById = new Map<string, Record<string, unknown>>()
  const candidates: RecCandidate[] = []
  for (const row of rows) {
    const id = row.id as string
    if (state.hidden.has(id)) continue // excluded outright
    const embedding = (row.embedding as number[] | null) ?? null
    delete row.embedding
    renderById.set(id, row)
    candidates.push({
      id,
      categorySlugs: ((row.categories as { slug: string }[] | null) ?? []).map(c => c.slug),
      venueNorm: (row.venue_norm as string | null) ?? null,
      neighborhood: (row.neighborhood as string | null) ?? null,
      isFree: !!row.is_free,
      startTime: row.start_time as string,
      engagementScore: (row.engagement_score as number | null) ?? null,
      embedding,
      seenCount: state.seen.get(id) ?? 0,
    })
  }

  const ranked = rankCandidates(candidates, taste, {
    weights: model.weights,
    nowMs,
    limit,
    exploreSlots: RECS_EXPLORE_SLOTS,
  })

  const events = ranked.map(r => enrichRow(renderById.get(r.id)!, nowIso))
  const impressions = ranked.map(r => ({
    eventId: r.id,
    position: r.position,
    features: r.features,
    explored: r.explored,
  }))
  // Personalized when the actor has any learned taste; otherwise the same model
  // ran on zero features (a trending-shaped list) and the UI labels it as such.
  const personalized = taste.affinity.size > 0 || taste.vector !== null
  return { events, impressions, modelVersion: model.id, personalized }
}

// Approved events that haven't been embedded yet (newest first — the soonest
// upcoming events matter most to the rail). Used by the backfill script and,
// later, a cron.
export async function getEventsMissingEmbedding(
  limit: number
): Promise<{ id: string; title: string; description: string | null }[]> {
  const db = await getDb()
  return db.query(
    `SELECT id, title, description FROM events
     WHERE embedding IS NULL AND status = 'approved'
     ORDER BY start_time DESC
     LIMIT $1`,
    [limit]
  )
}

export async function setEventEmbedding(id: string, vec: number[]): Promise<void> {
  const db = await getDb()
  await db.query(`UPDATE events SET embedding = $2 WHERE id = $1`, [id, vec])
}