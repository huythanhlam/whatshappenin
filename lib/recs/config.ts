// Recommendation engine — tunable constants and the seeded model.
//
// One place for every magic number the recommender uses, so the DB layer, the
// API routes, and the (later) training job all agree. Nothing here reaches out
// to the database; it's pure configuration + the v1 prior weights.

// --- City gating ------------------------------------------------------------
// The feature launches Austin-only. Tracking, the For You rail, the survey, and
// the profile all no-op for any city not in this list; expansion is one entry.
export const RECS_CITIES = ['austin'] as const

export function isRecsCity(slug: string | null | undefined): boolean {
  return !!slug && (RECS_CITIES as readonly string[]).includes(slug)
}

// --- Interaction types ------------------------------------------------------
// The allowlist /api/track validates against. Adding a type here is all it takes
// for the beacon to accept it; the write-through logic keys off the sets below.
export const INTERACTION_TYPES = [
  'view',
  'clickout',
  'favorite',
  'unfavorite',
  'interested',
  'uninterested',
  'hide',
  'calendar_add',
  'share',
  'search',
  'digest_click',
  'attended',
] as const

export type InteractionType = (typeof INTERACTION_TYPES)[number]

export function isInteractionType(v: unknown): v is InteractionType {
  return typeof v === 'string' && (INTERACTION_TYPES as readonly string[]).includes(v)
}

// Positive engagement: the signals that count as "this person liked this event."
// They drive event_engagement (the trending prior) and are the training label
// for an impression.
export const POSITIVE_ENGAGEMENT_TYPES: ReadonlySet<InteractionType> = new Set([
  'favorite',
  'interested',
  'clickout',
  'calendar_add',
  'attended',
])

// A negative signal actively pushes an event/category down for that actor.
export const NEGATIVE_ENGAGEMENT_TYPES: ReadonlySet<InteractionType> = new Set([
  'hide',
  'unfavorite',
  'uninterested',
])

// Per-signal magnitude fed into the affinity EMA (§3 of RECOMMENDATIONS-SPEC).
// These size how hard one signal nudges a taste; how much each resulting feature
// then matters to the ranking is the model's job, not these numbers'.
export const SIGNAL_MAGNITUDE: Record<InteractionType, number> = {
  favorite: 4.0,
  interested: 2.5,
  clickout: 3.0,
  calendar_add: 3.0,
  attended: 4.0,
  share: 2.0,
  view: 1.0,
  digest_click: 2.0,
  search: 0.5,
  hide: -4.0,
  unfavorite: -2.0,
  uninterested: -2.5,
}

// --- Affinity math ----------------------------------------------------------
// EMA smoothing: score ← alpha*target + (1-alpha)*score. Higher alpha reacts
// faster but is noisier. A signal's magnitude maps to a target in [0,1] (or
// negative) before blending; see lib/recs/affinity.ts.
export const EMA_ALPHA = 0.3

// The magnitude that maps to a full-strength target of 1.0. A favorite (4.0)
// saturates; a view (1.0) is a quarter-strength nudge.
export const SIGNAL_SATURATION = 4.0

// Exponential time-decay half-life (days). Applied when the nightly batch ages
// stale affinities/engagement so tastes drift with recent behavior.
export const DECAY_HALFLIFE_DAYS = 45

// --- Event engagement prior -------------------------------------------------
// Bayesian smoothing strength: the prior counts as this many pseudo-impressions
// at the city-average rate, so a brand-new event starts at the average instead
// of a noisy 0/0, and needs real volume to move off it.
export const ENGAGEMENT_PRIOR_STRENGTH = 20

// Fallback city-average engagement rate before enough data exists to compute one.
export const DEFAULT_CITY_ENGAGEMENT_RATE = 0.1

// Score assigned to an affinity the user explicitly picks in the onboarding
// survey or profile. A survey pick is a strong, direct statement, so it's set
// straight to a high score rather than nudged up from 0 through the EMA (which
// would only reach ~0.3 on a first signal). This is what makes an event feed
// personalized the moment onboarding finishes, before any behavior accrues.
export const EXPLICIT_AFFINITY_SCORE = 0.8

