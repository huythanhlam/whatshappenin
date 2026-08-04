import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { INSTAGRAM_HANDLE, INSTAGRAM_URL, SUPPORT_EMAIL } from '@/lib/contact'

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'How Whats Happenin collects, uses, and protects your information when you browse events, subscribe to updates, or create an account.',
}

// Static, city-agnostic legal page. Lives at the app root (not under [city]) so
// there's a single canonical /privacy URL linked from the global footer.
const UPDATED = 'July 22, 2026'

export default function PrivacyPage() {
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
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated {UPDATED}</p>

        <div className="mt-8 space-y-8 text-[15px] leading-relaxed text-foreground/90">
          <p>
            Whats Happenin (&ldquo;we,&rdquo; &ldquo;us&rdquo;) helps you discover local events,
            concerts, and things to do. This policy explains what information we collect, how we use
            it, and the choices you have. By using the site you agree to the practices described here.
          </p>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Information we collect</h2>
            <ul className="list-disc space-y-2 pl-5 text-foreground/90">
              <li>
                <strong className="font-semibold text-foreground">Account details.</strong> If you
                create an account, we store your email address and password (the password is hashed by
                our authentication provider — we never see it), plus any profile details you set, such
                as a display name and your home city.
              </li>
              <li>
                <strong className="font-semibold text-foreground">Preferences.</strong> Choices you
                make during onboarding or in your profile — favorite categories, neighborhoods, days of
                the week, or a free-events-only preference — so we can tailor what you see.
              </li>
              <li>
                <strong className="font-semibold text-foreground">Email subscriptions.</strong> When
                you sign up for event updates, we store your email address and digest preferences so we
                can send the digests you requested. You can subscribe to digests without creating an
                account.
              </li>
              <li>
                <strong className="font-semibold text-foreground">Activity.</strong> To power
                recommendations and improve the site, we record actions like saving, hiding, marking
                interest in, sharing, or adding events to your calendar, checking in to events, and the
                search terms you enter. We derive a taste profile from this activity to personalize your
                recommendations. We also collect usage analytics such as pages viewed and sign-ups.
              </li>
              <li>
                <strong className="font-semibold text-foreground">Event submissions.</strong> If you
                submit an event, we collect the details you provide so we can review and publish it.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">How we use your information</h2>
            <ul className="list-disc space-y-2 pl-5 text-foreground/90">
              <li>Show you relevant events and personalized recommendations.</li>
              <li>Send the email updates and digests you&rsquo;ve subscribed to.</li>
              <li>Operate, maintain, secure, and improve the site.</li>
              <li>Review and publish events submitted by the community.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Accounts and sign-in</h2>
            <p>
              Accounts use email and a password by default. You can optionally enable a passwordless
              &ldquo;magic link&rdquo; sign-in, which emails you a one-time login link. Your account
              data is protected so that only you can access it.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Analytics and cookies</h2>
            <p>
              With your consent, we use Google Analytics to understand how visitors find and use the
              site — for example, which pages are popular and how many people sign up. Google Analytics
              sets cookies and collects information such as your approximate location, device, and pages
              visited, and also measures page performance (load speed and responsiveness). Analytics
              stay off until you accept them in our cookie banner. We do not use this data for
              advertising. See our{' '}
              <Link href="/cookies" className="font-medium text-primary hover:underline">
                Cookie Policy
              </Link>{' '}
              for details, or{' '}
              <a
                href="https://policies.google.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary hover:underline"
              >
                Google&rsquo;s Privacy Policy
              </a>
              .
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Service providers</h2>
            <p>
              We don&rsquo;t sell your personal information. We share data only with the providers that
              help us run the site, and only as needed to provide their service. These currently
              include:
            </p>
            <ul className="list-disc space-y-2 pl-5 text-foreground/90">
              <li>
                <strong className="font-semibold text-foreground">Supabase</strong> — authentication and
                our database, where your account and activity data are stored.
              </li>
              <li>
                <strong className="font-semibold text-foreground">Resend</strong> — delivers our emails
                (confirmations, digests, and sign-in links).
              </li>
              <li>
                <strong className="font-semibold text-foreground">Google Analytics</strong> — usage
                analytics, as described above.
              </li>
              <li>
                <strong className="font-semibold text-foreground">Vercel</strong> — hosts the site.
              </li>
            </ul>
            <p>
              We also use Google Maps and Google&rsquo;s Gemini to geocode venues, render maps, and
              process public event content — these handle event data, not your personal profile. We may
              update the providers we rely on from time to time, and may disclose information if
              required by law.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Data retention</h2>
            <p>
              We keep your personal data for as long as your account or subscription is active. We
              don&rsquo;t run on a fixed deletion schedule — instead you can remove your data yourself at
              any time (see &ldquo;Your choices&rdquo; below). Our application uses your IP address only
              transiently to rate-limit abusive requests and doesn&rsquo;t retain it; our hosting and
              infrastructure providers may log it briefly for security and operations.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Third-party links</h2>
            <p>
              Event listings link out to ticketing platforms, venues, and organizers. Once you leave
              our site, their privacy practices — not ours — govern the information you share with
              them.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Your choices</h2>
            <ul className="list-disc space-y-2 pl-5 text-foreground/90">
              <li>
                <strong className="font-semibold text-foreground">Delete your account.</strong> From
                your account settings you can permanently delete your account, which removes your
                profile, saved events, activity, and recommendation data.
              </li>
              <li>
                <strong className="font-semibold text-foreground">Clear your history.</strong> You can
                clear your activity history (which resets your recommendations) while keeping your
                account.
              </li>
              <li>
                <strong className="font-semibold text-foreground">Unsubscribe from email.</strong> Every
                digest includes a one-click unsubscribe link. An email subscription is separate consent,
                so it stays active even if you delete your account — unsubscribe to end it.
              </li>
            </ul>
            <p>
              You can also request access to or correction of your data by contacting us at the address
              below.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Changes to this policy</h2>
            <p>
              We may update this policy from time to time. When we do, we&rsquo;ll revise the
              &ldquo;last updated&rdquo; date above. Continued use of the site after changes take
              effect means you accept the revised policy.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-xl font-semibold text-foreground">Contact</h2>
            <p>
              Questions about this policy or your data? Email us at{' '}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="font-medium text-primary hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>{' '}
              or reach out via Instagram,{' '}
              <a
                href={INSTAGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary hover:underline"
              >
                {INSTAGRAM_HANDLE}
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
