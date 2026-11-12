import type { Metadata } from "next";
import { Suspense } from "react";
import { AmountConfirmPage } from "../../components/amount-confirm";

export const metadata: Metadata = { title: "Confirm the amount" };

export default function Page() {
  return (
    <Suspense>
      <AmountConfirmPage />
    </Suspense>
  );
}
