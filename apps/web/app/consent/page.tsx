import type { Metadata } from "next";
import { ConsentPage } from "../../components/consent-page";

export const metadata: Metadata = { title: "Allow access" };

export default function Page() {
  return <ConsentPage />;
}
