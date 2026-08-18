import { describe, it, expect } from 'vitest'
import {
  computeFeatures,
  scoreFeatures,
  rankCandidates,
  trendingScore,
  type Candidate,
  type ActorTaste,
} from './score'
import { V1_MODEL_WEIGHTS, V2_MODEL_WEIGHTS } from './config'

const NOW = new Date('2026-07-17T12:00:00Z').getTime()

function cand(id: string, over: Partial<Candidate> = {}): Candidate {
  return {
    id,
    categorySlugs: ['music'],
    titleNorm: `title-${id}`,
    venueNorm: `venue-${id}`,
    neighborhood: null,
    isFree: false,
    startTime: '2026-07-18T20:00:00Z',
    engagementScore: 0.1,
    embedding: null,
    seenCount: 0,
    prominence: null,
    velocity: null,
    ...over,
  }
}

function taste(entries: [string, number][] = [], vector: number[] | null = null): ActorTaste {
  return { affinity: new Map(entries), vector }
}

describe('computeFeatures', () => {
  it('takes the max category affinity across an event’s categories', () => {
    const f = computeFeatures(
      cand('a', { categorySlugs: ['music', 'arts'] }),
      taste([['category:arts', 0.9], ['category:music', 0.2]]),
      NOW,
    )
    expect(f.category_affinity).toBe(0.9)
  })

  it('reads free-price preference only for free events', () => {
    const t = taste([['price:free_only', 0.8]])
    expect(computeFeatures(cand('a', { isFree: true }), t, NOW).price_fit).toBe(0.8)
    expect(computeFeatures(cand('a', { isFree: false }), t, NOW).price_fit).toBe(0)
  })

  it('falls back to the city-average engagement prior when unscored', () => {
    expect(computeFeatures(cand('a', { engagementScore: null }), taste(), NOW).engagement_prior).toBeGreaterThan(0)
  })

  it('decreases proximity as the event gets further out', () => {
    const soon = computeFeatures(cand('a', { startTime: '2026-07-17T18:00:00Z' }), taste(), NOW).proximity
    const later = computeFeatures(cand('a', { startTime: '2026-07-30T18:00:00Z' }), taste(), NOW).proximity
    expect(soon).toBeGreaterThan(later)
  })

  it('uses cosine similarity for the embedding feature', () => {
    const f = computeFeatures(cand('a', { embedding: [1, 0] }), taste([], [1, 0]), NOW)
    expect(f.embedding_sim).toBeCloseTo(1)
  })
})

describe('scoreFeatures', () => {
  it('a strong category-affinity event outscores a neutral one', () => {
    const loved = computeFeatures(cand('a'), taste([['category:music', 1]]), NOW)
    const neutral = computeFeatures(cand('b'), taste(), NOW)
    expect(scoreFeatures(loved, V1_MODEL_WEIGHTS)).toBeGreaterThan(scoreFeatures(neutral, V1_MODEL_WEIGHTS))
  })
})

