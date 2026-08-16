-- Sweatpals (sweatpals.com/discover) as a first-class daily source: the fitness
-- and wellness side of the calendar — run clubs, pickup pickleball, yoga and
-- pilates classes, hikes, socials — which the music/arts roundups we already
-- ingest barely cover.
--
-- The discover page is a client-rendered Next.js app, but the API its own
-- frontend calls is public and unauthenticated (live-verified 2026-08-16 with
-- plain curl: no key, no cookie, no Origin header; robots.txt Allows /discover).
-- So the 'sweatpals' parser (lib/sources/sweatpals.ts) is exact and free —
-- kind 'jsonld', no Gemini, no BROWSER_FETCH_URL — same tier as luma/showlist.
--
-- It takes nothing from this row but the display URL: the parser resolves the
-- city's Sweatpals UUID from the configured city's name+state at run time
-- (GET /api/events/available-cities), then POSTs /api/events/public/search
-- once per day across the rolling 2-month window. Date windows are the ONLY
-- pagination available — the search caps `limit` at 500 and has no offset
-- parameter — and Austin runs ~54 events/day once the API's own
-- maxEventsPerAuthorPerDay filter caps studios posting their whole timetable.
--
-- cityId is metro-scoped, so this also picks up Pflugerville, Cedar Park and
-- San Marcos; the parser applies the same target-state backstop lib/sources/
-- luma.ts uses at the radius edges, and drops online-only events (they carry
-- no address at all).
INSERT INTO sources (name, kind, url, parser, cadence, notes) VALUES
  ('crawl:sweatpals-com', 'jsonld',
   'https://sweatpals.com/discover',
   'sweatpals', 'daily',
   'fitness/wellness; public unauthenticated JSON API (ilove.sweatpals.com), city id resolved by name at run time, day-windowed sweep because the search has no offset param, no Gemini');
