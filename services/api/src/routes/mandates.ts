import { isDeepStrictEqual } from "node:util";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { fromHex, toHex } from "@keelson/core";
import {
  agentConnections,
  and,
  asc,
  createQueries,
  desc,
  disputes,
  eq,
  gt,
  inArray,
  mandates,
  passkey,
  purchaseHolds,
  purchases,
  sql,
  transition,
} from "@keelson/db";
import {
  decodeMandate,
  hSd,
  type Mandate,
  mandateChallenge,
  RP_ID,
  renderCard,
  spcDetails,
} from "@keelson/mandate";
import type { SignedChallenge } from "@keelson/mandate/browser";
import { POLICY_SET_HASH } from "@keelson/policy/hashes";
import type { Context } from "hono";
import type { Deps } from "../app.ts";
import { Amount, breakdowns, withBreakdown } from "../checkout.ts";
import { agentBond, agentCnf, termsConsent } from "../compile-sources.ts";
import {
  type Connection,
  kindOf,
  looserThan,
  normalizeUserCode,
  openRequest,
  unmatched,
} from "../connections.ts";
import { clientEmbedOrigins } from "../embed.ts";
import { publishEvent } from "../events.ts";
import { hostedCapError } from "../hosted-caps.ts";
import { passkeyJwk, SignatureError, verifyMandateSignature } from "../mandate-signature.ts";
import { requireSession } from "../middleware/auth.ts";
import { cardViewOf, purchaseView } from "../pipeline/drive.ts";
import { type Principal, principalChannel } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { LegError, type MandateIssued } from "../tee/client.ts";
import { bothLegs } from "../tee/coordinator.ts";
import { unboundPolicy } from "../tee/engine-source.ts";
import { PurchaseProgress } from "./purchases.ts";
import { REVOCABLE, revokeMandate } from "./revoke.ts";

const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const MANDATES_SHOWN = 50;
const PURCHASES_SHOWN = 100;

const Assertion = z
  .object({
    authenticatorData: z.string(),
    clientDataJSON: z.string(),
    signature: z.string(),
    credentialId: z.string(),
    userHandle: z.string().optional(),
  })
  .openapi("PasskeyAssertion", {
    description: "A WebAuthn or Secure Payment Confirmation assertion, base64url fields.",
  });

export const CreateMandate = z
  .object({
    payloadSd: z.record(z.string(), z.unknown()).openapi({
      description: "The SD-JWT payload with its `_sd` digests, as signed.",
    }),
    disclosures: z.array(z.string()).max(1024).openapi({
      description: "Every disclosure of the payload; each digest must resolve.",
    }),
    decoySalts: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{22}$/))
      .max(512)
      .optional()
      .openapi({
        description:
          "The salts of the payload's decoy digests (RFC 9901 section 4.2.5); every other digest resolves to a disclosure. Accepted once both TEEs resolve decoys.",
      }),
    commitment: Hex32.openapi({ description: "`C_m`; must equal the payload's `zk.commitment`." }),
    salt: z
      .string()
      .regex(/^0x[0-9a-f]{32}$/)
      .optional()
      .openapi({
        description: "The salt that opens `C_m`; the TEE needs it to issue the mandate.",
      }),
    assertion: Assertion,
    connection: z
      .object({
        code: z.string().min(8).max(16),
        askAboveMinor: z.int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .optional()
      .openapi({
        description:
          "The agent's request this mandate approves, by its user code. The mandate must name the asking agent's operator and grant no more than it asked; `askAboveMinor` may only be lower too.",
      }),
  })
  .openapi("CreateMandate");

const MandateState = z.enum([
  "DRAFT",
  "COMPILED",
  "SIGNED",
  "HOLD_PENDING",
  "ACTIVE",
  "EXHAUSTED",
  "EXPIRED",
  "REVOKED",
]);

