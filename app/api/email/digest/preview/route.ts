import { NextRequest, NextResponse } from 'next/server'
import { sendDigestPreview, type DigestFrequency } from '@/lib/email/digest'
import { getEnabledCities } from '@/lib/db'
import { requireCronAuth } from '@/lib/auth'

export const maxDuration = 60

// One-off preview send for testing in prod. Guarded by CRON_SECRET (same as the
// real digest route) so it can't be used to spam. Sends to a SINGLE ?to= address
// and never reads the subscriber list.
//
//   GET /api/email/digest/preview?to=you@example.com&frequency=weekly[&city=<id>]
//
// Requires header:  Authorization: Bearer <CRON_SECRET>
async function run(req: NextRequest) {
  const denied = requireCronAuth(req)
  if (denied) return denied

  const to = req.nextUrl.searchParams.get('to')
  if (!to) return NextResponse.json({ error: 'Missing ?to= address' }, { status: 400 })

  const frequency: DigestFrequency =
    req.nextUrl.searchParams.get('frequency') === 'weekly' ? 'weekly' : 'daily'

  // Default to the first enabled city unless an explicit ?city=<id> is given.
  const cityParam = req.nextUrl.searchParams.get('city')
  let cityId = cityParam ? Number(cityParam) : NaN
  if (!Number.isFinite(cityId)) {
    const cities = await getEnabledCities()
    if (!cities.length) return NextResponse.json({ error: 'No enabled cities' }, { status: 404 })
    cityId = cities[0].id
  }

  const result = await sendDigestPreview(to, frequency, cityId)
  return NextResponse.json(result, { status: result.ok ? 200 : 502 })
}

export async function GET(req: NextRequest) {
  return run(req)
}

export async function POST(req: NextRequest) {
  return run(req)
}
