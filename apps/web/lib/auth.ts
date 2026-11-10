import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { API } from "./config";

export const authClient = createAuthClient({
  baseURL: `${API}/api/auth`,
  fetchOptions: { credentials: "include" },
  plugins: [passkeyClient()],
});
