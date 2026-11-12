import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Cart } from "@keelson/core";
import { agentConnections, and, eq, gt, mandates, operators, sql } from "@keelson/db";
import { decodeMandate } from "@keelson/mandate";
import type { Context } from "hono";
import type { Deps } from "../app.ts";
import { cartChecks } from "../cart-checks.ts";
import { grantOf, REQUEST_TTL_SEC, requestChange } from "../connections.ts";
import { approvedMandate, isDelegated, notAnotherApps } from "../delegated.ts";
import { hostedCapError } from "../hosted-caps.ts";
import { MERCHANTS } from "../merchants.ts";
import { requireAgent } from "../middleware/auth.ts";
import { notify, requestAlert } from "../notify/notifier.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { stoppedSince } from "../stop.ts";
import { CartSchema } from "./countersign.ts";
import { REVOCABLE } from "./revoke.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
const Id = z.object({ id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/) });
const Minor = z.int().positive().max(Number.MAX_SAFE_INTEGER);

/** The fields one approval of the user may lift: how much, and at which store. */
const LIFTABLE = new Set(["total", "budget", "merchant"]);

const ChangeRequest = z
  .object({
    note: z
      .string()
      .min(10)
      .max(280)
      .refine((s) => s.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(s), "control or format characters")
      .openapi({
        description:
          "Why the agent needs more room, in one line the user reads verbatim, e.g. 'Needs $40 more for shipping'.",
      }),
    limits: z
      .object({
        perPurchaseMinor: Minor.optional(),
        totalMinor: Minor.optional(),
        until: z.iso.datetime({ offset: true }).optional(),
        askAboveMinor: Minor.optional(),
      })
      .optional()
      .openapi({ description: "The limits asked for; the mandate's own where left out." }),
  })
  .openapi("MandateChangeRequest");

const Blocker = z.object({
  code: z.string().openapi({ example: "field:total" }),
  field: z.string().nullable(),
  message: z.string(),
  next: z.string().openapi({ description: "What the agent does about it." }),
});

const CheckResult = z
  .object({
    canAttempt: z.boolean().openapi({
      description: "Whether a countersign of this cart would pass the mandate as it stands now.",
    }),
    needsApproval: z.boolean().openapi({
      description:
        "The cart passes, and is above the user's ask-me amount: the countersign pauses it for their one-time approval.",
    }),
    blockers: z.array(Blocker),
    checks: z.array(
      z.object({
        field: z.string(),
        mandate: z.string().nullable(),
        cart: z.string().nullable(),
        pass: z.boolean(),
      }),
    ),
  })
  .openapi("CartCheck");

const change = createRoute({
  method: "post",
  path: "/v1/mandates/{id}/changes",
  operationId: "requestMandateChange",
  tags: ["mandates"],
  summary: "Ask the user to change a mandate",
  description:
    "The agent asks its user for different limits, with a one-line note the user reads verbatim. The user may lower what is asked and approves with a passkey; the new mandate then replaces this one, whose hold is released. Nothing changes until the user signs. Poll `GET /v1/connections/requests/{id}` for the answer. An app acting for a user (`mandates:request`) asks only about a mandate that user approved for it.",
  middleware: [requireAgent("mandates:request")],
  request: {
    params: Id,
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: { required: true, content: { "application/json": { schema: ChangeRequest } } },
  },
  responses: {
    201: {
      description: "The user was asked; show the link and poll",
      content: {
        "application/json": {
          schema: z.object({
            request_id: z.string(),
            user_code: z.string(),
            verification_uri_complete: z.string(),
            expires_in: z.int(),
            interval: z.int(),
          }),
        },
      },
    },
    401: { description: "No valid access token", content: problemContent },
    404: {
      description:
        "No such mandate of an operator this client linked, or that the user approved for this app",
      content: problemContent,
    },
    409: {
      description:
        "The mandate has ended, or a change of it is already waiting for the user (`change-pending`, with its `requestId`)",
      content: problemContent,
    },
    422: {
      description: "The limits are invalid, or over the hosted operator's cap (`hosted-cap`)",
      content: problemContent,
    },
  },
});

