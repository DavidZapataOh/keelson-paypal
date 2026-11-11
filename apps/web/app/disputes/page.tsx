import type { Metadata } from "next";
import { Disputes } from "../../components/disputes";

export const metadata: Metadata = { title: "Disputes" };

export default function Page() {
  return <Disputes />;
}
