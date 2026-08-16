import { describe, it, expect } from 'vitest'
import { normalizeArtist } from './artists'

// Only the pure match-key policy is covered here. The Spotify client and the
// cache are I/O and are exercised by the ingest path, not by unit tests.
describe('normalizeArtist', () => {
  it('collapses the spellings the same act gets across ticketing sources', () => {
    const forms = ['Beyoncé', 'BEYONCE', 'Beyoncé ', 'beyonce']
    expect(new Set(forms.map(normalizeArtist)).size).toBe(1)
  })

  it('drops parenthetical qualifiers that vendors append to billings', () => {
    expect(normalizeArtist('SZA (18+ Event)')).toBe('sza')
    expect(normalizeArtist('Khruangbin (Rescheduled)')).toBe('khruangbin')
  })

  it('ignores a leading "the"', () => {
    expect(normalizeArtist('The Black Angels')).toBe(normalizeArtist('Black Angels'))
  })

  it('strips punctuation without merging distinct words', () => {
    expect(normalizeArtist('Tyler, The Creator')).toBe('tyler the creator')
    expect(normalizeArtist("Guns N' Roses")).toBe('guns n roses')
  })

  it('keeps genuinely different artists distinct', () => {
    expect(normalizeArtist('Drake')).not.toBe(normalizeArtist('Drake White'))
  })

  it('returns an empty key for a name with no letters or digits', () => {
    // resolveArtistFame treats this as unresolvable rather than querying for it.
    expect(normalizeArtist('!!! ???')).toBe('')
  })
})
