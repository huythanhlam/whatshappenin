import { describe, it, expect } from 'vitest'
import { eventsFromHtml, parseCompactDate, parseBracketTime, qualifyAddress } from './showlist'

// Fixtures mirror live-verified markup shapes from austin.showlists.net (the
// homepage renders the whole listing; each <li> is reproduced verbatim in
// structure, including the theme's ragged whitespace and the two mutually
// exclusive address shapes).
function listHtml(items: string): string {
  return `<div class="showlist" id="theList">
    <div id="20260815" class="show-date">
      <h5 class="text-brand">Saturday, August 15th 2026</h5>
      <ul>${items}</ul>
    </div>
  </div>`
}

// The common shape: linked venue + Google-Maps link carrying a bare street
// line, and a bracketed door time.
function mappedItem(): string {
  return `<li data-venue="Sahara Lounge" class="showlist-item" data-show-id="1357505" data-show-date="20260815">
    <a href="https://do512.com/events/2026/8/15/africa-night-tickets" title="show link" target="_blank" rel="noopener noreferrer" class="show-title show-link text-dark" data-show-title="Africa Night featuring Zoumountchi, Bamako Airlines, Afro Jazz">
      Africa Night featuring Zoumountchi,
      Bamako Airlines, Afro Jazz
    </a>
    at
    <a class="venue-title text-dark venue-link text-decoration-none" title="venue link" target="_blank" data-venue-title="Sahara Lounge" href="https://www.saharalounge.com/">Sahara Lounge</a>
    <a class="text-brand maps-link text-decoration-none" href="https://goo.gl/maps/fLfuqVpxn8gW972f9" data-venue-title="Sahara Lounge" title="map link" target="_blank" rel="noopener noreferrer">
      <span class="visually-hidden">1413 Webberville Rd</span>
      <svg class="map-icon"></svg>
    </a>
    <span class="text-gray">
      [7:00 PM]
    </span>
  </li>`
}

// No maps link and no time: the address is printed in parentheses instead.
function parenthesizedAddressItem(): string {
  return `<li data-venue="" class="showlist-item" data-show-id="1351584" data-show-date="20260816">
    <a href="https://www.instagram.com/tinyrocknroll/?hl=en" title="show link" target="_blank" rel="noopener noreferrer" class="show-title show-link text-dark" data-show-title="RECORD RELEASE featuring Tiny, Stilveca">
      RECORD RELEASE featuring Tiny, Stilveca
    </a>
    at
    <a class="venue-title text-dark venue-link text-decoration-none" title="venue link" target="_blank" data-venue-title="Tweedy&rsquo;s" href="https://www.tweedysbar.com/">Tweedy&rsquo;s</a>
    ( <span class="text-dark">2908 Fruth St</span> )
  </li>`
}

// Out-of-town show: the venue is an unlinked <span> and the parentheses hold a
// town name rather than a street.
function outOfTownItem(): string {
  return `<li data-venue="" class="showlist-item" data-show-id="1350119" data-show-date="20260918">
    <a href="https://www.eventbrite.com/e/floyd-in-the-dark-tickets-1991156389361" title="show link" target="_blank" rel="noopener noreferrer" class="show-title show-link text-dark" data-show-title="Floyd in the Dark">
      Floyd in the Dark
    </a>
    at
    <span class="venue-title text-dark text-decoration-none">Lantex Theater</span>
    ( <span class="text-dark">Llano</span> )
    <span class="text-gray">
      [8:00 PM]
    </span>
  </li>`
}

describe('parseCompactDate', () => {
  it('reads the data-show-date attribute', () => {
    expect(parseCompactDate('20260815')).toEqual({ y: 2026, m: 7, d: 15 })
  })

  it('rejects malformed or out-of-range dates', () => {
    for (const bad of [undefined, '', '2026-08-15', '2026081', '20261315', '20260800']) {
      expect(parseCompactDate(bad)).toBeNull()
    }
  })
})

