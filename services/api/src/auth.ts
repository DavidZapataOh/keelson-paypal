import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import type { Db } from "@keelson/db";
import type { AuthenticationExtensionsClientInputs } from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins";

/** RFC 8707 resource identifier of this API; the `aud` of every access token it accepts. */
export const apiAudience = "https://api.keelson.finance";

/** The WebAuthn RP ID of every passkey outside tests. */
export const DEFAULT_RP_ID = "keelson.finance";

/** ES256 only: mandate signatures are verified with P-256 on chain. */
const pubKeyCredParams = [{ type: "public-key", alg: cose.COSEALG.ES256 }];

/** The Secure Payment Confirmation `payment` extension, which the WebAuthn typings lack. */
const paymentExtension = { payment: { isPayment: true } } as AuthenticationExtensionsClientInputs;

const scopes = ["countersign:write", "alibis:read", "disputes:read", "operators:write"] as const;

export interface AuthEnv {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  /** Origin of the app where passkey ceremonies run. */
  APP_ORIGIN: string;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_ENV: "sandbox" | "live";
  /** Overrides the WebAuthn RP ID; only for tests served from `localhost`. */
  PASSKEY_RP_ID?: string | undefined;
}

export function createAuth(db: Db, env: AuthEnv) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.APP_ORIGIN],
    disabledPaths: ["/token"],
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (ctx.path !== "/passkey/generate-register-options" || returned instanceof APIError)
          return;
        return ctx.json({ ...(returned as object), pubKeyCredParams });
      }),
    },
    user: {
      additionalFields: {
        role: { type: ["user", "admin"], required: true, defaultValue: "user", input: false },
      },
    },
    socialProviders: {
      paypal: {
        clientId: env.PAYPAL_CLIENT_ID,
        clientSecret: env.PAYPAL_CLIENT_SECRET,
        environment: env.PAYPAL_ENV,
      },
    },
    plugins: [
      jwt(),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: [...scopes],
        grantTypes: ["client_credentials"],
        resources: [apiAudience],
        clientPrivileges: ({ user }) => user?.role === "admin",
      }),
      // The app origin is a subdomain of the RP ID, so WebAuthn accepts it without a
      // Related Origins `/.well-known/webauthn` document. The `payment` extension lets the
      // passkey sign through Secure Payment Confirmation, which requires a user-verifying
      // platform authenticator holding a discoverable credential.
      passkey({
        rpID: env.PASSKEY_RP_ID ?? DEFAULT_RP_ID,
        rpName: "Keelson",
        origin: env.APP_ORIGIN,
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "required",
        },
        registration: {
          extensions: paymentExtension,
          afterVerification: ({ verification }) => {
            const key = verification.registrationInfo?.credential.publicKey;
            const alg = key && decodeCredentialPublicKey(key).get(cose.COSEKEYS.alg);
            if (alg !== cose.COSEALG.ES256) {
              throw new APIError("BAD_REQUEST", { message: "Passkeys must use ES256." });
            }
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