// --- Serving ----------------------------------------------------------------
// Candidate window: only events starting within the next N days are eligible.
export const RECS_WINDOW_DAYS = 14
// Hard cap on candidates scored per request (keeps the in-TS scoring bounded).
export const RECS_CANDIDATE_CAP = 300
// Default rail/feed size and how many of those slots go to exploration.
export const RECS_DEFAULT_LIMIT = 20
export const RECS_EXPLORE_SLOTS = 2

// --- Editorial curation -----------------------------------------------------
// How much an appearance in each publication actually says about an event.
//
// This started as a boolean — "is this source editorial?" — and that was wrong
// in a way only production data showed. An editorial mention is evidence
// *because it is selective*: a curator picking 20 things out of a city's 1,500
// is making a strong statement, while a magazine's monthly calendar listing 240
// of them is barely making one. Scoring both as 1.0 meant the signal fired on
// ~22% of the upcoming Austin catalog, which is not a distinction at all — it
// flooded the middle of the trending rail with beginner yoga and paint nights
// whose ONLY evidence was "appeared in a listings calendar".
//
// Strength is therefore graded by measured selectivity — the share of the
// upcoming catalog each source lists (Austin, 2026-08-16, 1,557 events):
//
//   crawl:calendar-austinchronicle-com   Staff Picks, a hand-picked shortlist
//   crawl:austinmonthly-com              238 events, 15.3% — a full calendar
//   crawl:austin-culturemap-com          119 events,  7.6% — a full calendar
//
// Re-measure when adding a source: a broad listings feed that creeps in at full
// strength quietly degrades the whole rail. The query is a count of distinct
// upcoming events per `event_sources.source` over the city's catalog size.
export const EDITORIAL_STRENGTH: Readonly<Record<string, number>> = {
  // A genuine shortlist: an editor choosing a handful of things worth doing.
  'crawl:calendar-austinchronicle-com': 1.0,
  // Roundup calendars. Being listed is mildly positive — someone decided it was
  // worth typing up — but it is nothing like a pick, and these two alone cover
  // nearly a quarter of the catalog between them.
  'crawl:austin-culturemap-com': 0.3,
  'crawl:austinmonthly-com': 0.2,
}

// The strongest editorial claim any of an event's sources makes, in [0,1].
// 0 means no editorial source listed it, which prominence reads as no evidence
// rather than as negative evidence.
export function editorialStrength(sources: readonly string[]): number {
  let best = 0
  for (const s of sources) best = Math.max(best, EDITORIAL_STRENGTH[s] ?? 0)
  return best
}

// --- Trending ---------------------------------------------------------------
// The `mode=trending` surface doesn't run the personalization model (there is no
// taste to personalize against); it ranks on world-popularity alone. These size
// that blend. See trendingScore() in lib/recs/score.ts.
//
// Velocity outweighs prominence here — a big-name show that has been sitting on
// the calendar for three months is *popular*, but the thing rising this week is
// what "trending" is supposed to surface. Prominence keeps a real weight so the
// rail isn't empty of marquee events in a quiet week.
// How far ahead trending looks. Deliberately much wider than RECS_WINDOW_DAYS:
// the two surfaces answer different questions. The personalized feed answers
// "what should I do this week", so a fortnight is right. Trending answers
// "what's big right now", and arena shows go on sale MONTHS ahead — the moment a
// tour date drops is exactly when demand spikes and when a user most wants to
// hear about it. At 14 days the rail was blind to 66 of Austin's 83
// highest-prominence events, including every one above 0.75.
//
// This does not flood the rail with distant events: TRENDING_HALFLIFE_DAYS
// decay means something 60 days out keeps under 2% of its score, so it has to be
// genuinely enormous to outrank a decent event this week.
export const TRENDING_WINDOW_DAYS = 60

