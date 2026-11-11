"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Header } from "./header";

/** Routes that draw their own chrome: the onboarding steps and the app. */
const OWN_CHROME = new Set(["/", "/new/", "/purchase/", "/disputes/"]);

export function Chrome({ children }: { children: ReactNode }) {
  const path = usePathname();
  if (OWN_CHROME.has(path.endsWith("/") ? path : `${path}/`)) return <>{children}</>;
  return (
    <>
      <Header />
      <main id="main" className="mx-auto w-full max-w-5xl px-5 pt-6 pb-24 sm:px-8">
        {children}
      </main>
    </>
  );
}
