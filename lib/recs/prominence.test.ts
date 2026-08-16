import { describe, it, expect } from 'vitest'
import {
  computeProminence,
  prominenceParts,
  NEUTRAL_PROMINENCE,
  type ProminenceInput,
} from './prominence'

const NOW = new Date('2026-07-17T12:00:00Z').getTime()
const FUTURE = '2026-07-18T20:00:00Z'
const PAST = '2026-07-16T20:00:00Z'

function input(over: Partial<ProminenceInput> = {}): ProminenceInput {
  return { signals: null, artist: null, nowMs: NOW, ...over }
}

describe('computeProminence', () => {
  it('returns exactly neutral when nothing is known', () => {
    expect(computeProminence(input())).toBe(NEUTRAL_PROMINENCE)
  })

  it('treats an empty signals object the same as no signals', () => {
    expect(computeProminence(input({ signals: {} }))).toBe(NEUTRAL_PROMINENCE)
  })

  it('scores a superstar far above neutral', () => {
    const star = computeProminence(
      input({ artist: { popularity: 95, followers: 40_000_000 } })
    )
    expect(star).toBeGreaterThan(0.6)
  })

  it('ranks a superstar above a mid-tier act above an unknown', () => {
    const star = computeProminence(input({ artist: { popularity: 95, followers: 40_000_000 } }))
    const mid = computeProminence(input({ artist: { popularity: 55, followers: 200_000 } }))
    const unknown = computeProminence(input({ artist: { popularity: 5, followers: 300 } }))
    expect(star).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(unknown)
  })

  it('pulls a well-evidenced low score below neutral', () => {
    // A SeatGeek-scored event that scored badly really is a small event — that
    // is information, not absence of information.
    const score = computeProminence(
      input({
        signals: { externalPopularity: 0.01, venueCapacity: 60 },
        artist: { popularity: 2, followers: 100 },
      })
    )
    expect(score).toBeLessThan(NEUTRAL_PROMINENCE)
  })

  it('hedges a thin high signal toward neutral', () => {
    // Price floor alone (weight 0.7) is far short of FULL_CONFIDENCE_WEIGHT, so
    // it may lift the score but must not carry it near the top.
    const thin = computeProminence(input({ priceMin: 500 }))
    const backed = computeProminence(
      input({ priceMin: 500, artist: { popularity: 90, followers: 5_000_000 }, venueCapacity: 18_000 })
    )
    expect(thin).toBeGreaterThan(NEUTRAL_PROMINENCE)
    expect(thin).toBeLessThan(0.35)
    expect(backed).toBeGreaterThan(thin)
  })

  it('stays within [0,1] under extreme inputs', () => {
    const huge = computeProminence(
      input({
        signals: {
          externalPopularity: 99,
          venueCapacity: 500_000,
          performerUpcomingEvents: 100_000,
          attendeeCount: 1_000_000,
          ticketStatus: 'offsale',
        },
        artist: { popularity: 100, followers: 1e12 },
        sourceCount: 500,
        editorialPick: true,
        priceMin: 100_000,
        startTime: FUTURE,
      })
    )
    expect(huge).toBeGreaterThan(0.9)
    expect(huge).toBeLessThanOrEqual(1)

    const tiny = computeProminence(
      input({ signals: { externalPopularity: -5, venueCapacity: -100 }, priceMin: -20 })
    )
    expect(tiny).toBeGreaterThanOrEqual(0)
  })
})

