import { GoogleGenAI } from '@google/genai'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getPgDb } from '@/lib/db/pg'

// The one and only Gemini client. Every model call in the app goes through
// geminiJson — fence-stripping, JSON parsing, retry-once-on-429, the RPM rate
// limiter, and the daily request budget live here and nowhere else. Callers pass
// a prompt (and optionally a responseSchema) and get back parsed JSON or null;
// null (missing key / budget exhausted / parse failure) is logged once and never
// thrown, so a source degrades to "no events" instead of crashing the run.

const apiKey = process.env.GEMINI_API_KEY
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null

// Extraction and tagging both run on Gemini 3.1 Flash-Lite — newer than the 2.5
// models it replaces, and its output rate ($1.50/1M) is well under 2.5 Flash's
// ($2.50/1M), so full-coverage ingest stays in single-digit dollars/month.
export const DEFAULT_MODEL = 'gemini-3.1-flash-lite'
export const TAGGING_MODEL = 'gemini-3.1-flash-lite'
export const EMBEDDING_MODEL = 'text-embedding-004'
export const EMBEDDING_DIM = 768

// True when a key is configured. Callers use it to skip work entirely (e.g. the
// keyword-tagger fallback) rather than issuing calls that would return null.
export function hasGemini(): boolean {
  return ai !== null
}

function intEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

// GEMINI_DAILY_BUDGET is a HARD daily request ceiling — the cost/quota guard.
// In prod it is enforced GLOBALLY across all serverless invocations via the
// gemini_usage table (see reserveBudget below), so it can't be multiplied by the
// number of concurrent cron windows. Default 500 gives full-coverage headroom
// (a full Monday needs ~150-200) while capping worst-case spend on the paid tier
// to a few dollars/day. GEMINI_RPM is the per-minute burst limit; on the paid
// tier RAISE it (e.g. 1000) — the free-tier default of 5 will otherwise serialize
// a heavy window past maxDuration and re-introduce the orphaning it once caused.
const RPM = intEnv('GEMINI_RPM', 5)
const DAILY_BUDGET = intEnv('GEMINI_DAILY_BUDGET', 500)

// Prod (real Postgres) shares the daily budget through gemini_usage; local
// PGlite dev (no DATABASE_URL, table absent) keeps the in-process counter.
const SHARED_BUDGET = !!process.env.DATABASE_URL

// ---------------------------------------------------------------------------
// Per-run accounting. Sources run concurrently, so a plain global counter can't
// attribute requests to a source. An AsyncLocalStorage-scoped meter lets each
// source's fetch+tag work tally its own requests/budget-skips even while other
// sources run — the orchestrator records the tally in source_runs.
// ---------------------------------------------------------------------------
export type GeminiMeter = { requests: number; skippedForBudget: number }
const meterStore = new AsyncLocalStorage<GeminiMeter>()

// Run `fn` inside a fresh meter; returns fn's result plus that scope's counts.
export async function withGeminiMeter<T>(fn: () => Promise<T>): Promise<{ result: T; meter: GeminiMeter }> {
  const meter: GeminiMeter = { requests: 0, skippedForBudget: 0 }
  const result = await meterStore.run(meter, fn)
  return { result, meter }
}

