import type { RawEvent } from './types'
import { TZ, partsInTz, zonedToUtc, LOOKAHEAD_DAYS } from '@/lib/dateRanges'
import { mapPool } from '@/lib/gemini'
import { stateFromAddress } from './luma'

// sweatpals.com/discover is a client-rendered Next.js page (its own
// __NEXT_DATA__ carries nothing but a canonical URL), but the API its frontend
// calls is public and unauthenticated — live-verified with plain `curl`: no
// key, no cookie, no Origin header, and robots.txt explicitly Allows /discover.
// So this is a structured JSON source: no Gemini, no BROWSER_FETCH_URL.
//
// Two endpoints, both on the ilove.sweatpals.com API host:
//   GET  /api/events/available-cities?search=<name>&pageSize=1
//        → [{ cityId, cityName, stateName, ... }]; resolves the configured
//          city's UUID, so this parser is city-agnostic like luma.ts rather
//          than carrying a hardcoded Austin id.
//   POST /api/events/public/search  (filters in the BODY — live-verified that
//        query params are silently ignored)
//
// Search constraints, all live-verified 2026-08-16:
//  * `limit` is hard-capped at 500 (501+ returns 400 "Limit should be <= 500")
//    and there is NO offset/page parameter. The only way to page is to narrow
//    periodFrom/periodTo — hence the day-at-a-time sweep below (~54 Austin
//    events/day with the per-author cap, comfortably under the cap), same
//    shape as culturemap.ts's day loop.
//  * `cityId` is metro-scoped, not city-exact: Austin's id also returns
//    Pflugerville / Cedar Park / San Marcos. That's desirable coverage, but
//    it's a fuzzy radius, so `targetState` applies the same backstop luma.ts
//    uses (shared implementation — see stateFromAddress).
//  * Recurring series report the SERIES bounds in startDate/endDate and the
//    occurrence in `instance` (UTC) + `shortLocalInstance` (local date). Only
//    the latter pair is trustworthy for a calendar; see instanceEnd() for why
//    `instanceEndDate` needs a sanity bound.
//
// `url` in the DB row is the human discover page, retained for the UI only; it
// is not fetched.

const API = 'https://ilove.sweatpals.com/api'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// One request per day across the shared rolling 2-month window, fetched with
// bounded concurrency so the whole sweep stays well inside the ingest route's
// maxDuration (which this source shares with ~50 others).
const DAYS_AHEAD = LOOKAHEAD_DAYS
const DAY_FETCH_CONCURRENCY = 6
const DAY_TIMEOUT_MS = 15000
const PAGE_LIMIT = 500

// Sweatpals is dominated by studios posting every class on their timetable —
// one gym can account for a dozen rows on a single day. The API's own
// `maxEventsPerAuthorPerDay` filter (which Sweatpals' site uses for its
// "Things to do this weekend" collection) caps that at the source instead of
// flooding the feed with one studio's schedule: live-verified 72 → 54 events
// on a sample day, dropping only the long tails of repeat posters.
const MAX_EVENTS_PER_AUTHOR_PER_DAY = 2

// Longest occurrence duration we'll believe from `instanceEndDate` — see
// instanceEnd().
const MAX_DURATION_HOURS = 12

type SweatpalsCity = { cityId?: unknown; cityName?: unknown; stateName?: unknown }

type SweatpalsPrice = { priceAmount?: unknown }

type SweatpalsResult = {
  id?: unknown
  alias?: unknown
  name?: unknown
  description?: unknown
  instance?: unknown
  instanceEndDate?: unknown
  shortLocalInstance?: unknown
  addressName?: unknown
  avatarId?: unknown
  isPaid?: unknown
  isOnlineEvent?: unknown
  prices?: unknown
  participantsCount?: unknown
  attendeesLimit?: unknown
}

type DayParts = { y: number; m: number; d: number }

function addDays(base: DayParts, days: number): DayParts {
  const dt = new Date(Date.UTC(base.y, base.m, base.d + days))
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() }
}

// Midnight of `p` in the city's timezone, as the UTC instant the API expects.
// Exported for the day-boundary test.
export function localMidnightIso(p: DayParts): string {
  return zonedToUtc(p.y, p.m, p.d, 0, 0, 0, TZ).toISOString()
}

