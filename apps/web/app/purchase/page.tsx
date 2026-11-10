import type { Metadata } from "next";
import { Suspense } from "react";
import { PurchasePage } from "../../components/purchase-page";

export const metadata: Metadata = { title: "Purchase" };

export default function Page() {
  return (
    <Suspense>
      <PurchasePage />
    </Suspense>
  );
}
