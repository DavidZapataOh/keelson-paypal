import { randomBytes } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { agentConnections, type Db, eq, passkey, sql } from "@keelson/db";
import { RP_ID } from "@keelson/mandate";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey, isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Context } from "hono";
import type { Deps } from "../app.ts";
import { paymentExtension, pubKeyCredParams } from "../auth.ts";
import {
  bindUser,
  confirmLink,
  EMBED_LINK_TTL_SEC,
  type Embed,
  type EmbedUser,
  mintLink,
  sessionEmbed,
  sessionUser,
  startCeremony,
  takeCeremony,
} from "../embed.ts";
import { framedAs } from "../mandate-signature.ts";
import { requireSession } from "../middleware/auth.ts";
import { userPasskeys } from "../passkeys.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { DraftRequest, draftMandate } from "./connections.ts";
import { Card, CreatedMandate, CreateMandate, storeMandate } from "./mandates.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
const EMBED_SESSION_HEADER = "keelson-embed";
const sessionHeaders = z.object({ "keelson-embed": z.string().max(64).optional() });
const TIMEOUT_MS = 120_000;

/** The user the frame signs for, as the frame may read it. */
export const EmbedSigner = z
  .object({
    passkeys: z.array(z.object({ credentialId: z.string(), payment: z.boolean() })),
    /** The passkey the user signed in with in this frame, so one on this device. */
    credentialId: z.string().nullable(),
  })
  .openapi("EmbedSigner");

/** The frame's view of `u`: their passkeys, and the one they signed in with here. */
export async function signerOf(db: Db, u: EmbedUser): Promise<z.infer<typeof EmbedSigner>> {
  return {
    passkeys: (await userPasskeys(db, u.userId)).map((p) => ({
      credentialId: p.credentialID,
      payment: p.payment,
    })),
    credentialId: u.credentialId ?? null,
  };
}

const Json = z.record(z.string(), z.unknown());

const WebAuthnResponse = z
  .object({
    id: z.string().max(1024),
    rawId: z.string().max(1024),
    type: z.literal("public-key"),
    response: z.record(z.string(), z.unknown()),
    authenticatorAttachment: z.string().max(32).optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  })
  .openapi("WebAuthnResponse", {
    description: "`PublicKeyCredential.toJSON()` of the ceremony the frame started.",
  });

