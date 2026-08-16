// Recommendation engine — affinity + engagement math.
//
// Pure functions, no DB. The DB layer (lib/db/index.ts) calls these to update a
// row's stored score write-through on each signal, and the (later) nightly batch
// calls `decay` to age stale scores. Keeping the math here makes it unit-testable
// without a database.

import {
  EMA_ALPHA,
  SIGNAL_SATURATION,
  ENGAGEMENT_PRIOR_STRENGTH,
  DEFAULT_CITY_ENGAGEMENT_RATE,
} from './config'
import { NEUTRAL_PROMINENCE } from './prominence'

// Map a raw signal magnitude to an EMA target in [-1, 1]. A favorite (4.0)
// saturates to +1; a view (1.0) is a soft +0.25; a hide (-4.0) is -1.
export function signalTarget(magnitude: number, saturation: number = SIGNAL_SATURATION): number {
  if (saturation <= 0) return 0
  return clamp(magnitude / saturation, -1, 1)
}

// Blend a new observation into an exponential moving average. A fresh score is 0.
export function emaUpdate(prev: number, target: number, alpha: number = EMA_ALPHA): number {
  return alpha * target + (1 - alpha) * prev
}

// One call site convenience: apply a signal of the given magnitude to a prior
// affinity score. `prev` is 0 (or absent) for a first-ever signal.
export function applySignal(prev: number, magnitude: number, alpha: number = EMA_ALPHA): number {
  return emaUpdate(prev, signalTarget(magnitude), alpha)
}

// The prior mean a given event is smoothed toward — the fix for the cold start
// that the flat city rate caused. prominence is a 0–1 index, not a rate, so it's
// mapped onto one: NEUTRAL_PROMINENCE maps to exactly DEFAULT_CITY_ENGAGEMENT_RATE
// (an event with no evidence behaves exactly as it did before this existed), and
// the result is clamped so neither a superstar nor a dud can set a prior that
// real observations can't overcome.
//
// MUST stay in sync with public.prior_rate() in migration 046 — the write-through
// runs in SQL, this is the same policy for anything computing a score in TS
// (the backfill script, tests).
export const MIN_PRIOR_RATE = 0.02
export const MAX_PRIOR_RATE = 0.45

export function priorRate(
  prominence: number | null | undefined,
  cityRate: number = DEFAULT_CITY_ENGAGEMENT_RATE,
): number {
  const p = prominence ?? NEUTRAL_PROMINENCE
  return clamp((cityRate * p) / NEUTRAL_PROMINENCE, MIN_PRIOR_RATE, MAX_PRIOR_RATE)
}

// Bayesian-smoothed engagement rate for an event: engagements over impressions,
// pulled toward the prior mean by `priorStrength` pseudo-observations. With no
// data it equals that prior; it needs real volume to move off it, so a single
// lucky click on a barely-shown event can't top the rail. Pass priorRate(...) as
// `cityRate` to smooth toward the event's own prominence instead of the flat
// city average.
export function bayesianEngagementScore(
  engagements: number,
  impressions: number,
  cityRate: number = DEFAULT_CITY_ENGAGEMENT_RATE,
  priorStrength: number = ENGAGEMENT_PRIOR_STRENGTH,
): number {
  return (engagements + priorStrength * cityRate) / (impressions + priorStrength)
}

// Exponential time decay toward 0. `ageDays` old, halving every `halflifeDays`.
export function decay(value: number, ageDays: number, halflifeDays: number): number {
  if (halflifeDays <= 0 || ageDays <= 0) return value
  return value * Math.pow(0.5, ageDays / halflifeDays)
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

// --- Deriving which affinities a signal touches -----------------------------

// The minimal event facts needed to turn one interaction into affinity updates.
export type EventSignalContext = {
  categorySlugs: string[]
  venueNorm: string | null
  isFree: boolean
  startTime: string // ISO
}

export type AffinityKey = { kind: string; value: string }

// Local day-of-week (0=Sun … 6=Sat) of an event's start, used as the 'dow'
// affinity value. Uses the runtime's local zone — good enough for a coarse
// "which nights this person goes out" signal.
export function dayOfWeekKey(startTimeIso: string): string {
  const d = new Date(startTimeIso)
  return Number.isNaN(d.getTime()) ? 'unknown' : String(d.getDay())
}

// Which (kind, value) affinities a signal on this event should nudge: one per
// category, the venue, the day-of-week, and — for free events — the free-price
// preference. The caller applies the signal's magnitude to each.
export function affinityKeysForEvent(ctx: EventSignalContext): AffinityKey[] {
  const keys: AffinityKey[] = []
  for (const slug of ctx.categorySlugs) keys.push({ kind: 'category', value: slug })
  if (ctx.venueNorm) keys.push({ kind: 'venue', value: ctx.venueNorm })
  keys.push({ kind: 'dow', value: dayOfWeekKey(ctx.startTime) })
  // Only free events reinforce the free-price preference; a paid engagement
  // simply doesn't touch it (rather than falsely implying "dislikes free").
  if (ctx.isFree) keys.push({ kind: 'price', value: 'free_only' })
  return keys
}
