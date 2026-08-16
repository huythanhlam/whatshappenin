import { describe, it, expect } from 'vitest'
import {
  buildSearchBody,
  eventsFromResults,
  instanceEnd,
  localMidnightIso,
  venueOf,
} from './sweatpals'

// Fixtures mirror live-verified rows from POST
// ilove.sweatpals.com/api/events/public/search (2026-08-16), trimmed to the
// fields the parser reads — the real rows also carry ~17KB of author,
// participants and intake-form settings per event.
function result(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'aee6a84a-bae8-4c15-824b-9f46d3a658cb',
    alias: 'the-sunday-serve-pickleball-league',
    name: 'The Sunday Serve Pickleball League',
    description: 'Meet other players, make new friends and have fun!',
    // Occurrence, not series: startDate/endDate on a recurring row are the
    // series template and are deliberately not read.
    instance: '2026-08-16T19:00:00.000Z',
    instanceEndDate: '2026-08-16T21:00:00.000Z',
    shortLocalInstance: '2026-08-16',
    startDate: '2026-01-04T20:00:00.000Z',
    endDate: '2026-01-18T23:00:00.000Z',
    addressName: 'Capital City Pickleball - Downtown (Waterloo), Pressler Street, Austin, TX',
    avatarId: 'f2cdd971-5698-4b3c-8dde-e2dd0944c189',
    isPaid: false,
    isOnlineEvent: false,
    prices: [],
    participantsCount: 12,
    ...over,
  }
}

describe('buildSearchBody', () => {
  it('sends the enum casings the API validates for, and the 500 cap', () => {
    const body = buildSearchBody('city-uuid', '2026-08-16T05:00:00.000Z', '2026-08-17T05:00:00.000Z')
    // The API returns 400 listing allowed values if either of these is wrong:
    // withEventTypes must be EVENT/CLASS/RETREAT, privacyFilteringMode must be
    // default/public/no-privacy-checks.
    expect(body.withEventTypes).toEqual(['EVENT', 'CLASS'])
    expect(body.privacyFilteringMode).toBe('public')
    expect(body.limit).toBe(500) // 501+ is rejected outright
    expect(body.cityId).toBe('city-uuid')
    expect(body.periodFrom).toBe('2026-08-16T05:00:00.000Z')
    expect(body.periodTo).toBe('2026-08-17T05:00:00.000Z')
    expect(body.maxEventsPerAuthorPerDay).toBe(2)
  })
})

describe('localMidnightIso', () => {
  it('anchors day windows to Austin local midnight, across the DST boundary', () => {
    // CDT (UTC-5) in August, CST (UTC-6) in December.
    expect(localMidnightIso({ y: 2026, m: 7, d: 16 })).toBe('2026-08-16T05:00:00.000Z')
    expect(localMidnightIso({ y: 2026, m: 11, d: 16 })).toBe('2026-12-16T06:00:00.000Z')
  })
})

describe('venueOf', () => {
  it('splits the flat address string into a leading venue and the whole address', () => {
    expect(venueOf('Capital City Pickleball - Downtown (Waterloo), Pressler Street, Austin, TX')).toEqual({
      name: 'Capital City Pickleball - Downtown (Waterloo)',
      address: 'Capital City Pickleball - Downtown (Waterloo), Pressler Street, Austin, TX',
    })
  })

  it('keeps an unnamed street address as the venue', () => {
    expect(venueOf('4622 S Lamar Blvd, Austin, TX').name).toBe('4622 S Lamar Blvd')
  })

  it('names no venue when the host pinned only a city, however it is spelled', () => {
    expect(venueOf('Austin, TX')).toEqual({ name: null, address: 'Austin, TX' })
    expect(venueOf('Austin, TX, USA').name).toBeNull()
    expect(venueOf('Cedar Park, TX 78613, USA').name).toBeNull()
  })

  it('still names a real venue in an address that carries a country segment', () => {
    expect(venueOf('Pressure Gym, East 5th Street, Austin, TX, USA').name).toBe('Pressure Gym')
  })

  it('returns nulls for a missing or blank address', () => {
    expect(venueOf(null)).toEqual({ name: null, address: null })
    expect(venueOf('   ')).toEqual({ name: null, address: null })
  })
})