const routes = {
  signInOptions: createRoute({
    method: "post",
    path: "/v1/embed/sign-in/options",
    tags: ["embed"],
    summary: "Start a passkey sign-in in the embedded approval",
    description:
      "WebAuthn request options for any of the user's passkeys, with a challenge for this embed session only. The frame passes them to `navigator.credentials.get`.",
    request: { headers: sessionHeaders },
    responses: {
      200: { description: "The options", content: { "application/json": { schema: Json } } },
      401: { description: "No live embed session", content: problemContent },
    },
  }),
  signIn: createRoute({
    method: "post",
    path: "/v1/embed/sign-in",
    tags: ["embed"],
    summary: "Sign in with a passkey in the embedded approval",
    description:
      "Verifies the assertion against the session's challenge. It must come from the approval in a frame whose top-level origin is the embed's platform (`crossOrigin` true, `topOrigin` that origin). The session then signs for the passkey's user.",
    request: {
      headers: sessionHeaders,
      body: { required: true, content: { "application/json": { schema: WebAuthnResponse } } },
    },
    responses: {
      200: {
        description: "Who the frame signs for",
        content: { "application/json": { schema: EmbedSigner } },
      },
      401: {
        description: "No live embed session, or the passkey did not verify",
        content: problemContent,
      },
    },
  }),
  linkStart: createRoute({
    method: "post",
    path: "/v1/embed/links",
    tags: ["embed"],
    summary: "Link the embedded approval to a Keelson window",
    description:
      "A single-use nonce for the Keelson window the frame opens for a user without a passkey here: once they sign in there and confirm, this session signs for them.",
    request: { headers: sessionHeaders },
    responses: {
      201: {
        description: "The nonce",
        content: {
          "application/json": {
            schema: z.object({ nonce: z.string(), expires_in: z.int() }).openapi("EmbedLink"),
          },
        },
      },
      401: { description: "No live embed session", content: problemContent },
    },
  }),
  linkConfirm: createRoute({
    method: "post",
    path: "/v1/embed/links/confirm",
    tags: ["embed"],
    summary: "Confirm a link from the Keelson window",
    description:
      "The signed-in user binds the embedded approval that opened this window to their account. The frame then creates a passkey or signs there.",
    middleware: [requireSession()],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: z.object({ nonce: z.string().max(64) }) } },
      },
    },
    responses: {
      200: {
        description: "Linked",
        content: {
          "application/json": { schema: z.object({ origin: z.string() }).openapi("EmbedLinked") },
        },
      },
      401: { description: "Not signed in", content: problemContent },
      404: { description: "The link is unknown, spent or expired", content: problemContent },
    },
  }),
  registerOptions: createRoute({
    method: "post",
    path: "/v1/embed/passkeys/options",
    tags: ["embed"],
    summary: "Start creating a passkey in the embedded approval",
    description:
      "WebAuthn creation options for the session's user, who linked a Keelson window. With `platform`, the passkey is created on this device's platform authenticator with the SPC `payment` extension.",
    request: {
      headers: sessionHeaders,
      body: {
        required: true,
        content: { "application/json": { schema: z.object({ platform: z.boolean() }) } },
      },
    },
    responses: {
      200: { description: "The options", content: { "application/json": { schema: Json } } },
      401: { description: "No live embed session, or no user linked", content: problemContent },
    },
  }),
  register: createRoute({
    method: "post",
    path: "/v1/embed/passkeys",
    tags: ["embed"],
    summary: "Create a passkey in the embedded approval",
    description:
      "Verifies the new credential against the session's challenge, made in the approval framed by the embed's platform, and stores it as the user's passkey (ES256 only).",
    request: {
      headers: sessionHeaders,
      body: { required: true, content: { "application/json": { schema: WebAuthnResponse } } },
    },
    responses: {
      201: {
        description: "Who the frame signs for, with the new passkey",
        content: { "application/json": { schema: EmbedSigner } },
      },
      401: { description: "No live embed session, or no user linked", content: problemContent },
      422: { description: "The credential did not verify", content: problemContent },
    },
  }),
  draft: createRoute({
    method: "post",
    path: "/v1/embed/draft",
    tags: ["embed"],
    summary: "Draft the mandate in the embedded approval",
    description:
      "As `POST /v1/connections/{code}/draft`, for the embedded request and the session's user. The mandate carries `embed.top_origin`, the platform's origin, so only an assertion made in this frame signs it.",
    request: {
      headers: sessionHeaders.extend({ "keelson-device": z.string().optional() }),
      body: { required: true, content: { "application/json": { schema: DraftRequest } } },
    },
    responses: {
      200: {
        description: "The draft mandate and its card",
        content: {
          "application/json": {
            schema: z.object({
              mandateDraft: Json,
              card: Card,
              ambiguous: z.array(z.string()),
              check: z.object({ status: z.literal("skipped"), discrepancies: z.null() }),
            }),
          },
        },
      },
      401: { description: "No live embed session, or no user", content: problemContent },
      403: { description: "The passkey is not the user's", content: problemContent },
      404: { description: "The request is no longer open", content: problemContent },
      409: { description: "The user has no passkey", content: problemContent },
      422: { description: "A limit is above what the agent asked", content: problemContent },
      503: { description: "The operator's agent key or bond is not set", content: problemContent },
    },
  }),
  sign: createRoute({
    method: "post",
    path: "/v1/embed/mandates",
    tags: ["embed"],
    summary: "Approve the embedded request with a signed mandate",
    description:
      "As `POST /v1/mandates` with `connection`, for the embedded request and the session's user. The mandate's `embed.top_origin` must be the platform's origin, still registered, and the assertion must be made in this frame under it.",
    request: {
      headers: sessionHeaders,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: CreateMandate.omit({ connection: true }).extend({
              askAboveMinor: z.int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The mandate; the request is approved",
        content: { "application/json": { schema: CreatedMandate } },
      },
      401: {
        description: "No live embed session, no user, or a bad signature",
        content: problemContent,
      },
      403: {
        description: "The passkey is not the user's, or the origin is no longer registered",
        content: problemContent,
      },
      404: { description: "The request is no longer open", content: problemContent },
      409: { description: "The request was already answered", content: problemContent },
      422: { description: "The mandate is invalid", content: problemContent },
      429: { description: "Too many approvals", content: problemContent },
      503: { description: "Leg A cannot issue the mandate now", content: problemContent },
    },
  }),
};

