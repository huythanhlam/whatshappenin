import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Cookie Policy',
  description:
    'How Whats Happenin uses cookies — essential cookies that keep you signed in and remember your consent choice, plus optional Google Analytics, and how to control them.',
}

// Static, city-agnostic legal page. Single canonical /cookies URL for the footer.
const UPDATED = 'July 22, 2026'

export default function CookiesPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-12 sm:py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to events
        </Link>

        <h1 className="mt-6 font-display text-3xl sm:text-4xl font-semibold tracking-tight text-foreground">
          Cookie Policy
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated {UPDATED}</p>

        <div className="mt-8 space-y-8 text-[15px] leading-relaxed text-foreground/90">
          <p>
            Cookies are small text files a site stores in your browser. We use a small number of them
            to keep the site working and to understand how it&rsquo;s used. This policy explains which
            cookies we use and how you can control them. For the bigger picture of how we handle your
            data, see our{' '}
            <Link href="/privacy" className="font-medium text-primary hover:underline">
              Privacy Policy
            </Link>
            .
          </p>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Essential cookies</h2>
            <p>
              These are required for the site to function and are always on. They keep you signed in to
              your account (our authentication is provided by Supabase) and remember your cookie-consent
              choice so we don&rsquo;t ask again on every visit. They don&rsquo;t track you for
              advertising.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Analytics cookies</h2>
            <p>
              With your consent, we use Google Analytics 4 to understand how visitors find and use the
              site — for example which pages are popular and how many people sign up. It sets cookies
              and collects information such as your approximate location, device, and pages visited, and
              measures page performance. We do not use this data for advertising. Analytics stay off
              until you accept them in the consent banner; if you decline, these cookies are not set.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">No advertising cookies</h2>
            <p>
              We don&rsquo;t run ads and don&rsquo;t use advertising or cross-site tracking cookies.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Managing your choices</h2>
            <ul className="list-disc space-y-2 pl-5 text-foreground/90">
              <li>
                Use the consent banner shown on your first visit to accept or decline analytics
                cookies. To change your choice later, clear this site&rsquo;s data in your browser and
                the banner will appear again.
              </li>
              <li>
                Your browser settings let you block or delete cookies for any site. Blocking essential
                cookies may stop you from staying signed in.
              </li>
              <li>
                You can opt out of Google Analytics across all sites with Google&rsquo;s{' '}
                <a
                  href="https://tools.google.com/dlpage/gaoptout"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-primary hover:underline"
                >
                  opt-out browser add-on
                </a>
                .
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Changes to this policy</h2>
            <p>
              We may update this policy from time to time. When we do, we&rsquo;ll revise the
              &ldquo;last updated&rdquo; date above.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
