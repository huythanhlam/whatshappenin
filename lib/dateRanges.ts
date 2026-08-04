// Date-range filtering for events, anchored to Austin local time (Central).
// Resolves a named range ("today", "week", "weekend", "month") or a custom
// from/to pair into absolute UTC ISO bounds the data layer can query.

export const TZ = 'America/Chicago'

// How far ahead the roundup crawlers (culturemap, tribe-events, the
// austintexas.gov index) reach on every run: a rolling ~2-month window
// recomputed from "now" each ingest. This is a coverage *floor* that drives
// loop length / pagination depth / stop conditions — events further out are
// still kept when a page happens to list them (the only upper bound is the
// ~18-month ceiling in lib/persist.ts). Shared so all three stay in sync.
export const LOOKAHEAD_DAYS = 60

// UTC ms of the far edge of the lookahead window (now + LOOKAHEAD_DAYS).
export function lookaheadHorizonMs(): number {
  return Date.now() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000
}

export type WhenPreset = 'today' | 'week' | 'weekend' | 'month'
export const WHEN_PRESETS: { value: WhenPreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This Week' },
  { value: 'weekend', label: 'This Weekend' },
  { value: 'month', label: 'This Month' },
]

// Milliseconds the given timezone is offset from UTC at `date` (handles DST).
function tzOffsetMs(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]))
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? '00' : p.hour), +p.minute, +p.second)
  return asUTC - date.getTime()
}

// Convert a wall-clock time in `tz` to the corresponding UTC instant.
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, ss: number, tz: string): Date {
  const asUTC = Date.UTC(y, m, d, hh, mm, ss)
  const guess = new Date(asUTC)
  return new Date(asUTC - tzOffsetMs(tz, guess))
}

// The Y/M/D and weekday (0=Sun) of `date` in the target timezone.
export function partsInTz(date: Date, tz: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  })
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]))
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  return { y: +p.year, m: +p.month - 1, d: +p.day, weekday: wd }
}

export type ResolvedRange = { fromIso: string; toIso: string | null; label: string | null; active: boolean }

// Resolve URL params into UTC bounds. `from`/`to` are yyyy-mm-dd (custom range).
// Lower bound is never earlier than "now" — we never show past events.
export function resolveDateRange(params: {
  when?: string | null
  from?: string | null
  to?: string | null
}): ResolvedRange {
  const now = new Date()
  const nowIso = now.toISOString()

  // Custom range takes precedence when a valid from/to is supplied.
  if (params.from || params.to) {
    const f = params.from ? parseYmd(params.from) : null
    const t = params.to ? parseYmd(params.to) : null
    const fromIso = f ? maxIso(nowIso, zonedToUtc(f.y, f.m, f.d, 0, 0, 0, TZ).toISOString()) : nowIso
    // `to` is likewise floored at `fromIso`: when the whole requested window is
    // in the past, clamping `from` up to now would otherwise invert the range
    // (to < from). Flooring keeps the invariant "to is never before from" — a
    // fully-past window collapses to an empty forward slice, never past events.
    const toIso = t ? maxIso(fromIso, zonedToUtc(t.y, t.m, t.d, 23, 59, 59, TZ).toISOString()) : null
    const label = `${params.from ?? ''}${params.to ? ` – ${params.to}` : '+'}`
    return { fromIso, toIso, label, active: true }
  }

  const { y, m, d, weekday } = partsInTz(now, TZ)
  const endOfToday = zonedToUtc(y, m, d, 23, 59, 59, TZ).toISOString()

  switch (params.when) {
    case 'today':
      return { fromIso: nowIso, toIso: endOfToday, label: 'Today', active: true }
    case 'week': {
      // through end of this calendar week (Sunday)
      const daysToSun = (7 - weekday) % 7
      const end = zonedToUtc(y, m, d + daysToSun, 23, 59, 59, TZ).toISOString()
      return { fromIso: nowIso, toIso: end, label: 'This Week', active: true }
    }
    case 'weekend': {
      // upcoming Sat 00:00 → Sun 23:59 (or now→Sun if already the weekend)
      const daysToSat = (6 - weekday + 7) % 7
      const satStart = zonedToUtc(y, m, d + daysToSat, 0, 0, 0, TZ).toISOString()
      const sunEnd = zonedToUtc(y, m, d + daysToSat + 1, 23, 59, 59, TZ).toISOString()
      const fromIso = weekday === 0 || weekday === 6 ? nowIso : maxIso(nowIso, satStart)
      return { fromIso, toIso: sunEnd, label: 'This Weekend', active: true }
    }
    case 'month': {
      const end = zonedToUtc(y, m + 1, 0, 23, 59, 59, TZ).toISOString() // day 0 of next month = last day
      return { fromIso: nowIso, toIso: end, label: 'This Month', active: true }
    }
    default:
      return { fromIso: nowIso, toIso: null, label: null, active: false }
  }
}

function parseYmd(s: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!match) return null
  return { y: +match[1], m: +match[2] - 1, d: +match[3] }
}

function maxIso(a: string, b: string): string {
  return a > b ? a : b
}