describe('parseBracketTime', () => {
  it('reads the bracketed 12-hour time', () => {
    expect(parseBracketTime('[7:00 PM]')).toEqual({ hh: 19, mm: 0 })
    expect(parseBracketTime(' [12:30 am] ')).toEqual({ hh: 0, mm: 30 })
    expect(parseBracketTime('12:15 pm')).toEqual({ hh: 12, mm: 15 })
  })

  it('returns null when absent or unparseable', () => {
    for (const bad of [undefined, '', '[TBA]', '7 PM']) {
      expect(parseBracketTime(bad)).toBeNull()
    }
  })
})

describe('qualifyAddress', () => {
  it('qualifies a bare street line with the implicit city and state', () => {
    expect(qualifyAddress('1413 Webberville Rd')).toBe('1413 Webberville Rd, Austin, TX')
  })

  it('treats a digit-free value as a town name', () => {
    expect(qualifyAddress('Driftwood')).toBe('Driftwood, TX')
  })

  it('leaves an already-qualified address alone', () => {
    expect(qualifyAddress('440 E St Elmo Rd G-2, Austin, TX 78745')).toBe('440 E St Elmo Rd G-2, Austin, TX 78745')
  })

  it('returns null for empty input', () => {
    expect(qualifyAddress(null)).toBeNull()
    expect(qualifyAddress('   ')).toBeNull()
  })
})

describe('eventsFromHtml', () => {
  it('reads title, venue, mapped address, ticket link and door time', () => {
    const [ev] = eventsFromHtml(listHtml(mappedItem()), 'crawl:austin-showlists-net')

    expect(ev).toMatchObject({
      title: 'Africa Night featuring Zoumountchi, Bamako Airlines, Afro Jazz',
      venue_name: 'Sahara Lounge',
      venue_address: '1413 Webberville Rd, Austin, TX',
      ticket_url: 'https://do512.com/events/2026/8/15/africa-night-tickets',
      source: 'crawl:austin-showlists-net',
      source_id: '1357505',
      description: null,
      end_time: null,
      image_url: null,
      is_free: false,
      price_min: null,
      price_max: null,
    })
    // 7:00 PM CDT on 2026-08-15.
    expect(ev.start_time).toBe('2026-08-16T00:00:00.000Z')
  })

  it('falls back to 19:00 local when the item carries no time', () => {
    const [ev] = eventsFromHtml(listHtml(parenthesizedAddressItem()), 'showlist')
    expect(ev.start_time).toBe('2026-08-17T00:00:00.000Z')
  })

  it('reads the parenthesized address when there is no maps link', () => {
    const [ev] = eventsFromHtml(listHtml(parenthesizedAddressItem()), 'showlist')
    expect(ev.venue_name).toBe('Tweedy’s')
    expect(ev.venue_address).toBe('2908 Fruth St, Austin, TX')
  })

  it('keeps the venue name out of the address when the venue is unlinked', () => {
    const [ev] = eventsFromHtml(listHtml(outOfTownItem()), 'showlist')
    expect(ev.venue_name).toBe('Lantex Theater')
    expect(ev.venue_address).toBe('Llano, TX')
  })

  it('dates each item from its own attribute, not its day group', () => {
    const events = eventsFromHtml(
      listHtml(mappedItem() + parenthesizedAddressItem() + outOfTownItem()),
      'showlist',
    )
    expect(events.map(e => e.start_time.slice(0, 10))).toEqual(['2026-08-16', '2026-08-17', '2026-09-19'])
  })

  it('skips items missing an id, a date, or a title', () => {
    const broken = `<li class="showlist-item" data-show-date="20260815"><a class="show-title" data-show-title="No id"></a></li>
      <li class="showlist-item" data-show-id="1" data-show-date="nope"><a class="show-title" data-show-title="Bad date"></a></li>
      <li class="showlist-item" data-show-id="2" data-show-date="20260815"><a class="show-title" data-show-title=" "></a></li>`
    expect(eventsFromHtml(listHtml(broken), 'showlist')).toEqual([])
  })

  it('returns no events for markup without the listing', () => {
    expect(eventsFromHtml('<html><body><p>nothing here</p></body></html>', 'showlist')).toEqual([])
  })
})