function toIso(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

// The search body. Exported pure so the param contract (which the API
// validates strictly — wrong enum casing returns 400 with the allowed values)
// is unit-testable without network.
export function buildSearchBody(cityId: string, fromIso: string, toIso: string) {
  return {
    limit: PAGE_LIMIT,
    cityId,
    periodFrom: fromIso,
    periodTo: toIso,
    // Uppercase; the API rejects anything but EVENT / CLASS / RETREAT.
    withEventTypes: ['EVENT', 'CLASS'],
    // Lowercase; allowed values are default / public / no-privacy-checks.
    privacyFilteringMode: 'public',
    // Include an event still running at periodFrom, matching what the site
    // shows. Costs a small bleed of late-night events into the next day's
    // window, which the (id, instance) dedup below collapses.
    filterByEndDate: true,
    hideEmptyAvatars: true,
    hideSoldOut: true,
    maxEventsPerAuthorPerDay: MAX_EVENTS_PER_AUTHOR_PER_DAY,
  }
}

// "Pickleland - Indoor Pickleball Courts in Pflugerville, Martin Lane,
// Pflugerville, TX" — one flat string, venue first. The leading segment is the
// venue; the whole string is the address (it's what Sweatpals hands its own
// Google-Maps links, so it geocodes as-is).
//
// The exception is a host who pinned only a city — "Austin, TX", "Austin, TX
// 78746, USA", "Cedar Park, TX 78613, USA" — which would otherwise yield the
// venue name "Austin" (59 of 2,639 on a live sweep), both wrong on the card
// and a bad blocking key for persistEvents' title+venue dedup. A leading
// street number ("4622 S Lamar Blvd, Austin, TX") IS kept: that's a real,
// stable location the host simply didn't name.
//
// `address` is always the untouched original — it's what geocodes.
const COUNTRY_SEGMENT = /^(usa|u\.s\.a\.|united states)$/i
const STATE_MAYBE_ZIP = /^[A-Za-z]{2}(\s+\d{5}(-\d{4})?)?$/

export function venueOf(addressName: string | null): { name: string | null; address: string | null } {
  const trimmed = addressName?.trim()
  if (!trimmed) return { name: null, address: null }
  const segments = trimmed.split(',').map(s => s.trim())
  if (segments.length > 1 && COUNTRY_SEGMENT.test(segments[segments.length - 1])) segments.pop()
  const cityOnly = segments.length === 2 && STATE_MAYBE_ZIP.test(segments[1])
  return { name: cityOnly ? null : segments[0] || null, address: trimmed }
}

// `instanceEndDate` is the occurrence's end for most rows (p50 duration 1h),
// but for a recurring series whose stored template spans an implausibly long
// block it reproduces that whole span — e.g. a 1-hour class reporting a 13-hour
// "end". There's no second source for the real end, so anything beyond
// MAX_DURATION_HOURS (or non-positive) is dropped to null rather than invented,
// matching the convention in luma.ts/meetup.ts.
export function instanceEnd(startIso: string, rawEnd: unknown): string | null {
  const end = toIso(rawEnd)
  if (!end) return null
  const hours = (new Date(end).getTime() - new Date(startIso).getTime()) / 3_600_000
  return hours > 0 && hours <= MAX_DURATION_HOURS ? end : null
}

// Prices are integer cents; RawEvent.price_min/max are dollars (matching every
// other source and the UI's `$${price_min}` rendering).
function priceRange(prices: unknown): { min: number | null; max: number | null } {
  if (!Array.isArray(prices)) return { min: null, max: null }
  const amounts = (prices as SweatpalsPrice[])
    .map(p => p?.priceAmount)
    .filter((a): a is number => typeof a === 'number' && a >= 0)
    .map(cents => cents / 100)
  if (!amounts.length) return { min: null, max: null }
  return { min: Math.min(...amounts), max: Math.max(...amounts) }
}

function isResult(v: unknown): v is SweatpalsResult {
  const o = v as SweatpalsResult
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.instance === 'string'
  )
}

function toRawEvent(r: SweatpalsResult, source: string): RawEvent | null {
  const start_time = toIso(r.instance)
  if (!start_time) return null
  const title = (r.name as string).trim()
  if (!title) return null

  const { name: venue_name, address: venue_address } = venueOf(
    typeof r.addressName === 'string' ? r.addressName : null,
  )
  const { min, max } = priceRange(r.prices)
  const description = typeof r.description === 'string' && r.description.trim() ? r.description.trim() : null

  // The detail URL is /event/<alias>/<local date of this occurrence> — the same
  // pair that identifies the occurrence, so a row without both gets no link
  // rather than one pointing at the wrong night.
  const ticket_url =
    typeof r.alias === 'string' && typeof r.shortLocalInstance === 'string'
      ? `https://sweatpals.com/event/${r.alias}/${r.shortLocalInstance}`
      : null

  return {
    title,
    description,
    start_time,
    end_time: instanceEnd(start_time, r.instanceEndDate),
    venue_name,
    venue_address,
    image_url: typeof r.avatarId === 'string' ? `${API}/files/${r.avatarId}?variant=l` : null,
    ticket_url,
    source,
    // One row per (series, occurrence): the series UUID alone would collapse a
    // weekly class into a single event.
    source_id: `${r.id as string}:${start_time}`,
    is_free: r.isPaid !== true,
    price_min: min,
    price_max: max,
    signals: typeof r.participantsCount === 'number' ? { attendeeCount: r.participantsCount } : null,
  }
}

