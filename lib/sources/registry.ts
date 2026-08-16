import type { SourceParser, RawEvent, SourceContext, SourceRow } from './types'
import { fetchEventbriteEvents } from './eventbrite'
import { fetchIcalUrl } from './ical'
import { fetchTicketmasterEvents } from './ticketmaster'
import { fetchSeatGeekEvents } from './seatgeek'
import { fetchBlueskyEvents } from './social'
import { fetchYoutubeEvents } from './youtube'
import { fetchCrawlSource } from './crawler'
import { fetchPaginatedCrawlSource } from './paginated-crawl'
import { fetchFeed } from './rss'
import { fetchJsonLdEvents } from './jsonld-events'
import { fetchPartifulEvents } from './partiful'
import { fetchSimpleviewEvents } from './simpleview'
import { fetchCultureMapEvents } from './culturemap'
import { fetchTribeEvents } from './tribe-events'
import { fetchMeetupEvents } from './meetup'
import { fetchLumaEvents } from './luma'
import { fetchMeanwhileEvents } from './meanwhile'
import { fetchAustinMonthlyEvents } from './austinmonthly'
import { fetchShowlistEvents } from './showlist'
import { fetchSweatpalsEvents } from './sweatpals'
import { extractEvents } from '@/lib/extractor'

const has = (v: string | undefined): boolean => !!v && v.length > 0
const hasGeminiKey = () => has(process.env.GEMINI_API_KEY)

// Stamp every event with the fetching SourceRow's authoritative `kind` (the
// DB's per-instance trust signal — see RawEvent.source_kind) so lib/dedup.ts's
// sourceTrust() can rank instance-named sources (e.g. 'crawl:mohawkaustin-com')
// correctly instead of only recognizing the handful of literal names in its
// static fallback map.
const withKind = (source: SourceRow, events: RawEvent[]): RawEvent[] =>
  events.map(e => ({ ...e, source_kind: source.kind }))

// Wrap a plain RawEvent[] producer as a non-skipping parser (only `crawl`
// content-hashes, so everyone else always reports skipped:false). `ctx` is
// available to every fetcher (geo-aware sources use it; the rest ignore it).
const simple = (
  available: () => boolean,
  fetch: (url: string | null, name: string, ctx: SourceContext) => Promise<RawEvent[]>
): SourceParser => ({
  available,
  fetch: async (source, ctx) => ({ events: withKind(source, await fetch(source.url, source.name, ctx)), skipped: false }),
})

