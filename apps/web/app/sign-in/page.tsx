"use client";

import { Welcome } from "../../components/welcome";
import { API } from "../../lib/config";

/** The parameters the authorization server adds to sign the query; a fresh authorize adds them again. */
const SIGNATURE = new Set(["sig", "exp", "ba_iat", "ba_pl", "ba_param"]);

/**
 * The OAuth login page: after signing in, the browser goes back through the authorization
 * request it came from, now with a session, to the consent page.
 */
export default function SignIn() {
  const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  for (const key of [...params.keys()]) if (SIGNATURE.has(key)) params.delete(key);
  return (
    <Welcome
      title="Sign in to Keelson"
      line="An app asks to connect to your Keelson account. You choose what it may do next."
      returnTo={params.has("client_id") ? `${API}/api/auth/oauth2/authorize?${params}` : undefined}
    />
  );
}
