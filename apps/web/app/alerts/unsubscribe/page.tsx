import type { Metadata } from "next";
import { Suspense } from "react";
import { AlertLinkPage } from "../../../components/alert-link-page";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false } };

export default function Page() {
  return (
    <Suspense>
      <AlertLinkPage kind="unsubscribe" />
    </Suspense>
  );
}
