/** The API the app calls with the session cookie; `NEXT_PUBLIC_API_ORIGIN` overrides it at build time. */
export const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "https://api.keelson.finance";

/** The public Alibi verifier. */
export const VERIFY = "https://verify.keelson.finance";
