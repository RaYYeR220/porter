import { GeistMono } from "geist/font/mono";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { preload } from "react-dom";
import { Footer } from "../components/site/Footer";
import { Nav } from "../components/site/Nav";
import { SITE_URL } from "../components/site/links";
import "./globals.css";

// General Sans is declared in globals.css and served from public/fonts (fetched by scripts/fonts.ts); when the
// files are missing the page falls back to a metric-matched Arial, so neither the build nor the layout depends on them.
const SANS_PRELOAD = ["/fonts/GeneralSans-Medium.woff2", "/fonts/GeneralSans-Regular.woff2"];

const DESCRIPTION =
  "Porter answers GitHub issues from strangers on open-weight models through Otari. Attacks are held at the gateway, " +
  "every author gets their own budget, and nothing gets labelled or closed until a maintainer approves it.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Porter", template: "%s · Porter" },
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Porter",
    title: "Porter: a front desk strangers can’t talk their way past",
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Porter: a front desk strangers can’t talk their way past",
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#12110f",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  for (const href of SANS_PRELOAD) preload(href, { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  return (
    <html lang="en" className={GeistMono.variable}>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <div className="grain" aria-hidden="true" />
        <Nav />
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}
