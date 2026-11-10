import type { Metadata } from "next";
import { MerchantConsole } from "../../components/merchant/console";

export const metadata: Metadata = {
  title: "Merchant console",
  description:
    "Your PayPal disputes over AI agent purchases, the signed verdict on each, and which agents fail which mandate checks.",
};

export default function Page() {
  return <MerchantConsole />;
}