// Pure results[] -> events reduction (no network), so it's unit-testable
// without mocking fetch. Drops online-only events (they carry no address or
// city at all and aren't "things to do in Austin"), dedupes by
// (series id, occurrence) since adjacent day windows overlap by design, and
// applies the same state backstop as luma.ts to the metro radius's edges.
export function eventsFromResults(results: unknown, source: string, targetState?: string): RawEvent[] {
  if (!Array.isArray(results)) return []
  const seen = new Map<string, RawEvent>()
  for (const r of results) {
    if (!isResult(r) || r.isOnlineEvent === true) continue
    const raw = toRawEvent(r, source)
    if (!raw || seen.has(raw.source_id)) continue
    if (targetState) {
      const state = stateFromAddress(raw.venue_address)
      if (state && state !== targetState.toUpperCase()) continue
    }
    seen.set(raw.source_id, raw)
  }
  return [...seen.values()]
}

async function postJson(path: string, body: unknown): Promise<unknown | null> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DAY_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!res.ok) return null
    return await res.json()
  } catch (e) {
    console.error(`Sweatpals POST ${path} failed:`, e)
    return null
  }
}

// Resolve the configured city's Sweatpals UUID by name, confirming the state
// matches so a same-named city in another state can't be picked up silently
// (the endpoint is a fuzzy `search`, not an exact lookup).
export async function resolveCityId(cityName: string, state: string): Promise<string | null> {
  try {
    const u = new URL(`${API}/events/available-cities`)
    u.searchParams.set('search', cityName)
    u.searchParams.set('pageSize', '5')
    const res = await fetch(u, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(DAY_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const rows = (await res.json()) as SweatpalsCity[]
    if (!Array.isArray(rows)) return null
    const match = rows.find(
      c =>
        typeof c?.cityId === 'string' &&
        String(c?.cityName ?? '').toLowerCase() === cityName.toLowerCase() &&
        String(c?.stateName ?? '').toUpperCase() === state.toUpperCase(),
    )
    return (match?.cityId as string) ?? null
  } catch (e) {
    console.error(`Sweatpals city lookup failed for ${cityName}, ${state}:`, e)
    return null
  }
}

export type SweatpalsFetchOptions = { cityName: string; state: string; since?: Date }

export async function fetchSweatpalsEvents(
  url: string,
  source: string,
  opts: SweatpalsFetchOptions,
): Promise<RawEvent[]> {
  const { cityName, state, since } = opts
  const cityId = await resolveCityId(cityName, state)
  if (!cityId) {
    // Fail closed: without a city id the search returns an unfiltered global
    // feed, which would import other metros' events into this city.
    console.error(`Sweatpals ${source}: could not resolve city id for ${cityName}, ${state} (${url}); skipping`)
    return []
  }

  // Day windows run local-midnight to local-midnight in the city's timezone,
  // so a "day" matches what the site itself shows rather than a UTC slice.
  const today = partsInTz(since ?? new Date(), TZ)
  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(today, i))

  const pages = await mapPool(days, DAY_FETCH_CONCURRENCY, day =>
    postJson('/events/public/search', buildSearchBody(cityId, localMidnightIso(day), localMidnightIso(addDays(day, 1)))),
  )

  const merged: unknown[] = []
  for (const page of pages) if (Array.isArray(page)) merged.push(...page)

  // A recurring series occasionally reports an `instance` that predates the
  // window it was returned for — the search resolves the series' nearest
  // instance rather than one inside the requested period (77 of 2,639 on a
  // live sweep, some weeks in the past). Nothing downstream wants a past
  // occurrence, so the window's own lower bound is the filter.
  const windowStart = localMidnightIso(days[0])
  return eventsFromResults(merged, source, state).filter(e => e.start_time >= windowStart)
}
