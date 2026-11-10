import type { Metadata } from "next";
import { Suspense } from "react";
import { NewMandate } from "../../components/new-mandate";

export const metadata: Metadata = { title: "New mandate" };

export default function Page() {
  return (
    <Suspense>
      <NewMandate />
    </Suspense>
  );
}
