import { isDeepStrictEqual } from "node:util";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { fromHex, toHex } from "@keelson/core";
import {
  createQueries,
  desc,
  disputes,
  eq,
  inArray,
  mandates,
  passkey,
  purchases,
  sql,
  transition,
  user,
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
import type { Deps } from "../app.ts";
import { agentBond, agentCnf, termsConsent } from "../compile-sources.ts";
import { passkeyJwk, SignatureError, verifyMandateSignature } from "../mandate-signature.ts";
import { requireSession } from "../middleware/auth.ts";
import { purchaseView } from "../pipeline/drive.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { LegError, type MandateIssued } from "../tee/client.ts";
import { unboundPolicy } from "../tee/engine-source.ts";
import { PurchaseProgress } from "./purchases.ts";

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

const CreateMandate = z
  .object({
    payloadSd: z.record(z.string(), z.unknown()).openapi({
      description: "The SD-JWT payload with its `_sd` digests, as signed.",
    }),
    disclosures: z.array(z.string()).max(1024).openapi({
      description: "Every disclosure of the payload; each digest must resolve.",
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

const CreatedMandate = z
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
    amount: z.object({ currency: z.string(), minor: z.string() }),
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

const MandateView = z
  .object({
    id: z.string(),
    state: MandateState,
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

function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

export function registerMandates(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "log" | "appOrigin" | "passkeyRpId" | "tee" | "proveAnonymousMandate">,
): void {
  const { db } = deps;
  const queries = createQueries(db);

  app.openapi(create, async (c) => {
    const origin = deps.appOrigin;
    if (origin === undefined) throw new Error("appOrigin is required to verify mandates");
    const userId = (c.get("principal") as Principal).subject;
    const body = c.req.valid("json");
    const invalid = (detail: string) =>
      problem(c, 422, "invalid-mandate", "Invalid mandate", detail);
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
      m = decodeMandate(body.payloadSd, body.disclosures);
    } catch (err) {
      return invalid(err instanceof Error ? err.message : "The mandate does not decode.");
    }
    if (body.commitment !== m.zk.commitment) {
      return invalid("commitment differs from zk.commitment");
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
        expectedOrigin: origin,
        expectedRpId: rpId,
        spc: spcDetails(m),
      }));
    } catch (err) {
      if (err instanceof SignatureError) return invalidSignature();
      throw err;
    }

    let issued: MandateIssued | undefined;
    if (deps.tee) {
      if (!body.salt) return invalid("salt is required");
      const holder = await db.query.user.findFirst({
        columns: { userCredential: true },
        where: (row, { eq: is }) => is(row.id, userId),
      });
      try {
        issued = await deps.tee.client.a.registerMandate({
          sub: userId,
          payload_sd: body.payloadSd,
          disclosures: body.disclosures,
          assertion: {
            authenticatorData: assertion.authenticatorData,
            clientDataJSON: assertion.clientDataJSON,
            signature: assertion.signature,
          },
          salt: body.salt as `0x${string}`,
          ...(holder?.userCredential ? { user_credential: holder.userCredential } : {}),
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
    // holds each cart on its own and needs no budget hold to be usable.
    const holdMode = merchants.allowed.length > 1 ? "per_purchase" : "mandate";
    try {
      await db.transaction(async (tx) => {
        const counted = await tx
          .update(passkey)
          .set({ counter: newCounter })
          .where(
            sql`${passkey.id} = ${key.id} and (${newCounter} = 0 or ${passkey.counter} < ${newCounter})`,
          );
        if (counted.rowCount !== 1) throw new CounterError();
        await tx.insert(mandates).values({
          id: m.mid,
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
          userAuth: assertion,
          credentialId: key.credentialID,
          ...(issued
            ? {
                openMandate: issued.open_mandate,
                sealedSalt: Buffer.from(issued.sealed_salt, "base64"),
              }
            : {}),
        });
        if (issued) {
          await tx
            .update(user)
            .set({ userCredential: issued.user_credential })
            .where(eq(user.id, userId));
        }
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
      });
    } catch (err) {
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
  });

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
    c.header("Cache-Control", "no-store");
    const card =
      row.payloadSd && row.disclosures
        ? renderCard(row.payloadSd as object, row.disclosures, NO_EVIDENCE)
        : null;
    return c.json(
      {
        id: row.id,
        state: row.state,
        mandateHash: row.mandateHash ? toHex(row.mandateHash) : null,
        budget: budgetOf(row),
        expiresAt: row.expiresAt.toISOString(),
        hold: holdView(row),
        card,
        purchases: bought.map((p) => {
          const { mandateId: _, ...view } = purchaseView(p);
          return {
            ...view,
            merchantId: p.merchantId,
            createdAt: p.createdAt.toISOString(),
            disputes: opened
              .filter((d) => d.purchaseId === p.id)
              .map((d) => ({ id: d.id, state: d.state })),
          };
        }),
      },
      200,
    );
  });
}
