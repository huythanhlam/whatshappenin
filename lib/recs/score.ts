// Recommendation engine — the ranking model's scoring + re-ranking (pure).
//
// This is where the model actually ranks. Given an actor's affinities/taste
// vector and a set of candidate events, it builds each candidate's feature
// vector, scores it as the dot product with the active model's weights (logistic
// regression — ranking needs the linear score, not the sigmoid), then applies a
// diversity cap and reserves a few exploration slots. All pure and DB-free so it
// unit-tests without a database; lib/db/index.ts feeds it rows and persists the
// resulting impressions.

import type { ModelWeights } from './config'
import { dayOfWeekKey } from './affinity'
import { cosine } from './embed'
import { NEUTRAL_PROMINENCE } from './prominence'
import {
  DEFAULT_CITY_ENGAGEMENT_RATE,
  TRENDING_HALFLIFE_DAYS,
  TRENDING_PROMINENCE_WEIGHT,
  TRENDING_VELOCITY_WEIGHT,
  TRENDING_MARQUEE_INSERT_AT,
  TRENDING_MARQUEE_MIN_PROMINENCE,
} from './config'

// The feature vector. Keys match ModelWeights (minus bias). Kept as a plain
// object so an impression can log exactly what was scored.
export type FeatureVector = {
  category_affinity: number
  venue_affinity: number
  neighborhood_affinity: number
  price_fit: number
  dow_affinity: number
  engagement_prior: number
  embedding_sim: number
  proximity: number
  seen_count: number
  // World-popularity, independent of our own traffic. See lib/recs/prominence.ts
  // and migration 046 for why these are separate from engagement_prior.
  prominence: number
  velocity: number
}

export const FEATURE_KEYS: (keyof FeatureVector)[] = [
  'category_affinity',
  'venue_affinity',
  'neighborhood_affinity',
  'price_fit',
  'dow_affinity',
  'engagement_prior',
  'embedding_sim',
  'proximity',
  'seen_count',
  'prominence',
  'velocity',
]

// A candidate event reduced to what scoring needs. lib/db builds these from SQL.
export type Candidate = {
  id: string
  categorySlugs: string[]
  // Normalized title, the series key. Two rows sharing it at the same venue are
  // different DATES of one run, not different events. Null on rows predating the
  // column, which collapseSeries treats as its own series (never grouped).
  titleNorm: string | null
  venueNorm: string | null
  neighborhood: string | null
  isFree: boolean
  startTime: string // ISO
  engagementScore: number | null // event_engagement.score, null if never scored
  embedding: number[] | null
  seenCount: number // prior views of this event by the actor
  // events.prominence / events.velocity. Null on a database below the legacy
  // migration ceiling, where the columns don't exist yet (see migration 046).
  prominence: number | null
  velocity: number | null
}

// An actor's affinities as a flat map keyed "kind:value" → score, plus their
// taste vector (null when they have none yet).
export type ActorTaste = {
  affinity: Map<string, number>
  vector: number[] | null
}

export type ScoredCandidate = {
  id: string
  score: number
  features: FeatureVector
  explored: boolean
}

// A scored candidate that made the final list, with its shown rank (0-based).
export type RankedImpression = ScoredCandidate & { position: number }

function aff(map: Map<string, number>, kind: string, value: string | null): number {
  if (!value) return 0
  return map.get(`${kind}:${value}`) ?? 0
}

