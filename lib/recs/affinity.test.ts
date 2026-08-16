import { describe, it, expect } from 'vitest'
import {
  signalTarget,
  emaUpdate,
  applySignal,
  bayesianEngagementScore,
  decay,
  dayOfWeekKey,
  affinityKeysForEvent,
  priorRate,
  MIN_PRIOR_RATE,
  MAX_PRIOR_RATE,
} from './affinity'
import { SIGNAL_MAGNITUDE, DEFAULT_CITY_ENGAGEMENT_RATE } from './config'
import { NEUTRAL_PROMINENCE } from './prominence'

describe('priorRate', () => {
  it('reproduces the old flat city rate for an event with no evidence', () => {
    // The compatibility guarantee: prominence-unaware behaviour is unchanged.
    expect(priorRate(NEUTRAL_PROMINENCE)).toBeCloseTo(DEFAULT_CITY_ENGAGEMENT_RATE)
    expect(priorRate(null)).toBeCloseTo(DEFAULT_CITY_ENGAGEMENT_RATE)
    expect(priorRate(undefined)).toBeCloseTo(DEFAULT_CITY_ENGAGEMENT_RATE)
  })

  it('gives a prominent event a higher prior than an obscure one', () => {
    expect(priorRate(0.9)).toBeGreaterThan(priorRate(NEUTRAL_PROMINENCE))
    expect(priorRate(0.02)).toBeLessThan(priorRate(NEUTRAL_PROMINENCE))
  })

  it('clamps so real observations can always overcome the prior', () => {
    expect(priorRate(1)).toBeLessThanOrEqual(MAX_PRIOR_RATE)
    expect(priorRate(0)).toBeGreaterThanOrEqual(MIN_PRIOR_RATE)
  })

  it('starts a cold marquee event above a cold ordinary one', () => {
    // Both have zero impressions and zero engagements — the entire difference is
    // the prior, which is the whole point.
    const arena = bayesianEngagementScore(0, 0, priorRate(0.9))
    const openMic = bayesianEngagementScore(0, 0, priorRate(0.1))
    expect(arena).toBeGreaterThan(openMic)
  })
})

describe('signalTarget', () => {
  it('saturates a favorite to +1 and a hide to -1', () => {
    expect(signalTarget(SIGNAL_MAGNITUDE.favorite)).toBe(1)
    expect(signalTarget(SIGNAL_MAGNITUDE.hide)).toBe(-1)
  })

  it('scales a weaker signal below saturation', () => {
    expect(signalTarget(SIGNAL_MAGNITUDE.view)).toBeCloseTo(0.25) // 1.0 / 4.0
  })

  it('clamps beyond saturation', () => {
    expect(signalTarget(100)).toBe(1)
    expect(signalTarget(-100)).toBe(-1)
  })
})

describe('emaUpdate / applySignal', () => {
  it('a first signal moves a fresh (0) score partway toward the target', () => {
    expect(emaUpdate(0, 1, 0.3)).toBeCloseTo(0.3)
  })

  it('repeated favorites converge toward 1 without exceeding it', () => {
    let s = 0
    for (let i = 0; i < 50; i++) s = applySignal(s, SIGNAL_MAGNITUDE.favorite)
    expect(s).toBeGreaterThan(0.99)
    expect(s).toBeLessThanOrEqual(1)
  })

  it('a hide lowers a positive score, and repeated hides drive it negative', () => {
    const once = applySignal(0.5, SIGNAL_MAGNITUDE.hide)
    expect(once).toBeLessThan(0.5)
    let s = 0.5
    for (let i = 0; i < 5; i++) s = applySignal(s, SIGNAL_MAGNITUDE.hide)
    expect(s).toBeLessThan(0)
  })
})

describe('bayesianEngagementScore', () => {
  it('equals the city rate with no data', () => {
    expect(bayesianEngagementScore(0, 0, 0.1, 20)).toBeCloseTo(0.1)
  })

  it('a heavily-shown-but-ignored event sinks below the prior', () => {
    const ignored = bayesianEngagementScore(1, 500, 0.1, 20)
    expect(ignored).toBeLessThan(0.1)
  })

  it('a well-engaged event rises above the prior', () => {
    const loved = bayesianEngagementScore(80, 100, 0.1, 20)
    expect(loved).toBeGreaterThan(0.5)
  })

  it('needs volume to move: one click on a barely-shown event stays near the prior', () => {
    const noisy = bayesianEngagementScore(1, 1, 0.1, 20)
    expect(noisy).toBeLessThan(0.2)
  })
})

describe('decay', () => {
  it('halves at one half-life and is a no-op at age 0', () => {
    expect(decay(1, 45, 45)).toBeCloseTo(0.5)
    expect(decay(1, 0, 45)).toBe(1)
  })
})

describe('affinityKeysForEvent', () => {
  it('emits a key per category, the venue, the day-of-week, and free-price for free events', () => {
    const keys = affinityKeysForEvent({
      categorySlugs: ['music', 'arts'],
      venueNorm: 'mohawk',
      isFree: true,
      startTime: '2026-07-18T20:00:00Z', // context: coarse night-out signal
    })
    expect(keys).toContainEqual({ kind: 'category', value: 'music' })
    expect(keys).toContainEqual({ kind: 'category', value: 'arts' })
    expect(keys).toContainEqual({ kind: 'venue', value: 'mohawk' })
    expect(keys).toContainEqual({ kind: 'price', value: 'free_only' })
    expect(keys.some(k => k.kind === 'dow')).toBe(true)
  })

  it('omits the venue key when there is no venue and the price key for paid events', () => {
    const keys = affinityKeysForEvent({
      categorySlugs: ['comedy'],
      venueNorm: null,
      isFree: false,
      startTime: '2026-07-18T20:00:00Z',
    })
    expect(keys.some(k => k.kind === 'venue')).toBe(false)
    expect(keys.some(k => k.kind === 'price')).toBe(false)
  })
})

describe('dayOfWeekKey', () => {
  it('returns a 0-6 string for a valid date and unknown for garbage', () => {
    expect(dayOfWeekKey('2026-07-18T20:00:00Z')).toMatch(/^[0-6]$/)
    expect(dayOfWeekKey('not-a-date')).toBe('unknown')
  })
})
