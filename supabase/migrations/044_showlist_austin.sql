-- Showlist Austin (austin.showlists.net) as a first-class daily source. It's a
-- hand-curated listing of every live-music show in town and the densest single
-- Austin calendar we ingest: live-verified 2026-08-15 at 782 shows across 93
-- days (today through ~4 months out), all of them rendered statically into the
-- site's homepage — no pagination, no per-event detail pages, no JS.
--
-- The 'showlist' parser (lib/sources/showlist.ts) reads that one page: each
-- `<li class="showlist-item">` carries its own show id and date as data
-- attributes plus rendered anchors for title, outbound ticket link, venue, and
-- street address (either a Google-Maps link's hidden address line or, for the
-- few venues without one, a parenthesized address/town). So a full run is a
-- single request and spends no Gemini (kind 'jsonld', exact and free).
--
-- It overlaps by design with the individual Austin venue crawlers already
-- seeded here (Mohawk, Stubb's, Emo's, Antone's, Hotel Vegas, Scoot Inn, C-Boy's,
-- The Far Out, Sahara Lounge…) — Showlist is the aggregate of exactly those
-- rooms. persistEvents' title+venue dedup collapses the overlap rather than
-- double-listing it; the value here is coverage of the many small rooms that
-- have no crawlable site of their own.
INSERT INTO sources (name, kind, url, parser, cadence, notes) VALUES
  ('crawl:austin-showlists-net', 'jsonld',
   'https://austin.showlists.net/',
   'showlist', 'daily',
   'roundup; hand-curated Austin live-music listing, whole ~3-month window statically rendered on one page, no Gemini');