// Build one candidate's feature vector against an actor's taste. `nowMs` is
// passed in (not read from the clock) so scoring is deterministic and testable.
export function computeFeatures(c: Candidate, taste: ActorTaste, nowMs: number): FeatureVector {
  const categoryAffinity = c.categorySlugs.length
    ? Math.max(...c.categorySlugs.map(s => aff(taste.affinity, 'category', s)))
    : 0

  const startMs = new Date(c.startTime).getTime()
  const daysUntil = Number.isNaN(startMs) ? 0 : Math.max(0, (startMs - nowMs) / 86_400_000)

  return {
    category_affinity: categoryAffinity,
    venue_affinity: aff(taste.affinity, 'venue', c.venueNorm),
    neighborhood_affinity: aff(taste.affinity, 'neighborhood', c.neighborhood),
    // Only free events read the free-price preference; paid events are neutral.
    price_fit: c.isFree ? aff(taste.affinity, 'price', 'free_only') : 0,
    dow_affinity: aff(taste.affinity, 'dow', dayOfWeekKey(c.startTime)),
    engagement_prior: c.engagementScore ?? DEFAULT_CITY_ENGAGEMENT_RATE,
    embedding_sim: cosine(taste.vector, c.embedding),
    proximity: 1 / (1 + daysUntil),
    seen_count: c.seenCount,
    prominence: c.prominence ?? NEUTRAL_PROMINENCE,
    velocity: c.velocity ?? 0,
  }
}

// The model score: bias + Σ wᵢ·featureᵢ. Linear (pre-sigmoid) — monotonic in the
// engagement probability, which is all ranking needs.
//
// A weight the active model version doesn't carry counts as 0, not NaN. Feature
// keys are added in code and reach the database one migration later (and never
// at all on a legacy-ceiling dev database), so serving has to tolerate a model
// row that predates a feature — it simply ignores the column until a model
// trained with it is promoted.
export function scoreFeatures(features: FeatureVector, weights: ModelWeights): number {
  let s = weights.bias
  for (const k of FEATURE_KEYS) s += (weights[k] ?? 0) * features[k]
  return s
}

// The trending surface's ranking, which is deliberately NOT the model above.
//
// The model ranks by predicted engagement *for a given actor*; run with an empty
// taste it degenerates into "whatever our existing users already clicked", which
// is the closed loop this whole feature exists to escape. Trending instead ranks
// on world-popularity and its rate of change, decayed toward the near future, so
// a marquee show that nobody on the platform has touched yet can still lead the
// rail on the day it's announced.
export function trendingScore(c: Candidate, nowMs: number): number {
  const startMs = new Date(c.startTime).getTime()
  const daysUntil = Number.isNaN(startMs) ? 0 : Math.max(0, (startMs - nowMs) / 86_400_000)
  const recency = Math.pow(0.5, daysUntil / TRENDING_HALFLIFE_DAYS)

  const popularity =
    TRENDING_PROMINENCE_WEIGHT * (c.prominence ?? NEUTRAL_PROMINENCE) +
    TRENDING_VELOCITY_WEIGHT * (c.velocity ?? 0)

  return popularity * recency
}

export type RankOptions = {
  weights: ModelWeights
  nowMs: number
  limit: number
  exploreSlots?: number // slots reserved for exploration (default 2)
  categoryCap?: number // max events sharing a top category (default 3)
  venueCap?: number // max events sharing a venue (default 2)
  // Collapse a multi-date run to its soonest showing (default true). See
  // collapseSeries.
  collapseSeries?: boolean
  // Slots held for the biggest events regardless of date (default 0). Only
  // meaningful alongside `trending`.
  marqueeSlots?: number
  // Rank by trendingScore instead of the model. The feature vector is still
  // computed and logged, so trending impressions remain usable training data —
  // only the ordering differs.
  trending?: boolean
}

