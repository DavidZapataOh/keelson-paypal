import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { API } from "./config";

export const authClient = createAuthClient({
  baseURL: `${API}/api/auth`,
  fetchOptions: { credentials: "include" },
  plugins: [passkeyClient()],
});

/** Set while this browser has a session, so the next visit skips the visitor's welcome. */
export const SESSION_HINT = "keelson.session";
