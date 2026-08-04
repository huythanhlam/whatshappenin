import { NextRequest, NextResponse } from 'next/server'
import { PARSERS } from '@/lib/sources/registry'
import type { SourceRow, SourceContext } from '@/lib/sources/types'
import { persistEvents } from '@/lib/persist'
import { isLocal, getEnabledCities, getEnabledSources, startSourceRun, finishSourceRun, touchSourceSuccess, reapStaleRuns, type City } from '@/lib/db'
import { withGeminiMeter } from '@/lib/gemini'
import { requireCronAuth } from '@/lib/auth'

export const maxDuration = 300

function contextFor(source: SourceRow, city: City): SourceContext {
  return {
    city: { id: city.id, slug: city.slug, name: city.name, state: city.state, lat: city.lat, lng: city.lng },
    since: new Date(),
    logger: {
      log: (...a) => console.log(`[${city.slug}/${source.name}]`, ...a),
      warn: (...a) => console.warn(`[${city.slug}/${source.name}]`, ...a),
      error: (...a) => console.error(`[${city.slug}/${source.name}]`, ...a),
    },
  }
}

// Run one configured source end to end, wrapped in a source_runs record linked to
// its sources row. A missing parser or unavailable mechanism (no API key) is a
// visible `skipped`, never a silent empty source.
async function runSource(source: SourceRow, city: City): Promise<{ upserted: number; found: number; rejected: number }> {
  const parser = PARSERS[source.parser]
  if (!parser || !parser.available()) {
    const id = await startSourceRun(source.name, source.id)
    await finishSourceRun(id, {
      status: 'skipped',
      error: parser ? 'parser unavailable (missing key)' : `unknown parser: ${source.parser}`,
    })
    return { upserted: 0, found: 0, rejected: 0 }
  }

  const id = await startSourceRun(source.name, source.id)
  try {
    // Scope a Gemini meter to this source so its fetch-time extraction and
    // persist-time tagging requests are attributed to it, even though sources
    // run concurrently.
    const { result, meter } = await withGeminiMeter(async () => {
      const { events, skipped } = await parser.fetch(source, contextFor(source, city))
      if (skipped) return { skipped: true as const, persist: null }
      return { skipped: false as const, persist: await persistEvents(events, { cityId: city.id, status: 'approved' }) }
    })

    if (result.skipped) {
      // Content-hash short-circuit: page unchanged, no Gemini spent.
      await finishSourceRun(id, { status: 'skipped', error: 'unchanged since last crawl' })
      await touchSourceSuccess(source.id)
      return { upserted: 0, found: 0, rejected: 0 }
    }

    const { inserted, rejected, total } = result.persist!

    // A source shut out entirely by the daily budget (made zero requests, all
    // deferred, no events) is recorded as skipped-for-budget so it's visible and
    // goes first next run — not silently dropped (PRODUCT-SPEC §6.1).
    const budgetBlocked = meter.requests === 0 && meter.skippedForBudget > 0 && total === 0
    await finishSourceRun(id, {
      status: budgetBlocked ? 'skipped' : 'ok',
      events_found: total,
      events_upserted: inserted,
      events_rejected: rejected,
      gemini_requests: meter.requests,
      error: meter.skippedForBudget > 0 ? `${meter.skippedForBudget} Gemini calls skipped (daily budget)` : null,
    })
    if (!budgetBlocked) await touchSourceSuccess(source.id)
    return { upserted: inserted, found: total, rejected }
  } catch (e) {
    console.error(`Source ${source.name} (${city.slug}) failed:`, e)
    await finishSourceRun(id, { status: 'error', error: (e as Error).message?.slice(0, 500) ?? 'unknown' })
    return { upserted: 0, found: 0, rejected: 0 }
  }
}

// Optional `?city=<slug>` scopes a run to one city (see vercel.json — each
// enabled city gets its own cron entry, staggered, so one invocation's
// maxDuration/Gemini-RPM budget is never shared across cities). Omitting it
// preserves the original all-cities-in-one-run behavior for local/manual
// triggering (README's `curl -X POST /api/ingest`) and as a fallback.
//
// `?source=a,b` (include-only) and `?exclude=a,b` (skip these) further scope a
// run to a subset of the city's enabled sources, matched by `sources.name`.
// This lets a heavy source that can't finish inside a shared 300s invocation
// get its OWN cron window: a source like `crawl:meetup-com` sweeps ~280 events
// (whose persist warms geocode/venue caches) and, when it competes with ~50
// other sources for one invocation's wall-clock and DB pool, is reliably still
// running when maxDuration kills the function — orphaning it at 'running' and
// persisting nothing. So the bulk cron `exclude`s it and a dedicated cron runs
// it `source`-scoped, mirroring the per-city split above.
function parseNameSet(v: string | null): Set<string> | null {
  if (!v) return null
  const names = v.split(',').map(s => s.trim()).filter(Boolean)
  return names.length ? new Set(names) : null
}