describe('prominenceParts', () => {
  it('records nothing when no evidence is present', () => {
    expect(prominenceParts(input())).toEqual([])
  })

  const SALE_OPENED = '2026-06-01T10:00:00Z' // before NOW
  const SALE_UPCOMING = '2026-07-25T10:00:00Z' // after NOW

  it('counts sold-out only for an event that has not happened yet', () => {
    const upcoming = prominenceParts(
      input({ signals: { ticketStatus: 'offsale', salesStartTime: SALE_OPENED }, startTime: FUTURE })
    )
    const past = prominenceParts(
      input({ signals: { ticketStatus: 'offsale', salesStartTime: SALE_OPENED }, startTime: PAST })
    )
    expect(upcoming.map(p => p.key)).toContain('soldOut')
    expect(past.map(p => p.key)).not.toContain('soldOut')
  })

  it('does not read "not yet on sale" as a sellout', () => {
    // Ticketmaster returns offsale for both. Observed live: without this check,
    // eight dates of a touring musical whose tickets had not been released
    // topped the list on a fabricated soldOut signal.
    const notYetReleased = prominenceParts(
      input({
        signals: { ticketStatus: 'offsale', salesStartTime: SALE_UPCOMING },
        startTime: FUTURE,
      })
    )
    expect(notYetReleased.map(p => p.key)).not.toContain('soldOut')
  })

  it('declines to call a sellout when the onsale time is unknown', () => {
    // A missed sellout costs a little ranking; a false one puts an unbuyable
    // show at the top of the rail.
    const noSaleTime = prominenceParts(
      input({ signals: { ticketStatus: 'offsale' }, startTime: FUTURE })
    )
    expect(noSaleTime.map(p => p.key)).not.toContain('soldOut')
  })

  it('ignores an on-sale status entirely', () => {
    // 'onsale' is the default state of every ticketed event and says nothing.
    const parts = prominenceParts(input({ signals: { ticketStatus: 'onsale' }, startTime: FUTURE }))
    expect(parts).toEqual([])
  })

  it('does not penalize an explicit editorialPick: false', () => {
    // Nearly the whole catalog is un-curated; absence of a pick must not score
    // as a zero, or every non-curated event gets dragged down.
    expect(prominenceParts(input({ editorialPick: false }))).toEqual([])
    expect(prominenceParts(input({ editorialPick: true })).map(p => p.key)).toEqual(['editorial'])
  })

  it('prefers a source-stated capacity over the venues-table fallback', () => {
    const parts = prominenceParts(
      input({ signals: { venueCapacity: 20_000 }, venueCapacity: 50 })
    )
    const cap = parts.find(p => p.key === 'venueCapacity')
    expect(cap?.value).toBe(1)
  })

  it('records no corroboration at all for a lone source', () => {
    // Every event has at least one source, so one is the default state of the
    // catalog. Recording it as a zero-valued part would drag the whole
    // single-sourced long tail BELOW events we know nothing about.
    expect(prominenceParts(input({ sourceCount: 1 }))).toEqual([])
    const five = prominenceParts(input({ sourceCount: 5 })).find(p => p.key === 'corroboration')
    expect(five?.value).toBeGreaterThan(0.8)
  })

  it('never scores a real event below one with no evidence whatsoever', () => {
    // The invariant the bottom of the live Ticketmaster feed violated: a small
    // local show carrying only floor-valued signals was scoring 0.000, i.e.
    // ranked worse than a total unknown.
    const floorOnly = computeProminence(
      input({ sourceCount: 1, signals: { performerUpcomingEvents: 1 }, startTime: FUTURE })
    )
    expect(floorOnly).toBe(NEUTRAL_PROMINENCE)
  })

  it('treats a single booking as no touring information', () => {
    expect(prominenceParts(input({ signals: { performerUpcomingEvents: 1 } }))).toEqual([])
    const touring = prominenceParts(input({ signals: { performerUpcomingEvents: 60 } }))
    expect(touring.map(p => p.key)).toEqual(['touringScale'])
  })

  it('log-scales capacity so small rooms separate more than large ones', () => {
    const at = (capacity: number) =>
      prominenceParts(input({ venueCapacity: capacity })).find(p => p.key === 'venueCapacity')!.value
    expect(at(400) - at(200)).toBeGreaterThan(at(20_000) - at(19_800))
  })
})

describe('artist fame without a popularity index', () => {
  // The keyless default provider (Deezer) publishes follower counts but no 0–100
  // index, so prominence has to rank on followers alone.
  it('still separates a stadium act from a local one', () => {
    const stadium = computeProminence(input({ artist: { popularity: null, followers: 6_000_000 } }))
    const local = computeProminence(input({ artist: { popularity: null, followers: 2_000 } }))
    expect(stadium).toBeGreaterThan(local)
    expect(stadium).toBeGreaterThan(0.5)
  })

  it('ranks consistently with the indexed provider on the same artist', () => {
    // Same act, two providers: the ordering against a small act must not flip
    // depending on which provider happened to answer.
    const viaFollowers = computeProminence(input({ artist: { popularity: null, followers: 6_000_000 } }))
    const viaIndex = computeProminence(input({ artist: { popularity: 90, followers: 6_000_000 } }))
    const small = computeProminence(input({ artist: { popularity: null, followers: 5_000 } }))
    expect(viaFollowers).toBeGreaterThan(small)
    expect(viaIndex).toBeGreaterThan(small)
  })
})
