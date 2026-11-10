import type { Metadata } from "next";
import { NewMandate } from "../../components/new-mandate";

export const metadata: Metadata = { title: "New mandate" };

export default function Page() {
  return <NewMandate />;
}