const check = createRoute({
  method: "post",
  path: "/v1/mandates/{id}/check",
  operationId: "checkCart",
  tags: ["mandates"],
  summary: "Check a cart against a mandate",
  description:
    "A dry run: what a countersign of this cart would find, field by field, from the same policy set the TEE legs run, with nothing signed, reserved or logged. The countersign stays the only decision. An app acting for a user (`purchases:write`) checks only under a mandate that user approved for it.",
  middleware: [requireAgent("purchases:write")],
  request: {
    params: Id,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ cart: CartSchema }) } },
    },
  },
  responses: {
    200: { description: "The check", content: { "application/json": { schema: CheckResult } } },
    401: { description: "No valid access token", content: problemContent },
    404: {
      description: "No such mandate of an operator this client linked",
      content: problemContent,
    },
  },
});

/**
 * The mandate if an operator this client linked holds it or, for an app acting for a user, if
 * that user approved it for the app.
 */
async function clientMandate(c: Context, db: Deps["db"], id: string) {
  const principal = c.get("principal") as Principal;
  if (isDelegated(principal)) return approvedMandate(db, principal, id);
  const [found] = await db
    .select({ mandate: mandates, clientId: operators.clientId })
    .from(mandates)
    .innerJoin(operators, eq(operators.agentId, mandates.operatorAgentId))
    .where(and(eq(mandates.id, id), notAnotherApps(principal.subject)));
  // The same answer for an unknown mandate and another client's, so neither is disclosed.
  if (!found?.clientId || found.clientId !== principal.subject) {
    return undefined;
  }
  return found.mandate;
}

const decoded = (m: typeof mandates.$inferSelect) =>
  m.payloadSd && m.disclosures
    ? decodeMandate(m.payloadSd as Record<string, unknown>, m.disclosures)
    : undefined;

