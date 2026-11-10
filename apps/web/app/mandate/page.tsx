import type { Metadata } from "next";
import { Suspense } from "react";
import { MandatePage } from "../../components/mandate-page";

export const metadata: Metadata = { title: "Mandate" };

export default function Page() {
  return (
    <Suspense>
      <MandatePage />
    </Suspense>
  );
}
