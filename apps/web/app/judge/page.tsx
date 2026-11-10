import type { Metadata } from "next";
import { JudgeMode } from "../../components/judge/tour";

export const metadata: Metadata = {
  title: "Judge Mode",
  description:
    "One click, no keys: a temporary tenant and a five-minute tour of Keelson on the live sandbox system.",
};

export default function Page() {
  return <JudgeMode />;
}
