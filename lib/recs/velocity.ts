// Trending velocity — "is this heating up right now?"
//
// `prominence` is a level and `event_engagement.score` is a lifetime rate;
// neither can express a *rise*. An event that has been quietly on the calendar
// for two months and an event that three hundred people discovered yesterday can
// hold identical lifetime rates, and the second one is the one a trending rail
// exists to show.
//
// Velocity is therefore a comparison of an event against its own recent past,
// not against other events. That normalization matters: a huge event with a
// small bump should not outrank a small event that just tripled.
//
// Pure and DB-free; lib/db feeds it counts, the cron writes the result to
// events.velocity.

// The two windows. "Recent" is short enough to react within a day of something
// breaking; the baseline is long enough that a single quiet Tuesday doesn't read
// as a collapse.
export const RECENT_WINDOW_DAYS = 2
export const BASELINE_WINDOW_DAYS = 12

// Additive smoothing on both rates. Without it, an event going from 0 to 2
// interactions is an infinite lift and would pin the rail; with it, low-volume
// events need real movement to score.
const RATE_SMOOTHING = 0.5

// The lift that counts as maximum heat. 5× its own baseline is a genuine
// breakout; beyond that the difference stops being meaningful for ranking.
const LIFT_SATURATION = 5

// Daily fractional drop in ticket supply that counts as maximum heat. 20% of
// remaining listings per day is a show on its way to selling out.
const DEMAND_DROP_SATURATION = 0.2

export type VelocityInput = {
  // Positive interactions in the recent window.
  recentCount: number
  // Positive interactions in the baseline window preceding it.
  baselineCount: number
  // Fractional per-day decline in resale listings, from the event_demand series.
  // Null when the event isn't ticketed or has fewer than two observations.
  demandDropPerDay?: number | null
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

// Engagement heat: this event's recent rate against its own baseline rate.
export function engagementVelocity(recentCount: number, baselineCount: number): number {
  const recentRate = recentCount / RECENT_WINDOW_DAYS
  const baselineRate = baselineCount / BASELINE_WINDOW_DAYS
  const lift = (recentRate + RATE_SMOOTHING) / (baselineRate + RATE_SMOOTHING)
  if (lift <= 1) return 0 // flat or cooling is not trending
  return clamp01(Math.log(lift) / Math.log(LIFT_SATURATION))
}

// Demand heat: tickets disappearing. Independent of our own traffic entirely,
// which is what makes it worth polling for.
export function demandVelocity(dropPerDay: number | null | undefined): number {
  if (typeof dropPerDay !== 'number' || dropPerDay <= 0) return 0
  return clamp01(dropPerDay / DEMAND_DROP_SATURATION)
}

// Velocity in [0,1].
//
// The two channels combine by MAX, not by average. They measure different
// audiences — ours and the ticket-buying public — and either one firing means
// something is happening. Averaging would let a silent channel (an event with no
// ticketing footprint at all, which is most of the long tail) halve a real
// signal from the other.
export function computeVelocity(input: VelocityInput): number {
  return Math.max(
    engagementVelocity(input.recentCount, input.baselineCount),
    demandVelocity(input.demandDropPerDay)
  )
}
