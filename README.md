# Whats Happenin

A multi-city events aggregator built on Next.js 16 (App Router, React 19),
currently live for **Austin** and **Houston** under `/[city]/` routing (`/`
redirects to the first enabled city). It ingests events daily from a wide mix
of sources — Eventbrite, city iCal feeds, Ticketmaster, SeatGeek, Meetup,
Luma, Partiful, Meanwhile Brewing, DMO/CVB event calendars (Simpleview),
CultureMap, generic schema.org JSON-LD event pages, local newspaper RSS,
Bluesky, YouTube, and a Gemini-powered page crawler (single-page and
paginated) — de-dupes and tags them, and serves a filterable/searchable
grid, calendar, and map view with personalized email digests and
time-bounded featured listings.

**It runs with zero credentials** — no accounts, no keys — thanks to an embedded
in-memory Postgres (PGlite) seeded with real Austin events.

## Run it right now (no accounts, no keys)

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (redirects to
[http://localhost:3000/austin](http://localhost:3000/austin); Houston is at
[http://localhost:3000/houston](http://localhost:3000/houston)). With no
`DATABASE_URL` configured the app uses embedded PGlite + a built-in seed, so
search, category filters, event detail pages, subscriptions, calendar, and
featured listings all work immediately. Tagging falls back to keyword matching
(no Gemini key needed).

Pull in more live events on demand:

```bash
curl -X POST http://localhost:3000/api/ingest   # scans sources for every enabled city + tags events (dev auth is open)

# Or scope a run to a single city:
curl -X POST 'http://localhost:3000/api/ingest?city=houston'
```

### Import from an influencer post or aggregator page

`POST /api/import` crawls a page (or pasted post text) and extracts every
upcoming event it finds. **Requires `GEMINI_API_KEY`** (it reads free text).
`city` defaults to `austin` when omitted, but pass it explicitly for any other
city.

```bash
# Crawl a public aggregator / link-in-bio page:
curl -X POST http://localhost:3000/api/import \
  -H 'content-type: application/json' -d '{"url":"https://365thingsaustin.com/", "city":"austin"}'

# Or paste a caption from a login-walled post:
curl -X POST http://localhost:3000/api/import \
  -H 'content-type: application/json' \
  -d '{"text":"📅 Sat July 4, 8pm — Indie Night @ Mohawk Austin, $15. Tickets in bio!", "city":"austin"}'
```

### Public event submissions + admin moderation

Anyone can submit an event (no account needed) at `/[city]/submit` (e.g.
[http://localhost:3000/austin/submit](http://localhost:3000/austin/submit)) —
same url-or-pasted-text input as `/api/import`, backed by the public
`POST /api/submissions` route. Submissions land as `pending` (an `events.status`
column) and never appear publicly until approved.

```bash
curl -X POST http://localhost:3000/api/submissions \
  -H 'content-type: application/json' \
  -d '{"text":"📅 Sat July 4, 8pm — Indie Night @ Mohawk Austin, $15.", "city":"austin"}'
```

Review and approve/reject pending submissions at `/[city]/admin` (e.g.
[http://localhost:3000/austin/admin](http://localhost:3000/austin/admin)),
which also shows per-source health. It's gated by the same `CRON_SECRET`
bearer token as the other admin/cron endpoints (paste any string into the
token field in dev — auth is open outside production; in production paste the
real `CRON_SECRET`, stored in the browser's local storage).

### Personalized email digests

Subscribe at `/[city]/subscribe` (e.g.
[http://localhost:3000/austin/subscribe](http://localhost:3000/austin/subscribe))
for a daily or weekly digest, filterable by category, a free-events-only
toggle, and (once venues are geocoded — see `GOOGLE_GEOCODING_API_KEY` below)
neighborhood. Subscriptions use double opt-in: the welcome email links to a
confirm page, and unconfirmed subscriptions never receive digests.

```bash
curl -X POST http://localhost:3000/api/subscribe \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","frequency":"daily","category_slugs":["music"],"free_only":true,"city":"austin"}'
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm test` | Run the Vitest suite (pure fns, fixture parsers, PGlite integration) |
| `npm run lint` | ESLint |
| `npm run migrate` | Apply `supabase/migrations-legacy/*` to `DATABASE_URL` (prod DB) |
| `npm run backfill-geocode` | One-off: geocode any existing venues that predate `GOOGLE_GEOCODING_API_KEY` being set |

## Going to production

### 1. Database (required)

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard) (free tier is fine).
2. **Settings → Database → Connection pooling → "Transaction" tab** → copy the
   **URI** (port `6543`) → set it as `DATABASE_URL` in `.env.local`. Use the
   Transaction pooler, not Session (port `5432`) — the app opens a `pg` Pool
   per serverless instance, and Session mode's low client cap gets exhausted
   by ordinary traffic ("max clients reached in session mode").
3. Apply the schema:

   ```bash
   npm run migrate
   ```

   Runs every file in `supabase/migrations-legacy/` against `DATABASE_URL`
   (idempotent, tracked in a `_migrations` ledger). When `DATABASE_URL` is
   unset the app just uses PGlite and needs no migration step.

### 2. Optional keys

Everything above works without these; add them to unlock more:

- `GEMINI_API_KEY` — smarter AI tagging **and** unlocks the newspaper/social/
  YouTube/crawler sources (they publish prose, so Gemini extracts concrete
  events). Free: [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
  Free-tier request limits are enforced centrally — tune with
  `GEMINI_DAILY_BUDGET` / `GEMINI_RPM`.
- `TICKETMASTER_API_KEY`, `SEATGEEK_CLIENT_ID`, `YOUTUBE_API_KEY` — additional
  event sources (each is skipped, and recorded as such in `/api/admin/health`,
  when its key is absent).
- `NEWSPAPER_FEEDS`, `CRAWL_URLS` — add RSS feeds / pages to crawl without code
  changes.
- `BROWSER_FETCH_URL` / `BROWSER_FETCH_TOKEN` — headless-render fallback for
  JS-heavy/blocked pages.
- `GOOGLE_GEOCODING_API_KEY` — geocodes each unique venue once at ingest time
  (cached in the `venues` table), which powers neighborhood-filtered digests.
  `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (a separate, HTTP-referrer-restricted key)
  renders the map view in the browser; without it the map toggle is hidden.
- `RESEND_API_KEY` + `EMAIL_FROM` — actually send the email digests.
- `CRON_SECRET` — **required in production**; guards the ingest/import/featured/
  digest/health routes (they refuse to run without it). Generate:
  `openssl rand -hex 32`. Vercel Cron sends it automatically once set.
- `SITE_URL` — canonical public origin for email/OG links.

See [`.env.example`](.env.example) for the full annotated list.

### 3. Deploy

```bash
npm i -g vercel && vercel deploy
```

Add the same env vars in the Vercel dashboard. The crons in
[`vercel.json`](vercel.json) then run automatically: a per-city daily ingest,
staggered so each city gets its own run within the function's time budget
(Austin at 6:00am, Houston at 6:15am), plus the daily digest (8am) and weekly
digest (Mon 2pm).

**Migrations on deploy.** Postgres does not auto-migrate at runtime, so schema
changes must reach the shared DB before the code that needs them. CI applies them
for you: on every push to `main`, the `migrate` job in
[`ci.yml`](.github/workflows/ci.yml) runs `npm run migrate` — add a `DATABASE_URL`
repo secret (the Supabase pooler string) under **Settings → Secrets and variables
→ Actions** to enable it. Until that secret is set the step no-ops. Preview
deployments query the same DB, so a branch that adds a migration only previews
correctly once its migration is on the DB (run `npm run migrate` locally, or merge
to `main`).

## Observability

`GET /api/admin/health` (auth'd) returns the last runs per source and flags any
source that has gone `stale` (repeated errors/zero-events after previously
producing). Each ingest run records status, counts, and Gemini usage per source
in the `source_runs` ledger.

## Tests & CI

`npm test` runs three tiers: pure-function unit tests, fixture-based
source-parser tests (asserting no fabricated dates), and full PGlite-backed
integration tests (ingest → list → detail; subscribe → list → unsubscribe) with
zero external services. GitHub Actions runs `lint → tsc → test → build` on every
PR and on `main` (`.github/workflows/ci.yml`).

## Architecture notes

- **RSC-with-direct-DB fetching** — pages query the database in Server
  Components (`app/[city]/page.tsx`); no client fetch waterfall.
- **URL-as-state filters** — search, categories, date range, view, and calendar
  month all live in query params, so every view is shareable and server-rendered.
- **Catalog query layer** — `lib/db` runs raw SQL over a `Db` driver seam: a `pg`
  Pool (Supabase Postgres) in prod, embedded PGlite for zero-config local catalog
  dev/tests. The same `supabase/migrations-legacy/*` are the single schema truth.
- **Auth + user-private data** — Supabase Auth with per-user Row Level Security.
  Email + password is the default sign-in/sign-up (no email sent); passwordless
  magic-link login is a per-account opt-in (`profiles.magic_link_enabled`),
  gated server-side by `/api/auth/magic-link` so OTP emails go only to accounts
  that turned it on. Password reset is on-demand email. User-private reads/writes
  (favorites, interactions, interests, profile) go through the RLS-scoped
  Supabase client
  (`lib/user/data.ts`, `@supabase/ssr` → PostgREST), so the database enforces
  `auth.uid() = user_id`. Event metadata stays public. Local dev uses the Supabase
  CLI stack (`supabase start`); see `docs/RECOMMENDATIONS-SPEC.md`.
- This is a modified Next.js 16 build; breaking-change guides ship in
  `node_modules/next/dist/docs/` — read them before changing framework code (see
  [`AGENTS.md`](AGENTS.md)).
