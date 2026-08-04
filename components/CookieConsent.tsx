'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

// Cookie consent banner that gates Google Analytics via Consent Mode v2.
//
// The layout's `beforeInteractive` script sets analytics_storage to 'denied' by
// default and defines a global `gtag`. This banner is the only thing that flips
// it to 'granted', and only after the visitor explicitly accepts. The choice is
// persisted so we don't re-prompt on every visit. Rendered only when GA is
// actually configured (see the `gaId` gate in app/layout.tsx) — there's nothing
// to consent to otherwise.

const STORAGE_KEY = 'wh-cookie-consent'
type Choice = 'granted' | 'denied'

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
  }
}

function grantAnalytics() {
  // gtag is defined by the beforeInteractive script in the layout; guard anyway
  // in case consent runs before that script (or GA is somehow absent).
  window.gtag?.('consent', 'update', { analytics_storage: 'granted' })
}

export function CookieConsent() {
  // Start hidden; decide on mount so SSR and the pre-choice client agree (no
  // flash of a banner the user already dismissed).
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let stored: string | null = null
    try {
      stored = window.localStorage.getItem(STORAGE_KEY)
    } catch {
      // localStorage can throw (private mode, blocked storage) — treat as no choice.
    }

    if (stored === 'granted') {
      grantAnalytics()
    } else if (stored !== 'denied') {
      // Intentional: we render hidden on the server and the first client paint
      // (hydration-safe, and no banner flash for visitors who already chose),
      // then reveal only after reading the client-only consent value. This is a
      // one-time sync from an external store, not a render-loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisible(true)
    }
  }, [])

  function choose(choice: Choice) {
    try {
      window.localStorage.setItem(STORAGE_KEY, choice)
    } catch {
      // If we can't persist, still honor the choice for this session.
    }
    if (choice === 'granted') grantAnalytics()
    // 'denied' needs no gtag call — the layout default is already 'denied'.
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-50 p-4 sm:p-6"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4 rounded-xl border border-border bg-card p-5 shadow-lg sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-relaxed text-foreground/90">
          We use essential cookies to run the site and, with your consent, Google Analytics to
          understand usage. See our{' '}
          <Link href="/cookies" className="font-medium text-primary hover:underline">
            Cookie Policy
          </Link>
          .
        </p>
        <div className="flex shrink-0 gap-3">
          <button
            type="button"
            onClick={() => choose('denied')}
            className="rounded-full border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => choose('granted')}
            className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  )
}
