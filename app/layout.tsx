import type { Metadata } from "next";
import { Onest, Unbounded } from "next/font/google";
import Script from "next/script";
import { GoogleAnalytics } from "@next/third-parties/google";
import { getBaseUrl } from "@/lib/site";
import { organizationJsonLd, websiteJsonLd, jsonLdHtml } from "@/lib/jsonLd";
import { SiteFooter } from "@/components/SiteFooter";
import { CookieConsent } from "@/components/CookieConsent";
import { WebVitals } from "@/components/WebVitals";
import "./globals.css";

// Google Analytics 4 measurement id (e.g. G-XXXXXXXXXX). Public by design and
// inlined at build time. Set only in the deploy environment — when absent
// (local dev, previews without the var) all analytics below no-op, so nothing
// loads and the console stays clean.
const gaId = process.env.NEXT_PUBLIC_GA_ID;

// Warm, rounded grotesk for body/UI text — a distinctive Inter alternative
// that still holds up at small sizes in dense filter rows and event cards.
const onest = Onest({
  variable: "--font-onest",
  subsets: ["latin"],
});

// Blocky, geometric display face for headlines/wordmark — matches the bold
// poster-color palette instead of receding into a generic system sans.
const unbounded = Unbounded({
  variable: "--font-unbounded",
  subsets: ["latin"],
});

const TITLE = "Whats Happenin — Local Events, Concerts & Things To Do";
const DESCRIPTION =
  "Discover things to do in your city: concerts, festivals, comedy, food & drink, arts, and more — aggregated daily and searchable by date and category.";

export const metadata: Metadata = {
  metadataBase: new URL(getBaseUrl()),
  title: {
    default: TITLE,
    template: "%s · Whats Happenin",
  },
  description: DESCRIPTION,
  applicationName: "Whats Happenin",
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Whats Happenin",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  // Domain ownership for Google Search Console and Bing Webmaster Tools. Paste
  // the tokens as env vars (GOOGLE_SITE_VERIFICATION / BING_SITE_VERIFICATION)
  // and Next emits the corresponding <meta> tags; DNS-TXT verification is an
  // alternative that needs no code. Omitted entirely when unset.
  verification: {
    ...(process.env.GOOGLE_SITE_VERIFICATION
      ? { google: process.env.GOOGLE_SITE_VERIFICATION }
      : {}),
    ...(process.env.BING_SITE_VERIFICATION
      ? { other: { "msvalidate.01": process.env.BING_SITE_VERIFICATION } }
      : {}),
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${onest.variable} ${unbounded.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {gaId && (
          // Consent Mode v2 defaults, set before gtag.js configures (this runs
          // beforeInteractive; GoogleAnalytics's config runs afterInteractive).
          // Everything is denied by default; the <CookieConsent /> banner flips
          // analytics_storage to 'granted' only after the visitor opts in, and
          // re-grants on later visits from the stored choice. Ads stay off.
          <Script id="ga-consent-default" strategy="beforeInteractive">
            {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
});`}
          </Script>
        )}
        {/* Site-wide brand identity for Google (knowledge panel / sitelinks). */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdHtml(organizationJsonLd()) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdHtml(websiteJsonLd()) }}
        />
        {children}
        <SiteFooter />
        {gaId && <CookieConsent />}
        {gaId && <WebVitals />}
        {gaId && <GoogleAnalytics gaId={gaId} />}
      </body>
    </html>
  );
}
