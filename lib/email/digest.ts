import { Resend } from 'resend'
import type { Event, Category } from '@/lib/types'
import { listSubscriptions, getEventsBetween, getCityById } from '@/lib/db'
import { escapeHtml, safeUrl } from '@/lib/html'
import { getBaseUrl } from '@/lib/site'

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

// Verified sender for production; falls back to Resend's shared sandbox address
// (which only delivers to the account owner) when EMAIL_FROM is unset.
export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'Whats Happenin <onboarding@resend.dev>'

export type DigestFrequency = 'daily' | 'weekly'

type EventWithCats = Event & { categories?: Category[]; neighborhood?: string | null }

// Applies a subscriber's category/free-only/neighborhood preferences, in that
// order, to the city's event window. Each filter is a no-op when the
// subscriber left it unset (empty categories/neighborhoods, free_only false).
export function filterEventsForSubscriber(
  events: EventWithCats[],
  sub: { category_slugs: string[]; free_only: boolean; neighborhoods: string[] }
): EventWithCats[] {
  let filtered = sub.category_slugs?.length
    ? events.filter(e => e.categories?.some(c => sub.category_slugs.includes(c.slug)))
    : events
  if (sub.free_only) filtered = filtered.filter(e => e.is_free)
  if (sub.neighborhoods?.length) filtered = filtered.filter(e => e.neighborhood && sub.neighborhoods.includes(e.neighborhood))
  return filtered
}

// Design tokens mirror app/globals.css (light theme) so the digest reads as the
// same product: cream canvas, white cards, coral brand, slate/moss text.
const C = {
  bg: '#F9FAF4',        // --background (cream-100)
  card: '#FFFFFF',      // --card
  border: '#E2E4DA',    // --border
  text: '#4A6163',      // --foreground (slate-600)
  heading: '#1C2929',   // --primary-foreground (slate-900)
  muted: '#7C9092',     // --muted-foreground
  primary: '#F17A7E',   // --primary (coral-500)
  price: '#7C9A4F',     // --success (moss-500)
}
// Body uses Onest, wordmark uses Unbounded — both with graceful fallbacks since
// most email clients won't load web fonts.
const FONT_SANS = "'Onest', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
// 'Unbounded Wordmark' is the subsetted face embedded below (just the wordmark's
// glyphs), so the brand name renders in the real display type even in clients
// that block remote fonts. Falls back to the remote Unbounded, then system.
const FONT_DISPLAY = "'Unbounded Wordmark', 'Unbounded', 'Onest', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"

// Subsetted Unbounded 700 (glyphs for "Whats Happenin" only, ~1.6KB woff2,
// base64-inlined) so the wordmark keeps the brand type without a network fetch.
// Regenerate with: pyftsubset unbounded-latin.woff2 --text="Whats Happenin" --flavor=woff2
const WORDMARK_FONT_FACE = "@font-face{font-family:'Unbounded Wordmark';font-style:normal;font-weight:700;font-display:swap;src:url(data:font/woff2;base64,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) format('woff2')}"

// A category chip tinted from the category's own color, matching EventCard: fill
// at ~9% alpha, border at ~27%, text at full color (18/44 in hex = those alphas).
function categoryChip(name: string, color: string): string {
  const c = escapeHtml(color)
  return `<span style="display:inline-block;font-size:11px;line-height:1;padding:5px 8px;margin:0 4px 4px 0;border-radius:9999px;background:${c}18;color:${c};border:1px solid ${c}44">${escapeHtml(name)}</span>`
}