describe('rankCandidates', () => {
  it('ranks an affinity-matching event first (exploitation)', () => {
    const cands = [
      cand('cold', { categorySlugs: ['sports'], venueNorm: 'v1' }),
      cand('warm', { categorySlugs: ['music'], venueNorm: 'v2' }),
    ]
    const ranked = rankCandidates(cands, taste([['category:music', 1]]), {
      weights: V1_MODEL_WEIGHTS,
      nowMs: NOW,
      limit: 2,
      exploreSlots: 0,
    })
    expect(ranked[0].id).toBe('warm')
    expect(ranked.map(r => r.position)).toEqual([0, 1])
  })

  it('caps how many events share a top category (diversity)', () => {
    // Six music events all with strong affinity; cap should hold to 3 in the top.
    const cands = Array.from({ length: 6 }, (_, i) => cand(`m${i}`, { categorySlugs: ['music'], venueNorm: `v${i}` }))
    // Plus a couple of other-category events to fill.
    cands.push(cand('c1', { categorySlugs: ['comedy'], venueNorm: 'vc1' }))
    cands.push(cand('a1', { categorySlugs: ['arts'], venueNorm: 'va1' }))
    const ranked = rankCandidates(cands, taste([['category:music', 1]]), {
      weights: V1_MODEL_WEIGHTS,
      nowMs: NOW,
      limit: 5,
      exploreSlots: 0,
      categoryCap: 3,
    })
    const musicInTop = ranked.filter(r => cands.find(c => c.id === r.id)!.categorySlugs[0] === 'music').length
    expect(musicInTop).toBeLessThanOrEqual(3)
    expect(ranked).toHaveLength(5)
  })

  it('reserves exploration slots flagged as explored', () => {
    const cands = Array.from({ length: 10 }, (_, i) =>
      cand(`e${i}`, { categorySlugs: ['music'], venueNorm: `v${i}`, engagementScore: i === 9 ? 0.001 : 0.5 }),
    )
    const ranked = rankCandidates(cands, taste([['category:music', 1]]), {
      weights: V1_MODEL_WEIGHTS,
      nowMs: NOW,
      limit: 5,
      exploreSlots: 2,
      categoryCap: 99,
      venueCap: 99,
    })
    expect(ranked.filter(r => r.explored)).toHaveLength(2)
    // The least-exposed candidate should be among the exploration picks.
    expect(ranked.some(r => r.id === 'e9' && r.explored)).toBe(true)
  })

  it('never returns more than the limit and positions are contiguous', () => {
    const cands = Array.from({ length: 30 }, (_, i) => cand(`x${i}`, { venueNorm: `v${i}` }))
    const ranked = rankCandidates(cands, taste(), { weights: V1_MODEL_WEIGHTS, nowMs: NOW, limit: 12 })
    expect(ranked).toHaveLength(12)
    expect(ranked.map(r => r.position)).toEqual([...Array(12).keys()])
  })
})

describe('scoreFeatures with a model that predates a feature', () => {
  it('treats a missing weight as zero rather than producing NaN', () => {
    // V1 carries no prominence/velocity weights — the state of every database
    // stuck at the legacy migration ceiling. Serving must still rank.
    const features = computeFeatures(cand('a', { prominence: 0.9, velocity: 0.7 }), taste(), NOW)
    expect(Number.isFinite(scoreFeatures(features, V1_MODEL_WEIGHTS))).toBe(true)
  })

  it('scores prominence identically under v1 regardless of its value', () => {
    const high = computeFeatures(cand('a', { prominence: 0.9 }), taste(), NOW)
    const low = computeFeatures(cand('b', { prominence: 0.0 }), taste(), NOW)
    expect(scoreFeatures(high, V1_MODEL_WEIGHTS)).toBe(scoreFeatures(low, V1_MODEL_WEIGHTS))
    // ...but v2, which carries the weight, must separate them.
    expect(scoreFeatures(high, V2_MODEL_WEIGHTS)).toBeGreaterThan(scoreFeatures(low, V2_MODEL_WEIGHTS))
  })
})

describe('trendingScore', () => {
  const soon = new Date(NOW + 2 * 86_400_000).toISOString()
  const far = new Date(NOW + 40 * 86_400_000).toISOString()

  it('ranks a prominent event above an obscure one at the same date', () => {
    const big = trendingScore(cand('a', { startTime: soon, prominence: 0.9 }), NOW)
    const small = trendingScore(cand('b', { startTime: soon, prominence: 0.05 }), NOW)
    expect(big).toBeGreaterThan(small)
  })

  it('weighs a rising event above a merely famous one', () => {
    // The whole point of a trending rail: movement beats a standing reputation.
    const rising = trendingScore(cand('a', { startTime: soon, prominence: 0.4, velocity: 0.9 }), NOW)
    const famous = trendingScore(cand('b', { startTime: soon, prominence: 0.9, velocity: 0.0 }), NOW)
    expect(rising).toBeGreaterThan(famous)
  })

  it('decays a distant event below an equally popular near one', () => {
    const near = trendingScore(cand('a', { startTime: soon, prominence: 0.8 }), NOW)
    const distant = trendingScore(cand('b', { startTime: far, prominence: 0.8 }), NOW)
    expect(near).toBeGreaterThan(distant)
  })

  it('treats missing columns as neutral prominence, not zero', () => {
    // On a legacy-ceiling database every candidate has null prominence; they
    // must tie on popularity and be separated only by date, not all score 0.
    const a = trendingScore(cand('a', { startTime: soon }), NOW)
    const b = trendingScore(cand('b', { startTime: soon }), NOW)
    expect(a).toBe(b)
    expect(a).toBeGreaterThan(0)
  })

  it('surfaces a marquee event that has zero first-party engagement', () => {
    // The cold-start case this feature exists for: nobody has clicked the arena
    // show, everyone has clicked the recurring trivia night.
    const arena = cand('arena', { startTime: soon, prominence: 0.95, engagementScore: 0 })
    const regular = cand('regular', { startTime: soon, prominence: 0.1, engagementScore: 0.8 })
    const ranked = rankCandidates([regular, arena], taste(), {
      weights: V2_MODEL_WEIGHTS,
      nowMs: NOW,
      limit: 2,
      exploreSlots: 0,
      trending: true,
    })
    expect(ranked[0].id).toBe('arena')
  })
})

