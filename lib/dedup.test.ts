import { describe, it, expect } from 'vitest'
import { chooseMatch, mergeFields, sourceTrust, type Candidate, type ExistingEvent } from './dedup'

describe('sourceTrust', () => {
  it('ranks api > ical > jsonld > crawl > unknown', () => {
    expect(sourceTrust('ticketmaster')).toBeGreaterThan(sourceTrust('ical'))
    expect(sourceTrust('ical')).toBeGreaterThan(sourceTrust('eventbrite')) // eventbrite is jsonld
    expect(sourceTrust('eventbrite')).toBeGreaterThan(sourceTrust('crawl'))
    expect(sourceTrust('nope')).toBe(0)
  })
  it('puts rss (newspapers) at the same tier as crawl', () => {
    expect(sourceTrust('newspapers')).toBe(sourceTrust('crawl')) // rss tier == crawl tier == 1
  })
  it('ranks a city-suffixed structured source the same as its base name', () => {
    expect(sourceTrust('ticketmaster:houston')).toBe(sourceTrust('ticketmaster'))
    expect(sourceTrust('seatgeek:houston')).toBe(sourceTrust('seatgeek'))
  })
  it('puts public submissions at the same (lowest) trust tier as crawl', () => {
    expect(sourceTrust('submission')).toBe(sourceTrust('crawl'))
  })

  it('falls back to 0 for an instance-named source with no kind given (the pre-fix bug)', () => {
    // 'crawl:mohawkaustin-com' isn't a literal key in the static map, so with no
    // kind info it scores as untrusted as pure garbage.
    expect(sourceTrust('crawl:mohawkaustin-com')).toBe(0)
  })

  it('uses the real kind when given, ranking an instance-named crawl source at the crawl tier', () => {
    expect(sourceTrust('crawl:mohawkaustin-com', 'crawl')).toBe(sourceTrust('crawl'))
    expect(sourceTrust('crawl:mohawkaustin-com', 'crawl')).toBeGreaterThan(sourceTrust('crawl:mohawkaustin-com'))
  })

  it('uses the real kind for an instance-named rss/newspaper source', () => {
    expect(sourceTrust('newspaper:kut', 'rss')).toBe(sourceTrust('newspapers'))
    expect(sourceTrust('newspaper:kut')).toBe(0) // no kind given: not a literal key, no match
  })

  it('the real kind takes priority over the static map even when the name also has a literal entry', () => {
    // 'crawl' literally maps to 'crawl' (tier 1) in the static map; an explicit
    // 'api' kind should still win, proving kind isn't just an OR-fallback.
    expect(sourceTrust('crawl', 'api')).toBe(sourceTrust('ticketmaster'))
  })

  it('a null kind (e.g. no matching sources row) falls back to the static map, same as omitting it', () => {
    expect(sourceTrust('crawl', null)).toBe(sourceTrust('crawl'))
    expect(sourceTrust('nope', null)).toBe(0)
  })
})

describe('chooseMatch', () => {
  const cand = (id: string, sim: number, venueAgree: boolean): Candidate => ({ id, sim, venueAgree })

  it('matches at sim >= 0.55 when the venue agrees', () => {
    expect(chooseMatch([cand('a', 0.6, true)])).toBe('a')
  })
  it('does NOT match at sim 0.6 without venue agreement', () => {
    expect(chooseMatch([cand('a', 0.6, false)])).toBeNull()
  })
  it('matches at sim >= 0.85 even without venue agreement', () => {
    expect(chooseMatch([cand('a', 0.9, false)])).toBe('a')
  })
  it('picks the highest-scoring passing candidate', () => {
    expect(chooseMatch([cand('a', 0.56, true), cand('b', 0.99, false)])).toBe('b')
  })
  it('returns null when nothing passes', () => {
    expect(chooseMatch([cand('a', 0.4, true), cand('b', 0.7, false)])).toBeNull()
  })
})

