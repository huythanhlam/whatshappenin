import { describe, it, expect } from 'vitest'
import { editorialStrength, EDITORIAL_STRENGTH } from './config'

describe('editorialStrength', () => {
  it('is zero for a source no editor curates', () => {
    expect(editorialStrength(['ticketmaster', 'crawl:meetup-com'])).toBe(0)
    expect(editorialStrength([])).toBe(0)
  })

  it('takes the strongest claim among an event’s sources', () => {
    expect(editorialStrength(['crawl:austinmonthly-com', 'crawl:calendar-austinchronicle-com'])).toBe(1)
  })

  it('ranks a hand-picked shortlist above a listings calendar', () => {
    // Austin Monthly lists 15.3% of the upcoming catalog and CultureMap 7.6%;
    // Chronicle Staff Picks is a shortlist. Scoring them equally is what flooded
    // the trending rail with beginner yoga classes.
    expect(editorialStrength(['crawl:calendar-austinchronicle-com']))
      .toBeGreaterThan(editorialStrength(['crawl:austin-culturemap-com']))
    expect(editorialStrength(['crawl:austin-culturemap-com']))
      .toBeGreaterThan(editorialStrength(['crawl:austinmonthly-com']))
  })

  it('keeps every strength inside [0,1]', () => {
    for (const [source, v] of Object.entries(EDITORIAL_STRENGTH)) {
      expect(v, source).toBeGreaterThan(0)
      expect(v, source).toBeLessThanOrEqual(1)
    }
  })
})
