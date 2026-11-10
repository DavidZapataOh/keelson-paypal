import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { type Db, passkey as passkeyTable, sql } from "@keelson/db";
import { RP_ID } from "@keelson/mandate";
import type { PayPalEnv } from "@keelson/paypal";
import type { AuthenticationExtensionsClientInputs } from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { anonymous, jwt } from "better-auth/plugins";
import { siwe } from "better-auth/plugins/siwe";
import type { PayPalProfile } from "better-auth/social-providers";
import { type Hex, verifyMessage } from "viem";
import { generateSiweNonce } from "viem/siwe";
import { SETTLEMENT } from "./merchants.ts";

/** RFC 8707 resource identifier of this API; the `aud` of every access token it accepts. */
export const apiAudience = "https://api.keelson.finance";

/** ES256 only: mandate signatures are verified with P-256 on chain. */
const pubKeyCredParams = [{ type: "public-key", alg: cose.COSEALG.ES256 }];

/** The Secure Payment Confirmation `payment` extension, which the WebAuthn typings lack. */
const paymentExtension = { payment: { isPayment: true } } as AuthenticationExtensionsClientInputs;

/** Verification-table prefix marking a registration challenge issued with `paymentExtension`. */
const PAYMENT_CEREMONY = "passkey-payment:";
const PAYMENT_CEREMONY_MS = 10 * 60_000;

/** Arbitrum Sepolia and Arbitrum One, the chains a merchant's settlement wallet signs on. */
const SIWE_CHAINS = new Set([421614, 42161]);

const paypalAuthorizeURL = {
  sandbox: "https://www.sandbox.paypal.com/signin/authorize",
  production: "https://www.paypal.com/signin/authorize",
} as const;
const paypalScopes = "openid email profile https://uri.paypal.com/services/paypalattributes";

/** An entry of `emails` in PayPal's `userinfo?schema=paypalv1.1` response. */
interface PayPalEmail {
  value: string;
  primary: boolean;
  confirmed: boolean;
}

export const OAUTH_SCOPES = [
  "countersign:write",
  "evidence:write",
  "evidence:disclose",
  "evidence:decrypt",
  "alibis:read",
  "disputes:read",
  "operators:write",
  "merchants:write",
] as const;

export interface AuthEnv {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  /** Origin of the app where passkey ceremonies run. */
  APP_ORIGIN: string;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_ENV: PayPalEnv;
  /** Overrides the WebAuthn RP ID; only for tests served from `localhost`. */
  PASSKEY_RP_ID?: string | undefined;
}

export function createAuth(
  db: Db,
  env: AuthEnv,
  merchantSigners: Readonly<Record<string, string>> = SETTLEMENT,
) {
  const merchantWallets = new Set(Object.values(merchantSigners).map((a) => a.toLowerCase()));
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.APP_ORIGIN],
    // Judges are created only through `POST /v1/judge/sessions`, which limits them.
    disabledPaths: ["/token", "/sign-in/anonymous"],
    hooks: {
      // A passkey is payment-capable only if the server issued the `payment` extension for its
      // ceremony; the verified registration's challenge identifies that ceremony.
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (returned instanceof APIError) return;
        if (ctx.path === "/passkey/generate-register-options") {
          const options = returned as { challenge: string; extensions?: { payment?: unknown } };
          if (options.extensions?.payment) {
            await ctx.context.internalAdapter.createVerificationValue({
              identifier: `${PAYMENT_CEREMONY}${options.challenge}`,
              value: "payment",
              expiresAt: new Date(Date.now() + PAYMENT_CEREMONY_MS),
            });
          }
          return ctx.json({ ...options, pubKeyCredParams });
        }
        if (ctx.path === "/passkey/verify-registration") {
          const body = ctx.body as { response?: { response?: { clientDataJSON?: string } } };
          const clientData = JSON.parse(
            Buffer.from(body.response?.response?.clientDataJSON ?? "", "base64url").toString(),
          ) as { challenge: string };
          const issued = await ctx.context.internalAdapter.consumeVerificationValue(
            `${PAYMENT_CEREMONY}${clientData.challenge}`,
          );
          if (!issued) return;
          const { id } = returned as { id: string };
          await db
            .update(passkeyTable)
            .set({ payment: true })
            .where(sql`${passkeyTable.id} = ${id}`);
        }
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
        // The provider names the production environment `live`.
        environment: env.PAYPAL_ENV === "production" ? "live" : "sandbox",
        // The provider sends no `scope`, which PayPal rejects; query parameters on the
        // endpoint are kept, so the identity scopes ride on it.
        authorizationEndpoint: `${paypalAuthorizeURL[env.PAYPAL_ENV]}?${new URLSearchParams({ scope: paypalScopes })}`,
        mapProfileToUser: (profile) => {
          const { emails } = profile as PayPalProfile & { emails?: PayPalEmail[] };
          const email = emails?.find((e) => e.primary && e.confirmed);
          return email ? { email: email.value, emailVerified: true } : {};
        },
      },
    },
    plugins: [
      jwt(),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: [...OAUTH_SCOPES],
        grantTypes: ["client_credentials"],
        resources: [apiAudience],
        clientPrivileges: ({ user }) => user?.role === "admin",
      }),
      // The app origin is a subdomain of the RP ID, so WebAuthn accepts it without a
      // Related Origins `/.well-known/webauthn` document. Any authenticator may register; a
      // client asking for a platform one gets the SPC `payment` extension, which needs it.
      passkey({
        rpID: env.PASSKEY_RP_ID ?? RP_ID,
        rpName: "Keelson",
        origin: env.APP_ORIGIN,
        authenticatorSelection: { userVerification: "required", residentKey: "required" },
        registration: {
          extensions: ({ ctx }) =>
            ctx.query?.authenticatorAttachment === "platform" ? paymentExtension : undefined,
          afterVerification: ({ verification }) => {
            const key = verification.registrationInfo?.credential.publicKey;
            const alg = key && decodeCredentialPublicKey(key).get(cose.COSEKEYS.alg);
            if (alg !== cose.COSEALG.ES256) {
              throw new APIError("BAD_REQUEST", { message: "Passkeys must use ES256." });
            }
          },
        },
      }),
      // A Judge Mode tenant: no email, no account, no key.
      anonymous({ emailDomainName: "judge.keelson.finance", disableDeleteAnonymousUser: true }),
      // Merchants sign in with their settlement wallet (EIP-4361); no other wallet gets an account.
      siwe({
        domain: new URL(env.APP_ORIGIN).host,
        getNonce: async () => generateSiweNonce(),
        verifyMessage: async ({ message, signature, address, chainId }) =>
          SIWE_CHAINS.has(chainId) &&
          merchantWallets.has(address.toLowerCase()) &&
          verifyMessage({ address: address as Hex, message, signature: signature as Hex }),
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
