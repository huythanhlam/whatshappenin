-- Popularity signals: event prominence + trending velocity.
--
-- Until now the only popularity input to ranking was `event_engagement.score` —
-- a rate computed entirely from OUR OWN users' interactions. That is a closed
-- loop: an event needs engagement to rank, and needs to rank to get engagement.
-- Every event enters it at the same DEFAULT_CITY_ENGAGEMENT_RATE, so a sold-out
-- arena show and a coffee-shop open mic are indistinguishable on day one.
--
-- Two columns break the loop, and they answer different questions:
--   * prominence — "how big a deal is this in the world?" Computed at ingest
--     from evidence outside our traffic (artist fame, room size, resale supply,
--     multi-source corroboration). See lib/recs/prominence.ts.
--   * velocity   — "is this heating up right now?" Recomputed on a cron from
--     time-windowed engagement and the event_demand series below. `prominence`
--     is a level; `velocity` is its derivative, which is what "trending"
--     actually means and what event_engagement's lifetime rate could never say.
--
-- Post-cutover tier (>033): applied by the Supabase stack and the
-- rls.integration.test harness, NOT the legacy PGlite dev runner (which stops at
-- 033). Every read of these columns/tables therefore degrades gracefully when
-- they are absent — same contract as user_badges in migration 039. See
-- lib/recs/prominence-store.ts.

-- 0.15 is NEUTRAL_PROMINENCE in lib/recs/prominence.ts, and the default matters:
-- an un-backfilled row must read as "we know nothing about this", not as "this
-- is unpopular". A zero default would rank the entire existing catalog below
-- every newly-ingested event.
ALTER TABLE events ADD COLUMN prominence REAL NOT NULL DEFAULT 0.15;

-- Velocity genuinely starts at zero: nothing is trending until it moves.
ALTER TABLE events ADD COLUMN velocity REAL NOT NULL DEFAULT 0;

-- The resolved headliner, normalized for lookup into `artists` below. Lets the
-- backfill script and any later re-scoring recover an event's artist without
-- re-parsing the provenance blob in event_sources.raw.
ALTER TABLE events ADD COLUMN headliner_norm TEXT;

-- Room size. Hand-seeded for the venues that matter (below); NULL everywhere
-- else, which the scorer reads as "unknown capacity", not "tiny room".
ALTER TABLE venues ADD COLUMN capacity INT;

-- Trending is ranked by these two columns over the upcoming window, so the sort
-- wants them together with start_time.
CREATE INDEX events_trending ON events (city_id, start_time, prominence, velocity);