export const CreatedMandate = z
  .object({
    id: z.string(),
    mandateHash: Hex32,
    state: z.enum(["SIGNED", "ACTIVE"]).openapi({
      description:
        "`ACTIVE` at once when the mandate allows several merchants: each cart is then held on its own.",
    }),
    openMandate: z.string().nullable().openapi({
      description: "The open mandate (L2) the TEE issued; the agent closes it per purchase.",
    }),
  })
  .openapi("CreatedMandate");

export const Card = z
  .object({
    rows: z.array(
      z.object({
        field: z.string(),
        label: z.string(),
        values: z.array(z.string()),
        color: z.enum(["green", "amber", "gray"]),
        answers: z.enum(["Keelson", "Agent operator", "You"]),
      }),
    ),
    warnings: z.array(z.string()),
  })
  .openapi("MandateCard");

const HoldView = z
  .object({
    mode: z.enum(["mandate", "per_purchase"]),
    orderId: z.string(),
    authorizationId: z.string().nullable().openapi({
      description: "The authorization captures use: the original, or its reauthorization.",
    }),
    authorizedAt: z.iso.datetime().nullable(),
    reauthorizedAt: z.iso.datetime().nullable(),
    remainingMinor: z.string().regex(/^\d+$/),
    state: z.enum(["PENDING", "AUTHORIZED", "RELEASED"]).openapi({
      description:
        "`PENDING` until authorized; `RELEASED` once the mandate ended and the hold was voided or captured.",
    }),
  })
  .openapi("MandateHold");

const Budget = z
  .object({
    currency: z.string(),
    maxMinor: z.string().regex(/^\d+$/),
    remainingMinor: z.string().regex(/^\d+$/),
  })
  .openapi("MandateBudget", {
    description: "The mandate's budget and what is left of it, in minor units.",
  });

const MandateSummary = z
  .object({
    id: z.string(),
    state: MandateState,
    budget: Budget,
    merchantIds: z.array(z.string()),
    holdMode: z.enum(["mandate", "per_purchase"]),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .openapi("MandateSummary");

const MandatePurchase = z
  .object({
    id: z.string().openapi({ description: "The purchase's ULID, which is also its Alibi id." }),
    merchantId: z.string(),
    amount: Amount,
    createdAt: z.iso.datetime(),
    ...PurchaseProgress.shape,
    state: z.string(),
    disputes: z
      .array(z.object({ id: z.string(), state: z.enum(["OPEN", "ATTRIBUTED", "RESOLVED"]) }))
      .openapi({
        description: "PayPal disputes over the purchase; `GET /v1/disputes/{id}` has each.",
      }),
  })
  .openapi("MandatePurchase");

const PendingPurchaseHold = z
  .object({
    requestId: z.string(),
    orderId: z.string().openapi({ description: "The PayPal order the buyer approves." }),
    merchant: z.string(),
    amountMinor: z.string(),
  })
  .openapi("PendingPurchaseHold");

const MandateView = z
  .object({
    id: z.string(),
    state: MandateState,
    rail: z.enum(["paypal", "card"]).openapi({
      description: "`card` when each purchase is paid with its own single-use card.",
    }),
    mandateHash: Hex32.nullable(),
    budget: Budget,
    expiresAt: z.iso.datetime(),
    hold: z.union([HoldView, z.null()]).openapi({
      description: "The PayPal hold of the mandate's budget, once its order exists.",
    }),
    card: z.union([Card, z.null()]).openapi({
      description: "The card rendered from the stored payload, before any checkout evidence.",
    }),
    purchases: z.array(MandatePurchase).openapi({
      description: `The mandate's latest ${PURCHASES_SHOWN} purchases, newest first.`,
    }),
    pendingHolds: z.array(PendingPurchaseHold).openapi({
      description:
        "Purchase holds of a several-store mandate still waiting for the buyer's PayPal approval, oldest first. Later changes arrive as `mandate.purchase_hold` events.",
    }),
  })
  .openapi("Mandate");

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const create = createRoute({
  method: "post",
  path: "/v1/mandates",
  tags: ["mandates"],
  summary: "Store a passkey-signed mandate",
  description:
    'Verifies the passkey assertion over `M = SHA-256("keelson/mandate-challenge/v1" || 0x00 || H_sd || C_m)` and stores the mandate as `SIGNED`, or `ACTIVE` when it allows several merchants.',
  middleware: [requireSession()],
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: { required: true, content: { "application/json": { schema: CreateMandate } } },
  },
  responses: {
    201: {
      description: "The mandate was stored",
      headers: z.object({ location: z.string() }),
      content: { "application/json": { schema: CreatedMandate } },
    },
    401: { description: "Not signed in, or the signature is invalid", content: problemContent },
    403: { description: "The passkey is not the signer's", content: problemContent },
    409: { description: "The mandate is already stored", content: problemContent },
    422: {
      description:
        "The mandate is invalid (`invalid-mandate`), or it binds an agent key, a bond, an engine build, a policy set or terms other than the ones `POST /v1/mandates/compile` fills: the named operator's registered `cnf` key, its bond vault with the 50 PYUSD minimum, the engine version and TEE measurements of the build the legs run (or of another build admitted during a rotation), the current policy set hash and the current terms (`mandate-binding-mismatch`; `fields` names `agent.cnf`, `agent.bond`, `policy.engine`, `policy.version`, `policy.measurements`, `policy.policy_set_hash` or `consent`)",
      content: problemContent,
    },
    429: { description: "Too many approvals by user code", content: problemContent },
    503: { description: "The TEE could not issue the mandate", content: problemContent },
  },
});

const read = createRoute({
  method: "get",
  path: "/v1/mandates/{id}",
  tags: ["mandates"],
  summary: "Get a mandate",
  description:
    "Renders the card of the signed mandate. The user answered for every field when signing, so fields that were ambiguous at compile time show with the colors the engine enforces, not gray.",
  middleware: [requireSession()],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "The mandate", content: { "application/json": { schema: MandateView } } },
    401: { description: "Not signed in", content: problemContent },
    404: { description: "No such mandate for this user", content: problemContent },
  },
});

