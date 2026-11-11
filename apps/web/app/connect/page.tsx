import type { Metadata } from "next";
import { Suspense } from "react";
import { ConnectPage } from "../../components/connect-page";

export const metadata: Metadata = { title: "Connect your agent" };

export default function Page() {
  return (
    <Suspense>
      <ConnectPage />
    </Suspense>
  );
}
