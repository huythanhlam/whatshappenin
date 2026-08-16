// Artist fame lookup — the one signal that knows a household name is a
// household name before anybody has clicked anything.
//
// Every other prominence sub-signal is circumstantial (big room, many sources,
// tickets moving), and none of them can tell a stadium headliner from a long
// theatrical booking. This one is direct, so "a popular musician is in town" is
// answerable at ingest time from the event's billing alone.
//
// TWO PROVIDERS, and the default is deliberately the keyless one:
//
//   * Deezer (default) — no API key, no account, no OAuth. Publishes `nb_fan`
//     per artist, which separates a stadium act from a local one across four
//     orders of magnitude. This is the whole reason the feature needs no
//     credentials to work.
//   * Spotify (opt-in) — used only when SPOTIFY_CLIENT_ID/SECRET are set. Adds a
//     0–100 `popularity` index that Deezer has no equivalent of, and which is
//     recency-aware where follower counts only ever accumulate. Strictly an
//     upgrade, and it costs a Spotify Premium developer account, so it is not
//     required. Note this uses the client-credentials flow: an app-level token
//     authorizing zero end users, so Spotify's authorized-user cap is not in
//     play — only the Premium requirement on the developer account is.
//
// Results are cached in the `artists` table keyed by normalized name, so one
// lookup serves every date on a tour — and misses are cached too, or a name that
// resolves to nothing would be re-queried on every ingest forever.
//
// Returns null (never throws) whenever a lookup fails or the `artists` table
// doesn't exist — the graceful-degradation contract migration 046 documents.
// computeProminence reads a null artist as "unknown", not "unknown artist".

import { getCachedArtist, upsertCachedArtist, type ArtistCacheRow } from '../db'
import type { ArtistFame } from './prominence'

// How long a cached lookup stays fresh. Fame drifts over weeks, not hours, and
// the catalog only ever asks about artists actually booked here.
const CACHE_TTL_MS = 30 * 86_400_000

// Below this, a search hit is not the artist we asked about. Both providers'
// search is fuzzy and will happily return a tribute band or an unrelated act
// with a similar name; scoring a local covers band as a superstar is a much
// worse error than scoring a real superstar as unknown, so the bar is
// exact-normalized-match-or-nothing.
const MIN_CONFIDENCE = 1.0

// Match key for the artist cache. Deliberately more aggressive than
// normalizeVenue: a leading "the" and any parenthetical qualifier are noise that
// differs between how Ticketmaster and SeatGeek spell the same act.
export function normalizeArtist(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics: "Beyoncé" === "Beyonce"
    .replace(/\([^)]*\)/g, ' ') // "Sza (18+ Event)" → "sza"
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// What a provider returns for a confident match.
type Lookup = {
  provider: 'deezer' | 'spotify'
  externalId: string
  displayName: string
  popularity: number | null
  followers: number
}

// Pick the first result whose normalized name matches exactly. Both providers
// rank their own search results by relevance, so the first exact match is the
// right one; anything else is a different act.
function exactMatch<T>(items: T[], wanted: string, nameOf: (item: T) => string): T | null {
  return items.find(i => normalizeArtist(nameOf(i))=== wanted) ?? null
}

// --- Deezer (no credentials) ------------------------------------------------

type DeezerArtist = { id: number | string; name: string; nb_fan?: number }

async function lookupDeezer(name: string): Promise<Lookup | null> {
  const url = new URL('https://api.deezer.com/search/artist')
  url.searchParams.set('q', name)
  url.searchParams.set('limit', '5')

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: DeezerArtist[] }
    const hit = exactMatch(data.data ?? [], normalizeArtist(name), a => a.name)
    if (!hit) return null
    return {
      provider: 'deezer',
      externalId: String(hit.id),
      displayName: hit.name,
      popularity: null, // Deezer publishes no popularity index
      followers: hit.nb_fan ?? 0,
    }
  } catch {
    return null
  }
}

// --- Spotify (opt-in, client credentials) -----------------------------------

type SpotifyArtist = {
  id: string
  name: string
  popularity?: number
  followers?: { total?: number }
}

let tokenCache: { token: string; expiresAtMs: number } | null = null

export function spotifyAvailable(): boolean {
  return !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET)
}

// Client-credentials flow: an app-level token, no user auth, no refresh. Cached
// in module scope and re-fetched a minute before expiry.
async function getToken(): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAtMs > Date.now()) return tokenCache.token
  if (!spotifyAvailable()) return null

  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64')

  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!data.access_token) return null
    tokenCache = {
      token: data.access_token,
      expiresAtMs: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
    }
    return tokenCache.token
  } catch {
    return null
  }
}