const list = createRoute({
  method: "get",
  path: "/v1/mandates",
  tags: ["mandates"],
  summary: "List your mandates",
  description: `The signed-in user's latest ${MANDATES_SHOWN} signed mandates, newest first.`,
  middleware: [requireSession()],
  responses: {
    200: {
      description: "The mandates",
      content: {
        "application/json": {
          schema: z.object({ mandates: z.array(MandateSummary) }).openapi("Mandates"),
        },
      },
    },
    401: { description: "Not signed in", content: problemContent },
  },
});

const TERMINAL = new Set(["EXHAUSTED", "EXPIRED", "REVOKED"]);

const budgetOf = (
  row: Pick<typeof mandates.$inferSelect, "currency" | "maxMinor" | "remainingMinor">,
) => ({
  currency: row.currency,
  maxMinor: row.maxMinor.toString(),
  remainingMinor: row.remainingMinor.toString(),
});

function holdView(row: typeof mandates.$inferSelect): z.infer<typeof HoldView> | null {
  if (!row.paypalOrderId) return null;
  return {
    mode: row.holdMode,
    orderId: row.paypalOrderId,
    authorizationId: row.paypalAuthorizationId,
    authorizedAt: row.authorizedAt?.toISOString() ?? null,
    reauthorizedAt: row.reauthorizedAt?.toISOString() ?? null,
    remainingMinor: row.remainingMinor.toString(),
    state: TERMINAL.has(row.state)
      ? "RELEASED"
      : row.paypalAuthorizationId
        ? "AUTHORIZED"
        : "PENDING",
  };
}

const NO_EVIDENCE = { merchantSignedCheckout: false, zkTlsFields: new Set<never>() };
const AGENT_ID = /^(0|[1-9]\d{0,77})$/;

class CounterError extends Error {}
class RequestClosed extends Error {}
class OverHostedCap extends Error {}

/** Approvals by user code a user may attempt in a minute. */
const APPROVALS_PER_MINUTE = 20;