// ---------------------------------------------------------------------------
// Daily budget + RPM limiter. The daily budget is DB-backed and global in prod
// (reserveBudget → gemini_usage); dailyCount/dailyKey below are the local-dev
// fallback only. The RPM limiter stays per-invocation — crons are staggered, so
// per-minute bursts rarely overlap across windows, and RPM is a latency guard,
// not the cost cap.
// ---------------------------------------------------------------------------
let dailyCount = 0
let dailyKey = ''
let recent: number[] = [] // request timestamps within the trailing 60s

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// Reserve one request against the daily budget for `model`. Returns true if it
// was within budget (and the counter is now incremented), false if the cap is
// reached. Prod does an atomic compare-and-increment in gemini_usage so the cap
// holds across every concurrent invocation; local falls back to the in-process
// counter. A DB error fails OPEN (allows the call) rather than silently killing
// all Gemini features on a transient blip — the provider's own 429 still guards.
async function reserveBudget(model: string): Promise<boolean> {
  const day = today()
  if (!SHARED_BUDGET) {
    if (dailyKey !== day) { dailyKey = day; dailyCount = 0 }
    if (dailyCount >= DAILY_BUDGET) return false
    dailyCount++
    return true
  }
  try {
    const db = getPgDb()
    await db.query(
      `INSERT INTO gemini_usage (day, model, requests) VALUES ($1, $2, 0)
       ON CONFLICT (day, model) DO NOTHING`,
      [day, model]
    )
    const rows = await db.query<{ requests: number }>(
      `UPDATE gemini_usage SET requests = requests + 1
        WHERE day = $1 AND model = $2 AND requests < $3
        RETURNING requests`,
      [day, model, DAILY_BUDGET]
    )
    return rows.length > 0
  } catch (e) {
    console.error('gemini_usage budget check failed (allowing request):', (e as Error).message)
    return true
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Block until firing another request stays under RPM.
async function rateLimit(): Promise<void> {
  const now = Date.now()
  recent = recent.filter(t => now - t < 60_000)
  if (recent.length >= RPM) {
    const wait = 60_000 - (now - recent[0]) + 50
    await sleep(wait)
    return rateLimit()
  }
  recent.push(Date.now())
}

function isRateLimitError(e: unknown): boolean {
  const s = String((e as Error)?.message ?? e)
  return s.includes('429') || /RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(s)
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}

let warnedNoKey = false

export async function geminiJson<T>(opts: {
  prompt: string
  schema?: object
  model?: string
  maxOutputTokens?: number
}): Promise<T | null> {
  if (!ai) {
    if (!warnedNoKey) { console.warn('GEMINI_API_KEY not set — Gemini features disabled'); warnedNoKey = true }
    return null
  }

  const model = opts.model ?? DEFAULT_MODEL
  const meter = meterStore.getStore()
  if (!(await reserveBudget(model))) {
    if (meter) meter.skippedForBudget++
    return null
  }

  await rateLimit()
  if (meter) meter.requests++

  const call = () =>
    ai.models.generateContent({
      model,
      contents: opts.prompt,
      config: {
        temperature: 0,
        maxOutputTokens: opts.maxOutputTokens ?? 4096,
        ...(opts.schema ? { responseMimeType: 'application/json', responseSchema: opts.schema } : {}),
      },
    })

  let response
  try {
    response = await call()
  } catch (e) {
    if (isRateLimitError(e)) {
      await sleep(2000)
      try {
        response = await call() // retry once
      } catch (e2) {
        console.error('Gemini request failed (after 429 retry):', (e2 as Error).message)
        return null
      }
    } else {
      console.error('Gemini request failed:', (e as Error).message)
      return null
    }
  }

  try {
    return JSON.parse(stripFences(response.text ?? '')) as T
  } catch {
    console.error('Gemini returned unparseable JSON')
    return null
  }
}

// Embed a batch of texts to fixed-dimension vectors for the recommender's
// semantic feature. Returns one vector per input (order preserved), or null when
// no key is configured / the call fails — callers then leave the embedding unset
// and the scorer treats it as no signal, exactly like the tagger's keyword
// fallback. Kept separate from the geminiJson budget: embeddings are a different,
// cheaper quota and run in a backfill, not the per-run ingest meter.
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (!ai || texts.length === 0) return null
  try {
    const res = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: texts,
    })
    const vectors = res.embeddings?.map(e => e.values ?? []) ?? []
    if (vectors.length !== texts.length || vectors.some(v => v.length === 0)) return null
    return vectors
  } catch (e) {
    console.error('Gemini embedding failed:', (e as Error).message)
    return null
  }
}

// Bounded-concurrency map — the one concurrency helper, replacing the four
// hand-rolled worker pools. Preserves input order in the output.
export async function mapPool<A, B>(items: A[], limit: number, fn: (a: A, i: number) => Promise<B>): Promise<B[]> {
  const out: B[] = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}
