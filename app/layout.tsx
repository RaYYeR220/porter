import type { Metadata, Viewport } from "next";
import { Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { Footer } from "../components/site/Footer";
import { Nav } from "../components/site/Nav";
import { SITE_URL } from "../components/site/links";
import "./globals.css";

// General Sans (Indian Type Foundry, Fontshare Free Font License), fetched into public/fonts by scripts/fonts.ts.
const sans = localFont({
  src: [
    { path: "../public/fonts/GeneralSans-Regular.woff2", weight: "400", style: "normal" },
    { path: "../public/fonts/GeneralSans-Medium.woff2", weight: "500", style: "normal" },
    { path: "../public/fonts/GeneralSans-Semibold.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-sans",
  display: "swap",
  adjustFontFallback: "Arial",
});

const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

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
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
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
