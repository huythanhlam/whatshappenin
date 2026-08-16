import * as cheerio from 'cheerio'
import type { RawEvent } from './types'
import { TZ, zonedToUtc } from '@/lib/dateRanges'

// austin.showlists.net ("Showlist Austin") — a hand-curated aggregator of every
// live-music show in Austin, and the densest single Austin listing we ingest.
// Live-verified (plain `curl`, no browser/JS): the WordPress theme renders the
// ENTIRE upcoming listing — 780+ shows across ~90 days, today through ~4 months
// out — statically into the homepage, grouped by `<div id="YYYYMMDD"
// class="show-date">` with one `<li class="showlist-item">` per show. So one
// request covers the whole window: no pagination, no per-event detail fetches,
// and no Gemini (kind 'jsonld' — structured, exact, free).
//
// Every `<li>` carries its own date and id as data-attributes, so items are read
// independently of the day-group they sit in. The rest of the fields come from
// the item's rendered anchors:
//
//   • title       — `a.show-title[data-show-title]` (the attribute is the
//                   unwrapped source string; the anchor text is the same value
//                   re-wrapped across lines)
//   • ticket_url  — that same anchor's href: the venue/ticketing link the
//                   curators picked (do512, Eventbrite, the venue's own page…)
//   • venue_name  — `.venue-title`, an `<a>` when the venue has a site and a
//                   `<span>` when it doesn't (4/782 live). The `data-venue`
//                   attribute is NOT used: it's empty for exactly those items.
//   • address     — one of two mutually exclusive shapes (live-verified 775/7):
//                   the Google-Maps link's `.visually-hidden` street line, or a
//                   parenthesized `span.text-dark` holding either a street or,
//                   for the handful of out-of-town shows, just a city name.
//   • time        — `span.text-gray` "[7:00 PM]", present on ~1/3 of items.
//
// The listing has no per-event image, description, or price (the curators link
// out for tickets rather than restating prices), so those stay null/false —
// same "don't invent what the source doesn't have" convention as meanwhile.ts
// and luma.ts. Showlist overlaps heavily with the individual Austin venue
// crawlers (Mohawk, Stubb's, Emo's, Antone's…); persistEvents' title+venue
// dedup collapses those rather than double-listing them.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const DEFAULT_HOUR = 19 // matches lib/extractor.ts's "date only -> 19:00 local" convention

// The site is Austin-only apart from a few nearby-town shows, which it marks by
// printing a bare city name where a street address would go.
const DEFAULT_CITY = 'Austin'
const STATE = 'TX'

// "20260815" -> {y, m (0-indexed), d}, or null if unparseable.
export function parseCompactDate(s: string | undefined): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec((s ?? '').trim())
  if (!m) return null
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { y: Number(m[1]), m: month - 1, d: day }
}

// "[7:00 PM]" / "7:00 PM" -> 24h {hh, mm}, or null if unparseable/absent.
export function parseBracketTime(s: string | undefined): { hh: number; mm: number } | null {
  const m = /^\[?\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*\]?$/i.exec((s ?? '').trim())
  if (!m) return null
  let hh = Number(m[1]) % 12
  if (m[3].toLowerCase() === 'pm') hh += 12
  return { hh, mm: Number(m[2]) }
}

// Showlist prints street lines bare ("1413 Webberville Rd") because the whole
// site is implicitly Austin, and prints a bare city for the occasional
// out-of-town show. Qualify both into something geocodable, and leave alone
// anything the source already spelled out fully ("… Austin, TX 78745").
export function qualifyAddress(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  if (new RegExp(`\\b(${STATE}|Texas)\\b`, 'i').test(s)) return s
  // No digits at all -> it's a town name, not a street.
  if (!/\d/.test(s)) return `${s}, ${STATE}`
  return `${s}, ${DEFAULT_CITY}, ${STATE}`
}

// Pure HTML -> events reduction (no network), so it's unit-testable without
// mocking fetch.
export function eventsFromHtml(html: string, source: string): RawEvent[] {
  const $ = cheerio.load(html)
  const out: RawEvent[] = []

  $('li.showlist-item').each((_, el) => {
    const $el = $(el)

    const id = $el.attr('data-show-id')?.trim()
    const date = parseCompactDate($el.attr('data-show-date'))
    if (!id || !date) return

    const $title = $el.find('.show-title').first()
    const title = ($title.attr('data-show-title') ?? $title.text()).replace(/\s+/g, ' ').trim()
    if (!title) return

    const time = parseBracketTime($el.children('span.text-gray').first().text())
    const start_time = zonedToUtc(
      date.y, date.m, date.d,
      time?.hh ?? DEFAULT_HOUR, time?.mm ?? 0, 0,
      TZ,
    ).toISOString()

    const venue_name = $el.find('.venue-title').first().text().replace(/\s+/g, ' ').trim() || null

    // Exactly one of these is present per item: the maps link's hidden street
    // line, or the parenthesized span (which the venue-less items also use for
    // a plain town name). `:not(.venue-title)` keeps the venue's own <span>
    // — same classes, same depth — out of the address.
    const mapped = $el.find('a.maps-link .visually-hidden').first().text()
    const parenthesized = $el.children('span.text-dark:not(.venue-title)').first().text()
    const venue_address = qualifyAddress(mapped || parenthesized)

    const href = $title.attr('href')?.trim()
    const ticket_url = href && href !== '#' ? href : null

    out.push({
      title,
      description: null,
      start_time,
      end_time: null,
      venue_name,
      venue_address,
      image_url: null,
      ticket_url,
      source,
      // The site's own WordPress post id for the show — stable across the
      // listing's daily regeneration, unlike its position or its outbound
      // ticket link.
      source_id: id,
      is_free: false,
      price_min: null,
      price_max: null,
    })
  })

  return out
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      // The homepage is the whole listing (~1.5 MB), so allow a longer read
      // than the single-page crawlers.
      signal: AbortSignal.timeout(30000),
      cache: 'no-store',
    })
    if (!res.ok) return null
    return await res.text()
  } catch (e) {
    console.error(`Showlist fetch failed for ${url}:`, e)
    return null
  }
}

// One request, whole listing. `url` is the site root (austin.showlists.net).
export async function fetchShowlistEvents(url: string, source: string): Promise<RawEvent[]> {
  const html = await fetchHtml(url)
  if (!html) return []

  const seen = new Set<string>()
  return eventsFromHtml(html, source).filter(ev => {
    if (seen.has(ev.source_id)) return false
    seen.add(ev.source_id)
    return true
  })
}
