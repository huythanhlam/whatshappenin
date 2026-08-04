import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export const metadata: Metadata = {
  title: 'About',
  description:
    'Whats Happenin aggregates local events, concerts, and things to do across Austin and Houston — updated daily from dozens of sources so you have one place to look instead of a dozen tabs.',
}

// Static, city-agnostic page. Lives at the app root (not under [city]) so
// there's a single canonical /about URL linked from the global footer.
export default function AboutPage() {
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
          About Whats Happenin
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Local events, concerts &amp; things to do — aggregated daily.
        </p>

        <div className="mt-8 space-y-8 text-[15px] leading-relaxed text-foreground/90">
          <p>
            Whats Happenin helps you find something to do in your city. We bring together concerts,
            festivals, comedy, food &amp; drink, arts, markets, and more into one place you can search
            by date and category — currently live for{' '}
            <strong className="font-semibold text-foreground">Austin</strong> and{' '}
            <strong className="font-semibold text-foreground">Houston</strong>.
          </p>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Why we built it</h2>
            <p>
              Local events are scattered across ticketing sites, venue calendars, social posts, and
              newsletters. Keeping up meant juggling a dozen tabs. We wanted one daily-updated place to
              see what&rsquo;s actually happening near you — so you spend less time searching and more
              time going out.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">How it works</h2>
            <p>
              Every day we gather events from a wide mix of public sources — Eventbrite, Ticketmaster,
              SeatGeek, Meetup, city and venue calendars, local publications, and more. We de-duplicate
              overlapping listings, tag them by category, and present them in a filterable grid, a
              calendar, and a map view so you can browse whichever way suits you.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Make it yours</h2>
            <p>
              Browsing is free and needs no account. Create one and you can save events, get
              recommendations tuned to what you like, and subscribe to a daily or weekly email digest
              filtered to the categories and neighborhoods you care about. You&rsquo;re always in
              control of your data — see our{' '}
              <Link href="/privacy" className="font-medium text-primary hover:underline">
                Privacy Policy
              </Link>{' '}
              for what we collect and how to delete it.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Get in touch</h2>
            <p>
              Spotted a missing event, a bug, or want to work together? We&rsquo;d love to hear from
              you — head to our{' '}
              <Link href="/contact" className="font-medium text-primary hover:underline">
                contact page
              </Link>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
