import type { Metadata } from "next";
import { EmbedApproval } from "../../../components/embed-approval";

export const metadata: Metadata = {
  title: "Approve a mandate",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <EmbedApproval />;
}