describe('multi-date run collapse', () => {
  // A month-long exhibition is stored as one event per date — correctly, since
  // each date is separately attendable — but a rail must show it once.
  function run(id: string, day: number): Candidate {
    return cand(id, {
      titleNorm: 'the art of banksy without limits',
      venueNorm: 'fair market',
      startTime: new Date(NOW + day * 86_400_000).toISOString(),
      categorySlugs: ['arts'],
    })
  }

  it('shows a multi-date run once', () => {
    const ranked = rankCandidates([run('d1', 1), run('d2', 2), run('d3', 3)], taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 10, exploreSlots: 0,
    })
    expect(ranked).toHaveLength(1)
  })

  it('keeps the soonest date, whatever order they arrive in', () => {
    const ranked = rankCandidates([run('late', 9), run('early', 1), run('mid', 4)], taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 10, exploreSlots: 0,
    })
    expect(ranked.map(r => r.id)).toEqual(['early'])
  })

  it('frees the slots for other events', () => {
    const cands = [run('d1', 1), run('d2', 2), run('d3', 3), run('d4', 4),
      cand('other1', { categorySlugs: ['comedy'] }), cand('other2', { categorySlugs: ['sports'] })]
    const ranked = rankCandidates(cands, taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 3, exploreSlots: 0,
    })
    expect(ranked).toHaveLength(3)
    expect(new Set(ranked.map(r => r.id)).size).toBe(3)
    expect(ranked.filter(r => r.id.startsWith('d')).length).toBe(1)
  })

  it('does not merge the same title at a different venue', () => {
    // A touring show playing two rooms is two real, separately-attendable events.
    const a = cand('a', { titleNorm: 'come from away', venueNorm: 'zach theatre' })
    const b = cand('b', { titleNorm: 'come from away', venueNorm: 'bass concert hall' })
    const ranked = rankCandidates([a, b], taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 10, exploreSlots: 0, venueCap: 9,
    })
    expect(ranked).toHaveLength(2)
  })

  it('never groups rows with a null title_norm together', () => {
    // Null is "unknown", not a shared key — grouping on it would collapse every
    // un-normalized event in the catalog into a single rail entry.
    const cands = [
      cand('n1', { titleNorm: null, venueNorm: null }),
      cand('n2', { titleNorm: null, venueNorm: null }),
      cand('n3', { titleNorm: null, venueNorm: null }),
    ]
    const ranked = rankCandidates(cands, taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 10, exploreSlots: 0, venueCap: 9,
    })
    expect(ranked).toHaveLength(3)
  })

  it('can be turned off', () => {
    const ranked = rankCandidates([run('d1', 1), run('d2', 2)], taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 10, exploreSlots: 0,
      collapseSeries: false, venueCap: 9,
    })
    expect(ranked).toHaveLength(2)
  })
})

