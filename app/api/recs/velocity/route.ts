import { NextRequest, NextResponse } from 'next/server'
import { getEnabledCities, recomputeCityVelocity } from '@/lib/db'
import { pollCityDemand } from '@/lib/recs/demand'
import { requireCronAuth } from '@/lib/auth'

export const maxDuration = 300

// Trending maintenance, on a cron.
//
// Two steps, in order, because the second reads what the first wrote:
//   1. Poll ticket supply for upcoming ticketed events, appending to the
//      event_demand series. This is demand measured outside our own traffic.
//   2. Recompute events.velocity from windowed engagement + that series.
//
// Both degrade to no-ops when the 043 tables are absent or the ticketing API
// keys aren't configured, so this route is safe to schedule before either is
// true — it just reports zeroes.
async function run(req: NextRequest) {
  const denied = requireCronAuth(req)
  if (denied) return denied

  const cities = await getEnabledCities()
  const results = []

  for (const city of cities) {
    const polled = await pollCityDemand(city.id)
    const scored = await recomputeCityVelocity(city.id)
    results.push({ city: city.slug, polled, scored })
  }

  return NextResponse.json({ results })
}

export async function POST(req: NextRequest) {
  return run(req)
}

// Vercel Cron invokes scheduled jobs with GET (carrying the CRON_SECRET bearer),
// so GET must be supported — guarded identically.
export async function GET(req: NextRequest) {
  return run(req)
}