// Collapse a multi-date run to a single entry.
//
// A month-long exhibition or a theatre run is stored as one event PER DATE, and
// that is correct — each date is a real, separately-attendable event, so dedup
// rightly refuses to merge them. But a rail is a list of things to do, not a
// calendar: showing "The Art of Banksy" at slots 4 and 9 burns a slot and reads
// as a bug. Observed in production: 195 upcoming Austin events belong to just 46
// such series, and three of the first twenty rail slots were repeats.
//
// The kept date is the soonest, not the highest-scoring — within a series every
// date scores near-identically, and the one a user can act on first is the
// useful one. Candidates arrive ranked, so this preserves that order.
function collapseSeries(candidates: Candidate[]): Candidate[] {
  const soonestBySeries = new Map<string, Candidate>()
  const out: Candidate[] = []

  for (const c of candidates) {
    // A null title_norm can't be grouped safely — it would collapse every such
    // row into one bucket — so those pass through untouched.
    if (!c.titleNorm) {
      out.push(c)
      continue
    }
    const key = `${c.titleNorm}|${c.venueNorm ?? ''}`
    const held = soonestBySeries.get(key)
    if (!held) {
      soonestBySeries.set(key, c)
      out.push(c)
    } else if (new Date(c.startTime).getTime() < new Date(held.startTime).getTime()) {
      // A sooner date turned up later in the list: swap it into the held slot so
      // the series keeps its original ranking position.
      out[out.indexOf(held)] = c
      soonestBySeries.set(key, c)
    }
  }
  return out
}

// Greedy diversity pick: walk candidates best-first, taking one while its top
// category and venue are under their caps; overflow is kept to backfill if the
// caps leave us short of `limit`.
function diversityPick(
  ranked: ScoredCandidate[],
  byId: Map<string, Candidate>,
  limit: number,
  categoryCap: number,
  venueCap: number,
): ScoredCandidate[] {
  const chosen: ScoredCandidate[] = []
  const overflow: ScoredCandidate[] = []
  const catCount = new Map<string, number>()
  const venueCount = new Map<string, number>()

  for (const sc of ranked) {
    if (chosen.length >= limit) break
    const cand = byId.get(sc.id)!
    const topCat = cand.categorySlugs[0] ?? 'other'
    const venue = cand.venueNorm ?? ''
    const cc = catCount.get(topCat) ?? 0
    const vc = venue ? venueCount.get(venue) ?? 0 : 0
    if (cc < categoryCap && vc < venueCap) {
      chosen.push(sc)
      catCount.set(topCat, cc + 1)
      if (venue) venueCount.set(venue, vc + 1)
    } else {
      overflow.push(sc)
    }
  }
  // Backfill from overflow (still best-first) if diversity caps left room.
  for (const sc of overflow) {
    if (chosen.length >= limit) break
    chosen.push(sc)
  }
  return chosen
}

// Rank a candidate set into the final ordered list of size ≤ limit.
// Exploitation fills all but `exploreSlots`; those remaining slots go to
// exploration picks — the lowest-exposure candidates not already chosen — so the
// model keeps getting fresh data and new events earn a look. Explored items are
// flagged so training can account for their non-organic exposure.
export function rankCandidates(candidates: Candidate[], taste: ActorTaste, opts: RankOptions): RankedImpression[] {
  const { weights, nowMs, limit } = opts
  const exploreSlots = Math.min(opts.exploreSlots ?? 2, Math.max(0, limit))
  const marqueeSlots = Math.min(opts.marqueeSlots ?? 0, Math.max(0, limit))
  const categoryCap = opts.categoryCap ?? 3
  const venueCap = opts.venueCap ?? 2

  // Collapse runs BEFORE scoring, so a series consumes one candidate slot rather
  // than crowding the diversity caps with copies of itself.
  const pool = opts.collapseSeries === false ? candidates : collapseSeries(candidates)

  const byId = new Map(pool.map(c => [c.id, c]))
  const scored: ScoredCandidate[] = pool.map(c => {
    const features = computeFeatures(c, taste, nowMs)
    const score = opts.trending ? trendingScore(c, nowMs) : scoreFeatures(features, weights)
    return { id: c.id, features, score, explored: false }
  })
  scored.sort((a, b) => b.score - a.score)

  // Reserve the marquee block first, so exploitation fills around it rather than
  // being trimmed after the fact.
  const marquee = pickMarquee(scored, byId, marqueeSlots)
  const marqueeIds = new Set(marquee.map(s => s.id))

  const exploitTarget = Math.max(0, limit - exploreSlots - marquee.length)
  const exploited = diversityPick(
    scored.filter(s => !marqueeIds.has(s.id)),
    byId, exploitTarget, categoryCap, venueCap
  )

  if (exploited.length + marquee.length >= limit) {
    return spliceMarquee(exploited, marquee).slice(0, limit).map(withPosition)
  }

  // Exploration: from what's left, prefer the least-exposed events (lowest prior
  // engagement score → newest/least-shown), so exploration probes the unknown.
  const chosenIds = new Set([...exploited.map(s => s.id), ...marqueeIds])
  const remaining = scored
    .filter(s => !chosenIds.has(s.id))
    .sort((a, b) => (byId.get(a.id)!.engagementScore ?? 0) - (byId.get(b.id)!.engagementScore ?? 0))

  const explore = remaining
    .slice(0, limit - exploited.length - marquee.length)
    .map(s => ({ ...s, explored: true }))
  return [...spliceMarquee(exploited, marquee), ...explore].map(withPosition)
}