function buildDigestHtml(events: EventWithCats[], unsubscribeUrl: string, dateLabel: string, cityName: string, baseUrl: string): string {
  const eventHtml = events.slice(0, 12).map(e => {
    const date = new Date(e.start_time).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    })
    const chips = (e.categories ?? []).slice(0, 3).map(c => categoryChip(c.name, c.color)).join('')
    const priceLabel = e.is_free ? 'Free' : e.price_min ? `$${escapeHtml(e.price_min)}` : ''
    const image = safeUrl(e.image_url)
    const ticket = safeUrl(e.ticket_url)
    return `
      <div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;overflow:hidden;margin-bottom:16px;box-shadow:0 1px 2px rgba(28,41,41,0.06)">
        ${image ? `<img src="${image}" alt="" style="display:block;width:100%;height:176px;object-fit:cover">` : ''}
        <div style="padding:16px">
          <h3 style="margin:0 0 8px;font-family:${FONT_SANS};font-size:16px;font-weight:600;line-height:1.3;color:${C.heading}">${escapeHtml(e.title)}</h3>
          <p style="margin:0 0 4px;font-size:13px;color:${C.muted}">📅 ${escapeHtml(date)}</p>
          ${e.venue_name ? `<p style="margin:0 0 4px;font-size:13px;color:${C.muted}">📍 ${escapeHtml(e.venue_name)}</p>` : ''}
          ${priceLabel ? `<p style="margin:6px 0 0;font-size:13px;font-weight:600;color:${C.price}">${priceLabel}</p>` : ''}
          ${chips ? `<div style="margin-top:10px">${chips}</div>` : ''}
          ${ticket ? `<div style="margin-top:14px"><a href="${ticket}" style="display:inline-block;background:${C.primary};color:${C.heading};padding:9px 14px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">View event →</a></div>` : ''}
        </div>
      </div>
    `
  }).join('')

  return `
    <!-- Pull in the site's Onest (body) + Unbounded (wordmark) faces. Clients that
         honor <style>/@import (Apple Mail, iOS Mail, Outlook for Mac) render the
         real typefaces; the rest fall back to the system stacks in FONT_SANS. -->
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600&family=Unbounded:wght@700&display=swap');
      ${WORDMARK_FONT_FACE}
    </style>
    <div style="background:${C.bg};margin:0;padding:24px 0;font-family:${FONT_SANS}">
      <div style="max-width:600px;margin:0 auto;padding:0 24px">
        <div style="padding:8px 0 16px">
          <h1 style="margin:0 0 4px;font-family:${FONT_DISPLAY};font-size:24px;font-weight:700;letter-spacing:-0.01em;color:${C.primary}">Whats Happenin</h1>
          <p style="margin:0;font-size:14px;color:${C.text}">${escapeHtml(cityName)} events — ${escapeHtml(dateLabel)}</p>
        </div>
        <hr style="border:none;border-top:1px solid ${C.border};margin:0 0 20px">
        ${eventHtml}
        ${events.length === 0 ? `<p style="color:${C.muted};text-align:center;padding:24px 0">No events found for your filters.</p>` : ''}
        <hr style="border:none;border-top:1px solid ${C.border};margin:24px 0 0">
        <div style="text-align:center;padding-top:20px">
          <img src="${escapeHtml(baseUrl)}/brand/icon/icon-128.png" alt="Whats Happenin" width="48" height="48" style="display:inline-block;width:48px;height:48px;border-radius:12px;border:1px solid ${C.border}">
          <p style="margin:10px 0 0;font-family:${FONT_DISPLAY};font-size:14px;font-weight:700;color:${C.primary}">Whats Happenin</p>
          <p style="margin:12px 0 0;font-size:12px;color:${C.muted}">
            <a href="${escapeHtml(unsubscribeUrl)}" style="color:${C.muted}">Unsubscribe</a>
          </p>
        </div>
      </div>
    </div>
  `
}

export async function sendDigests(frequency: DigestFrequency, cityId: number) {
  const city = await getCityById(cityId)
  if (!city) return { sent: 0, frequency, cityId }

  const baseUrl = getBaseUrl()
  const subs = await listSubscriptions(frequency, cityId)
  if (!subs.length) return { sent: 0, frequency, cityId }

  const now = new Date()
  const windowDays = frequency === 'weekly' ? 7 : 1
  const end = new Date(now.getTime() + windowDays * 86400000)

  const rawEvents = await getEventsBetween(cityId, now.toISOString(), end.toISOString())
  const events: EventWithCats[] = rawEvents.map(e => e as unknown as EventWithCats)

  const dateLabel = frequency === 'weekly'
    ? `week of ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`
    : now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const subject = frequency === 'weekly'
    ? `${city.name} events this week — ${dateLabel}`
    : `${city.name} events today — ${dateLabel}`

  let sent = 0

  for (const sub of subs) {
    const filtered = filterEventsForSubscriber(events, sub)

    // Unsubscribe is a POST (RFC 8058 one-click); the token travels in the query.
    const unsubscribeUrl = `${baseUrl}/api/unsubscribe?token=${sub.token}`

    if (!resend) { console.log(`[digest] would send to ${sub.email} (${filtered.length} events) — no RESEND_API_KEY`); continue }
    try {
      await resend.emails.send({
        from: EMAIL_FROM,
        to: sub.email,
        subject,
        html: buildDigestHtml(filtered, unsubscribeUrl, dateLabel, city.name, baseUrl),
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      })
      sent++
    } catch (e) {
      console.error(`Failed to send digest to ${sub.email}:`, e)
    }
  }

  return { sent, frequency, cityId }
}
