import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { Db } from "@keelson/db";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";

/** RFC 8707 resource identifier of this API; the `aud` of every access token it accepts. */
export const apiAudience = "https://api.keelson.finance";

const scopes = ["countersign:write", "alibis:read", "disputes:read", "operators:write"] as const;

export interface AuthEnv {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
}

export function createAuth(db: Db, env: AuthEnv) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    disabledPaths: ["/token"],
    plugins: [
      jwt(),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: [...scopes],
        grantTypes: ["client_credentials"],
        resources: [apiAudience],
        /** Must be gated on an operator or admin role once user sign-in exists. */
        clientPrivileges: () => true,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