function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/** Where a mandate signed in an embedded approval was signed, as its embed session says. */
export interface SignedIn {
  /** The agent platform's origin, the frame's top-level origin. */
  origin: string;
  /** The origin of the approval page the platform frames. */
  frameOrigin: string;
  clientId: string;
  connectionId: string;
}

type MandateDeps = Pick<
  Deps,
  | "db"
  | "kv"
  | "log"
  | "appOrigin"
  | "passkeyRpId"
  | "tee"
  | "proveAnonymousMandate"
  | "paypal"
  | "demoAgentId"
  | "hostedCaps"
>;

/**
 * Verifies and stores a mandate `userId` signed, answering `body.connection` when given. A
 * mandate signed in an embedded approval (`embed`) must name that approval's platform in
 * `embed.top_origin`, still one of its client's embed origins, and its assertion must come from
 * that frame; any other mandate has no `embed` and was signed at the top level in the app.
 */
export async function storeMandate(
  c: Context,
  deps: MandateDeps,
  userId: string,
  body: z.infer<typeof CreateMandate>,
  embed?: SignedIn,
) {
  const { db } = deps;
  const queries = createQueries(db);
  const origin = deps.appOrigin;
  if (origin === undefined) throw new Error("appOrigin is required to verify mandates");
  const invalid = (detail: string) => problem(c, 422, "invalid-mandate", "Invalid mandate", detail);
  const notOwned = () =>
    problem(
      c,
      403,
      "credential-not-owned",
      "Credential not owned",
      "The mandate must be signed with one of your passkeys, the one it names.",
    );

  let m: Mandate;
  try {
    m = decodeMandate(body.payloadSd, body.disclosures, body.decoySalts);
  } catch (err) {
    return invalid(err instanceof Error ? err.message : "The mandate does not decode.");
  }
  if (body.commitment !== m.zk.commitment) {
    return invalid("commitment differs from zk.commitment");
  }
  // Every verifier, the Alibi's included, reads embed in clear.
  if (!isDeepStrictEqual((body.payloadSd as { embed?: unknown }).embed, m.embed)) {
    return invalid("embed must be in clear in payloadSd");
  }
  if (m.embed?.top_origin !== embed?.origin) {
    return invalid(
      embed
        ? `embed.top_origin must be ${embed.origin}, the page this approval is framed in`
        : "embed is only set by the embedded approval that signs it",
    );
  }
  if (embed && !(await clientEmbedOrigins(db, embed.clientId)).includes(embed.origin)) {
    return problem(
      c,
      403,
      "origin-not-allowed",
      "Origin not allowed",
      "The agent platform no longer lists this origin for its embeds.",
    );
  }
  const now = Date.now();
  if (m.exp * 1000 <= now) return invalid("exp has passed");
  if (m.nbf * 1000 > now) return invalid("nbf is in the future");
  const rpId = deps.passkeyRpId ?? RP_ID;
  if (m.user.cred.rp_id !== rpId) return invalid(`user.cred.rp_id must be ${rpId}`);
  const budget = m.payment.constraints.find((x) => x.type === "payment.budget");
  const merchants = m.checkout.constraints.find((x) => x.type === "checkout.allowed_merchants");
  if (budget?.type !== "payment.budget" || merchants?.type !== "checkout.allowed_merchants") {
    return invalid("mandate lacks a budget or allowed merchants");
  }
  const agentId = AGENT_ID.test(m.agent.operator.agent_id)
    ? BigInt(m.agent.operator.agent_id)
    : undefined;
  const operator =
    agentId === undefined
      ? undefined
      : await db.query.operators.findFirst({ where: (row, { eq }) => eq(row.agentId, agentId) });
  if (!operator) return invalid("agent.operator.agent_id is not a registered operator");
  if (operator.agentRegistry.toLowerCase() !== m.agent.operator.agent_registry.toLowerCase()) {
    return invalid(`agent.operator.agent_registry must be ${operator.agentRegistry}`);
  }
  const key = await db.query.passkey.findFirst({
    where: (row, { eq }) => eq(row.credentialID, body.assertion.credentialId),
  });
  if (!key || key.userId !== userId) return notOwned();
  let jwk: { x: string; y: string };
  try {
    jwk = passkeyJwk(key);
  } catch {
    return notOwned();
  }
  if (
    m.user.sub !== userId ||
    m.user.cred.id !== key.credentialID ||
    m.user.cred.jwk.x !== jwk.x ||
    m.user.cred.jwk.y !== jwk.y
  ) {
    return notOwned();
  }

  const assertion: SignedChallenge = {
    authenticatorData: body.assertion.authenticatorData,
    clientDataJSON: body.assertion.clientDataJSON,
    signature: body.assertion.signature,
    credentialId: body.assertion.credentialId,
    ...(body.assertion.userHandle === undefined ? {} : { userHandle: body.assertion.userHandle }),
  };
  const cm = BigInt(body.commitment);
  let M: Uint8Array;
  try {
    M = mandateChallenge(hSd(body.payloadSd), cm);
  } catch (err) {
    return invalid(err instanceof Error ? err.message : "invalid commitment");
  }
  const exists = () =>
    problem(c, 409, "mandate-exists", "Mandate exists", "This signed mandate is already stored.");
  const storedHash = () =>
    db.query.mandates.findFirst({
      columns: { id: true },
      where: (row, { eq }) => eq(row.mandateHash, Buffer.from(M)),
    });
  if (await storedHash()) return exists();
  const cnf = await agentCnf(operator);
  const bond = agentBond(operator);
  const unbound = [
    ...(cnf && isDeepStrictEqual(m.agent.cnf, cnf) ? [] : ["agent.cnf"]),
    ...(bond && isDeepStrictEqual(m.agent.bond, bond) ? [] : ["agent.bond"]),
    ...unboundPolicy(m.policy),
    ...(m.policy.policy_set_hash === POLICY_SET_HASH ? [] : ["policy.policy_set_hash"]),
    ...(isDeepStrictEqual(m.consent, await termsConsent()) ? [] : ["consent"]),
  ];
  let request: Connection | undefined;
  if (body.connection) {
    // RFC 8628 §5.1: user codes are short, so naming one is budgeted per user.
    const key = `rl:connection-approve:${userId}:${Math.floor(Date.now() / 60_000)}`;
    const [count] = await deps.kv.multi().incr(key).expire(key, 60, "NX").exec();
    if (Number(count) > APPROVALS_PER_MINUTE) {
      c.header("Retry-After", "60");
      return problem(c, 429, "rate-limited", "Too many requests", "Too many approvals.");
    }
    const code = normalizeUserCode(body.connection.code);
    request = code ? await openRequest(db, code) : undefined;
    if (embed && request?.id !== embed.connectionId) request = undefined;
    // A cart paused under a mandate is approved only while that mandate still stands.
    const parent = request?.parentMandateId
      ? await queries.mandateById(request.parentMandateId)
      : undefined;
    if (
      !request ||
      (request.userId !== null && request.userId !== userId) ||
      (request.kind === "once" && (parent?.state !== "ACTIVE" || parent.revokeRequestedAt)) ||
      (kindOf(request) === "change" &&
        (!parent ||
          !(REVOCABLE as readonly string[]).includes(parent.state) ||
          parent.revokeRequestedAt)) ||
      (request.parentMandateId !== null && parent?.userId !== userId)
    ) {
      return problem(
        c,
        409,
        "connection-closed",
        "Request closed",
        "The agent's request was already decided, expired or does not exist.",
      );
    }
    // An embedded approval is the request's own page, minted for the client that asked.
    if (!embed && unmatched(request)) {
      return problem(
        c,
        409,
        "number-not-matched",
        "Number not matched",
        "Pick the number your agent shows first.",
      );
    }
    const askAbove = body.connection.askAboveMinor;
    const looser = looserThan(m, request);
    if (
      (request.askAboveMinor !== null && askAbove === undefined) ||
      (askAbove !== undefined &&
        BigInt(askAbove) > (request.askAboveMinor ?? request.perPurchaseMinor))
    ) {
      looser.push("askAbove");
    }
    if (looser.length > 0) {
      return problem(
        c,
        422,
        "mandate-looser-than-request",
        "Mandate looser than the request",
        `${looser.join(", ")} must not grant more than ${request.name} asked for.`,
        { fields: looser },
      );
    }
  }
  if (unbound.length > 0) {
    return problem(
      c,
      422,
      "mandate-binding-mismatch",
      "Mandate binding mismatch",
      `${unbound.join(", ")} must be what compiling fills: the operator's registered agent key and bond, an engine build the legs are admitted to run, the current policy set and the current terms.`,
      { fields: unbound },
    );
  }

  const invalidSignature = () =>
    problem(
      c,
      401,
      "invalid-signature",
      "Invalid signature",
      "The passkey signature does not verify for this mandate.",
    );
  let newCounter: number;
  try {
    ({ newCounter } = await verifyMandateSignature({
      payloadSd: body.payloadSd,
      cm,
      assertion,
      passkey: key,
      expectedOrigin: embed ? embed.frameOrigin : origin,
      expectedTopOrigin: embed?.origin,
      expectedRpId: rpId,
      spc: spcDetails(m),
    }));
  } catch (err) {
    if (err instanceof SignatureError) return invalidSignature();
    throw err;
  }

  let issued: MandateIssued | undefined;
  const decoySalts = body.decoySalts ?? [];
  if (deps.tee) {
    if (!body.salt) return invalid("salt is required");
    if (decoySalts.length > 0 && !(await bothLegs({ tee: deps.tee })).decoys) {
      return problem(
        c,
        409,
        "decoys-unsupported",
        "Decoys not supported yet",
        "The TEEs do not resolve decoy digests yet: sign the mandate without them.",
      );
    }
    try {
      issued = await deps.tee.client.a.registerMandate({
        sub: userId,
        payload_sd: body.payloadSd,
        disclosures: body.disclosures,
        ...(decoySalts.length > 0 ? { decoy_salts: decoySalts } : {}),
        assertion: {
          authenticatorData: assertion.authenticatorData,
          clientDataJSON: assertion.clientDataJSON,
          signature: assertion.signature,
        },
        salt: body.salt as `0x${string}`,
        ...(key.userCredential ? { user_credential: key.userCredential } : {}),
      });
    } catch (err) {
      if (!(err instanceof LegError)) throw err;
      if (err.kind !== "problem" || (err.status ?? 0) >= 500) {
        return problem(
          c,
          503,
          "tee-unavailable",
          "TEE unavailable",
          "Leg A cannot issue the mandate now.",
        );
      }
      if (err.code?.startsWith("auth.")) return notOwned();
      return invalid(`the TEE refused the mandate: ${err.code ?? "unknown"}`);
    }
  }

  // PayPal holds one payee's funds per authorization, so a mandate allowing several merchants
  // holds each cart on its own and needs no budget hold to be usable. A card mandate holds its
  // budget on Keelson's account, which pays its single-use cards' charges.
  const rail = m.payment.rail;
  const holdMode = rail === "paypal" && merchants.allowed.length > 1 ? "per_purchase" : "mandate";
  try {
    await db.transaction(async (tx) => {
      const counted = await tx
        .update(passkey)
        .set({
          counter: newCounter,
          ...(issued ? { userCredential: issued.user_credential } : {}),
        })
        .where(
          sql`${passkey.id} = ${key.id} and (${newCounter} = 0 or ${passkey.counter} < ${newCounter})`,
        );
      if (counted.rowCount !== 1) throw new CounterError();
      await tx.insert(mandates).values({
        id: m.mid,
        rail,
        holdMode,
        userId,
        operatorAgentId: operator.agentId,
        currency: m.payment.currency,
        maxMinor: BigInt(budget.max),
        remainingMinor: BigInt(budget.max),
        merchantIds: merchants.allowed.map((x) => x.id),
        expiresAt: new Date(m.exp * 1000),
        mandateHash: Buffer.from(M),
        commitment: Buffer.from(fromHex(body.commitment)),
        payloadSd: body.payloadSd,
        disclosures: body.disclosures,
        decoySalts,
        userAuth: assertion,
        credentialId: key.credentialID,
        ...(issued
          ? {
              openMandate: issued.open_mandate,
              sealedSalt: Buffer.from(issued.sealed_salt, "base64"),
            }
          : {}),
      });
      if (!(await transition(tx, "mandates", m.mid, "DRAFT", "COMPILED"))) {
        throw new Error("mandate left DRAFT concurrently");
      }
      if (!(await transition(tx, "mandates", m.mid, "COMPILED", "SIGNED"))) {
        throw new Error("mandate left COMPILED concurrently");
      }
      if (
        holdMode === "per_purchase" &&
        !(await transition(tx, "mandates", m.mid, "SIGNED", "ACTIVE"))
      ) {
        throw new Error("mandate left SIGNED concurrently");
      }
      // The user code is spent with the mandate that answers it, or neither is stored.
      if (request) {
        const over = await hostedCapError(
          tx,
          deps,
          {
            clientId: request.clientId,
            operatorAgentId: operator.agentId,
            userId,
            currency: m.payment.currency,
            amountMinor: BigInt(budget.max),
            replaces: kindOf(request) === "change" ? request.parentMandateId : null,
          },
          true,
        );
        if (over) throw new OverHostedCap(over);
        const askAbove = body.connection?.askAboveMinor;
        const approved = await tx
          .update(agentConnections)
          .set({
            state: "APPROVED",
            userId,
            mandateId: m.mid,
            decidedAt: new Date(),
            askAboveMinor: askAbove === undefined ? null : BigInt(askAbove),
          })
          .where(
            and(
              eq(agentConnections.id, request.id),
              eq(agentConnections.state, "PENDING"),
              gt(agentConnections.expiresAt, new Date()),
            ),
          )
          .returning({ id: agentConnections.id });
        if (approved.length !== 1) throw new RequestClosed();
        // A change replaces its mandate: countersigns under the old one stop with this commit.
        if (kindOf(request) === "change" && request.parentMandateId) {
          await tx
            .update(mandates)
            .set({ revokeRequestedAt: sql`coalesce(${mandates.revokeRequestedAt}, now())` })
            .where(eq(mandates.id, request.parentMandateId));
        }
      }
    });
  } catch (err) {
    if (err instanceof OverHostedCap) {
      return problem(c, 422, "hosted-cap", "Over the hosted operator's cap", err.message);
    }
    if (err instanceof RequestClosed) {
      return problem(
        c,
        409,
        "connection-closed",
        "Request closed",
        "The agent's request was decided or expired while you signed.",
      );
    }
    if (isUniqueViolation(err)) return exists();
    // A concurrent request with the same assertion advanced the counter first.
    if (err instanceof CounterError) return (await storedHash()) ? exists() : invalidSignature();
    throw err;
  }

  // Leg A opened the commitment with this salt; the circuit pins Keelson's RP ID.
  if (issued && rpId === RP_ID && deps.proveAnonymousMandate) {
    const salt = body.salt as string;
    void deps
      .proveAnonymousMandate(m.mid, salt)
      .catch((err: unknown) => deps.log.warn({ err, mandateId: m.mid }, "C3 proof not started"));
  }

  if (request) {
    await publishEvent(
      deps,
      principalChannel({ kind: "client", subject: request.clientId }, "connections"),
      request.id,
      { type: "connection.approved", userCode: request.userCode, mandateId: m.mid },
    );
    // Its hold is released now; the sweeper voids it if PayPal is down.
    if (kindOf(request) === "change" && request.parentMandateId) {
      const parent = await queries.mandateById(request.parentMandateId);
      if (parent && (REVOCABLE as readonly string[]).includes(parent.state)) {
        await revokeMandate(deps, parent).catch((err: unknown) =>
          deps.log.warn({ err, mandateId: parent.id }, "replaced mandate not revoked yet"),
        );
      }
    }
  }

  c.header("location", `/v1/mandates/${m.mid}`);
  return c.json(
    {
      id: m.mid,
      mandateHash: toHex(M),
      state: holdMode === "per_purchase" ? ("ACTIVE" as const) : ("SIGNED" as const),
      openMandate: issued?.open_mandate ?? null,
    },
    201,
  );
}