-- Artist fame cache, keyed by normalized name so one Spotify lookup serves every
-- date on a tour. Refreshed lazily (see refreshedAt staleness check in
-- lib/recs/artists.ts) rather than on a cron — an artist's popularity moves on a
-- scale of weeks, and the catalog only asks about artists actually playing here.
CREATE TABLE artists (
  name_norm   TEXT PRIMARY KEY,           -- normalizeArtist() of the source's spelling
  display_name TEXT NOT NULL,             -- the canonical name as the provider spells it
  provider    TEXT,                       -- 'deezer' | 'spotify'; null on a miss
  external_id TEXT,                       -- the provider's own artist id
  -- A 0–100 recency-aware popularity index. Only Spotify publishes one, so this
  -- is null on Deezer, where `followers` alone carries the fame signal.
  popularity  INT,
  followers   BIGINT,
  -- Match confidence in [0,1]. A miss is recorded (not skipped) so a name that
  -- resolves to nothing isn't re-queried on every ingest.
  confidence  REAL NOT NULL DEFAULT 0,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ticket-demand time series. One row per observation per event; the derivative
-- across consecutive rows is the real signal (supply draining, price climbing),
-- which is why this is a series and not a column on events.
CREATE TABLE event_demand (
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  listing_count INT,
  avg_price     NUMERIC(10,2),
  status        TEXT,                     -- 'onsale' | 'offsale' | 'cancelled'
  PRIMARY KEY (event_id, observed_at)
);
CREATE INDEX event_demand_event ON event_demand (event_id, observed_at DESC);

ALTER TABLE artists      ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_demand ENABLE ROW LEVEL SECURITY;
-- Artist fame is public catalog metadata (it renders on event cards); demand
-- telemetry is internal and service-role only, like event_engagement.
CREATE POLICY "Public read artists"           ON artists      FOR SELECT USING (true);
CREATE POLICY "Service role manages artists"  ON artists      FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role manages demand"   ON event_demand FOR ALL USING (auth.role() = 'service_role');

-- Austin room capacities. Hand-seeded rather than fetched: the set of venues
-- that actually distinguishes a big night from a small one is small and stable,
-- and no free API covers the independent rooms. venue_norm values match
-- normalizeVenue() in lib/normalize.ts. Unlisted venues stay NULL.
UPDATE venues SET capacity = v.cap FROM (VALUES
  ('moody center', 15000),
  ('frank erwin center', 16500),
  ('q2 stadium', 20500),
  ('darrell k royal texas memorial stadium', 100119),
  ('circuit of the americas', 120000),
  ('germania insurance amphitheater', 14000),
  ('moody amphitheater', 5000),
  ('bass concert hall', 2900),
  ('acl live at the moody theater', 2750),
  ('emos austin', 1700),
  ('stubbs waller creek amphitheater', 2200),
  ('the long center', 2400),
  ('paramount theatre', 1270),
  ('scoot inn', 1500),
  ('the far out lounge', 1200),
  ('antones nightclub', 800),
  ('mohawk austin', 900),
  ('empire control room garage', 700),
  ('the parish', 450),
  ('cactus cafe', 200),
  ('continental club', 300),
  ('the saxon pub', 200),
  ('hole in the wall', 150),
  ('cheer up charlies', 400)
) AS v(venue_norm, cap)
WHERE venues.venue_norm = v.venue_norm;

-- Model v2: v1's weights plus the two new features. Promotion is a status flip
-- (the pipeline documented in migration 031), so v1 is retired rather than
-- edited — rollback stays a single UPDATE. MUST stay in sync with
-- V2_MODEL_WEIGHTS in lib/recs/config.ts.
--
-- prominence gets a weight near category_affinity's: for a logged-out visitor
-- (no affinities at all) it is essentially the only thing separating candidates,
-- which is exactly the cold-start case this migration exists to fix. velocity is
-- weighted lower — it is noisier and, unlike prominence, can be moved by our own
-- feedback loop.
UPDATE model_versions SET status = 'retired' WHERE status = 'active';
INSERT INTO model_versions (weights, status) VALUES (
  '{"bias":-2.0,"category_affinity":2.0,"venue_affinity":1.0,"neighborhood_affinity":0.8,"price_fit":0.5,"dow_affinity":0.3,"engagement_prior":1.5,"embedding_sim":1.2,"proximity":0.4,"seen_count":-0.5,"prominence":1.8,"velocity":0.9}',
  'active'
);

-- The cold-start fix proper.
--
-- bump_impression/bump_engagement (migration 036) smoothed every event toward
-- the SAME hardcoded 0.1 city rate, which is what made a brand-new arena show
-- and a brand-new open mic numerically identical until users separated them.
-- The prior mean now scales with the event's own prominence, so a marquee event
-- enters the ranking already believed-popular and is corrected downward by real
-- data if the audience doesn't bite — the direction a prior is supposed to work.
--
-- prominence is a 0–1 index, not an engagement rate, so it is mapped onto one:
-- NEUTRAL_PROMINENCE (0.15) maps to exactly the old 0.1 rate (an event with no
-- evidence behaves precisely as it did before), and the result is clamped to
-- [0.02, 0.45] so neither a superstar nor a dud can set a prior that real
-- observations can't overcome.
CREATE OR REPLACE FUNCTION public.prior_rate(p_event_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT LEAST(0.45, GREATEST(0.02,
    0.1 * COALESCE((SELECT prominence FROM events WHERE id = p_event_id), 0.15) / 0.15
  ));
$$;

CREATE OR REPLACE FUNCTION public.bump_impression(p_event_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO event_engagement (event_id, impressions, engagements, score)
  VALUES (p_event_id, 1, 0, (0 + 20 * public.prior_rate(p_event_id)) / (1 + 20))
  ON CONFLICT (event_id) DO UPDATE SET
    impressions = event_engagement.impressions + 1,
    score = (event_engagement.engagements + 20 * public.prior_rate(p_event_id))
            / (event_engagement.impressions + 1 + 20),
    updated_at = now();
$$;

CREATE OR REPLACE FUNCTION public.bump_engagement(p_event_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO event_engagement (event_id, impressions, engagements, score)
  VALUES (p_event_id, 0, 1, (1 + 20 * public.prior_rate(p_event_id)) / (0 + 20))
  ON CONFLICT (event_id) DO UPDATE SET
    engagements = event_engagement.engagements + 1,
    score = (event_engagement.engagements + 1 + 20 * public.prior_rate(p_event_id))
            / (event_engagement.impressions + 20),
    updated_at = now();
$$;

REVOKE ALL ON FUNCTION public.prior_rate(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.prior_rate(uuid) TO authenticated, service_role;
