import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { type Db, passkey as passkeyTable, sql } from "@keelson/db";
import { RP_ID } from "@keelson/mandate";
import type { PayPalEnv } from "@keelson/paypal";
import type { AuthenticationExtensionsClientInputs } from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { anonymous, jwt } from "better-auth/plugins";
import { siwe } from "better-auth/plugins/siwe";
import type { PayPalProfile } from "better-auth/social-providers";
import { type Hex, verifyMessage } from "viem";
import { generateSiweNonce } from "viem/siwe";
import { SETTLEMENT } from "./merchants.ts";
import { ownsLinkedOperator } from "./operators/owners.ts";

/** RFC 8707 resource identifier of this API; the `aud` of every access token it accepts. */
export const apiAudience = "https://api.keelson.finance";

/** Keelson's own hosts, which never name a client. */
const isOwnHost = (host: string) => host === "keelson.finance" || host.endsWith(".keelson.finance");

/** ES256 only: mandate signatures are verified with P-256 on chain. */
export const pubKeyCredParams = [{ type: "public-key", alg: cose.COSEALG.ES256 }];

/** The Secure Payment Confirmation `payment` extension, which the WebAuthn typings lack. */
export const paymentExtension = {
  payment: { isPayment: true },
} as AuthenticationExtensionsClientInputs;

/** Verification-table prefix marking a registration challenge issued with `paymentExtension`. */
const PAYMENT_CEREMONY = "passkey-payment:";
const PAYMENT_CEREMONY_MS = 10 * 60_000;

/**
 * A user who already has a passkey adds another only within this long of signing in, with PayPal
 * or with one of their passkeys.
 */
export const PASSKEY_FRESH_MS = 10 * 60_000;
const PASSKEY_REGISTRATION = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
]);

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
  "mandates:request",
  "purchases:write",
  "offline_access",
] as const;

/** What each scope grants, as the OpenAPI document and the consent page describe it. */
export const SCOPE_DESCRIPTIONS: Record<(typeof OAUTH_SCOPES)[number], string> = {
  "countersign:write": "Countersign carts as the operator's own agent",
  "evidence:write": "Seal and store evidence",
  "evidence:disclose": "Disclose stored evidence items",
  "evidence:decrypt": "Decrypt sealed evidence originals",
  "alibis:read": "Read and verify Alibis",
  "disputes:read": "Read disputes and their attribution",
  "operators:write": "Link and manage operators",
  "merchants:write": "Manage a merchant's settings",
  "mandates:request": "Ask the user for a mandate or a change of one",
  "purchases:write": "Check and countersign carts for the user",
  offline_access: "Stay connected with a refresh token",
};

/**
 * What a token a user delegated to an app (an MCP host) may do, whatever that app's registration
 * holds, and only for that user: read their Alibis, ask them for a mandate or a change of one,
 * seal evidence and countersign under a mandate they approved for that app. Everything an
 * operator does for itself (linking, bonds, holds, `countersign:write`) stays with an agent's own
 * client credentials.
 */
const DELEGATED_SCOPES = [
  "alibis:read",
  "mandates:request",
  "evidence:write",
  "purchases:write",
] as const;

/** The scopes a verified access token grants: a delegated one (`sub` is a user) never more than `DELEGATED_SCOPES`. */
export function tokenScopes(payload: { scope?: unknown; sub?: unknown; azp?: unknown }): string[] {
  const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
  return delegatedUser(payload) === undefined
    ? scopes
    : scopes.filter((s) => (DELEGATED_SCOPES as readonly string[]).includes(s));
}

/** The user a verified access token acts for, when a user granted it to the app (`azp`). */
export function delegatedUser(payload: { sub?: unknown; azp?: unknown }): string | undefined {
  return typeof payload.sub === "string" && payload.sub !== payload.azp ? payload.sub : undefined;
}

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
  /** Overrides the signing key's 30-day rotation, in seconds; only for tests. */
  jwks?: { rotationInterval: number; gracePeriod: number } | undefined;
}