// Slots in the trending rail reserved for the biggest events in town regardless
// of how far off they are.
//
// Recency decay and raw scale can't be reconciled by one number: prominence has
// narrow dynamic range (Austin's biggest event scores ~1.4x a merely good one),
// while a 10-day half-life costs a factor of ~6 over a month. Any half-life
// short enough to keep the rail about *this week* buries a stadium show a month
// out; any half-life long enough to surface it stops the rail being about now.
//
// So the rail answers both questions explicitly instead of compromising: most
// slots rank by trendingScore as before, and a few are held for sheer scale.
// Same shape as RECS_EXPLORE_SLOTS.
export const TRENDING_MARQUEE_SLOTS = 3

// How many top-prominence events are pulled into the candidate set *in addition*
// to the ones the trending ordering selects.
//
// Without this the reserved slots are unreachable: RECS_CANDIDATE_CAP is applied
// in SQL using the decayed trending order, so a stadium show a month out — the
// exact thing the slots exist for — is cut before scoring ever runs. The
// candidate query therefore unions "top N by trending score" with "top M by raw
// prominence", so both halves of the rail can actually be filled.
export const TRENDING_MARQUEE_POOL = 50

// Where the reserved block lands. Not the very top — the hottest current event
// should still lead — but high enough to be seen rather than buried at slot 18.
export const TRENDING_MARQUEE_INSERT_AT = 2

// A reserved slot is only worth spending on a genuinely big event. Below this,
// the slots go unused and normal ranking fills them, so a quiet catalog doesn't
// get an arbitrary "marquee" section of mediocre events.
export const TRENDING_MARQUEE_MIN_PROMINENCE = 0.5

export const TRENDING_PROMINENCE_WEIGHT = 1.0
export const TRENDING_VELOCITY_WEIGHT = 1.6
// Recency half-life (days) applied to trending: of two equally popular events,
// the sooner one wins, and something six weeks out doesn't crowd out this
// weekend.
export const TRENDING_HALFLIFE_DAYS = 10

// --- The seeded model -------------------------------------------------------
// Prior weights for the logistic-regression scorer, mirroring the active
// `model_versions` row. `embedding_sim` is present but its feature isn't
// computed until the embedding column ships; the scorer treats an absent feature
// as 0.
export type ModelWeights = {
  bias: number
  category_affinity: number
  venue_affinity: number
  neighborhood_affinity: number
  price_fit: number
  dow_affinity: number
  engagement_prior: number
  embedding_sim: number
  proximity: number
  seen_count: number
  // Optional because a model row can predate a feature: code adds a feature key,
  // the matching model version lands one migration later, and a legacy-ceiling
  // dev database never gets it at all. scoreFeatures reads a missing weight as 0.
  prominence?: number
  velocity?: number
}

// v1 — the original seed, in supabase/migrations-legacy/031_ml.sql. Retired by
// migration 046 but still the ACTIVE row on any database that stops at the
// legacy ceiling (033), i.e. every PGlite dev instance. Kept here, and kept
// without the two new keys, precisely to document that skew: scoreFeatures
// treats a weight the active model doesn't carry as 0, so a v1 database ranks
// exactly as it did before this feature existed rather than scoring NaN.
export const V1_MODEL_WEIGHTS: ModelWeights = {
  bias: -2.0,
  category_affinity: 2.0,
  venue_affinity: 1.0,
  neighborhood_affinity: 0.8,
  price_fit: 0.5,
  dow_affinity: 0.3,
  engagement_prior: 1.5,
  embedding_sim: 1.2,
  proximity: 0.4,
  seen_count: -0.5,
}

// v2 — v1 plus the world-popularity features. MUST match the INSERT in
// supabase/migrations/046_prominence_velocity.sql.
export const V2_MODEL_WEIGHTS: ModelWeights = {
  ...V1_MODEL_WEIGHTS,
  prominence: 1.8,
  velocity: 0.9,
}