// The biggest events in town, by raw prominence, ignoring how far off they are.
//
// This is the half of the trending rail that recency decay structurally cannot
// deliver (see TRENDING_MARQUEE_SLOTS). Picks are capped by prominence floor —
// a reserved slot is only worth spending on something genuinely big, and when
// nothing qualifies the slots simply go back to normal ranking.
//
// One pick per title: without that, three dates of the same stadium act at
// different venues would take the whole block (collapseSeries only merges same
// title AND venue, since a tour playing two rooms is two real events).
//
// One pick per category, too. The block bypasses diversityPick, and the highest-
// prominence events in a city are almost always concerts — measured on the live
// Austin catalog, an uncapped block took the rail from 25% to 40% music, making
// the music over-indexing that prominence already has materially worse. Capping
// at one per category means the block surfaces the biggest MUSIC event, the
// biggest SPORTS event, and so on, which is both more diverse and more useful
// than the top three rows of the same list.
function pickMarquee(
  scored: ScoredCandidate[],
  byId: Map<string, Candidate>,
  slots: number
): ScoredCandidate[] {
  if (slots <= 0) return []

  const byProminence = scored
    .filter(s => (byId.get(s.id)!.prominence ?? 0) >= TRENDING_MARQUEE_MIN_PROMINENCE)
    .sort((a, b) => (byId.get(b.id)!.prominence ?? 0) - (byId.get(a.id)!.prominence ?? 0))

  const picked: ScoredCandidate[] = []
  const seenTitles = new Set<string>()
  const seenCategories = new Set<string>()
  for (const s of byProminence) {
    if (picked.length >= slots) break
    const cand = byId.get(s.id)!
    const title = cand.titleNorm
    const category = cand.categorySlugs[0] ?? 'other'
    if (title && seenTitles.has(title)) continue
    if (seenCategories.has(category)) continue
    if (title) seenTitles.add(title)
    seenCategories.add(category)
    picked.push(s)
  }
  return picked
}

// Interleave the reserved block into the ranked list at TRENDING_MARQUEE_INSERT_AT.
// Not at the very top — whatever is hottest right now should still lead — but
// high enough that the block is seen rather than buried near the fold.
function spliceMarquee(ranked: ScoredCandidate[], marquee: ScoredCandidate[]): ScoredCandidate[] {
  if (marquee.length === 0) return ranked
  const at = Math.min(TRENDING_MARQUEE_INSERT_AT, ranked.length)
  return [...ranked.slice(0, at), ...marquee, ...ranked.slice(at)]
}

// Positions are assigned after final ordering; carried on the scored object for
// the impression log (position-bias correction at training time needs them).
function withPosition(sc: ScoredCandidate, i: number): RankedImpression {
  return { ...sc, position: i }
}