describe('marquee slots', () => {
  const soon = new Date(NOW + 2 * 86_400_000).toISOString()
  const distant = new Date(NOW + 29 * 86_400_000).toISOString()

  // The case that motivated this: a stadium show a month out cannot win on
  // trendingScore at any half-life short enough to keep the rail about now.
  const stadium = () => cand('stadium', {
    startTime: distant, prominence: 0.89, titleNorm: 'j cole', venueNorm: 'moody center atx',
  })
  const filler = (i: number) => cand(`f${i}`, {
    startTime: soon, prominence: 0.2, titleNorm: `f${i}`, venueNorm: `v${i}`,
    categorySlugs: [['music', 'arts', 'comedy', 'sports'][i % 4]],
  })

  it('surfaces a distant giant that trendingScore alone would bury', () => {
    const cands = [stadium(), ...Array.from({ length: 12 }, (_, i) => filler(i))]
    const without = rankCandidates(cands, taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 6, exploreSlots: 0, trending: true,
    })
    const withMarquee = rankCandidates(cands, taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 6, exploreSlots: 0, trending: true,
      marqueeSlots: 3,
    })
    expect(without.map(r => r.id)).not.toContain('stadium')
    expect(withMarquee.map(r => r.id)).toContain('stadium')
  })

  it('does not let the block lead — the hottest current event still ranks first', () => {
    const cands = [stadium(), ...Array.from({ length: 12 }, (_, i) => filler(i))]
    const ranked = rankCandidates(cands, taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 8, exploreSlots: 0, trending: true,
      marqueeSlots: 3,
    })
    expect(ranked[0].id).not.toBe('stadium')
    expect(ranked.findIndex(r => r.id === 'stadium')).toBeLessThan(5)
  })

  it('leaves the slots unused when nothing clears the prominence floor', () => {
    // A quiet catalog must not get an arbitrary "marquee" section of mediocre
    // events — the slots go back to normal ranking.
    const cands = Array.from({ length: 8 }, (_, i) => filler(i))
    const ranked = rankCandidates(cands, taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 5, exploreSlots: 0, trending: true,
      marqueeSlots: 3,
    })
    expect(ranked).toHaveLength(5)
    expect(new Set(ranked.map(r => r.id)).size).toBe(5)
  })

  it('never spends the whole block on one act playing several rooms', () => {
    // collapseSeries only merges same title AND venue, so a tour would otherwise
    // take every reserved slot.
    const tour = (i: number) => cand(`t${i}`, {
      startTime: distant, prominence: 0.9, titleNorm: 'j cole', venueNorm: `room-${i}`,
    })
    const cands = [tour(1), tour(2), tour(3), ...Array.from({ length: 8 }, (_, i) => filler(i))]
    const ranked = rankCandidates(cands, taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 8, exploreSlots: 0, trending: true,
      marqueeSlots: 3, venueCap: 9,
    })
    expect(ranked.filter(r => r.id.startsWith('t'))).toHaveLength(1)
  })

  it('returns no duplicates and respects the limit', () => {
    const cands = [stadium(), ...Array.from({ length: 20 }, (_, i) => filler(i))]
    const ranked = rankCandidates(cands, taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 10, exploreSlots: 2, trending: true,
      marqueeSlots: 3,
    })
    expect(ranked).toHaveLength(10)
    expect(new Set(ranked.map(r => r.id)).size).toBe(10)
    expect(ranked.map(r => r.position)).toEqual([...Array(10).keys()])
  })

  it('is off by default, so the personalized feed is unaffected', () => {
    const cands = [stadium(), ...Array.from({ length: 6 }, (_, i) => filler(i))]
    const ranked = rankCandidates(cands, taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 4, exploreSlots: 0,
    })
    expect(ranked).toHaveLength(4)
  })
})

describe('marquee diversity', () => {
  const distant = new Date(NOW + 29 * 86_400_000).toISOString()
  const big = (id: string, category: string, prom: number) =>
    cand(id, { startTime: distant, prominence: prom, titleNorm: id, venueNorm: id, categorySlugs: [category] })

  it('spends the block on one big event per category, not the top of one list', () => {
    // Uncapped, the three highest-prominence events in a city are almost always
    // all concerts — measured 25% -> 40% music on the live Austin rail.
    const cands = [
      big('m1', 'music', 0.90), big('m2', 'music', 0.88), big('m3', 'music', 0.86),
      big('s1', 'sports', 0.80), big('c1', 'comedy', 0.75),
      ...Array.from({ length: 10 }, (_, i) =>
        cand(`f${i}`, { prominence: 0.2, titleNorm: `f${i}`, venueNorm: `v${i}` })),
    ]
    const ranked = rankCandidates(cands, taste(), {
      weights: V2_MODEL_WEIGHTS, nowMs: NOW, limit: 12, exploreSlots: 0, trending: true,
      marqueeSlots: 3, venueCap: 9, categoryCap: 9,
    })
    const marqueeIds = ranked.slice(2, 5).map(r => r.id)
    expect(marqueeIds).toContain('m1')
    expect(marqueeIds).toContain('s1')
    expect(marqueeIds).toContain('c1')
    expect(marqueeIds).not.toContain('m2')
  })
})
