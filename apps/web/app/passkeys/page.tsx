import type { Metadata } from "next";
import { PasskeySettings } from "../../components/passkey-settings";

export const metadata: Metadata = { title: "Passkeys" };

export default function Page() {
  return <PasskeySettings />;
}