async function runIngest(
  cityFilter?: string,
  sourceFilter?: string | null,
  excludeFilter?: string | null,
  shard?: { index: number; total: number },
  ignoreCadence = false,
) {
  // Self-heal the health ledger before starting: any run left 'running' past the
  // max invocation wall-clock was orphaned by a maxDuration kill and must be
  // finalized, otherwise a source that never actually completed looks pending
  // forever (and stays invisible to /api/admin/health, which ignores 'running').
  const reaped = await reapStaleRuns()
  if (reaped > 0) console.log(`[ingest] reaped ${reaped} orphaned 'running' run(s)`)

  // Ingestion is driven entirely by the `sources` table (Phase 2B), looped over
  // every enabled city (Phase 3): enabled rows for each city, each dispatched to
  // its parser mechanism. Adding coverage is an INSERT, not a code change.
  const enabledCities = await getEnabledCities()
  const cities = cityFilter ? enabledCities.filter(c => c.slug === cityFilter) : enabledCities

  if (cityFilter && cities.length === 0) {
    return NextResponse.json({ error: `Unknown or disabled city "${cityFilter}"` }, { status: 400 })
  }

  const only = parseNameSet(sourceFilter ?? null)
  const skip = parseNameSet(excludeFilter ?? null)

  const perCity = await Promise.all(cities.map(async city => {
    let sources = await getEnabledSources(city.id, new Date(), shard, ignoreCadence)
    if (only) sources = sources.filter(s => only.has(s.name))
    if (skip) sources = sources.filter(s => !skip.has(s.name))
    const results = await Promise.all(
      sources.map(async source => ({ name: source.name, ...(await runSource(source, city)) }))
    )
    const bySource: Record<string, number> = {}
    let inserted = 0, found = 0, rejected = 0
    for (const r of results) {
      bySource[r.name] = r.upserted
      inserted += r.upserted
      found += r.found
      rejected += r.rejected
    }
    return { city: city.slug, inserted, found, rejected, bySource }
  }))

  const totals = perCity.reduce(
    (acc, c) => ({ inserted: acc.inserted + c.inserted, rejected: acc.rejected + c.rejected, total: acc.total + c.found }),
    { inserted: 0, rejected: 0, total: 0 }
  )

  return NextResponse.json({ ...totals, byCity: perCity, mode: isLocal() ? 'local' : 'supabase' })
}

// `?shard=<index>/<total>` splits a city's sources across cron windows so a
// large city can't overflow one 300s invocation and orphan its tail (see
// getEnabledSources). Malformed values are ignored (treated as no sharding).
function parseShard(v: string | null): { index: number; total: number } | undefined {
  if (!v) return undefined
  const m = /^(\d+)\/(\d+)$/.exec(v.trim())
  if (!m) return undefined
  const index = Number(m[1]), total = Number(m[2])
  if (!Number.isInteger(total) || total < 1 || index < 0 || index >= total) return undefined
  return { index, total }
}

// `?cadence=all` forces weekly sources to run off their Monday schedule — an
// operator escape hatch for re-crawling on demand (see getEnabledSources).
function paramsOf(req: NextRequest): [string | undefined, string | null, string | null, { index: number; total: number } | undefined, boolean] {
  const p = req.nextUrl.searchParams
  return [p.get('city') ?? undefined, p.get('source'), p.get('exclude'), parseShard(p.get('shard')), p.get('cadence') === 'all']
}

export async function POST(req: NextRequest) {
  const denied = requireCronAuth(req)
  if (denied) return denied
  return runIngest(...paramsOf(req))
}

// Vercel Cron invokes scheduled jobs with a GET request (carrying the
// CRON_SECRET bearer), so GET must be supported — it is guarded identically.
export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req)
  if (denied) return denied
  return runIngest(...paramsOf(req))
}
