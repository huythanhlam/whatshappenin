import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, Mail } from 'lucide-react'
import { INSTAGRAM_HANDLE, INSTAGRAM_URL, SUPPORT_EMAIL } from '@/lib/contact'

export const metadata: Metadata = {
  title: 'Contact',
  description:
    'Get in touch with Whats Happenin — support, event submissions, and press or partnership inquiries.',
}

// Static, city-agnostic page. Single canonical /contact URL for the footer.
export default function ContactPage() {
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
          Contact us
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We usually reply within a few days.
        </p>

        <div className="mt-8 space-y-8 text-[15px] leading-relaxed text-foreground/90">
          <p>
            Have a question, found a bug, or want to reach the team? The best way to get to us is by
            email — and you can always find us on Instagram.
          </p>

          <div className="flex flex-col gap-3 sm:flex-row">
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Mail className="h-4 w-4" />
              {SUPPORT_EMAIL}
            </a>
            <a
              href={INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:border-primary hover:text-primary"
            >
              {INSTAGRAM_HANDLE}
            </a>
          </div>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Support</h2>
            <p>
              Trouble with your account, an email digest, or the site itself? Email us at{' '}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="font-medium text-primary hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>{' '}
              and we&rsquo;ll help you out.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Submit an event</h2>
            <p>
              Hosting or know about something happening? You can submit it yourself from your
              city&rsquo;s submit page (for example{' '}
              <Link href="/austin/submit" className="font-medium text-primary hover:underline">
                Austin
              </Link>{' '}
              or{' '}
              <Link href="/houston/submit" className="font-medium text-primary hover:underline">
                Houston
              </Link>
              ). Submissions are reviewed before they appear publicly. Questions about a submission?
              Just email us.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Press &amp; partnerships</h2>
            <p>
              For media, partnership, or business inquiries, reach out to{' '}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="font-medium text-primary hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>{' '}
              and tell us what you have in mind.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
