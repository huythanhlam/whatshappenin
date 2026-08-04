import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { SUPPORT_EMAIL } from '@/lib/contact'

export const metadata: Metadata = {
  title: 'Terms of Service',
  description:
    'The terms that govern your use of Whats Happenin — event listings, accounts, submissions, and the usual legal disclaimers.',
}

// Static, city-agnostic legal page. Single canonical /terms URL for the footer.
const UPDATED = 'July 22, 2026'

export default function TermsPage() {
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
          Terms of Service
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated {UPDATED}</p>

        <div className="mt-8 space-y-8 text-[15px] leading-relaxed text-foreground/90">
          <p>
            These Terms of Service (&ldquo;Terms&rdquo;) govern your use of Whats Happenin (&ldquo;we,&rdquo;
            &ldquo;us,&rdquo; the &ldquo;Service&rdquo;), a website that aggregates local events,
            concerts, and things to do. By accessing or using the Service, you agree to these Terms. If
            you don&rsquo;t agree, please don&rsquo;t use the Service.
          </p>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">The Service</h2>
            <p>
              We collect and organize event listings from many third-party sources — ticketing
              platforms, venues, organizers, calendars, and public posts. We don&rsquo;t organize,
              host, or sell tickets to these events, and we don&rsquo;t guarantee that any listing is
              accurate, complete, or up to date. Always confirm details (date, time, location, price,
              availability) with the organizer or venue before making plans or purchases.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Accounts</h2>
            <p>
              You can browse without an account. If you create one, you must provide accurate
              information, be old enough to form a binding contract in your jurisdiction, and keep your
              login credentials secure. You&rsquo;re responsible for activity under your account.
              Accounts are for individuals — one person per account. You may delete your account at any
              time from your account settings.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Acceptable use</h2>
            <p>You agree not to:</p>
            <ul className="list-disc space-y-2 pl-5 text-foreground/90">
              <li>Use the Service for any unlawful purpose or in violation of these Terms.</li>
              <li>
                Scrape, harvest, or bulk-download content, or access the Service through automated means
                except as expressly permitted.
              </li>
              <li>
                Interfere with, disrupt, or attempt to gain unauthorized access to the Service, its
                systems, or other users&rsquo; accounts.
              </li>
              <li>
                Submit content that is false, misleading, unlawful, infringing, or that you don&rsquo;t
                have the right to share.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Event submissions</h2>
            <p>
              If you submit an event, you confirm you have the right to share the information you
              provide, and you grant us a non-exclusive, royalty-free license to display, edit, format,
              and distribute it as part of the Service. Submissions are reviewed before they appear
              publicly, and we may edit, reject, or remove any submission at our discretion.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Third-party links &amp; tickets</h2>
            <p>
              Listings link out to ticketing platforms, venues, and organizers. Any purchase or
              interaction you make with them is governed by their terms and policies, not ours. We
              aren&rsquo;t the seller and aren&rsquo;t responsible for those transactions, refunds, or
              disputes — take those up with the organizer or ticketing provider.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Intellectual property</h2>
            <p>
              The Service&rsquo;s design, branding, and original content are ours or our licensors&rsquo;
              and are protected by applicable laws. Event data belongs to its respective sources. You
              may use the Service for personal, non-commercial purposes only.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Disclaimers</h2>
            <p>
              The Service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without
              warranties of any kind, whether express or implied, including fitness for a particular
              purpose and non-infringement. We don&rsquo;t warrant that the Service will be
              uninterrupted, error-free, or that event information is accurate.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Limitation of liability</h2>
            <p>
              To the fullest extent permitted by law, we won&rsquo;t be liable for any indirect,
              incidental, special, consequential, or punitive damages, or for any loss arising from your
              use of (or inability to use) the Service, including reliance on any event listing.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Indemnity</h2>
            <p>
              You agree to indemnify and hold us harmless from any claims, losses, or expenses arising
              out of your use of the Service, your submissions, or your violation of these Terms.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Changes to these Terms</h2>
            <p>
              We may update these Terms from time to time. When we do, we&rsquo;ll revise the
              &ldquo;last updated&rdquo; date above. Continued use of the Service after changes take
              effect means you accept the revised Terms.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Governing law</h2>
            <p>
              These Terms are governed by the laws of the State of Texas, USA, without regard to its
              conflict-of-laws rules. Any disputes will be subject to the courts located in Texas.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Contact</h2>
            <p>
              Questions about these Terms? Email us at{' '}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="font-medium text-primary hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>{' '}
              or reach out via our{' '}
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
