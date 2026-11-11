import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Chrome } from "../components/chrome";
import { SESSION_HINT } from "../lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Keelson", template: "%s · Keelson" },
  description: "Sign what your agent may buy. Every purchase is checked before it pays.",
  icons: { icon: "/favicon.svg", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = { themeColor: "#f2f0ea", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before paint: a browser that was signed in skips the visitor's welcome. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant, first-paint script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("${SESSION_HINT}"))document.documentElement.dataset.session=""}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <Chrome>{children}</Chrome>
      </body>
    </html>
  );
}
