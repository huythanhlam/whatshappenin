import { describe, it, expect } from 'vitest'
import { resolveDateRange } from './dateRanges'

describe('resolveDateRange', () => {
  it('is inactive with no params', () => {
    const r = resolveDateRange({})
    expect(r.active).toBe(false)
    expect(r.toIso).toBeNull()
    expect(r.label).toBeNull()
  })

  it('bounds "today" to end of the Central-time day', () => {
    const r = resolveDateRange({ when: 'today' })
    expect(r.active).toBe(true)
    expect(r.label).toBe('Today')
    expect(r.toIso).not.toBeNull()
    // end is after start
    expect(new Date(r.toIso!).getTime()).toBeGreaterThan(new Date(r.fromIso).getTime())
  })

  it('produces a valid ordered range for "weekend"', () => {
    const r = resolveDateRange({ when: 'weekend' })
    expect(r.label).toBe('This Weekend')
    expect(new Date(r.fromIso).getTime()).toBeLessThanOrEqual(new Date(r.toIso!).getTime())
  })

  it('honors explicit from/to and never returns to before from', () => {
    // Dates are relative to "now" so this never rots: a fixed calendar range
    // eventually slips into the past, where `from` clamps up to now and the
    // strict ordering below no longer holds.
    const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    const DAY = 86_400_000
    const now = Date.now()

    const r = resolveDateRange({ from: ymd(now + 2 * DAY), to: ymd(now + 30 * DAY) })
    expect(r.active).toBe(true)
    expect(new Date(r.fromIso).getTime()).toBeLessThan(new Date(r.toIso!).getTime())

    // A fully-past explicit window must not invert: `to` is floored at `from`.
    const past = resolveDateRange({ from: '2020-01-01', to: '2020-01-31' })
    expect(new Date(past.toIso!).getTime()).toBeGreaterThanOrEqual(new Date(past.fromIso).getTime())
  })

  it('produces ISO 8601 timestamps', () => {
    const r = resolveDateRange({ when: 'month' })
    expect(r.fromIso).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(r.toIso).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
