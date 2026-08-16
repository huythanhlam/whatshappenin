import { describe, it, expect } from 'vitest'
import {
  computeVelocity,
  engagementVelocity,
  demandVelocity,
  RECENT_WINDOW_DAYS,
  BASELINE_WINDOW_DAYS,
} from './velocity'

describe('engagementVelocity', () => {
  it('scores a flat event at zero', () => {
    // Same rate in both windows — popular, perhaps, but not trending.
    const perDay = 4
    expect(
      engagementVelocity(perDay * RECENT_WINDOW_DAYS, perDay * BASELINE_WINDOW_DAYS)
    ).toBe(0)
  })

  it('scores a cooling event at zero rather than negative', () => {
    expect(engagementVelocity(1, 200)).toBe(0)
  })

  it('rises with the size of the lift', () => {
    const double = engagementVelocity(2 * RECENT_WINDOW_DAYS, 1 * BASELINE_WINDOW_DAYS)
    const quadruple = engagementVelocity(4 * RECENT_WINDOW_DAYS, 1 * BASELINE_WINDOW_DAYS)
    expect(quadruple).toBeGreaterThan(double)
    expect(double).toBeGreaterThan(0)
  })

  it('normalizes against the event itself, not against other events', () => {
    // A small event that tripled outranks a huge event that grew 10%. Without
    // per-event normalization the big event would always win and the rail would
    // just be a popularity list again.
    const smallTripled = engagementVelocity(3 * RECENT_WINDOW_DAYS, 1 * BASELINE_WINDOW_DAYS)
    const bigNudged = engagementVelocity(110 * RECENT_WINDOW_DAYS, 100 * BASELINE_WINDOW_DAYS)
    expect(smallTripled).toBeGreaterThan(bigNudged)
  })

  it('does not let a 0-to-2 jump pin the rail', () => {
    // Additive smoothing: technically an infinite lift, but on two data points.
    expect(engagementVelocity(2, 0)).toBeLessThan(0.7)
  })

  it('stays within [0,1] at extreme lift', () => {
    const v = engagementVelocity(100_000, 0)
    expect(v).toBeLessThanOrEqual(1)
    expect(v).toBeGreaterThan(0.9)
  })
})

describe('demandVelocity', () => {
  it('is zero when there is no observation or supply is growing', () => {
    expect(demandVelocity(null)).toBe(0)
    expect(demandVelocity(undefined)).toBe(0)
    expect(demandVelocity(-0.3)).toBe(0)
  })

  it('saturates at a fast sellout', () => {
    expect(demandVelocity(0.05)).toBeCloseTo(0.25)
    expect(demandVelocity(0.5)).toBe(1)
  })
})

describe('computeVelocity', () => {
  it('takes the louder of the two channels', () => {
    // An event with no ticketing footprint must not be halved for the silence.
    const engagementOnly = computeVelocity({
      recentCount: 4 * RECENT_WINDOW_DAYS,
      baselineCount: 1 * BASELINE_WINDOW_DAYS,
      demandDropPerDay: null,
    })
    const bothChannels = computeVelocity({
      recentCount: 4 * RECENT_WINDOW_DAYS,
      baselineCount: 1 * BASELINE_WINDOW_DAYS,
      demandDropPerDay: 0.01,
    })
    expect(bothChannels).toBe(engagementOnly)
  })

  it('surfaces a sellout that our own users have not reacted to yet', () => {
    // The signal we can't get from first-party data at all.
    const v = computeVelocity({ recentCount: 0, baselineCount: 0, demandDropPerDay: 0.15 })
    expect(v).toBeGreaterThan(0.7)
  })

  it('is zero for a genuinely quiet event', () => {
    expect(computeVelocity({ recentCount: 0, baselineCount: 0 })).toBe(0)
  })
})