/** The parsed client data of a WebAuthn response, or undefined. */
function clientDataOf(response: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    const data = JSON.parse(
      Buffer.from(String(response.clientDataJSON ?? ""), "base64url").toString("utf8"),
    ) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The approval agent platforms frame: passkey ceremonies for its embed session, made in the frame
 * with the platform as the top-level origin, then the draft and the signed mandate. Each ceremony
 * answers one challenge, kept server-side for the session; no cookie is read or set but by the
 * Keelson window's link confirmation.
 */
export function registerEmbedSigning(
  app: OpenAPIHono,
  deps: Pick<
    Deps,
    | "db"
    | "kv"
    | "log"
    | "appOrigin"
    | "authBaseUrl"
    | "passkeyRpId"
    | "rateLimit"
    | "compileSources"
    | "tee"
    | "proveAnonymousMandate"
  >,
): void {
  const { db, kv } = deps;
  const rpId = deps.passkeyRpId ?? RP_ID;
  /** The approval's own origin, where the API serves it. */
  const frameOrigin = new URL(deps.authBaseUrl ?? "https://api.keelson.finance").origin;

  const noSession = (c: Context) =>
    problem(c, 401, "embed-session-invalid", "No embed session", "Open the embed again.");
  const noUser = (c: Context) =>
    problem(c, 401, "embed-user-unknown", "Sign in first", "Sign in with a passkey here first.");

  /** The session's embed, or undefined. */
  const opened = (c: Context) => sessionEmbed(kv, c.req.header(EMBED_SESSION_HEADER));

  const signer = (u: EmbedUser) => signerOf(db, u);

  /** Whether a ceremony's client data names this frame under the embed's platform. */
  const inFrame = (data: Record<string, unknown> | undefined, embed: Embed) =>
    data !== undefined && data.origin === frameOrigin && framedAs(data, embed.origin);

  app.openapi(routes.signInOptions, async (c) => {
    const session = c.req.header(EMBED_SESSION_HEADER) as string;
    if (!(await opened(c))) return noSession(c);
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: "required",
      timeout: TIMEOUT_MS,
    });
    await startCeremony(kv, session, { kind: "authenticate", challenge: options.challenge });
    return c.json(options as unknown as Record<string, unknown>, 200, {
      "cache-control": "no-store",
    });
  });

  app.openapi(routes.signIn, async (c) => {
    const session = c.req.header(EMBED_SESSION_HEADER) as string;
    const embed = await opened(c);
    if (!embed) return noSession(c);
    const ceremony = await takeCeremony(kv, session);
    const body = c.req.valid("json");
    const refused = () =>
      problem(
        c,
        401,
        "passkey-invalid",
        "Passkey not accepted",
        "Sign in with your passkey again.",
      );
    if (ceremony?.kind !== "authenticate" || !inFrame(clientDataOf(body.response), embed)) {
      return refused();
    }
    const key = await db.query.passkey.findFirst({
      where: (row, { eq: is }) => is(row.credentialID, body.id),
    });
    if (!key) return refused();
    try {
      const { verified, authenticationInfo } = await verifyAuthenticationResponse({
        response: body as never,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: frameOrigin,
        expectedRPID: rpId,
        expectedType: "webauthn.get",
        requireUserVerification: true,
        credential: {
          id: key.credentialID,
          publicKey: new Uint8Array(isoBase64URL.toBuffer(key.publicKey, "base64")),
          counter: key.counter,
        },
      });
      if (!verified) return refused();
      const counted = await db
        .update(passkey)
        .set({ counter: authenticationInfo.newCounter })
        .where(
          sql`${passkey.id} = ${key.id} and (${authenticationInfo.newCounter} = 0 or ${passkey.counter} < ${authenticationInfo.newCounter})`,
        );
      if (counted.rowCount !== 1) return refused();
    } catch {
      return refused();
    }
    const bound = { userId: key.userId, credentialId: key.credentialID };
    await bindUser(kv, session, bound);
    return c.json(await signer(bound), 200, { "cache-control": "no-store" });
  });

  app.openapi(routes.linkStart, async (c) => {
    const session = c.req.header(EMBED_SESSION_HEADER) as string;
    if (!(await opened(c))) return noSession(c);
    const nonce = await mintLink(kv, session);
    return c.json({ nonce, expires_in: EMBED_LINK_TTL_SEC }, 201, { "cache-control": "no-store" });
  });

  app.openapi(routes.linkConfirm, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const embed = await confirmLink(kv, c.req.valid("json").nonce, userId);
    if (!embed) {
      return problem(c, 404, "link-invalid", "Link expired", "Go back to the app and try again.");
    }
    return c.json({ origin: embed.origin }, 200);
  });

  app.openapi(routes.registerOptions, async (c) => {
    const session = c.req.header(EMBED_SESSION_HEADER) as string;
    if (!(await opened(c))) return noSession(c);
    const bound = await sessionUser(kv, session);
    if (!bound) return noUser(c);
    const account = await db.query.user.findFirst({
      where: (row, { eq: is }) => is(row.id, bound.userId),
    });
    if (!account) return noUser(c);
    const { platform } = c.req.valid("json");
    const existing = await userPasskeys(db, bound.userId);
    const options = await generateRegistrationOptions({
      rpName: "Keelson",
      rpID: rpId,
      userID: new TextEncoder().encode(randomBytes(24).toString("base64url")),
      userName: account.name || account.email || account.id,
      userDisplayName: account.name || account.email || account.id,
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({
        id: p.credentialID,
        ...(p.transports ? { transports: p.transports.split(",") as never } : {}),
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
        ...(platform ? { authenticatorAttachment: "platform" as const } : {}),
      },
      timeout: TIMEOUT_MS,
      ...(platform ? { extensions: paymentExtension } : {}),
    });
    await startCeremony(kv, session, {
      kind: "register",
      challenge: options.challenge,
      payment: platform,
    });
    return c.json({ ...options, pubKeyCredParams } as unknown as Record<string, unknown>, 200, {
      "cache-control": "no-store",
    });
  });

  app.openapi(routes.register, async (c) => {
    const session = c.req.header(EMBED_SESSION_HEADER) as string;
    const embed = await opened(c);
    if (!embed) return noSession(c);
    const bound = await sessionUser(kv, session);
    if (!bound) return noUser(c);
    const ceremony = await takeCeremony(kv, session);
    const body = c.req.valid("json");
    const refused = (detail: string) =>
      problem(c, 422, "passkey-invalid", "Passkey not created", detail);
    if (ceremony?.kind !== "register") return refused("Start again: the ceremony expired.");
    if (!inFrame(clientDataOf(body.response), embed)) {
      return refused("The passkey must be created in this approval.");
    }
    let info: Awaited<ReturnType<typeof verifyRegistrationResponse>>["registrationInfo"];
    try {
      const v = await verifyRegistrationResponse({
        response: body as never,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: frameOrigin,
        expectedRPID: rpId,
        expectedType: "webauthn.create",
        requireUserVerification: true,
        supportedAlgorithmIDs: [cose.COSEALG.ES256],
      });
      if (!v.verified) return refused("The passkey did not verify.");
      info = v.registrationInfo;
    } catch (err) {
      return refused(err instanceof Error ? err.message : "The passkey did not verify.");
    }
    if (
      !info ||
      decodeCredentialPublicKey(info.credential.publicKey).get(cose.COSEKEYS.alg) !==
        cose.COSEALG.ES256
    ) {
      return refused("Passkeys must use ES256.");
    }
    const transports = (body.response.transports as string[] | undefined)?.join(",") ?? "";
    await db.insert(passkey).values({
      id: randomBytes(24).toString("base64url"),
      userId: bound.userId,
      credentialID: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey).toString("base64"),
      counter: info.credential.counter,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      transports,
      createdAt: new Date(),
      aaguid: info.aaguid,
      payment: ceremony.payment === true,
    });
    const next = { userId: bound.userId, credentialId: info.credential.id };
    await bindUser(kv, session, next);
    return c.json(await signer(next), 201, { "cache-control": "no-store" });
  });

  /** The session's embed, its open request and user, or the problem to answer. */
  const signing = async (c: Context) => {
    const session = c.req.header(EMBED_SESSION_HEADER) as string;
    const embed = await opened(c);
    if (!embed) return noSession(c);
    const bound = await sessionUser(kv, session);
    if (!bound) return noUser(c);
    const [request] = await db
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.id, embed.connectionId));
    if (request?.state !== "PENDING" || request.expiresAt.getTime() <= Date.now()) {
      return problem(c, 404, "not-found", "Not found", "The request is no longer open.");
    }
    return { embed, bound, request };
  };

  app.openapi(routes.draft, async (c) => {
    const s = await signing(c);
    if (s instanceof Response) return s;
    if (s.request.userId !== null && s.request.userId !== s.bound.userId) {
      return problem(c, 404, "not-found", "Not found", "The request is no longer open.");
    }
    return draftMandate(c, deps, s.bound.userId, s.request, c.req.valid("json"), s.embed.origin);
  });

  app.openapi(routes.sign, async (c) => {
    const s = await signing(c);
    if (s instanceof Response) return s;
    const { askAboveMinor, ...body } = c.req.valid("json");
    return storeMandate(
      c,
      deps,
      s.bound.userId,
      {
        ...body,
        connection: {
          code: s.request.userCode,
          ...(askAboveMinor === undefined ? {} : { askAboveMinor }),
        },
      },
      {
        origin: s.embed.origin,
        frameOrigin,
        clientId: s.embed.clientId,
        connectionId: s.embed.connectionId,
      },
    );
  });
}
