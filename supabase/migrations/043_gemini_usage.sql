-- Cross-invocation Gemini request budget (billing/quota safety).
--
-- The in-process daily counter in lib/gemini.ts resets on every serverless
-- invocation, so the N staggered cron windows (per-city + per-shard) each
-- believe they own the full daily budget and collectively overshoot the
-- project-wide Gemini quota — tripping 429s and (on a paid key) uncapped spend.
-- This table is the shared source of truth: geminiJson does an atomic
-- compare-and-increment (reserveGeminiBudget in lib/db/index.ts) keyed by UTC
-- day + model, so GEMINI_DAILY_BUDGET is a true GLOBAL cap no matter how many
-- invocations run concurrently.
--
-- Only prod (real Postgres) uses this; local PGlite dev keeps the in-process
-- counter (this migration is >33, so it never runs in the embedded dev DB — see
-- LEGACY_MIGRATION_CEILING in lib/db/migrate.ts).
CREATE TABLE gemini_usage (
  day       DATE NOT NULL,
  model     TEXT NOT NULL,
  requests  INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);

ALTER TABLE gemini_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages gemini_usage" ON gemini_usage FOR ALL USING (auth.role() = 'service_role');
