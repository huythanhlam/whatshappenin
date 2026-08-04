import Link from 'next/link'
import { INSTAGRAM_URL } from '@/lib/contact'

// Inline glyph: lucide-react (v1.22.0 in this project) ships no Instagram icon,
// so we draw the mark ourselves rather than import a non-existent export.
function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  )
}

export function SiteFooter() {
  const year = new Date().getFullYear()

  return (
    <footer className="mt-auto border-t border-border bg-card">
      <div className="max-w-7xl mx-auto px-4 py-12">
        {/* Centered brand: badge front and center, name + tagline beneath */}
        <div className="flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- decorative
              inline SVG badge from /public; no optimization needed and avoids
              enabling next/image's dangerouslyAllowSVG. */}
          <img
            src="/logo-badge-atx.svg"
            alt="Whats Happenin ATX badge"
            width={128}
            height={128}
            className="h-32 w-32 shrink-0"
          />
          <p className="mt-4 font-display text-xl font-semibold tracking-tight text-foreground">
            Whats Happenin
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Local events, concerts &amp; things to do.
          </p>

          {/* Social */}
          <a
            href={INSTAGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 inline-flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <InstagramIcon className="h-4 w-4" />
            Follow @whatshappenin.atx
          </a>
        </div>

        {/* Legal row */}
        <div className="mt-10 flex flex-col items-center gap-3 border-t border-border pt-6 text-sm text-muted-foreground sm:flex-row sm:justify-between">
          <p>© {year} Whats Happenin. All rights reserved.</p>
          <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 sm:justify-end">
            <Link href="/about" className="hover:text-primary transition-colors">
              About
            </Link>
            <Link href="/privacy" className="hover:text-primary transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-primary transition-colors">
              Terms
            </Link>
            <Link href="/cookies" className="hover:text-primary transition-colors">
              Cookies
            </Link>
            <Link href="/contact" className="hover:text-primary transition-colors">
              Contact
            </Link>
            <a
              href={INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-primary transition-colors"
            >
              Instagram
            </a>
          </nav>
        </div>
      </div>
    </footer>
  )
}