async function lookupSpotify(name: string): Promise<Lookup | null> {
  const token = await getToken()
  if (!token) return null

  const url = new URL('https://api.spotify.com/v1/search')
  url.searchParams.set('q', name)
  url.searchParams.set('type', 'artist')
  url.searchParams.set('limit', '5')

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { artists?: { items?: SpotifyArtist[] } }
    const hit = exactMatch(data.artists?.items ?? [], normalizeArtist(name), a => a.name)
    if (!hit) return null
    return {
      provider: 'spotify',
      externalId: hit.id,
      displayName: hit.name,
      popularity: hit.popularity ?? null,
      followers: hit.followers?.total ?? 0,
    }
  } catch {
    return null
  }
}

// Spotify when configured (its popularity index is the better signal), Deezer
// otherwise — and Deezer as the fallback if a configured Spotify lookup misses,
// since the two catalogs don't agree on spelling for every act.
async function lookupFame(name: string): Promise<Lookup | null> {
  if (spotifyAvailable()) {
    const hit = await lookupSpotify(name)
    if (hit) return hit
  }
  return lookupDeezer(name)
}

// --- Cache ------------------------------------------------------------------
// The SQL itself lives in lib/db (one home for every query, per the driver
// seam's contract); this module owns only the freshness and confidence policy.

// A cached row becomes usable fame only if it was a confident match. A cached
// miss is a real answer — "we looked, there's no such artist" — and yields null.
function toFame(row: ArtistCacheRow): ArtistFame | null {
  if (row.confidence < MIN_CONFIDENCE) return null
  if (row.popularity === null && row.followers === null) return null
  return { popularity: row.popularity, followers: Number(row.followers ?? 0) }
}

// --- Public API -------------------------------------------------------------

// How many candidate names one event may spend lookups on. Callers that have no
// stored performer pass title-derived guesses (see titleArtistCandidates), and
// each miss costs a request and a cached-miss row, so the list is capped.
const MAX_CANDIDATES = 2

// Resolve an event's billing to its headliner's fame.
//
// `candidates` is tried in order, first confident match wins. Normally that's
// `signals.performers` — which every ticketing API sorts headliner-first — but a
// caller with no stored performers may pass title-derived guesses instead. The
// exact-normalized-match requirement is what makes that safe: a title like "The
// Art of Banksy" matches no artist and correctly yields null.
//
// Never throws.
export async function resolveArtistFame(candidates: string[] | undefined): Promise<ArtistFame | null> {
  for (const candidate of (candidates ?? []).slice(0, MAX_CANDIDATES)) {
    const fame = await resolveOne(candidate)
    if (fame) return fame
  }
  return null
}

async function resolveOne(name: string): Promise<ArtistFame | null> {
  const headliner = name
  if (!headliner) return null

  const nameNorm = normalizeArtist(headliner)
  if (!nameNorm) return null

  const cached = await getCachedArtist(nameNorm)
  const fresh = cached && Date.now() - new Date(cached.refreshed_at).getTime() < CACHE_TTL_MS
  if (cached && fresh) return toFame(cached)

  const hit = await lookupFame(headliner)
  await upsertCachedArtist({
    nameNorm,
    displayName: hit?.displayName ?? headliner,
    provider: hit?.provider ?? null,
    externalId: hit?.externalId ?? null,
    popularity: hit?.popularity ?? null,
    followers: hit?.followers ?? null,
    confidence: hit ? 1.0 : 0,
  })

  // A stale cached row beats nothing when the refresh itself failed.
  if (!hit) return cached ? toFame(cached) : null
  return { popularity: hit.popularity, followers: hit.followers }
}

// Plausible artist names extracted from an event title, for the catalog that
// predates signals capture (or sources that never carry a billing). Ordered
// most-specific first.
//
// This is deliberately shallow — it only strips the packaging that promoters put
// around a name, and leans on the exact-match requirement in the provider to
// throw out everything that isn't really an artist. Anything cleverer would
// start inventing matches.
export function titleArtistCandidates(title: string): string[] {
  const out: string[] = []
  const push = (s: string) => {
    const t = s.trim()
    if (t.length >= 2 && t.length <= 60 && !out.includes(t)) out.push(t)
  }

  push(title)
  // "X presents Y" / "X Presents: Y" → the act is usually Y, sometimes X.
  const presents = title.match(/^(.*?)\s+presents:?\s+(.*)$/i)
  if (presents) {
    push(presents[2])
    push(presents[1])
  }
  // Strip a trailing tour name or qualifier: "JACK WHITE LIVE 2026",
  // "Deorro (18 and Over)", "Khruangbin - World Tour", "Artist w/ Support".
  push(title.replace(/\s*\([^)]*\)\s*$/, ''))
  push(title.split(/\s+[-–—]\s+/)[0])
  push(title.split(/\s+(?:w\/|with|feat\.?|featuring)\s+/i)[0])
  push(title.replace(/[:,]?\s*(the\s+)?[\w' ]*\btour\b.*$/i, ''))

  return out
}