export function registerMandates(app: OpenAPIHono, deps: MandateDeps): void {
  const { db } = deps;
  const queries = createQueries(db);

  app.openapi(create, async (c) =>
    storeMandate(c, deps, (c.get("principal") as Principal).subject, c.req.valid("json")),
  );

  app.openapi(list, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const rows = await db
      .select()
      .from(mandates)
      .where(eq(mandates.userId, userId))
      .orderBy(desc(mandates.createdAt), desc(mandates.id))
      .limit(MANDATES_SHOWN);
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        mandates: rows.map((row) => ({
          id: row.id,
          state: row.state,
          budget: budgetOf(row),
          merchantIds: row.merchantIds,
          holdMode: row.holdMode,
          expiresAt: row.expiresAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi(read, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const row = await queries.mandateById(c.req.valid("param").id);
    if (!row || row.userId !== userId) return problem(c, 404, "not-found", "Not found");
    const bought = await db
      .select()
      .from(purchases)
      .where(eq(purchases.mandateId, row.id))
      .orderBy(desc(purchases.createdAt), desc(purchases.id))
      .limit(PURCHASES_SHOWN);
    const opened =
      bought.length === 0
        ? []
        : await db
            .select({ id: disputes.id, state: disputes.state, purchaseId: disputes.purchaseId })
            .from(disputes)
            .where(
              inArray(
                disputes.purchaseId,
                bought.map((p) => p.id),
              ),
            );
    const waiting = await db
      .select({
        requestId: purchaseHolds.requestId,
        orderId: purchaseHolds.paypalOrderId,
        merchant: purchaseHolds.merchantId,
        amountMinor: purchaseHolds.amountMinor,
      })
      .from(purchaseHolds)
      .where(and(eq(purchaseHolds.mandateId, row.id), eq(purchaseHolds.state, "PENDING")))
      .orderBy(asc(purchaseHolds.createdAt));
    const parts = await breakdowns(
      db,
      bought.map((p) => p.evidenceRoot),
    );
    c.header("Cache-Control", "no-store");
    const card =
      row.payloadSd && row.disclosures
        ? renderCard(row.payloadSd as object, row.disclosures, NO_EVIDENCE, row.decoySalts)
        : null;
    const cards = new Map(
      await Promise.all(
        bought
          .filter((p) => p.rail === "card")
          .map(async (p) => [p.id, await cardViewOf(db, p.id)] as const),
      ),
    );
    return c.json(
      {
        id: row.id,
        state: row.state,
        rail: row.rail,
        mandateHash: row.mandateHash ? toHex(row.mandateHash) : null,
        budget: budgetOf(row),
        expiresAt: row.expiresAt.toISOString(),
        hold: holdView(row),
        card,
        purchases: bought.map((p) => {
          const { mandateId: _, ...view } = withBreakdown(purchaseView(p), p.evidenceRoot, parts);
          const card = cards.get(p.id);
          return {
            ...view,
            ...(card ? { card } : {}),
            merchantId: p.merchantId,
            createdAt: p.createdAt.toISOString(),
            disputes: opened
              .filter((d) => d.purchaseId === p.id)
              .map((d) => ({ id: d.id, state: d.state })),
          };
        }),
        pendingHolds: waiting.map((h) => ({ ...h, amountMinor: h.amountMinor.toString() })),
      },
      200,
    );
  });
}
