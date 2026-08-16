import { describe, it, expect } from 'vitest'
import { VENUE_CAPACITY, capacityForVenue, capacityForVenueName } from './venue-capacity'
import { normalizeVenue } from '../normalize'

describe('VENUE_CAPACITY', () => {
  it('every key round-trips through normalizeVenue', () => {
    // The guard that matters. A hand-written key that doesn't match what
    // normalizeVenue actually produces is silently dead — no error, no match,
    // just a capacity signal that never fires. That is exactly how the original
    // migration-seeded version of this failed in production.
    const broken = Object.keys(VENUE_CAPACITY).filter(k => normalizeVenue(k) !== k)
    expect(broken).toEqual([])
  })

  it('has plausible capacities', () => {
    for (const [venue, cap] of Object.entries(VENUE_CAPACITY)) {
      expect(cap, venue).toBeGreaterThan(50)
      expect(cap, venue).toBeLessThan(200_000)
    }
  })
})

describe('capacityForVenue', () => {
  it('resolves the real venue_norm values seen in the catalog', () => {
    // These strings were read from production `events.venue_norm`, not invented.
    expect(capacityForVenue('moody center atx')).toBe(15000)
    expect(capacityForVenue('acl live at the moody theater')).toBe(2750)
    expect(capacityForVenue('emos austin')).toBe(1700)
    expect(capacityForVenue('antones nightclub')).toBe(800)
  })

  it('returns null for an unknown room rather than guessing small', () => {
    expect(capacityForVenue('some coffee shop')).toBeNull()
    expect(capacityForVenue(null)).toBeNull()
    expect(capacityForVenue('')).toBeNull()
  })

  it('resolves from a raw venue name as sources spell it', () => {
    expect(capacityForVenueName('Moody Center ATX')).toBe(15000)
    expect(capacityForVenueName("Emo's Austin")).toBe(1700)
    expect(capacityForVenueName("Antone's Nightclub")).toBe(800)
    expect(capacityForVenueName('ACL Live at the Moody Theater')).toBe(2750)
  })

  it('separates a stadium from a club by an order of magnitude', () => {
    expect(capacityForVenue('q2 stadium')! / capacityForVenue('the parish')!).toBeGreaterThan(20)
  })
})