export function registerMandateRequests(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "appOrigin" | "notifier" | "demoAgentId" | "hostedCaps">,
): void {
  const { db } = deps;
  const appOrigin = deps.appOrigin ?? "https://app.keelson.finance";

  app.openapi(change, async (c) => {
    const mandate = await clientMandate(c, db, c.req.valid("param").id);
    if (!mandate) return problem(c, 404, "not-found", "Not found");
    if (
      !(REVOCABLE as readonly string[]).includes(mandate.state) ||
      mandate.revokeRequestedAt !== null
    ) {
      return problem(c, 409, "mandate-ended", "Mandate ended", `The mandate is ${mandate.state}.`);
    }
    const grant = (() => {
      try {
        const m = decoded(mandate);
        return m ? grantOf(m) : undefined;
      } catch {
        return undefined;
      }
    })();
    if (!grant) {
      return problem(c, 409, "mandate-ended", "Mandate ended", "The mandate is not signed.");
    }
    const { note, limits = {} } = c.req.valid("json");
    const until = limits.until ? new Date(limits.until) : grant.notAfter;
    // Unless the agent asks for more, the new mandate holds what is left of this one, not its total.
    const total = BigInt(limits.totalMinor ?? mandate.remainingMinor);
    let perPurchase = BigInt(limits.perPurchaseMinor ?? grant.perPurchaseMinor);
    if (limits.perPurchaseMinor === undefined && perPurchase > total) perPurchase = total;
    const [answered] = await db
      .select({ askAbove: agentConnections.askAboveMinor })
      .from(agentConnections)
      .where(
        and(eq(agentConnections.mandateId, mandate.id), eq(agentConnections.state, "APPROVED")),
      );
    const askAbove =
      limits.askAboveMinor !== undefined
        ? BigInt(limits.askAboveMinor)
        : (answered?.askAbove ?? null);
    const invalid =
      perPurchase > total
        ? "perPurchaseMinor exceeds totalMinor"
        : askAbove !== null && askAbove > perPurchase
          ? "askAboveMinor exceeds perPurchaseMinor"
          : until.getTime() <= Date.now() + REQUEST_TTL_SEC * 1000
            ? "until is too soon"
            : until.getTime() > Date.now() + 30 * 86_400_000
              ? "until is more than 30 days away"
              : undefined;
    if (invalid) return problem(c, 422, "invalid-limits", "Invalid limits", invalid);
    const over = await hostedCapError(db, deps, {
      clientId: (c.get("principal") as Principal).subject,
      operatorAgentId: mandate.operatorAgentId,
      userId: mandate.userId,
      currency: grant.currency,
      amountMinor: total,
      replaces: mandate.id,
    });
    if (over) return problem(c, 422, "hosted-cap", "Over the hosted operator's cap", over);
    // One change of a mandate waits for the user at a time.
    const auth = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`change:${mandate.id}`}))`);
      const [pending] = await tx
        .select({ id: agentConnections.id })
        .from(agentConnections)
        .where(
          and(
            eq(agentConnections.parentMandateId, mandate.id),
            eq(agentConnections.kind, "connect"),
            eq(agentConnections.state, "PENDING"),
            gt(agentConnections.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (pending) {
        return problem(
          c,
          409,
          "change-pending",
          "Change pending",
          "A change of this mandate is already waiting for the user; poll it.",
          { requestId: pending.id },
        );
      }
      return requestChange(
        { db: tx, kv: deps.kv, appOrigin },
        {
          mandate,
          clientId: (c.get("principal") as Principal).subject,
          note,
          grant: {
            currency: grant.currency,
            perPurchaseMinor: perPurchase,
            totalMinor: total,
            merchantIds: grant.merchantIds,
            notAfter: until,
            askAboveMinor: askAbove,
          },
        },
      );
    });
    if (auth instanceof Response) return auth;
    notify(deps.notifier, (n) => requestAlert(n, auth.request_id));
    const { device_code: _, ...shown } = auth;
    return c.json(shown, 201, { "cache-control": "no-store" });
  });

  app.openapi(check, async (c) => {
    const mandate = await clientMandate(c, db, c.req.valid("param").id);
    if (!mandate) return problem(c, 404, "not-found", "Not found");
    const cart = c.req.valid("json").cart as Cart;
    const blockers: z.infer<typeof Blocker>[] = [];
    if (mandate.state !== "ACTIVE" || mandate.revokeRequestedAt !== null) {
      blockers.push({
        code: "mandate-not-active",
        field: null,
        message:
          mandate.state === "SIGNED" || mandate.state === "HOLD_PENDING"
            ? "The mandate is signed and its PayPal hold is not approved yet."
            : `The mandate is ${mandate.revokeRequestedAt ? "revoked" : mandate.state.toLowerCase()}.`,
        next:
          mandate.state === "SIGNED" || mandate.state === "HOLD_PENDING"
            ? "Call keelson.confirm_mandate and wait for the hold."
            : "Stop. Ask the user for a new mandate with keelson.request_mandate.",
      });
    }
    if (await stoppedSince(db, mandate.userId, mandate.createdAt)) {
      blockers.push({
        code: "agents-stopped",
        field: null,
        message: "The user stopped all agents.",
        next: "Stop. Do not buy or ask again unless the user tells you to.",
      });
    }
    const checks = cartChecks(mandate, cart);
    const onboarded = MERCHANTS.some((x) => x.id === cart.merchant);
    for (const f of checks.filter((x) => !x.pass)) {
      const liftable = LIFTABLE.has(f.field) && onboarded;
      blockers.push({
        code: `field:${f.field}`,
        field: f.field,
        message: `${f.field}: the mandate allows ${f.mandate ?? "nothing"}, the cart has ${f.cart ?? "nothing"}.`,
        next: liftable
          ? "The countersign pauses this cart for the user's one-time approval, or ask for more room with keelson.request_mandate_change."
          : "Change the cart: one approval cannot lift this field.",
      });
    }
    const [answered] = await db
      .select({ askAbove: agentConnections.askAboveMinor })
      .from(agentConnections)
      .where(
        and(eq(agentConnections.mandateId, mandate.id), eq(agentConnections.state, "APPROVED")),
      );
    const total = cart.lines.reduce((s, l) => s + BigInt(l.qty) * BigInt(l.unit_minor), 0n);
    const canAttempt = blockers.length === 0;
    return c.json(
      {
        canAttempt,
        needsApproval: canAttempt && answered?.askAbove != null && total > answered.askAbove,
        blockers,
        checks,
      },
      200,
    );
  });
}
