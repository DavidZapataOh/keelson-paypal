import type { Metadata } from "next";
import { OperatorConsole } from "../../components/operator/console";

export const metadata: Metadata = {
  title: "Operator console",
  description:
    "Your agent's PYUSD bond, its trust grade and premium, and every purchase the bond covers, with the verdict and slash history of each.",
};

export default function Page() {
  return <OperatorConsole />;
}