describe('mergeFields', () => {
  const base: ExistingEvent = {
    source: 'crawl', source_id: 'x', title: 'old', title_norm: 'old', venue_norm: 'mohawk',
    description: 'short', image_url: null, venue_name: null, venue_address: null,
    end_time: null, ticket_url: 'http://crawl', is_free: false,
    price_min: null, price_max: null,
  }

  it('takes the longer description', () => {
    const p = mergeFields(base, { ...raw(), description: 'a much longer description' })
    expect(p?.description).toBe('a much longer description')
  })
  it('recomputes venue_norm when it fills a missing venue_name', () => {
    const p = mergeFields({ ...base, venue_name: null, venue_norm: null }, { ...raw(), venue_name: 'Mohawk' })
    expect(p).toMatchObject({ venue_name: 'Mohawk', venue_norm: 'mohawk' })
  })
  it('fills a missing image but does not overwrite an existing one from an equal/lower-trust source', () => {
    expect(mergeFields(base, { ...raw(), image_url: 'http://img' })?.image_url).toBe('http://img')
    expect(mergeFields({ ...base, image_url: 'http://have' }, { ...raw(), image_url: 'http://new' })?.image_url).toBeUndefined()
  })
  it('a higher-trust source upgrades an existing image (e.g. a crawl-tier fallback photo)', () => {
    const p = mergeFields(
      { ...base, image_url: 'http://fallback-stock-photo' },
      { ...raw(), source: 'ticketmaster', image_url: 'http://real-photo' }
    )
    expect(p?.image_url).toBe('http://real-photo')
  })
  it('a lower-trust source does not downgrade an existing higher-trust image', () => {
    const p = mergeFields(
      { ...base, source: 'ticketmaster', image_url: 'http://real-photo' },
      { ...raw(), source: 'crawl', image_url: 'http://generic-photo' }
    )
    expect(p?.image_url).toBeUndefined()
  })
  it('widens the price range', () => {
    const p = mergeFields({ ...base, price_min: 20, price_max: 30 }, { ...raw(), price_min: 10, price_max: 50 })
    expect(p).toMatchObject({ price_min: 10, price_max: 50 })
  })
  it('a higher-trust source wins title + ticket_url + primary source', () => {
    const p = mergeFields(base, { ...raw(), source: 'ticketmaster', source_id: 'tm1', title: 'Canonical Title', ticket_url: 'http://tm' })
    expect(p).toMatchObject({ source: 'ticketmaster', source_id: 'tm1', ticket_url: 'http://tm', title: 'Canonical Title' })
    expect(p?.title_norm).toBe('canonical title')
  })
  it('a lower-trust source does not overwrite title/ticket_url', () => {
    const p = mergeFields({ ...base, source: 'ticketmaster', ticket_url: 'http://tm' }, { ...raw(), source: 'crawl', title: 'spam', ticket_url: 'http://spam' })
    expect(p?.title).toBeUndefined()
    expect(p?.ticket_url).toBeUndefined()
  })
  it('an instance-named crawl source with source_kind wins over an existing UNKNOWN-kind source', () => {
    // Without source_kind info, base.source ('crawl') already resolves via the
    // static map, but an existing event whose source has no static-map entry at
    // all (simulating an un-joined/legacy row) previously scored 0 — any real
    // kind should now correctly outrank it.
    const unknownExisting = { ...base, source: 'crawl:some-random-unmapped-host', source_kind: null }
    const p = mergeFields(unknownExisting, {
      ...raw(), source: 'crawl:mohawkaustin-com', source_kind: 'crawl', title: 'Mohawk Show', ticket_url: 'http://mohawk',
    })
    expect(p).toMatchObject({ source: 'crawl:mohawkaustin-com', ticket_url: 'http://mohawk', title: 'Mohawk Show' })
  })
  it('two instance-named crawl sources at the same real kind tier do not swap title/ticket_url', () => {
    // Both existing and incoming carry the authoritative 'crawl' kind, so they
    // are equal trust — equal trust must not "win", matching same-tier behavior
    // for literal names (regression guard for the existing/incoming symmetry).
    const existingCrawl = { ...base, source: 'crawl:mohawkaustin-com', source_kind: 'crawl' as const, ticket_url: 'http://mohawk' }
    const p = mergeFields(existingCrawl, {
      ...raw(), source: 'crawl:theparishaustin-com', source_kind: 'crawl', title: 'spam', ticket_url: 'http://spam',
    })
    expect(p?.title).toBeUndefined()
    expect(p?.ticket_url).toBeUndefined()
  })
  it('a structured source still outranks an instance-named crawl source even with real kind info', () => {
    const existingCrawl = { ...base, source: 'crawl:mohawkaustin-com', source_kind: 'crawl' as const, ticket_url: 'http://mohawk' }
    const p = mergeFields(existingCrawl, {
      ...raw(), source: 'ticketmaster', source_kind: 'api', source_id: 'tm2', title: 'Canonical Title', ticket_url: 'http://tm',
    })
    expect(p).toMatchObject({ source: 'ticketmaster', ticket_url: 'http://tm', title: 'Canonical Title' })
  })
  it('returns null when nothing changes', () => {
    expect(mergeFields(base, { ...raw(), source: 'crawl', title: 'old', description: 'short' })).toBeNull()
  })
})

// Minimal RawEvent factory for merge tests.
function raw() {
  return {
    title: 'x', description: null, start_time: '2026-08-01T00:00:00Z', end_time: null,
    venue_name: null, venue_address: null, image_url: null, ticket_url: null,
    source: 'crawl', source_id: 'y', is_free: false, price_min: null, price_max: null,
  }
}