describe('instanceEnd', () => {
  it('keeps a plausible occurrence end', () => {
    expect(instanceEnd('2026-08-16T19:00:00.000Z', '2026-08-16T21:00:00.000Z')).toBe('2026-08-16T21:00:00.000Z')
  })

  it('drops an end inherited from an implausibly long series template', () => {
    // Live-verified shape: a 1-hour class whose recurring template spans 13h.
    expect(instanceEnd('2026-08-15T15:00:00.000Z', '2026-08-16T04:00:00.000Z')).toBeNull()
  })

  it('drops a non-positive or absent end rather than inventing one', () => {
    expect(instanceEnd('2026-08-16T19:00:00.000Z', '2026-08-16T19:00:00.000Z')).toBeNull()
    expect(instanceEnd('2026-08-16T19:00:00.000Z', null)).toBeNull()
  })
})

describe('eventsFromResults', () => {
  it('maps an occurrence to a RawEvent', () => {
    const [e] = eventsFromResults([result()], 'crawl:sweatpals-com')
    expect(e).toMatchObject({
      title: 'The Sunday Serve Pickleball League',
      description: 'Meet other players, make new friends and have fun!',
      start_time: '2026-08-16T19:00:00.000Z',
      end_time: '2026-08-16T21:00:00.000Z',
      venue_name: 'Capital City Pickleball - Downtown (Waterloo)',
      venue_address: 'Capital City Pickleball - Downtown (Waterloo), Pressler Street, Austin, TX',
      image_url: 'https://ilove.sweatpals.com/api/files/f2cdd971-5698-4b3c-8dde-e2dd0944c189?variant=l',
      // /event/<alias>/<local date of THIS occurrence>
      ticket_url: 'https://sweatpals.com/event/the-sunday-serve-pickleball-league/2026-08-16',
      source: 'crawl:sweatpals-com',
      is_free: true,
      price_min: null,
      price_max: null,
    })
    // Occurrence-scoped id: the series UUID alone would collapse a weekly class.
    expect(e.source_id).toBe('aee6a84a-bae8-4c15-824b-9f46d3a658cb:2026-08-16T19:00:00.000Z')
    // RSVP count feeds prominence for events with no ticketing footprint.
    expect(e.signals).toEqual({ attendeeCount: 12 })
  })

  it('converts cent prices to dollars and spans the tiers', () => {
    const [e] = eventsFromResults(
      [result({ isPaid: true, prices: [{ priceAmount: 1500 }, { priceAmount: 2500 }] })],
      'src',
    )
    expect(e).toMatchObject({ is_free: false, price_min: 15, price_max: 25 })
  })

  it('keeps two occurrences of the same recurring series as separate events', () => {
    const events = eventsFromResults(
      [
        result(),
        result({ instance: '2026-08-23T19:00:00.000Z', instanceEndDate: '2026-08-23T21:00:00.000Z', shortLocalInstance: '2026-08-23' }),
      ],
      'src',
    )
    expect(events).toHaveLength(2)
    expect(events.map(e => e.ticket_url)).toEqual([
      'https://sweatpals.com/event/the-sunday-serve-pickleball-league/2026-08-16',
      'https://sweatpals.com/event/the-sunday-serve-pickleball-league/2026-08-23',
    ])
  })

  it('collapses the same occurrence seen in two overlapping day windows', () => {
    // filterByEndDate bleeds a late-night event into the next day's window.
    expect(eventsFromResults([result(), result()], 'src')).toHaveLength(1)
  })

  it('drops online-only events, which carry no address at all', () => {
    const rows = [result(), result({ id: 'other', isOnlineEvent: true, addressName: null })]
    expect(eventsFromResults(rows, 'src')).toHaveLength(1)
  })

  it('drops an out-of-state event at the edge of the metro radius', () => {
    const rows = [
      result(),
      result({ id: 'ok-unknown-state', instance: '2026-08-17T19:00:00.000Z', addressName: null }),
      result({ id: 'out-of-state', addressName: 'Some Gym, Main Street, Texarkana, AR' }),
    ]
    const events = eventsFromResults(rows, 'src', 'TX')
    // The Texas row stays; the Arkansas row goes; an address-less row is left
    // alone rather than guessed at.
    expect(events.map(e => e.source_id.split(':')[0])).toEqual([
      'aee6a84a-bae8-4c15-824b-9f46d3a658cb',
      'ok-unknown-state',
    ])
  })

  it('skips malformed rows and non-array input', () => {
    expect(eventsFromResults(null, 'src')).toEqual([])
    expect(eventsFromResults([{ id: 'x' }, result({ name: '  ' })], 'src')).toEqual([])
  })
})

describe('attendee signal', () => {
  it('omits the signal when the API supplies no count', () => {
    // Absent is "unknown attendance", which computeProminence must not read as
    // "nobody is going".
    const [e] = eventsFromResults([result({ participantsCount: undefined })], 'crawl:sweatpals-com')
    expect(e.signals).toBeNull()
  })
})
