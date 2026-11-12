"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { registerWorker } from "../lib/push";
import { Header } from "./header";

/** Routes that draw their own chrome: the onboarding steps and the app. */
const OWN_CHROME = new Set([
  "/",
  "/new/",
  "/purchase/",
  "/disputes/",
  "/mandate/",
  "/live/",
  "/scoreboard/",
  "/scoreboard/methodology/",
  "/merchant/",
  "/operator/",
  "/judge/",
  "/agents/",
  "/developers/",
  "/connect/",
  "/consent/",
  "/sign-in/",
  "/passkeys/",
  "/embed/approve/",
  "/activity/",
  "/alerts/",
  "/alerts/confirm/",
  "/alerts/unsubscribe/",
  "/amount/",
]);

export function Chrome({ children }: { children: ReactNode }) {
  const path = usePathname();
  // The worker shows phone approvals; it is registered once the app has loaded.
  useEffect(() => {
    void registerWorker()?.catch(() => {});
  }, []);
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