// The parser registry: `SourceRow.parser` → mechanism. Instances (which
// feeds/venues/APIs) live in the `sources` table; this holds only the code that
// knows HOW to fetch each kind. Adding coverage of an existing kind is a DB
// INSERT; a genuinely new mechanism is one entry here.
export const PARSERS: Record<string, SourceParser> = {
  // Structured — no Gemini, always available.
  eventbrite: simple(() => true, () => fetchEventbriteEvents()),
  ical:       simple(() => true, (url, name) => fetchIcalUrl(url!, name)),

  // API-key gated, geo-parametrized by the source's city.
  ticketmaster: simple(() => has(process.env.TICKETMASTER_API_KEY), (_url, _name, ctx) => fetchTicketmasterEvents(ctx.city)),
  seatgeek:     simple(() => has(process.env.SEATGEEK_CLIENT_ID),   (_url, _name, ctx) => fetchSeatGeekEvents(ctx.city)),

  // Gemini-extracted free text.
  rss:     simple(hasGeminiKey, (url, name) => fetchFeed(url!, name, { limit: 20 }).then(extractEvents)),
  bluesky: simple(hasGeminiKey, () => fetchBlueskyEvents()),

  // Structured schema.org Event pages — no Gemini, exact and free where the
  // site publishes it (thelongcenter.org, austintexas.gov's per-event pages).
  'events-jsonld': simple(() => true, (url, name) => fetchJsonLdEvents(url!, name)),

  // 365thingsaustin.com — same schema.org Event JSON-LD as 'events-jsonld',
  // but on a Tribe "The Events Calendar" list view that paginates
  // (/events/list/page/N/); this follows that pagination to cover the 2-month
  // lookahead window instead of reading only the first page. `url` is the
  // list-view URL.
  'tribe-events': simple(() => true, (url, name) => fetchTribeEvents(url!, name)),

  // Partiful's Next.js __NEXT_DATA__ payload — likewise structured, no Gemini.
  partiful: simple(() => true, (url, name) => fetchPartifulEvents(url!, name)),

  // Simpleview CMS DMO sites (austintexas.org): a public JSON REST API backs
  // the events widget. `url` is the site origin, not an events path.
  simpleview: simple(() => true, (url, name) => fetchSimpleviewEvents(url!, name)),

  // austin.culturemap.com/events/: static server-rendered HTML, day-at-a-time
  // (?tags=YYYYMMDD), no Gemini. `url` is the events index URL.
  culturemap: simple(() => true, (url, name) => fetchCultureMapEvents(url!, name)),

  // meetup.com/find/: server-rendered Next.js page whose __NEXT_DATA__ embeds
  // a full Apollo GraphQL cache of the search results, no Gemini. `url` is
  // the find-page URL (location/filters baked in).
  meetup: simple(() => true, (url, name) => fetchMeetupEvents(url!, name)),

  // luma.com/<city-slug>: public, unauthenticated JSON API behind the
  // discover page. Luma geo-locates that API by the caller's IP, so the
  // city's stored coordinates are passed as latitude/longitude to pin results
  // to the city regardless of the server region (our cron runs in the DC
  // metro). `url` is retained only as the human discover page for the UI. The
  // radius is fuzzy, not a hard boundary, so `ctx.city.state` is also passed
  // as a backstop to drop any entry whose address resolves to another state.
  luma: simple(() => true, (url, name, ctx) =>
    fetchLumaEvents(url!, name, { targetState: ctx.city.state, lat: ctx.city.lat, lng: ctx.city.lng })),

  // meanwhilebeer.com/events: static server-rendered Webflow CMS collection
  // list, no Gemini. `url` is the events index page; the parser follows the
  // list's own "Next" pagination link to exhaustion and captures each item's
  // event-specific flyer image from its `background-image` style.
  meanwhile: simple(() => true, (url, name) => fetchMeanwhileEvents(url!, name)),

  // austin.showlists.net: the whole hand-curated Austin live-music listing —
  // 780+ shows, ~3 months out — is statically rendered into the homepage, so
  // one request covers the full window with no Gemini. `url` is the site root.
  showlist: simple(() => true, (url, name) => fetchShowlistEvents(url!, name)),

  // sweatpals.com/discover: the discover page is client-rendered, but the API
  // behind it (ilove.sweatpals.com) is public and unauthenticated, so this is
  // a structured JSON source, no Gemini. Driven entirely off the configured
  // city — the parser resolves the city's Sweatpals UUID by name+state and
  // sweeps the rolling window a day at a time (the search has a hard limit of
  // 500 and no offset param, so date windows ARE the pagination). `url` is
  // retained only as the human discover page for the UI.
  sweatpals: simple(() => true, (url, name, ctx) =>
    fetchSweatpalsEvents(url!, name, { cityName: ctx.city.name, state: ctx.city.state, since: ctx.since })),

  // austinmonthly.com/calendar/: WP custom calendar. Two structured passes,
  // no Gemini — paginate its admin-ajax load-more for all detail-page URLs,
  // then read each page's schema.org Event JSON-LD. Honors sources.max_pages
  // (each page = 10 events) to bound the rolling window's listing crawl.
  austinmonthly: {
    available: () => true,
    fetch: async (source, ctx) => ({
      events: withKind(source, await fetchAustinMonthlyEvents(source.url!, source.name, ctx.since, source.max_pages)),
      skipped: false,
    }),
  },

  // Crawl: content-hash aware, returns its own skip flag.
  crawl: {
    available: hasGeminiKey,
    fetch: async (source) => {
      const { events, skipped } = await fetchCrawlSource(source)
      return { events: withKind(source, events), skipped }
    },
  },

  // YouTube needs both its API key and Gemini.
  youtube: simple(() => has(process.env.YOUTUBE_API_KEY) && hasGeminiKey(), () => fetchYoutubeEvents()),

  // Multi-page variant of `crawl`, for sources whose events span a numbered
  // ?page=N pagination (e.g. calendar.austinchronicle.com's Staff Pick view).
  'crawl-paginated': {
    available: hasGeminiKey,
    fetch: async (source) => {
      const { events, skipped } = await fetchPaginatedCrawlSource(source)
      return { events: withKind(source, events), skipped }
    },
  },
}