/** The access token signing key rotates every 30 days; tokens it signed verify 30 days more. */
const JWKS_ROTATION = { rotationInterval: 30 * 86_400, gracePeriod: 30 * 86_400 };

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
    // Judges are created only through `POST /v1/judge/sessions`, which limits them. Passkeys are
    // removed through `DELETE /v1/passkeys/{id}`, which keeps the last one.
    disabledPaths: ["/token", "/sign-in/anonymous", "/passkey/delete-passkey"],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Open registration is for public clients only: a confidential client is created by an
        // admin, who grants its scopes. A public MCP client is linked to this API, the one
        // resource it can ask a token for (RFC 8707), without having to name it.
        if (ctx.path === "/oauth2/register") {
          const body = (ctx.body ?? {}) as {
            token_endpoint_auth_method?: unknown;
            resources?: unknown;
          };
          if (await getSessionFromCtx(ctx)) return;
          if (body.token_endpoint_auth_method !== "none") {
            throw new APIError("BAD_REQUEST", {
              error: "invalid_client_metadata",
              error_description:
                "Only public clients (token_endpoint_auth_method none) may register.",
            });
          }
          return { context: { body: { ...body, resources: body.resources ?? [apiAudience] } } };
        }
        // A request for spending limits is always shown to the user, even when they consented to
        // the same scopes before.
        if (ctx.path === "/oauth2/authorize") {
          const query = (ctx.query ?? {}) as Record<string, unknown>;
          if (query.authorization_details === undefined) return;
          return { context: { query: { ...query, prompt: "consent" } } };
        }
        if (ctx.path === "/link-social") {
          const session = await getSessionFromCtx(ctx);
          if ((session?.user as { isAnonymous?: boolean | null } | undefined)?.isAnonymous) {
            throw new APIError("FORBIDDEN", { message: "Judge Mode cannot link an account." });
          }
          return;
        }
        // Another passkey can sign for the user, so it takes a recent sign-in, as a first one
        // took the sign-up.
        if (PASSKEY_REGISTRATION.has(ctx.path)) {
          const session = await getSessionFromCtx(ctx);
          if (!session) return;
          const age = Date.now() - new Date(session.session.createdAt).getTime();
          if (age < PASSKEY_FRESH_MS) return;
          const [existing] = await db
            .select({ id: passkeyTable.id })
            .from(passkeyTable)
            .where(sql`${passkeyTable.userId} = ${session.user.id}`)
            .limit(1);
          if (existing) {
            throw APIError.from("FORBIDDEN", {
              code: "SESSION_NOT_FRESH",
              message: "Sign in again to add a passkey.",
            });
          }
        }
      }),
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
      jwt({ jwks: env.jwks ?? JWKS_ROTATION }),
      // Agents act for themselves with client credentials. MCP clients act for a user with the
      // authorization code grant and PKCE (S256 only, required of public clients), named by a
      // Client ID Metadata Document or else registering themselves (RFC 7591), as the MCP
      // authorization spec asks; such a client gets the delegated scopes, and spends only under a
      // mandate the user approves with a passkey.
      oauthProvider({
        loginPage: `${env.APP_ORIGIN}/sign-in`,
        consentPage: `${env.APP_ORIGIN}/consent`,
        scopes: [...OAUTH_SCOPES],
        grantTypes: ["client_credentials", "authorization_code", "refresh_token"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // `offline_access` (OpenID Connect Core §11) gets an app a refresh token, which stopping
        // every agent revokes.
        clientRegistrationDefaultScopes: [...DELEGATED_SCOPES, "offline_access"],
        clientRegistrationDefaultApplicationType: "infer",
        clientRegistrationAllowedResources: [apiAudience],
        // A client a metadata document names requests no resource, so every client gets the API.
        clientRegistrationDefaultResources: [apiAudience],
        resources: [apiAudience],
        clientPrivileges: ({ user }) => user?.role === "admin",
      }),
      // The server fetches a client's metadata document itself, resolving its host once and
      // pinning the address, so the host a consent page shows is proven, not claimed.
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
        metadataRevalidationInterval: "60m",
        isMetadataDocumentUrlAllowed: (url) => !isOwnHost(new URL(url).hostname),
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
      // Merchants sign in with their settlement wallet and operators with their agent's owner wallet
      // (EIP-4361); no other wallet gets an account.
      siwe({
        domain: new URL(env.APP_ORIGIN).host,
        getNonce: async () => generateSiweNonce(),
        verifyMessage: async ({ message, signature, address, chainId }) =>
          SIWE_CHAINS.has(chainId) &&
          (merchantWallets.has(address.toLowerCase()) || (await ownsLinkedOperator(db, address))) &&
          verifyMessage({ address: address as Hex, message, signature: signature as Hex }),
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
